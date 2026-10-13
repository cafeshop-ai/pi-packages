import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { classify as classifyDecisions } from "@earendil-works/pi-ai/api/openai-decisions";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-router-test-"));
const configPath = join(agentDir, "pi-auto-router.json");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const user = (content) => ({ role: "user", content });
const physical = (id) => ({ model: { provider: "cafe", id } });
const request = { reason: "user", thinkingLevel: "medium", messages: [user("task")] };

function setup({ classification = "medium", stopReason = "stop", config, classifierInput = ["text"] } = {}) {
  let router;
  const statuses = [];
  const routes = [];
  const calls = [];
  const classifierLookups = [];
  if (config === undefined) rmSync(configPath, { force: true });
  else writeFileSync(configPath, JSON.stringify(config));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    register({
      registerVirtualModel: (definition) => { router = definition; },
      on: () => {},
      events: { emit: (channel, route) => routes.push({ channel, ...route }) },
    });
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
  const ctx = {
    ui: { setWorkingMessage: (value) => statuses.push(value) },
    modelRegistry: {
      find: (provider, id) => ({ provider, id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
      findOfType: (type, provider, id) => {
        classifierLookups.push({ type, provider, id });
        return { provider, id, input: classifierInput };
      },
      classify: async (model, input, options) => {
        calls.push({ model, input, options });
        return {
          stopReason,
          answers: { complexity: { type: "choice", choice: classification } },
        };
      },
    },
  };
  return { router, ctx, statuses, routes, calls, classifierLookups };
}

test("configuration merges only supplied fields without mutating defaults", () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  const config = parseConfig({
    classifier: { model: " custom-classifier " },
    routes: { high: { provider: "other", model: "family/model", thinkingLevel: "minimal" } },
    instructions: " Use prompt and recentMessages. ",
    criteria: { high: "New high criterion" },
  });
  assert.deepEqual(config.classifier, { provider: "typesafe", model: "custom-classifier" });
  assert.deepEqual(config.routes.high, { provider: "other", model: "family/model", thinkingLevel: "minimal" });
  assert.deepEqual(config.routes.medium, DEFAULT_CONFIG.routes.medium);
  assert.equal(config.instructions, "Use prompt and recentMessages.");
  assert.equal(config.criteria.high, "New high criterion");
  assert.equal(config.criteria.low, DEFAULT_CONFIG.criteria.low);
  config.routes.medium.model = "changed";
  assert.equal(DEFAULT_CONFIG.routes.medium.model, "gpt-6.1-sol");
});

test("README configuration examples pass the same loader validation", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const examples = [...readme.matchAll(/```json\s+([\s\S]*?)```/g)];
  assert.equal(examples.length, 3);
  for (const [, json] of examples) assert.doesNotThrow(() => parseConfig(JSON.parse(json)));
});

test("configuration rejects malformed shapes, typos, blank strings, invalid effort and self-routing", () => {
  for (const [config, message] of [
    [null, /config must be an object/], [[], /config must be an object/],
    [{ route: {} }, /Unknown field config.route/],
    [{ classifier: [] }, /classifier must be an object/],
    [{ classifier: { model: 42 } }, /classifier.model/],
    [{ classifier: { provider: " " } }, /classifier.provider/],
    [{ classifier: { includeImages: true } }, /Unknown field classifier.includeImages/],
    [{ classifier: { apiKey: "not-supported" } }, /Unknown field classifier.apiKey/],
    [{ routes: null }, /routes must be an object/],
    [{ routes: { high: null } }, /routes.high must be an object/],
    [{ routes: { highest: {} } }, /Unknown field routes.highest/],
    [{ routes: { high: { model: false } } }, /routes.high.model/],
    [{ routes: { high: { thinkingLevel: "extreme" } } }, /routes.high.thinkingLevel/],
    [{ routes: { high: { provider: "router", model: "auto" } } }, /physical model/],
    [{ instructions: " " }, /instructions/],
    [{ criteria: { high: {} } }, /criteria.high/],
    [{ criteria: { custom: "unsupported tier" } }, /Unknown field criteria.custom/],
    [JSON.parse('{"__proto__": {"polluted": true}}'), /Unknown field config.__proto__/],
  ]) assert.throws(() => parseConfig(config), message);
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(parseConfig({ routes: { low: { thinkingLevel } } }).routes.low.thinkingLevel, thinkingLevel);
  }
  assert.throws(() => setup({ config: { routes: { high: { thinkingLevel: "bad" } } } }), /pi-auto-router.json.*routes.high.thinkingLevel/);
});

