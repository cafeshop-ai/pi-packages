import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const dir = mkdtempSync(join(tmpdir(), "pi-cafe-theme-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url);
const { normalizeThemeSettings, normalizeThemeName } = await jiti.import("../extension/settings.ts");
const { resolvePalette, paletteKeyForThemeName, fgAnsi } = await jiti.import("../extension/palette.ts");
const { loadThemeFromPath, setThemeJsonValidator } = await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { validateThemeJson } = await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js");
setThemeJsonValidator(validateThemeJson);
const suffixes = ["dark", "light", "dark-ansi", "light-ansi", "dark-daltonized", "light-daltonized"];

test("legacy theme choices and keys migrate without changing unrelated settings", () => {
  const original = { ccTheme: "claude-code-dark", ccToolsExtraDetail: true, groupToolCalls: false,
    theme: "claude-code-light/claude-code-dark", defaultProvider: "custom", nested: { model: "claude-test" } };
  assert.deepEqual(normalizeThemeSettings(original), {
    "cafe-theme": "cafe-theme-dark", "cafe-theme-tools-extra-detail": true, "cafe-theme-tools-group": false,
    theme: "cafe-theme-light/cafe-theme-dark", defaultProvider: "custom", nested: original.nested,
  });
  assert.equal(original.ccTheme, "claude-code-dark");
  assert.deepEqual(normalizeThemeSettings({ ccTheme: "claude-code-dark", "cafe-theme": "cafe-theme-light",
    ccToolsExtraDetail: true, "cafe-theme-tools-extra-detail": false,
    groupToolCalls: true, "cafe-theme-tools-group": false }), {
    "cafe-theme": "cafe-theme-light", "cafe-theme-tools-extra-detail": false, "cafe-theme-tools-group": false,
  });
  for (const suffix of suffixes) assert.equal(normalizeThemeName(`claude-code-${suffix}`), `cafe-theme-${suffix}`);
  for (const name of ["dark", "light", "system", "unrelated-theme", "claude-code-unknown"]) assert.equal(normalizeThemeName(name), name);
  for (const value of [null, [], "invalid"]) assert.throws(() => normalizeThemeSettings(value));
});

test("all six branded themes validate and resolve to their unchanged palettes", () => {
  const themeDir = fileURLToPath(new URL("../theme/", import.meta.url));
  assert.deepEqual(readdirSync(themeDir).sort(), suffixes.map(suffix => `cafe-theme-${suffix}.json`).sort());
  for (const suffix of suffixes) {
    const path = join(themeDir, `cafe-theme-${suffix}.json`);
    const text = readFileSync(path, "utf8");
    assert(!/claude/i.test(text));
    const json = JSON.parse(text);
    assert.equal(json.name, `cafe-theme-${suffix}`);
    const theme = loadThemeFromPath(path, "truecolor");
    assert.equal(theme.name, json.name);
    assert.equal(paletteKeyForThemeName(theme.name), suffix);
    const palette = resolvePalette(theme.name, token => theme.getFgAnsi(token));
    assert.equal(palette.cc.brand, json.vars.brand);
    assert.equal(palette.cc.brandShimmer, json.vars.brandShimmer);
    assert.equal(palette.scheme, suffix.startsWith("light") ? "light" : "dark");
    assert.equal(theme.getFgAnsi("borderAccent"), typeof palette.cc.brand === "number"
      ? `\x1b[38;5;${palette.cc.brand}m` : fgAnsi(palette.cc.brand));
  }
  for (const name of ["dark", "light", "cafe-theme-constructor", "cafe-theme-toString", "other-theme"]) assert.equal(paletteKeyForThemeName(name), undefined);
});
