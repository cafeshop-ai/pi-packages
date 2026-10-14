import { registerSessionResourceCleanup, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResponsesTransport } from "./transport.ts";

export function wrapProvider(base: Provider, transport: ResponsesTransport): Provider {
  return {
    ...base,
    stream: (model, context, options) => model.api === "openai-responses"
      ? transport.stream({ ...model, api: "openai-responses" }, context, options, false)
      : base.stream(model, context, options),
    streamSimple: (model, context, options) => model.api === "openai-responses"
      ? transport.stream({ ...model, api: "openai-responses" }, context, options)
      : base.streamSimple(model, context, options),
  };
}

export default function (pi: ExtensionAPI) {
  const transport = new ResponsesTransport();
  const installed = new Map<string, Provider>();
  const skipped = new Set<string>();
  let unregisterCleanup: (() => void) | undefined;
  const install = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry;
    const sessionManager = ctx.sessionManager;
    unregisterCleanup ??= registerSessionResourceCleanup(id => {
      if (id === undefined || id === sessionManager.getSessionId()) {
        transport.clear();
        unregisterCleanup?.(); unregisterCleanup = undefined;
        for (const [name, provider] of installed) {
          if (registry.getRegisteredNativeProvider(name) === provider) registry.unregisterProvider(name);
        }
        installed.clear(); skipped.clear();
      } else transport.clear(id);
    });
    const candidates = new Set(registry.getAll().filter(model => model.api === "openai-responses").map(model => model.provider));
    const registered = new Set(registry.getRegisteredProviderIds());
    skipped.clear();
    for (const [name, provider] of installed) {
      if (registry.getRegisteredNativeProvider(name) !== provider) installed.delete(name);
    }
    for (const name of candidates) {
      if (installed.has(name)) continue;
      // Never replace another extension's authentication or custom streaming implementation.
      if (registered.has(name)) { skipped.add(name); continue; }
      const base = registry.getProvider(name);
      if (!base) continue;
      const provider = wrapProvider(base, transport);
      pi.registerProvider(provider);
      installed.set(name, provider);
    }
  };
  pi.on("session_start", (_event, ctx) => install(ctx));
  pi.on("model_select", (_event, ctx) => install(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    transport.clear(); unregisterCleanup?.(); unregisterCleanup = undefined;
    for (const [name, provider] of installed) {
      if (ctx.modelRegistry.getRegisteredNativeProvider(name) === provider) pi.unregisterProvider(name);
    }
    installed.clear(); skipped.clear();
  });
  pi.registerCommand("responses-ws", {
    description: "Show Responses transport, enabled/skipped providers and full/delta counts (no credentials)",
    handler: async (_args, ctx) => {
      const status = transport.snapshot(ctx.sessionManager.getSessionId());
      ctx.ui.notify(JSON.stringify({ ...status, enabledProviders: [...installed.keys()].sort(), skippedProviders: [...skipped].sort() }, null, 2), "info");
    },
  });
}