test("config file loading handles missing files and BOM but reports invalid JSON and read errors", () => {
  rmSync(configPath, { force: true });
  assert.deepEqual(loadConfig(configPath), DEFAULT_CONFIG);
  writeFileSync(configPath, '\uFEFF{"routes":{"low":{"thinkingLevel":"off"}}}');
  assert.equal(loadConfig(configPath).routes.low.thinkingLevel, "off");
  writeFileSync(configPath, "{broken");
  assert.throws(() => loadConfig(configPath), /pi-auto-router.json/);
  assert.throws(() => loadConfig(agentDir), /pi-auto-router/);
});

test("custom classifier, rubric and per-tier provider/model/effort reach the real routing boundary", async () => {
  const config = {
    classifier: { provider: "custom-classifier", model: "decision-v2" },
    instructions: "根据 prompt 和 recentMessages 判定工作性质。",
    criteria: { high: "架构方案", medium: "常规实现", low: "机械替换" },
    routes: {
      high: { provider: "provider-a", model: "same-id", thinkingLevel: "minimal" },
      medium: { provider: "provider-b", model: "same-id", thinkingLevel: "off" },
      low: { provider: "provider-c", model: "family/small", thinkingLevel: "low" },
    },
  };
  for (const classification of ["high", "medium", "low"]) {
    const s = setup({ config, classification });
    const result = await s.router.route(request, s.ctx);
    assert.deepEqual(result.state, config.routes[classification]);
    assert.deepEqual(s.classifierLookups, [{ type: "classifier", provider: "custom-classifier", id: "decision-v2" }]);
    assert.deepEqual(s.calls[0].model, { provider: "custom-classifier", id: "decision-v2", input: ["text"] });
    assert.deepEqual(s.calls[0].input.questions.complexity, { type: "choice", instructions: config.instructions, criteria: config.criteria });
    assert.deepEqual(s.routes.at(-1), { channel: "pi-auto-router:route", ...config.routes[classification] });
    const retried = await s.router.route({
      ...request, reason: "retry", state: config.routes.medium,
      failed: { model: result.model, thinkingLevel: result.thinkingLevel },
    }, s.ctx);
    assert.equal(retried.model.provider, config.routes[classification].provider, "match provider as well as ID");
    assert.equal(s.calls.length, 1);
  }
  const s = setup({ config, stopReason: "error" });
  const fallback = await s.router.route(request, s.ctx);
  assert.deepEqual(fallback.state, config.routes.medium);
  s.ctx.modelRegistry.findOfType = () => undefined;
  assert.deepEqual((await s.router.route(request, s.ctx)).state, config.routes.medium);
  const direct = await s.router.route({ ...request, reason: "direct" }, s.ctx);
  assert.equal(direct.model.provider, "provider-c");
  assert.equal(direct.model.id, "family/small");
  assert.equal(direct.thinkingLevel, "low");
  assert.equal(direct.state, undefined);
  assert.equal(s.routes.length, 2, "direct requests do not publish a route");
});

const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=" };

test("Pi 1.1 catalog distinguishes Luna image classification from text-only Jev", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  const luna = registry.findOfType("classifier", "openai", "gpt-6-luna");
  assert.equal(luna.api, "openai-decisions");
  assert.deepEqual(luna.input, ["text", "image"]);
  assert.deepEqual(registry.findOfType("classifier", "typesafe", "jev-latest").input, ["text"]);
});

test("registers the provider-neutral router/auto identity", () => {
  const s = setup();
  assert.equal(s.router.provider, "router");
  assert.equal(s.router.id, "auto");
  assert.equal(s.router.name, "Auto Router");
});

