import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "pi-theme-commands-"));
const cwd = process.cwd();
const saved = Object.fromEntries(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
process.env.HOME = dir;
process.env.USERPROFILE = dir;
process.env.PI_CODING_AGENT_DIR = join(dir, ".pi", "agent");
process.chdir(dir);
after(() => {
  process.chdir(cwd);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});
assert.equal(homedir(), dir, "tests must not read or write real user settings");
const settingsPath = join(dir, ".pi", "settings.json");
mkdirSync(join(dir, ".pi"), { recursive: true });
writeFileSync(settingsPath, JSON.stringify({ ccTheme: "claude-code-dark", ccToolsExtraDetail: true, groupToolCalls: false, unrelated: "keep" }));
const jiti = createJiti(import.meta.url);
const { registerCommands, isExtraDetail, isGroupingEnabled } = await jiti.import("../extension/commands.ts");
const grouping = await jiti.import("../extension/tools/grouping.js");

test("Alt+O remains available to Trellis; theme detail shortcut and command still work", async () => {
  const shortcuts = new Map([["alt+o", { description: "Trellis" }]]);
  const commands = new Map();
  const handlers = new Map();
  registerCommands({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) {
      assert(!shortcuts.has(key), `shortcut conflict: ${key}`);
      shortcuts.set(key, shortcut);
    },
  });
  assert.equal(isExtraDetail(), true);
  assert.equal(isGroupingEnabled(), false);
  assert.equal(grouping.isGroupingEnabled(), false);
  assert.equal(shortcuts.get("alt+o").description, "Trellis");
  assert(shortcuts.has("ctrl+shift+o"));
  const notices = [];
  const ctx = { hasUI: true, ui: { notify: text => notices.push(text) } };
  assert.deepEqual([...commands.keys()], ["cafe-theme-tools", "cafe-theme", "cafe-theme-spinner"]);
  const tools = commands.get("cafe-theme-tools");
  await tools.handler("status", ctx);
  assert(!notices.at(-1).includes("alt+o"));
  assert(notices.at(-1).includes("/cafe-theme-tools detail toggle"));
  const initial = isExtraDetail();
  await shortcuts.get("ctrl+shift+o").handler(ctx);
  assert.equal(isExtraDetail(), !initial);
  await tools.handler("detail toggle", ctx);
  assert.equal(isExtraDetail(), initial);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    "cafe-theme": "cafe-theme-dark", "cafe-theme-tools-extra-detail": initial,
    "cafe-theme-tools-group": false, unrelated: "keep",
  });
  await tools.handler("group on", ctx);
  assert.equal(grouping.isGroupingEnabled(), true);
  await tools.handler("group off", ctx);
  assert.equal(grouping.isGroupingEnabled(), false);
  let applied;
  await handlers.get("session_start")({}, { hasUI: true, ui: { theme: { name: "dark" }, setTheme: name => { applied = name; } } });
  assert.equal(applied, "cafe-theme-dark");
  const themes = ["dark", "light", "dark-ansi", "light-ansi", "dark-daltonized", "light-daltonized"].map(suffix => `cafe-theme-${suffix}`);
  await commands.get("cafe-theme").handler("", { hasUI: true, ui: {
    theme: { name: "claude-code-dark" },
    select: async (title, options) => {
      assert(!/claude/i.test(title));
      assert.deepEqual(options, themes);
      return "cafe-theme-light";
    },
    setTheme: name => { applied = name; return { success: true }; },
    notify: text => notices.push(text),
  } });
  assert.equal(applied, "cafe-theme-light");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8"))["cafe-theme"], "cafe-theme-light");
  await commands.get("cafe-theme-spinner").handler("", ctx);
  for (const command of commands.values()) assert(!/claude/i.test(command.description));
  assert(notices.every(text => !/claude/i.test(text)));
  for (const invalid of ["{broken", "[]", "null"]) {
    writeFileSync(settingsPath, invalid);
    await assert.rejects(tools.handler("detail on", ctx));
    assert.equal(readFileSync(settingsPath, "utf8"), invalid, "invalid settings must never be overwritten");
  }
});
