import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];
type Area = 'gateway' | 'collab';
const channel = 'cafe:command-routes-v1';

// Use the scoped event bus: independently loaded entries may have different module instances.
export function registerCafeRoute(pi: ExtensionAPI, area: Area, command: Command): void {
  let attach: ((area: Area, command: Command) => void) | undefined;
  pi.events.emit(channel, { accept: (value: NonNullable<typeof attach>) => { attach = value; } });
  if (attach) { attach(area, command); return; }
  const routes = new Map<Area, Command>([[area, command]]);
  pi.events.on(channel, data => {
    const request = data as { accept: (value: NonNullable<typeof attach>) => void };
    request.accept((name, value) => { routes.set(name, value); });
  });
  pi.registerCommand('cafe', {
    description: 'Café Space：电脑共享、连接状态与 collab 协作讨论',
    async getArgumentCompletions(prefix) {
      const collab = /^collab(?:\s+(.*))?$/.exec(prefix);
      if (collab) return (await routes.get('collab')?.getArgumentCompletions?.(collab[1] ?? '') ?? [])
        .map(item => ({ ...item, value: 'collab ' + item.value, label: 'collab ' + item.label }));
      return [...(await routes.get('gateway')?.getArgumentCompletions?.(prefix) ?? []),
        ...('collab'.startsWith(prefix) ? [{ value: 'collab', label: 'collab · 协作讨论' }] : [])];
    },
    async handler(args, ctx) {
      const collab = /^collab(?:\s+(.*))?$/.exec(args.trim());
      if (collab) {
        const bridge = routes.get('collab');
        if (bridge) await bridge.handler(collab[1] ?? '', ctx);
        else if (ctx.hasUI) ctx.ui.notify('尚未加载讨论桥接。请显式加载 dist/collaboration/extension.js；加载本身不连接房间。', 'info');
        return;
      }
      const gateway = routes.get('gateway');
      if (gateway) { await gateway.handler(args, ctx); return; }
      if (ctx.hasUI) ctx.ui.notify('仅加载了讨论桥接，未启动电脑网关。用法：/cafe collab connect <私有配置绝对路径> · /cafe collab resume · /cafe collab pause · /cafe collab status', 'info');
    },
  });
}