test("only image-capable classifiers receive current user attachments", async () => {
  for (const supportsImages of [false, true]) {
    for (const withText of [false, true]) {
      const s = setup({ classification: "high", classifierInput: supportsImages ? ["text", "image"] : ["text"] });
      const content = [...(withText ? [{ type: "text", text: "Review this" }] : []), png];
      const result = await s.router.route({ ...request, messages: [
        user([{ type: "text", text: "Old task" }, { ...png, data: "old-user-image" }]),
        { role: "assistant", content: [{ type: "text", text: "Old reply" }, { type: "thinking", thinking: "private" }] },
        { role: "toolResult", content: [{ ...png, data: "tool-image" }] },
        user(content),
        { role: "assistant", content: [{ type: "text", text: "after-current-user" }] },
      ] }, s.ctx);
      if (supportsImages || withText) {
        assert.equal(s.calls.length, 1);
        assert.deepEqual(s.calls[0].input.images, supportsImages ? [png] : undefined);
        assert.deepEqual(s.calls[0].input.state, {
          prompt: withText ? "Review this" : "",
          recentMessages: [{ role: "user", content: "Old task" }, { role: "assistant", content: "Old reply" }],
        });
        assert.equal(result.model.id, "gpt-6-astra");
      } else {
        assert.equal(s.calls.length, 0, "image-only input falls back for text-only classifiers");
        assert.equal(result.model.id, "gpt-6.1-sol");
      }
    }
  }
});

test("image upload bounds fall back without sending a partial image set", async () => {
  for (const [images, allowed] of [
    [Array(4).fill(png), true], [Array(5).fill(png), false],
    [[{ ...png, data: "A".repeat(8 * 1024 * 1024) }], true],
    [[{ ...png, data: "A".repeat(8 * 1024 * 1024) }, png], false],
  ]) {
    const s = setup({ classification: "low", classifierInput: ["text", "image"], config: {
      routes: { medium: { provider: "other", model: "fallback" } },
    } });
    const result = await s.router.route({ ...request, messages: [user([{ type: "text", text: "Task" }, ...images])] }, s.ctx);
    assert.equal(s.calls.length, allowed ? 1 : 0);
    assert.equal(result.model.id, allowed ? "gpt-6-luna" : "fallback");
  }
});

