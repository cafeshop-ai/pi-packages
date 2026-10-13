import { createHash } from 'node:crypto';
// Reviewed react-router 7.18.2 lib/dom/ssr/routeModules.ts function, identical
// in the installed development/production ESM chunks. Our HashRouter has no
// framework manifest/context. Disable (not allowlist) this unused loader before
// Rollup hashes assets. Never patch node_modules or already-built JavaScript.
const reviewed = '0a5332223eb6334c71f9af26aedf144328c2e1d30731e76eea5b8e2192579999';
export function hashRouterOnly() {
  let replacements = 0;
  return {
    name: 'pi-cafe-hash-router-only', enforce: 'pre',
    transform(code, id) {
      if (!/\/react-router\/dist\/(development|production)\/chunk-[\w-]+\.mjs$/.test(id.replaceAll('\\', '/'))) return null;
      const match = /async function loadRouteModule\(route, routeModulesCache\) \{[\s\S]*?\n\}/.exec(code);
      if (!match) return null;
      if (createHash('sha256').update(match[0]).digest('hex') !== reviewed) throw Error('React Router framework loader changed; source review required');
      replacements++;
      return { code: code.slice(0, match.index) + 'async function loadRouteModule() { throw new Error("Framework route modules are disabled; use HashRouter"); }' + code.slice(match.index + match[0].length), map: null };
    },
    buildEnd(error) { if (!error && replacements !== 1) throw Error('Expected exactly one reviewed React Router framework loader'); },
  };
}
