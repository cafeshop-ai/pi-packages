import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { server, json } from "./helpers.mjs";

for (const virtual of [false, true]) {
  test(`real Pi loader and Codemode follow ${virtual ? "virtual router dispatch" : "physical selection"} without search configuration`, { timeout: 30000 }, async (t) => {
    const remote = await server(t, (_req, res) => json(res, { output: "SDK result turn0search0", results: [{ ref_id: "turn0search0", url: "https://example.com", title: "SDK" }] }));
    const dir = await mkdtemp(join(tmpdir(), "pi-search-sdk-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
    t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
    const settingsManager = SettingsManager.inMemory({ packages: [], defaultTools: ["openai_search", "codemode"] });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
    const faux = createFauxCore({ api: "openai-responses", provider: "sdk-search" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'const r = await tools.openai_search({search_query:[{q:"public docs"}]}); return {output:r.output, ref:r.results[0].ref_id};' }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    runtime.registerProvider("sdk-search", {
      baseUrl: remote.url, api: "openai-responses", apiKey: "test-sdk-key", streamSimple: faux.streamSimple,
      models: [{ id: "search-model", name: "Search", input: ["text"], reasoning: false, contextWindow: 8192, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    let routes = 0;
    if (virtual) runtime.registerVirtualModel({
      provider: "router", id: "auto", contextWindow: 8192, maxTokens: 2048,
      route: () => { routes++; return { model: runtime.getModel("sdk-search", "search-model"), thinkingLevel: "off" }; },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      extensionFactories: [createCodemodeExtension({ mode: "on" })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime,
      model: runtime.getModel(virtual ? "router" : "sdk-search", virtual ? "auto" : "search-model"), resourceLoader,
      settingsManager, sessionManager: SessionManager.inMemory(dir), tools: ["openai_search", "codemode"],
    });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes("openai_search"));
    assert.ok(session.getCallableToolNames().includes("openai_search"));
    await session.prompt("/openai-search status");
    assert.equal(routes, 0);
    assert.equal(remote.requests.length, 0);
    await session.prompt("Search public docs using Codemode.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result);
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.match(JSON.stringify(result.content), /SDK result turn0search0/);
    assert.equal(remote.requests.length, 1);
    assert.equal(remote.requests[0].body.input, undefined);
    assert.equal(remote.requests[0].body.model, "search-model");
    assert.equal(remote.requests[0].headers.authorization, "Bearer test-sdk-key");
    assert.equal(faux.state.callCount, 2);
    assert.equal(routes, virtual ? 2 : 0); // Searching must reuse dispatch, not invoke the router again.
    await assert.rejects(access(join(dir, "pi-openai-search.json")), { code: "ENOENT" });
    await session.prompt("/openai-search status");
    const status = session.messages.findLast((message) => message.role === "custom" && message.customType === "openai-search-status");
    assert.ok(status.content.includes("sdk-search/search-model"));
    await session.prompt("/openai-search reset");
    assert.equal(remote.requests.length, 1);
    assert.equal(routes, virtual ? 2 : 0);
  });
}