test("image classification errors fall back and cancellation publishes no route", async () => {
  const messages = [user([png])];
  for (const stopReason of ["error", "aborted"]) {
    const s = setup({ classification: "high", stopReason, classifierInput: ["text", "image"] });
    if (stopReason === "aborted") {
      await assert.rejects(s.router.route({ ...request, messages }, s.ctx), { name: "AbortError" });
      assert.deepEqual(s.routes, []);
      assert.deepEqual(s.statuses, []);
    } else {
      assert.equal((await s.router.route({ ...request, messages }, s.ctx)).model.id, "gpt-6.1-sol");
    }
    assert.deepEqual(s.calls[0].input.images, [png]);
  }
  const s = setup({ classifierInput: ["text", "image"] });
  const controller = new AbortController();
  const classify = s.ctx.modelRegistry.classify;
  s.ctx.modelRegistry.classify = async (...args) => {
    const result = await classify(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(s.router.route({ ...request, messages, signal: controller.signal }, s.ctx), { name: "AbortError" });
  assert.deepEqual(s.routes, []);
});

test("Pi 1.1 Decisions adapter accepts the router's text, image and mixed inputs", async () => {
  for (const content of ["Review the code", [png], [{ type: "text", text: "Review the screenshot" }, png]]) {
    const s = setup({
      config: { classifier: { provider: "openai", model: "gpt-6-luna" } },
      classifierInput: ["text", "image"],
    });
    let wire;
    s.ctx.modelRegistry.classify = async (model, input, options) => {
      assert.equal(model.provider, "openai");
      assert.equal(model.id, "gpt-6-luna");
      assert.equal(options.timeoutMs, 5000);
      assert.equal(options.maxRetries, 0);
      return classifyDecisions({ ...model, api: "openai-decisions", baseUrl: "https://example.invalid/v1/" }, input, {
        ...options, apiKey: "test-only",
        fetch: async (url, init) => {
          assert.equal(String(url), "https://example.invalid/v1/decisions");
          wire = JSON.parse(init.body);
          return new Response(JSON.stringify({ answers: [{
            name: "complexity", type: "choice", choice: "high", confidence: 1,
            probabilities: [{ value: "high", probability: 1 }, { value: "medium", probability: 0 }, { value: "low", probability: 0 }],
          }] }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
      });
    };
    const result = await s.router.route({ ...request, messages: [user(content)] }, s.ctx);
    assert.equal(result.model.id, "gpt-6-astra");
    assert.equal(wire.model, "gpt-6-luna");
    assert.deepEqual(wire.questions[0], {
      name: "complexity", type: "choice", instructions: DEFAULT_CONFIG.instructions,
      choices: Object.entries(DEFAULT_CONFIG.criteria).map(([value, description]) => ({ value, description })),
    });
    if (typeof content === "string") {
      assert.deepEqual(JSON.parse(wire.input), { prompt: content, recentMessages: [] });
    } else {
      assert.equal(wire.input[0].role, "user");
      assert.deepEqual(JSON.parse(wire.input[0].content[0].text), {
        prompt: content.length === 1 ? "" : "Review the screenshot", recentMessages: [],
      });
      assert.deepEqual(wire.input[0].content[1], { type: "input_image", image_url: `data:image/png;base64,${png.data}` });
    }
  }
});

test("shared models retain the chosen tier's effort across continuations, retries and reloads", async () => {
  const routes = Object.fromEntries([ ["high", "xhigh"], ["medium", "high"], ["low", "off"] ].map(
    ([tier, thinkingLevel]) => [tier, { provider: "other", model: "shared", thinkingLevel }],
  ));
  for (const classification of ["high", "medium", "low"]) {
    const s = setup({ config: { routes }, classification });
    const first = await s.router.route(request, s.ctx);
    const response = { model: first.model, thinkingLevel: first.thinkingLevel };
    for (const overrides of [
      { reason: "continuation", state: first.state },
      { reason: "retry", failed: response, state: routes.medium },
      { reason: "continuation", previous: response },
    ]) {
      const next = await s.router.route({ ...request, ...overrides }, s.ctx);
      assert.equal(next.model.provider, "other");
      assert.equal(next.thinkingLevel, routes[classification].thinkingLevel);
    }
    assert.equal(s.calls.length, 1);
    const reloaded = setup({ classification: "medium" });
    for (const reason of ["continuation", "retry"]) {
      const resumed = await reloaded.router.route({ ...request, reason, state: first.state, failed: response }, reloaded.ctx);
      assert.equal(resumed.model.provider, "other", "saved turn survives a config change");
      assert.equal(resumed.thinkingLevel, first.thinkingLevel);
      assert.equal(resumed.state, undefined);
    }
    const fresh = await reloaded.router.route({ ...request, state: first.state }, reloaded.ctx);
    assert.deepEqual(fresh.state, DEFAULT_CONFIG.routes.medium, "new turns use the reloaded configuration");
  }
});

test("unknown or virtual target models fail explicitly without publishing misleading UI", async () => {
  for (const model of [undefined, { api: "pi-virtual" }]) {
    const s = setup({ config: { routes: { medium: { provider: "custom", model: "missing" } } } });
    s.ctx.modelRegistry.find = () => model;
    await assert.rejects(s.router.route(request, s.ctx), /custom\/missing/);
    assert.deepEqual(s.routes, []);
    assert.deepEqual(s.statuses, []);
  }
});

test("classifies difficulty and maps model to thinking level", async () => {
  for (const [classification, model, thinkingLevel] of [
    ["high", "gpt-6-astra", "xhigh"],
    ["medium", "gpt-6.1-sol", "high"],
    ["low", "gpt-6-luna", "max"],
  ]) {
    const s = setup({ classification });
    const result = await s.router.route(request, s.ctx);
    assert.equal(result.model.id, model);
    assert.equal(result.thinkingLevel, thinkingLevel);
    assert.deepEqual(result.state, { provider: "cafe", model, thinkingLevel });
    assert.equal(s.calls.length, 1);
  }
});

test("classification rubric prioritizes discovery and design for Astra, ordinary work for Sol, and mechanical work for Luna", async () => {
  const s = setup();
  await s.router.route(request, s.ctx);
  const { instructions, criteria } = s.calls[0].input.questions.complexity;
  assert.match(instructions, /borderline between low and medium.*choose medium/);
  assert.match(criteria.medium, /default for ordinary work/);
  for (const task of ["routine debugging", "technical explanations", "configuration changes"]) {
    assert.ok(criteria.medium.includes(task), task);
  }
  assert.match(criteria.low, /Fully specified mechanical work/);
  assert.match(criteria.low, /approved routine commit\/push/);
  assert.match(instructions, /routine, explicitly approved commit\/push of completed work as low/);
  assert.match(instructions, /do not inherit the tier of the work being committed/);
  assert.match(criteria.low, /approved routine commit\/push of completed, scoped changes/);
  assert.match(criteria.low, /regardless of their complexity/);
  assert.match(criteria.low, /No conflict resolution, scope selection, security review or error diagnosis/);
  assert.match(instructions, /Evaluate high first/);
  assert.match(instructions, /user-configurable.*configuration-mechanism design/);
  for (const task of ["new user requirements", "underspecified request", "new/unfamiliar project", "goals, scope, workflows or constraints"]) {
    assert.ok(instructions.includes(task), task);
    assert.ok(criteria.high.includes(task), task);
  }
  assert.ok(criteria.high.includes("requirements/project discovery without a design yet"));
  assert.ok(criteria.medium.includes("Requirements/project discovery is high, not medium"));
  assert.match(instructions, /minor missing detail.*latter alone does not justify high/);
  assert.match(instructions, /routine file lookup does not itself mean discovery/);
  assert.match(instructions, /requirements and the solution are specified, bounded implementation remains medium/);
  assert.doesNotMatch(instructions, /an unclear scope alone does not justify high/);
  for (const task of ["feature design", "architecture reviews", "trade-offs", "configuration mechanisms", "security-sensitive work"]) {
    assert.ok(criteria.high.includes(task), task);
  }
  assert.match(instructions, /review-only follow-up.*high, even for a small change/);
  assert.match(criteria.high, /All code reviews.*including small diffs/);
  assert.match(criteria.medium, /Code review is always high, not medium/);
  assert.doesNotMatch(criteria.medium, /ordinary code reviews/);
  assert.match(criteria.medium, /already-specified bounded feature/);
  assert.match(criteria.medium, /configuration mechanism.*high, not medium/);
});

test("new user messages reclassify despite persisted state or the previous physical model", async () => {
  for (const [classification, oldModel, model] of [
    ["high", "gpt-6-luna", "gpt-6-astra"],
    ["low", "gpt-6-astra", "gpt-6-luna"],
  ]) {
    for (const state of [undefined, Object.values(DEFAULT_CONFIG.routes).find((r) => r.model === oldModel)]) {
      const s = setup({ classification });
      const result = await s.router.route({ ...request, state, previous: physical(oldModel) }, s.ctx);
      assert.equal(result.model.id, model);
      assert.deepEqual(result.state, DEFAULT_CONFIG.routes[classification]);
      assert.equal(s.calls.length, 1);
    }
  }
});

test("successful file edits keep the current model without reclassification or duplicate state", async () => {
  for (const toolName of ["edit", "write", "powershell", "codemode"]) {
    for (const state of [DEFAULT_CONFIG.routes.high]) {
      const s = setup({ classification: "low" });
      const result = await s.router.route({
        ...request, reason: "continuation", state,
        previous: physical("gpt-6-luna"),
        messages: [user("task"), { role: "toolResult", toolName, isError: false }],
      }, s.ctx);
      assert.equal(result.model.id, "gpt-6-astra");
      assert.equal(result.thinkingLevel, "xhigh");
      assert.equal(result.state, undefined, "Pi retains the existing state without duplicate entries");
      assert.equal(s.calls.length, 0);
    }
  }
});

test("retries prefer the failed model; follow-ups recover from state or previous responses", async () => {
  for (const [overrides, expected] of [
    [{ reason: "retry", failed: physical("gpt-6-astra"), state: DEFAULT_CONFIG.routes.low, previous: physical("gpt-6.1-sol") }, "gpt-6-astra"],
    [{ reason: "retry", state: DEFAULT_CONFIG.routes.high, previous: physical("gpt-6-luna") }, "gpt-6-astra"],
    [{ reason: "retry", failed: physical("gpt-6-astra"), previous: physical("gpt-6-luna") }, "gpt-6-astra"],
    [{ reason: "continuation", previous: physical("gpt-6.1-sol") }, "gpt-6.1-sol"],
  ]) {
    const s = setup({ classification: "low" });
    const result = await s.router.route({ ...request, ...overrides }, s.ctx);
    assert.equal(result.model.id, expected);
    assert.equal((result.state ?? overrides.state).model, expected);
    assert.equal(s.calls.length, 0);
  }
  const s = setup({ classification: "high" });
  const result = await s.router.route({ ...request, reason: "continuation" }, s.ctx);
  assert.equal(result.model.id, "gpt-6-astra");
  assert.equal(s.calls.length, 1, "classify when there is no recoverable route");
});

test("falls back to Sol for an unavailable classifier, errors, invalid choices or missing user text", async () => {
  for (const failure of ["missing", "error", "invalid", "empty", "image-only"]) {
    const s = setup({ classification: failure === "invalid" ? "unknown" : "high", stopReason: failure === "error" ? "error" : "stop" });
    if (failure === "missing") s.ctx.modelRegistry.findOfType = () => undefined;
    const messages = failure === "empty" ? []
      : failure === "image-only" ? [user([{ type: "image", data: "not-sent", mimeType: "image/png" }])]
      : request.messages;
    const result = await s.router.route({ ...request, messages }, s.ctx);
    assert.equal(result.model.id, "gpt-6.1-sol", failure);
    assert.equal(result.thinkingLevel, "high");
    assert.equal(s.calls.length, ["error", "invalid"].includes(failure) ? 1 : 0);
  }
});

test("classifier sees recent dialogue but not system prompts, tool output, images or thinking", async () => {
  const s = setup();
  await s.router.route({ ...request, messages: [
    { role: "system", content: "system-secret" },
    user("请重构整个权限系统"),
    { role: "assistant", content: [
      { type: "thinking", thinking: "private-reasoning" },
      { type: "text", text: "方案：先审计权限边界，再分阶段迁移。" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "private-file" } },
    ] },
    { role: "toolResult", content: [{ type: "text", text: "tool-secret" }] },
    user([{ type: "text", text: "好" }, { type: "image", data: "image-secret" }, { type: "text", text: "按上面方案实现" }]),
    { role: "assistant", content: [{ type: "text", text: "after-current-user" }] },
  ] }, s.ctx);
  assert.deepEqual(s.calls[0].input.state, {
    prompt: "好\n按上面方案实现",
    recentMessages: [
      { role: "user", content: "请重构整个权限系统" },
      { role: "assistant", content: "方案：先审计权限边界，再分阶段迁移。" },
    ],
  });
  assert.match(s.calls[0].input.questions.complexity.instructions, /recentMessages/);
});

test("classification text is bounded to 16000 prompt chars plus four 2000-char prior messages", async () => {
  const s = setup();
  const history = Array.from({ length: 8 }, (_, i) => user(String(i).repeat(3000)));
  const toolOnly = Array.from({ length: 8 }, () => ({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }));
  await s.router.route({ ...request, messages: [...history, ...toolOnly, user("p".repeat(20000))] }, s.ctx);
  const { prompt, recentMessages } = s.calls[0].input.state;
  assert.equal(prompt, "p".repeat(16000));
  assert.deepEqual(recentMessages, history.slice(-4).map((m) => ({ ...m, content: m.content.slice(-2000) })));
  assert.equal(prompt.length + recentMessages.reduce((sum, m) => sum + m.content.length, 0), 24000);
});

test("cancellation does not choose a fallback or publish a route", async () => {
  for (const timing of ["before", "during", "result"]) {
    const controller = new AbortController();
    const s = setup({ stopReason: timing === "result" ? "aborted" : "stop" });
    if (timing === "before") controller.abort();
    if (timing === "during") {
      const classify = s.ctx.modelRegistry.classify;
      s.ctx.modelRegistry.classify = async (...args) => {
        const result = await classify(...args);
        controller.abort();
        return result;
      };
    }
    await assert.rejects(s.router.route({ ...request, signal: controller.signal }, s.ctx), { name: "AbortError" });
    assert.equal(s.calls.length, timing === "before" ? 0 : 1);
    if (s.calls.length) assert.equal(s.calls[0].options.signal, controller.signal);
    assert.deepEqual(s.routes, []);
    assert.deepEqual(s.statuses, []);
  }
});

test("cancellation during a fast fallback does not publish a route", async () => {
  for (const missingClassifier of [true, false]) {
    const s = setup();
    if (missingClassifier) s.ctx.modelRegistry.findOfType = () => undefined;
    const controller = new AbortController();
    const pending = s.router.route({
      ...request, messages: missingClassifier ? request.messages : [], signal: controller.signal,
    }, s.ctx);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.routes, []);
    assert.deepEqual(s.statuses, []);
  }
});

test("SDK classification timeout falls back to Sol without retries or cancelling the user", async (t) => {
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    deadlines.push(ms);
    return AbortSignal.abort(new DOMException("Test deadline", "TimeoutError"));
  });
  const s = setup({ classification: "high" });
  const controller = new AbortController();
  let fetches = 0;
  let receivedOptions;
  let sdkResult;
  s.ctx.modelRegistry.classify = async (_model, input, options) => {
    receivedOptions = options;
    sdkResult = await classify({
      provider: "typesafe", id: "jev-latest", api: "typesafe-system-one", baseUrl: "https://example.invalid/v1/",
    }, input, {
      ...options, apiKey: "test-only",
      fetch: async (_url, { signal }) => {
        fetches++;
        assert.equal(signal?.aborted, true);
        throw signal.reason;
      },
    });
    return sdkResult;
  };
  const result = await s.router.route({ ...request, signal: controller.signal }, s.ctx);
  assert.deepEqual(deadlines, [5000]);
  assert.equal(receivedOptions.maxRetries, 0);
  assert.equal(fetches, 1);
  assert.equal(sdkResult.stopReason, "error");
  assert.match(sdkResult.errorMessage, /timed out/i);
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.model.id, "gpt-6.1-sol");
});

