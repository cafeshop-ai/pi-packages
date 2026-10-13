import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-spinner-test-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { buildSpinnerLine, registerSpinner } = await jiti.import("../extension/spinner.ts");
const { default: registerRouter } = await jiti.import("../../pi-auto-router/src/index.ts");

const identity = (s) => s;
const paint = { accent: identity, shimmer: identity, dim: identity };

test("spinner keeps the routed model visible at wide and narrow widths", () => {
  const state = {
    verb: "Ebbing", timeMs: 135_000, tokens: 3900,
    thinkingStatus: "thinking", effortSuffix: " with high effort",
    modelLabel: "cafe/gpt-6.1-sol",
  };
  const wide = plain(buildSpinnerLine({ ...state, columns: 120 }, paint));
  assert.match(wide, /2m 15s · ↓ 3\.9k tokens · thinking with high effort · cafe\/gpt-6\.1-sol/);
  for (const columns of [40, 60, 80, 120]) {
    const line = plain(buildSpinnerLine({ ...state, columns }, paint));
    assert.ok(line.includes(state.modelLabel), line);
    assert.ok(visibleWidth(line) <= columns, line);
  }
  const tiny = plain(buildSpinnerLine({ ...state, columns: 24 }, paint));
  assert.ok(tiny.includes("…"));
  assert.ok(visibleWidth(tiny) <= 24, tiny);
});

test("theme repaint preserves auto route and effort in either extension load order", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 0 });
  for (const registrars of [[registerSpinner, registerRouter], [registerRouter, registerSpinner]]) {
    const bus = new EventEmitter();
    const handlers = new Map();
    let router;
    let workingMessage;
    let writes = 0;
    const pi = {
      on(name, handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      events: {
        emit: (name, data) => bus.emit(name, data),
        on: (name, handler) => { bus.on(name, handler); return () => bus.off(name, handler); },
      },
      registerVirtualModel: (definition) => { router = definition; },
    };
    const ctx = {
      hasUI: true, thinkingLevel: "high", model: { provider: "router", id: "auto" },
      ui: {
        theme: { name: "cafe-theme-dark", fg: (_token, text) => text },
        setWorkingMessage: (text) => { workingMessage = text; writes++; },
      },
      modelRegistry: { find: (provider, id) => ({ provider, id, reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }) },
    };
    const emit = async (name, event = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };
    for (const register of registrars) register(pi);
    try {
      await emit("agent_start");
      for (const [provider, model, effort] of [
        ["custom", "family/shared", "minimal"],
        ["cafe", "gpt-6-astra", "xhigh"], ["cafe", "gpt-6-luna", "max"], ["cafe", "gpt-6.1-sol", "high"],
      ]) {
        await router.route({
          reason: "continuation", thinkingLevel: "high", messages: [],
          state: { provider, model, thinkingLevel: effort },
        }, ctx);
        await emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
        // Several real spinner callbacks, not just the router's one-off UI write.
        const before = writes;
        t.mock.timers.tick(200);
        assert.ok(writes > before);
        assert.match(plain(workingMessage), /… \(/);
        assert.ok(plain(workingMessage).includes(`${provider}/${model}`), plain(workingMessage));
        assert.ok(plain(workingMessage).includes(`thinking with ${effort} effort`), plain(workingMessage));
      }
      await router.route({ reason: "direct", thinkingLevel: "high" }, ctx);
      t.mock.timers.tick(50);
      assert.ok(plain(workingMessage).includes("cafe/gpt-6.1-sol"), "direct request must not overwrite main route");
      await emit("model_select");
      t.mock.timers.tick(50);
      assert.ok(!plain(workingMessage).includes("cafe/"), "model switch must clear route");
      await emit("agent_settled");
      assert.equal(workingMessage, undefined);
      await emit("agent_start");
      assert.ok(!plain(workingMessage).includes("cafe/"), "new runs must not inherit a stale route");
    } finally {
      await emit("session_shutdown");
    }
    const before = writes;
    t.mock.timers.tick(250);
    assert.equal(writes, before, "reload/shutdown must stop the old repaint loop");
  }
});
