import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const { registerStatusLine } = await createJiti(import.meta.url).import("../extension/status-line.ts");

async function setup(mode = "tui") {
  const handlers = new Map();
  const statuses = new Map();
  let footer;
  let branchChanged;
  let renders = 0;
  let disposed = false;
  const ctx = {
    mode, cwd: "C:/project", model: { id: "test-model", contextWindow: 1000 },
    sessionManager: { getBranch: () => [] },
    getContextUsage: () => ({ tokens: 0 }),
    ui: { setFooter(factory) {
      footer = factory({ requestRender: () => renders++ }, { fg: (_token, text) => text }, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => statuses,
        onBranchChange(callback) { branchChanged = callback; return () => { disposed = true; }; },
      });
    } },
  };
  registerStatusLine({ on(name, handler) { handlers.set(name, handler); } });
  await handlers.get("session_start")({}, ctx);
  return { footer, statuses, branchChanged, renders: () => renders, disposed: () => disposed };
}

test("footer stays compact when extension statuses change or clear", async () => {
  const f = await setup();
  const baseline = f.footer.render(120);
  assert.equal(baseline.length, 1);
  assert.match(baseline[0], /test-model · C:\/project · ⎇ main/);
  f.statuses.set("pi-collab", "café space: connected · /cafe 分享");
  assert.deepEqual(f.footer.render(120), baseline);
  f.statuses.set("pi-collab", "café space: reconnecting · /cafe 分享");
  f.statuses.set("i-have-adhd", "● ADHD ON");
  assert.deepEqual(f.footer.render(120), baseline);
  f.statuses.delete("pi-collab");
  assert.deepEqual(f.footer.render(120), baseline);
  f.branchChanged();
  assert.equal(f.renders(), 1);
  f.footer.dispose();
  assert.equal(f.disposed(), true);
});

test("hidden extension statuses add no spacer and the footer fits narrow widths", async () => {
  const f = await setup();
  f.statuses.set("pi-collab", "café space: connected · /cafe 分享");
  f.statuses.set("other", "other\n extension\t ready\r");
  for (const width of [1, 12, 40, 80, 120]) {
    const lines = f.footer.render(width);
    assert.equal(lines.length, 1);
    assert(visibleWidth(lines[0]) <= width);
    assert(!/[\r\n\t]/.test(lines[0]));
  }
});

test("non-TUI modes do not install a custom terminal footer", async () => {
  for (const mode of ["rpc", "json", "print"]) assert.equal((await setup(mode)).footer, undefined);
});
