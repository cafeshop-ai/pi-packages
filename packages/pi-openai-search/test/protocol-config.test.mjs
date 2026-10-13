import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG, loadConfig, parseConfig, saveConfig } from "../src/config.ts";
import { parseCommands, parseResponse, resultReferences, ResultSchema, checkSettings, isWebUrl } from "../src/protocol.ts";
import { formatResult, sources, resultText } from "../src/output.ts";

const examples = [
  { search_query: [{ q: "Codex", recency: 7, domains: ["openai.com"] }] },
  { image_query: [{ q: "mountains" }] },
  { open: [{ ref_id: "turn0search0", lineno: 10 }, { ref_id: "https://example.com" }] },
  { click: [{ ref_id: "turn1view0", id: 5 }] },
  { find: [{ ref_id: "turn1view0", pattern: "API" }] },
  { screenshot: [{ ref_id: "turn1view0", pageno: 0 }] },
  { finance: [{ ticker: "BTC", type: "crypto", market: "" }, { ticker: "AMD", type: "equity", market: "USA" }] },
  { weather: [{ location: "France, Paris", start: "2024-02-29", duration: 7 }] },
  { sports: [{ tool: "sports", fn: "schedule", league: "nba", team: "GSW", opponent: "LAL", date_from: "2026-01-01", date_to: "2026-12-31", num_games: 3, locale: "en-US" }] },
  { time: [{ utc_offset: "+08:00" }, { utc_offset: "-14:00" }] },
];
test("all ten source-defined operations and combined commands validate", () => {
  for (const example of examples) assert.deepEqual(parseCommands(example), example);
  const combined = Object.assign({ response_length: "long" }, ...examples);
  assert.deepEqual(parseCommands(combined), combined);
  const parsed = parseCommands(examples[0]); parsed.search_query[0].q = "changed";
  assert.equal(examples[0].search_query[0].q, "Codex");
});
test("reject empty, unknown, malformed and dangerous operation arguments", () => {
  const invalid = [
    {}, { response_length: "short" }, { search_query: [] }, { search_query: [{ q: " " }] },
    { search_query: [{ q: 7 }] }, { search_query: [{ q: "x" }], apiKey: "secret" },
    { open: [{ ref_id: "file:///etc/passwd" }] }, { open: [{ ref_id: "javascript:alert(1)" }] },
    { open: [{ ref_id: "https://user:secret@example.com" }] }, { open: [{ ref_id: "https://example.com\n" }] },
    { click: [{ ref_id: "turn0search0", id: -1 }] }, { screenshot: [{ ref_id: "turn0search0", pageno: 1.5 }] },
    { finance: [{ ticker: "AMD", type: "unknown" }] }, { weather: [{ location: "Paris", start: "2025-02-29" }] },
    { weather: [{ location: "Paris", start: "2025-13-01" }] }, { sports: [{ fn: "schedule", league: "nba", date_from: "2026-02-02", date_to: "2026-01-01" }] },
    { time: [{ utc_offset: "+14:30" }] }, { time: [{ utc_offset: "+24:00" }] },
    { search_query: [{ q: "x", domains: ["https://openai.com"] }] },
    { search_query: Array.from({ length: 5 }, () => ({ q: "x" })), response_length: "long" },
    { search_query: Array.from({ length: 4 }, () => ({ q: "x" })) },
  ];
  for (const value of invalid) assert.throws(() => parseCommands(value), undefined, JSON.stringify(value));
  assert.equal(parseCommands({ search_query: Array.from({ length: 4 }, () => ({ q: "x" })), response_length: "medium" }).search_query.length, 4);
});
test("complete settings preserve valid wire values and reject typos", () => {
  const settings = {
    external_web_access: "indexed", search_context_size: "high", filters: { allowed_domains: ["openai.com"], blocked_domains: ["example.com"] },
    user_location: { type: "approximate", country: "CN", city: "Shanghai", timezone: "Asia/Shanghai" },
    image_settings: { max_results: 4, caption: true }, allowed_callers: ["direct", "shell", "code_interpreter"],
  };
  assert.doesNotThrow(() => checkSettings(settings));
  for (const external_web_access of [true, false, "cached", "indexed", "live"]) assert.doesNotThrow(() => checkSettings({ external_web_access }));
  assert.throws(() => checkSettings({ user_location: { type: "approximate", timezone: "not-a-zone" } }));
  assert.throws(() => checkSettings({ search_context_sizes: "high" }));
  assert.throws(() => checkSettings({ filters: { blocked_domains: ["*.example.com"] } }));
});
test("configuration defaults merge without adding secrets or mutating defaults", () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  const config = parseConfig({ request: { timeoutMs: 2000 }, settings: { external_web_access: false } });
  assert.deepEqual(Object.keys(config).sort(), ["request", "settings"]);
  assert.equal(config.request.maxOutputTokens, 4000);
  assert.deepEqual(config.settings.allowed_callers, ["direct"]);
  config.settings.allowed_callers.push("shell");
  assert.deepEqual(DEFAULT_CONFIG.settings.allowed_callers, ["direct"]);
  for (const value of [null, [], { apiKey: "super-secret" }, { connection: {} }, { request: { timeoutMs: 0 } }, { settings: { invalid: true } }]) {
    assert.throws(() => parseConfig(value), (error) => !error.message.includes("super-secret"));
  }
});
test("legacy connection selections are ignored while search settings are preserved", () => {
  const settings = { external_web_access: "cached" };
  const request = { timeoutMs: 2000 };
  assert.deepEqual(parseConfig({ mode: "proxy", direct: { model: "old" }, proxy: { provider: "old", model: "old", path: "https://ignored.example" }, settings, request }), parseConfig({ settings, request }));
});
test("config loading and atomic save preserve malformed/concurrently changed files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-search-config-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const initial = await loadConfig(path); assert.deepEqual(initial, DEFAULT_CONFIG);
  const next = parseConfig({ request: { timeoutMs: 2000 } });
  await saveConfig(next, initial, path); assert.deepEqual(await loadConfig(path), next);
  await assert.rejects(saveConfig(initial, initial, path), /changed while editing/);
  await writeFile(path, '\uFEFF{"mode":"proxy"}'); assert.deepEqual(await loadConfig(path), DEFAULT_CONFIG);
  await writeFile(path, '{"apiKey":"keep-secret"');
  await assert.rejects(loadConfig(path), /Invalid JSON/);
  await assert.rejects(saveConfig(next, initial, path), /Invalid JSON/);
  assert.equal(await readFile(path, "utf8"), '{"apiKey":"keep-secret"');
  assert.deepEqual(await readdir(dir), ["config.json"]);
});
test("response preserves missing, null, empty and unknown result variants; drops encryption", () => {
  for (const value of [{ output: "" }, { output: "text", results: null }, { output: "text", results: [] }, { output: "text", results: [{ type: "future", extra: { value: 1 } }] }]) {
    assert.deepEqual(parseResponse({ ...value, encrypted_output: "ciphertext" }), value);
  }
  for (const value of [null, [], {}, { output: 3 }, { output: "x", results: {} }]) assert.throws(() => parseResponse(value), /protocol error/);
});
test("references come from text and structured results, not remote URLs", () => {
  assert.deepEqual(new Set(resultReferences({ output: "citeturn0search0 【turn1view2】", results: [{ ref_id: "custom-ref" }, { children: [{ ref_id: "turn2fetch3" }] }] })), new Set(["turn0search0", "turn1view2", "custom-ref", "turn2fetch3"]));
  assert.equal(isWebUrl("https://example.com/docs"), true);
  assert.deepEqual(sources({ output: "x", results: [{ url: "javascript:x" }, { url: "https://example.com", title: "Docs" }, { url: "https://example.com" }] }), [{ title: "Docs", url: "https://example.com" }]);
});
test("large text and structured results are bounded with complete validated artifact", async (t) => {
  const response = { output: "多字节网页内容\n".repeat(10000), results: [{ type: "future", payload: "x".repeat(20000) }] };
  const result = await formatResult(response);
  t.after(() => rm(result.fullOutputPath, { force: true }));
  assert.equal(Value.Check(ResultSchema, result), true);
  assert.equal(result.truncated, true); assert.deepEqual(result.results, []);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50000);
  assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), response);
  assert.match(resultText(result), /External web evidence/); assert.match(resultText(result), /Full validated result/);
  assert.deepEqual(await formatResult({ output: "small", results: [] }), { output: "small", results: [], truncated: false });
});
