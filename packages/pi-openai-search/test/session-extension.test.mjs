import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import register from "../src/index.ts";
import { SearchSession, STATE_ENTRY } from "../src/session.ts";
import { server, json, registry, query } from "./helpers.mjs";

const binding = "a".repeat(64);
const otherBinding = "b".repeat(64);
function sessionSetup() {
  const branch = [];
  return { branch, session: new SearchSession((customType, data) => branch.push({ type: "custom", customType, data })) };
}
test("stable IDs, known references and recovery from active branch", () => {
  const { session, branch } = sessionSetup();
  const first = session.prepare("owner", binding, query);
  session.remember(first, { output: "【turn0search0】" });
  assert.equal(session.prepare("owner", binding, { open: [{ ref_id: "turn0search0" }] }), first);
  const restored = new SearchSession(() => {}); restored.restore("owner", branch);
  assert.equal(restored.prepare("owner", binding, { find: [{ ref_id: "turn0search0", pattern: "API" }] }), first);
  assert.throws(() => restored.prepare("owner", binding, { click: [{ ref_id: "turn999view1", id: 1 }] }), /Unknown or expired/);
  assert.equal(restored.prepare("owner", binding, { open: [{ ref_id: "https://example.com" }] }), first);
});
test("owner, binding, fork and tree resets isolate references, including after reload", () => {
  for (const action of ["new-owner", "binding", "fork", "reset"]) {
    const { session, branch } = sessionSetup();
    const id = session.prepare("owner", binding, query); session.remember(id, { output: "turn0search0" });
    if (action === "fork") session.restore("fork", branch, true);
    if (action === "reset") session.reset("owner");
    const owner = ["fork", "new-owner"].includes(action) ? "fork" : "owner";
    const target = action === "binding" ? otherBinding : binding;
    assert.throws(() => session.prepare(owner, target, { open: [{ ref_id: "turn0search0" }] }), /Unknown or expired/);
    const nextId = session.prepare(owner, target, query); assert.notEqual(nextId, id);
    session.remember(id, { output: "turn999search0" });
    const restored = new SearchSession(() => {}); restored.restore(owner, branch);
    assert.throws(() => restored.prepare(owner, target, { open: [{ ref_id: "turn999search0" }] }));
  }
});
test("untrusted/corrupt session state is ignored", () => {
  const { session } = sessionSetup();
  session.restore("owner", [{ type: "custom", customType: STATE_ENTRY, data: { version: 1, owner: "owner", id: "not-id", binding, refs: ["turn0search0"] } }]);
  assert.throws(() => session.prepare("owner", binding, { open: [{ ref_id: "turn0search0" }] }));
});
test("nested calls serialize and an aborted queued call never executes", async () => {
  const { session } = sessionSetup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const actions = [];
  const first = session.enqueue(AbortSignal.timeout(5000), async () => { actions.push("first"); await gate; actions.push("first-end"); });
  const controller = new AbortController();
  const second = session.enqueue(controller.signal, async () => { actions.push("cancelled-must-not-run"); });
  controller.abort(); await assert.rejects(second);
  const third = session.enqueue(AbortSignal.timeout(5000), async () => { actions.push("third"); });
  release(); await Promise.all([first, third]);
  assert.deepEqual(actions, ["first", "first-end", "third"]);
});