test("route events and native UI match the real Pi runtime's clamped effort", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const cases = [
    ["gpt-6-astra", false, {}, "off"],
    ["gpt-6.1-sol", true, { high: null, xhigh: "xhigh" }, "xhigh"],
    ["gpt-6-luna", true, { max: null, xhigh: null }, "high"],
  ];
  runtime.registerProvider("cafe", {
    baseUrl: "https://example.invalid/v1/", api: "openai-responses", apiKey: "test-only",
    models: cases.map(([id, reasoning, thinkingLevelMap]) => ({
      id, name: id, reasoning, thinkingLevelMap, input: ["text"], contextWindow: 272000, maxTokens: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  const s = setup();
  s.ctx.modelRegistry = new ModelRegistry(runtime);
  runtime.registerVirtualModel({ ...s.router, route: (r) => s.router.route(r, s.ctx) });
  for (const [model, , , effort] of cases) {
    const result = await runtime.resolveModel(runtime.getModel("router", "auto"), request.messages, {
      reason: "continuation", thinkingLevel: "high", state: Object.values(DEFAULT_CONFIG.routes).find((r) => r.model === model),
    });
    assert.equal(result.thinkingLevel, effort);
    assert.equal(s.routes.at(-1).thinkingLevel, effort);
    assert.equal(s.statuses.at(-1), `Thinking with ${effort} effort · cafe/${model}`);
  }
});

test("notifies custom spinners, retains the native fallback and isolates direct requests", async () => {
  const s = setup({ classification: "high" });
  await s.router.route(request, s.ctx);
  assert.deepEqual(s.routes.at(-1), {
    channel: "pi-auto-router:route", provider: "cafe", model: "gpt-6-astra", thinkingLevel: "xhigh",
  });
  assert.equal(s.statuses.at(-1), "Thinking with xhigh effort · cafe/gpt-6-astra");
  const direct = await s.router.route({ reason: "direct", thinkingLevel: "high", state: DEFAULT_CONFIG.routes.high }, s.ctx);
  assert.equal(direct.model.id, "gpt-6-luna");
  assert.equal(direct.thinkingLevel, "max");
  assert.equal(direct.state, undefined);
  assert.equal(s.calls.length, 1);
  assert.equal(s.routes.length, 1, "compaction/side requests must not replace the main route display");
  assert.equal(s.statuses.length, 1);
});
