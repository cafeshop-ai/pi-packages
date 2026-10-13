import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const text = path => readFileSync(join(root, path), 'utf8');
test('shadcn Base Nova and Tailwind use the existing Cafe tokens without direct Radix imports', () => {
  const config = JSON.parse(text('components.json'));
  assert.equal(config.style, 'base-nova'); assert.equal(config.tailwind.css, 'web/src/styles/tailwind.css');
  assert.match(text('web/vite.config.ts'), /tailwindcss\(\)/);
  assert.match(text(config.tailwind.css), /--primary: var\(--cafe-action\)/);
  assert.match(text(config.tailwind.css), /--background: var\(--cafe-page\)/);
  const visit = dir => { for (const file of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${file.name}`;
    if (file.isDirectory()) visit(path);
    else if (file.name.endsWith('.tsx')) assert.doesNotMatch(text(path), /from ['"](?:@radix-ui\/|radix-ui|cn['"])/, path);
  } };
  visit('web/src');
  assert.match(text('web/src/components/ui/ChoiceSelect.tsx'), /SelectGroup/);
});
test('CSP uses the supported Base UI opt-out and external scrollbar CSS; no CSP relaxation', () => {
  assert.match(text('web/src/components/ui/UiProvider.tsx'), /<CSPProvider disableStyleElements>/);
  assert.match(text('web/src/styles/tailwind.css'), /\.base-ui-disable-scrollbar\s*\{ scrollbar-width: none; \}/);
  assert.match(text('web/src/styles/tailwind.css'), /\.base-ui-disable-scrollbar::-webkit-scrollbar\s*\{ display: none; \}/);
  assert.match(text('web/src/components/ui/shadcn/LICENSE'), /Copyright \(c\) 2023 shadcn/);
  assert.match(text('scripts/refactor/build.mjs'), /shadcn\/LICENSE/);
  assert.match(text('relay/internal/httpserver/server.go'), /style-src 'self'; script-src 'self';/);
});