async function setup(t, modelRegistry, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-search-extension-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pi-openai-search.json");
  if (config !== undefined) await writeFile(path, JSON.stringify(config));
  const events = new Map(), commands = new Map(), tools = new Map(), branch = [], messages = [];
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
  try {
    register({
      on: (name, handler) => { events.set(name, handler); },
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command),
      appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
      sendMessage: (message) => messages.push(message),
    });
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
  const ctx = {
    cwd: directory, mode: "json", hasUI: false, modelRegistry, model: modelRegistry.model,
    sessionManager: { getSessionId: () => "pi-session", getBranch: () => branch },
    waitForIdle: async () => {}, ui: { notify: (text) => messages.push({ content: text }) },
  };
  await events.get("session_start")({ reason: "startup" }, ctx);
  return {
    path, ctx, events, branch, messages, tool: tools.get("openai_search"), command: commands.get("openai-search"),
    run: (params, signal) => tools.get("openai_search").execute("call-1", params, signal, undefined, ctx),
  };
}
test("registered tool works without UI and exposes structured output for Codemode", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "Docs 【turn0search0】", results: [{ type: "text_result", title: "Docs", url: "https://example.com", ref_id: "turn0search0" }] }));
  const app = await setup(t, registry(remote.url));
  assert.equal(app.tool.exposure, "direct"); assert.equal(app.tool.executionMode, "sequential");
  assert.equal(app.tool.annotations.openWorldHint, true);
  const result = await app.run(query);
  assert.equal(Value.Check(app.tool.outputSchema, result.structuredContent), true);
  assert.equal(result.structuredContent.results[0].ref_id, "turn0search0");
  assert.equal(result.details.provider, "test-proxy");
  assert.match(result.content[0].text, /External web evidence/);
  await app.run({ open: [{ ref_id: "turn0search0" }] });
  assert.equal(remote.requests[0].body.id, remote.requests[1].body.id);
  assert.ok(!JSON.stringify(app.branch).includes("test-secret-key"));
  assert.equal(remote.requests[0].body.input, undefined);
});
test("status is the default command and never opens a connection picker or resolves credentials", async (t) => {
  const reg = registry("https://example.com/v1");
  reg.getApiKeyAndHeaders = async () => { throw new Error("must-not-read-auth"); };
  const app = await setup(t, reg);
  await app.command.handler("status", app.ctx);
  assert.match(app.messages.at(-1).content, /https:\/\/example.com\/v1\/alpha\/search/);
  app.ctx.hasUI = true;
  app.ctx.ui.select = () => { throw new Error("must-not-open-picker"); };
  await app.command.handler("", app.ctx);
  assert.match(app.messages.at(-1).content, /跟随当前 Pi 会话/);
  assert.ok(app.messages.at(-1).content.includes("test-proxy/search-model"));
});
test("optional settings editor saves only settings and limits, not a connection", async (t) => {
  const app = await setup(t, registry("https://example.com/v1"));
  app.ctx.hasUI = true;
  app.ctx.ui.editor = async () => JSON.stringify({ request: { timeoutMs: 2000 }, settings: { search_context_size: "low" } });
  await app.command.handler("settings", app.ctx);
  const saved = JSON.parse(await readFile(app.path, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["request", "settings"]);
  assert.equal(saved.request.timeoutMs, 2000);
  assert.equal(saved.settings.search_context_size, "low");
  assert.ok(!JSON.stringify(saved).includes("test-secret"));
});
test("tool follows session model changes and ignores old connection overrides", async (t) => {
  const first = await server(t, (_req, res) => json(res, { output: "turn0search0" }));
  const second = await server(t, (_req, res) => json(res, { output: "turn1search0" }));
  const app = await setup(t, registry(first.url), { mode: "proxy", proxy: { provider: "old-provider", model: "old-model", path: "/old/search" } });
  await app.run(query);
  const next = registry(second.url, { apiKey: "next-provider-key" });
  next.model.provider = "next-provider"; next.model.id = "next-model";
  app.ctx.modelRegistry = next; app.ctx.model = next.model;
  await assert.rejects(app.run({ open: [{ ref_id: "turn0search0" }] }), /Unknown or expired/);
  assert.equal(second.requests.length, 0);
  const result = await app.run(query);
  assert.equal(first.requests.length, 1); assert.equal(second.requests.length, 1);
  assert.equal(first.requests[0].url, "/alpha/search");
  assert.equal(second.requests[0].headers.authorization, "Bearer next-provider-key");
  assert.equal(second.requests[0].body.model, "next-model");
  assert.notEqual(second.requests[0].body.id, first.requests[0].body.id);
  assert.equal(result.details.provider, "next-provider");
});
test("virtual session selection uses the dispatched physical model for search and status", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "turn0search0" }));
  const reg = registry(remote.url);
  const app = await setup(t, reg);
  app.ctx.model = { provider: "router", id: "auto", api: "pi-virtual", baseUrl: "" };
  app.branch.push(
    { type: "model_change", provider: "router", modelId: "auto" },
    { type: "message", message: { role: "assistant", provider: reg.model.provider, model: reg.model.id, api: reg.model.api, stopReason: "toolUse" } },
  );
  await app.command.handler("status", app.ctx);
  assert.ok(app.messages.at(-1).content.includes("test-proxy/search-model"));
  assert.equal(remote.requests.length, 0);
  const result = await app.run(query);
  assert.equal(result.details.provider, reg.model.provider);
  assert.equal(remote.requests[0].body.model, reg.model.id);
  assert.equal(remote.requests[0].headers.authorization, "Bearer test-secret-key-123");
});
test("unrouted virtual selection does not reuse a connection from before a model switch", async (t) => {
  const reg = registry("https://example.com");
  reg.getApiKeyAndHeaders = () => { throw new Error("must not resolve credentials"); };
  const app = await setup(t, reg);
  app.ctx.model = { provider: "router", id: "auto", api: "pi-virtual", baseUrl: "" };
  app.branch.push(
    { type: "message", message: { role: "assistant", provider: reg.model.provider, model: reg.model.id, api: reg.model.api, stopReason: "stop" } },
    { type: "model_change", provider: "router", modelId: "auto" },
    { type: "message", message: { role: "assistant", provider: reg.model.provider, model: reg.model.id, api: reg.model.api, stopReason: "error" } },
  );
  await assert.rejects(app.run(query), /尚未.*实际模型/);
});
test("virtual dispatch never falls back when the latest physical model is missing", async (t) => {
  const reg = registry("https://example.com");
  reg.getApiKeyAndHeaders = () => { throw new Error("must not resolve credentials"); };
  const app = await setup(t, reg);
  app.ctx.model = { provider: "router", id: "auto", api: "pi-virtual", baseUrl: "" };
  app.branch.push(
    { type: "message", message: { role: "assistant", provider: reg.model.provider, model: reg.model.id, api: reg.model.api, stopReason: "stop" } },
    { type: "message", message: { role: "assistant", provider: "removed", model: "removed", api: reg.model.api, stopReason: "toolUse" } },
  );
  await assert.rejects(app.run(query), /实际模型已不在/);
});
test("test command uses one public query and asks for confirmation with UI", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "Docs" }));
  const app = await setup(t, registry(remote.url));
  app.ctx.hasUI = true; app.ctx.ui.confirm = async () => false;
  await app.command.handler("test", app.ctx); assert.equal(remote.requests.length, 0);
  app.ctx.ui.confirm = async () => true;
  await app.command.handler("test", app.ctx); assert.equal(remote.requests.length, 1);
  assert.deepEqual(remote.requests[0].body.commands.search_query[0].domains, ["developers.openai.com"]);
});
test("tree/reset removes old references and shutdown cancels an in-flight response", async (t) => {
  const remote = await server(t, (_req, res, received) => {
    if (received.body.commands.time) { res.writeHead(200); res.write('{"output":"'); }
    else json(res, { output: "turn0search0" });
  });
  const app = await setup(t, registry(remote.url));
  await app.run(query);
  await app.events.get("session_tree")({}, app.ctx);
  await assert.rejects(app.run({ open: [{ ref_id: "turn0search0" }] }), /Unknown or expired/);
  assert.equal(remote.requests.length, 1);
  await app.run(query);
  await app.command.handler("reset", app.ctx);
  await assert.rejects(app.run({ open: [{ ref_id: "turn0search0" }] }), /Unknown or expired/);
  const pending = app.run({ time: [{ utc_offset: "+00:00" }] });
  const rejected = assert.rejects(pending, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await app.events.get("session_shutdown")({}, app.ctx);
  await rejected;
});
test("HTTP 200 operation error sets isError and does not register invalid references", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "Error parsing function call: example turn0search1", results: [] }));
  const app = await setup(t, registry(remote.url));
  const result = await app.run(query);
  assert.equal(result.isError, true);
  assert.ok(result.structuredContent.error);
  assert.equal(Value.Check(app.tool.outputSchema, result.structuredContent), true);
  await assert.rejects(app.run({ open: [{ ref_id: "turn0search1" }] }), /Unknown or expired/);
  assert.equal(remote.requests.length, 1);
});
test("corrupt configuration keeps the extension/commands loaded without overwriting it", async (t) => {
  const app = await setup(t, registry("https://example.com"));
  await writeFile(app.path, '{"secret":"do-not-print"');
  await app.command.handler("status", app.ctx);
  assert.match(app.messages.at(-1).content, /Invalid JSON/);
  assert.ok(!app.messages.at(-1).content.includes("do-not-print"));
  await assert.rejects(app.run(query), /Invalid JSON/);
  assert.equal(await readFile(app.path, "utf8"), '{"secret":"do-not-print"');
});
