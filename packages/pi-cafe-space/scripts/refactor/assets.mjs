import { createHash } from 'node:crypto';
import { lstat, realpath, readdir, open, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, parse, join, dirname, sep } from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_FILES = 256;
export const MANIFEST = 'asset-manifest.json';
export const FORMAT = 'pi-cafe-space-assets-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
const hashName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*-[a-zA-Z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2)$/;
const allowed = name => ['index.html', 'icon.svg', 'manifest.webmanifest'].includes(name) || /^assets\/[^/]+$/.test(name) && hashName.test(name.slice(7));
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export async function ordinaryDirectory(path) {
  const absolute = resolve(path); const root = parse(absolute).root; let cursor = root;
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment); const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error('asset directory must not be a link or junction');
  }
  if (!equalPath(await realpath(absolute), absolute)) throw Error('noncanonical asset directory');
  return absolute;
}
async function boundedFile(path, max = MAX_FILE_BYTES) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Error('asset must be an ordinary unlinked file');
  if (info.size < 0 || info.size > max) throw Error('asset file budget exceeded');
  if (!equalPath(await realpath(path), resolve(path))) throw Error('noncanonical asset file');
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw Error('asset changed before open');
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await file.stat(); const linked = await lstat(path);
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || linked.isSymbolicLink() || linked.dev !== info.dev || linked.ino !== info.ino) throw Error('asset changed during read');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await file.close(); }
}
function text(body) { return new TextDecoder('utf-8', { fatal: true }).decode(body); }
function references(name, body) {
  const refs = new Set();
  const add = (value, module = false) => {
    if (typeof value !== 'string' || !value || /[\\%\u0000-\u0020\u007f]/.test(value)) throw Error('invalid asset reference');
    if (module && (!value.endsWith('.js') || !value.startsWith('.') && !value.startsWith('/'))) throw Error('unbundled module reference');
    const url = new URL(value, `https://asset.invalid/${name}`);
    if (url.origin !== 'https://asset.invalid' || url.username || url.password || url.search || url.hash) throw Error('external or noncanonical asset reference');
    const target = url.pathname.slice(1);
    if (!allowed(target)) throw Error('asset reference has an invalid path');
    refs.add(target);
  };
  if (name === 'index.html') {
    const html = text(body); let entries = 0;
    if (!html.trim()) throw Error('empty entry document');
    for (const [, tag, attrs] of html.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
      if (tag.toLowerCase() === 'base' || /\bon\w+\s*=|\bstyle\s*=/i.test(attrs)) throw Error('inline entry content is not allowed');
      const pairs = [...attrs.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]);
      const attributes = new Map(pairs);
      if (attributes.size !== pairs.length || /\bsrcset\s*=/i.test(attrs)) throw Error('unverifiable entry reference');
      for (const attribute of ['src', 'href']) if (new RegExp(`\\b${attribute}\\s*=`, 'i').test(attrs) && !attributes.has(attribute)) throw Error('unquoted entry reference');
      if (tag.toLowerCase() === 'script') {
        const src = attributes.get('src');
        if (!src || attributes.get('type') !== 'module' || !src.endsWith('.js')) throw Error('inline or invalid entry script');
        entries++;
      }
      if (tag.toLowerCase() === 'style') throw Error('inline stylesheet is not allowed');
      for (const attribute of ['src', 'href']) if (attributes.has(attribute)) add(attributes.get(attribute));
    }
    if (!entries) throw Error('missing module entry');
  } else if (name.endsWith('.js')) {
    const source = ts.createSourceFile(name, text(body), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw Error('invalid JavaScript asset');
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw Error('invalid import reference');
        add(node.moduleSpecifier.text, true);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const value = node.arguments[0];
        if (!value || !ts.isStringLiteralLike(value)) throw Error('unverifiable dynamic import reference');
        add(value.text, true);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') {
        const value = node.arguments[0]; if (!value || !ts.isStringLiteralLike(value)) throw Error('unverifiable URL reference'); add(value.text);
      }
      // Vite preload maps and compiled image/font constants are root-relative
      // asset URLs rather than module-relative import specifiers.
      if (ts.isStringLiteralLike(node) && /^\/?assets\/[^/]+$/.test(node.text)) add('/' + node.text.replace(/^\//, ''));
      ts.forEachChild(node, visit);
    };
    visit(source);
  } else if (name.endsWith('.css')) {
    // Escaped utility *selectors* are valid Tailwind output, not resource URLs.
    // Parse CSS so only selectors gain that support; escaped declarations and
    // at-rule syntax remain rejected, including obfuscated imports/url().
    const values = []; const ast = postcss.parse(text(body), { from: name });
    ast.walkAtRules(rule => {
      if (/^import$/i.test(rule.name) || /\\/.test(rule.name + rule.params)) throw Error('unbundled or escaped CSS reference');
      values.push(rule.params);
    });
    ast.walkDecls(decl => {
      if (/\\/.test(decl.prop + decl.value)) throw Error('escaped CSS reference');
      values.push(decl.value);
    });
    const css = values.join('\n');
    for (const match of css.matchAll(/url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'"\r\n]+))\s*\)/gi)) add(match[1] ?? match[2] ?? match[3]);
    // Reject syntax we cannot reliably inventory instead of silently omitting it.
    if ((css.match(/url\(/gi)?.length ?? 0) !== refs.size && /url\(/i.test(css)) {
      const count = [...css.matchAll(/url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'"\r\n]+))\s*\)/gi)].length;
      if (count !== (css.match(/url\(/gi)?.length ?? 0)) throw Error('unverifiable CSS reference');
    }
  } else if (name === 'manifest.webmanifest') {
    const manifest = JSON.parse(text(body));
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.icons) || manifest.icons.length > 16) throw Error('invalid Web manifest');
    for (const icon of manifest.icons) add(icon?.src);
  } else if (name.endsWith('.svg')) {
    const svg = text(body);
    if (/<script\b|\bon\w+\s*=|<!ENTITY|<!DOCTYPE/i.test(svg)) throw Error('active SVG content is not allowed');
    for (const [, , ref] of svg.matchAll(/(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/g)) if (!ref.startsWith('#')) add(ref);
  }
  return refs;
}
export async function validateAssets(source) {
  const root = await ordinaryDirectory(source); const files = new Map(); let total = 0;
  const scan = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name; const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('asset link or junction');
      if (entry.isDirectory()) {
        if (name !== 'assets') throw Error('unexpected asset directory');
        await ordinaryDirectory(path); await scan(path, name + '/'); continue;
      }
      if (!allowed(name)) throw Error('unexpected asset path or extension');
      if (files.size >= MAX_FILES) throw Error('asset count budget exceeded');
      const body = await boundedFile(path); total += body.length;
      if (total > MAX_TOTAL_BYTES) throw Error('asset total budget exceeded');
      files.set(name, body);
    }
  };
  await scan(root);
  if (!files.has('index.html')) throw Error('missing entry document');
  const graph = new Map([...files].map(([name, body]) => [name, references(name, body)]));
  for (const dependencies of graph.values()) for (const target of dependencies) if (!files.has(target)) throw Error('asset reference is missing');
  const seen = new Set(); const pending = ['index.html'];
  while (pending.length) { const name = pending.pop(); if (seen.has(name)) continue; seen.add(name); pending.push(...graph.get(name)); }
  if (seen.size !== files.size) throw Error('unreferenced asset present');
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, body]) => ({ name, bytes: body.length, sha256: digest(body) }));
  return { files, manifest: { format: FORMAT, digest: digest(JSON.stringify(entries)), entries } };
}
export async function stageAssets(source, target) {
  const destination = resolve(target); const input = resolve(source);
  if (equalPath(input, destination) || equalPath(input.slice(0, destination.length + 1), destination + sep) || equalPath(destination.slice(0, input.length + 1), input + sep)) throw Error('source and staging must not overlap');
  await ordinaryDirectory(dirname(destination));
  let exists = true; try { await lstat(destination); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) {
    await ordinaryDirectory(destination);
    const previous = JSON.parse(text(await boundedFile(join(destination, MANIFEST), 64 * 1024)));
    if (previous.format !== FORMAT || !Array.isArray(previous.entries) || previous.entries.length > MAX_FILES) throw Error('refusing unowned asset destination');
    const owned = new Set([MANIFEST]);
    for (const entry of previous.entries) {
      if (!allowed(entry.name) || owned.has(entry.name)) throw Error('invalid prior asset manifest');
      const body = await boundedFile(join(destination, entry.name));
      if (body.length !== entry.bytes || digest(body) !== entry.sha256) throw Error('prior asset was modified outside builder');
      owned.add(entry.name);
    }
    for (const entry of await readdir(destination, { withFileTypes: true })) {
      if (entry.name === 'assets' && entry.isDirectory()) {
        await ordinaryDirectory(join(destination, 'assets'));
        for (const child of await readdir(join(destination, 'assets'))) if (!owned.has('assets/' + child)) throw Error('refusing unowned asset output');
      } else if (!owned.has(entry.name)) throw Error('refusing unowned asset output');
    }
    // This directory is a prior output of this builder, never production dist.
    // Invalidate it before validation so failure cannot reuse stale embed bytes.
    await rm(destination, { recursive: true });
  }
  const checked = await validateAssets(source);
  const temporary = await mkdtemp(join(dirname(destination), '.pi-cafe-assets-'));
  try {
    await mkdir(join(temporary, 'assets'));
    for (const [name, body] of checked.files) await writeFile(join(temporary, name), body, { flag: 'wx' });
    await writeFile(join(temporary, MANIFEST), JSON.stringify(checked.manifest), { flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return checked.manifest;
}
