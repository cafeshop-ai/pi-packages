import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerCafeRoute } from './commands.js';
import { registerCafe } from '../extension/cafe.js';

function fixture() {
  const bus = new EventEmitter(), commands = new Map<string, any>();
  const registerCommand = vi.fn((name, command) => { if (commands.has(name)) throw Error('duplicate command'); commands.set(name, command); });
  const api = () => ({ events: { emit: (name: string, data: unknown) => bus.emit(name, data), on: (name: string, fn: any) => { bus.on(name, fn); return () => bus.off(name, fn); } }, registerCommand }) as unknown as ExtensionAPI;
  const ctx = { hasUI: true, ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext;
  return { api, ctx, commands, registerCommand };
}
it.each([true, false])('shares one /cafe across independently loaded entries (gateway first: %s)', async gatewayFirst => {
  const f = fixture(), gateway = vi.fn(), collab = vi.fn();
  const addGateway = () => registerCafeRoute(f.api(), 'gateway', { description: 'gateway', handler: gateway,
    getArgumentCompletions: async prefix => ['status', 'share'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) });
  const addCollab = () => registerCafeRoute(f.api(), 'collab', { description: 'bridge', handler: collab,
    getArgumentCompletions: prefix => ['status', 'resume', 'resolve retry'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) });
  if (gatewayFirst) { addGateway(); addCollab(); } else { addCollab(); addGateway(); }
  expect(f.registerCommand).toHaveBeenCalledTimes(1); expect([...f.commands.keys()]).toEqual(['cafe']);
  const command = f.commands.get('cafe');
  await command.handler('status', f.ctx); await command.handler('', f.ctx);
  expect(gateway.mock.calls.map(call => call[0])).toEqual(['status', '']); expect(collab).not.toHaveBeenCalled();
  await command.handler(' collab connect C:/private directory/member.json ', f.ctx);
  expect(collab).toHaveBeenCalledExactlyOnceWith('connect C:/private directory/member.json', f.ctx);
  expect(await command.getArgumentCompletions('co')).toEqual([{ value: 'collab', label: 'collab · 协作讨论' }]);
  expect((await command.getArgumentCompletions('collab res')).map((item: any) => item.value)).toEqual(['collab resume', 'collab resolve retry']);
  expect((await command.getArgumentCompletions('sta')).map((item: any) => item.value)).toEqual(['status']);
});
it('gateway-only reports a missing bridge without connecting, and preserves the real gateway command', async () => {
  const f = fixture(), connect = vi.fn();
  const controller = registerCafe(f.api(), { config: vi.fn(), status: () => 'disabled', connect, disconnect: vi.fn() });
  try {
    await f.commands.get('cafe').handler('collab resume', f.ctx);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('尚未加载讨论桥接'), 'info');
    expect(connect).not.toHaveBeenCalled();
    expect(await f.commands.get('cafe').getArgumentCompletions('mod')).toEqual([{ value: 'models', label: 'models' }]);
  } finally { controller.stop(); }
});
it('bridge-only does not pretend /cafe status is the computer gateway or access a network', async () => {
  const f = fixture(), collab = vi.fn();
  registerCafeRoute(f.api(), 'collab', { description: 'bridge', handler: collab });
  await f.commands.get('cafe').handler('status', f.ctx);
  expect(collab).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('未启动电脑网关'), 'info');
  await f.commands.get('cafe').handler('collab status', f.ctx);
  expect(collab).toHaveBeenCalledExactlyOnceWith('status', f.ctx);
});
