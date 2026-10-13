import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRelayServer, type RunningRelayServer } from '../relay/server.js';
import register from './index.js';

vi.mock('./local-relay.js', async importOriginal => ({
  ...await importOriginal<typeof import('./local-relay.js')>(),
  ensureLocalRelay: vi.fn(async () => 'unavailable'),
}));
let relay: RunningRelayServer | undefined;
let shutdown: (() => unknown) | undefined;
afterEach(async () => { await shutdown?.(); shutdown = undefined; await relay?.close(); relay = undefined; vi.unstubAllEnvs(); });

it('uses the real handshake, not an inconclusive startup preflight, as connection truth', async () => {
  relay = await createRelayServer({ host:'127.0.0.1', port:0, hostToken:'host-token', clientToken:'client-token', allowedOrigins:[], logger:{info(){},warn(){},error(){}} }).listen();
  for (const [key,value] of Object.entries({ PI_COLLAB_ENABLED:'1', PI_COLLAB_RELAY_URL:relay.url.replace('http:','ws:')+'/ws', PI_COLLAB_HOST_TOKEN:'host-token', PI_COLLAB_ROOM:'startup-notification', PI_COLLAB_PEER_ID:'startup-notification-test' })) vi.stubEnv(key,value);
  const handlers = new Map<string,(...args:any[])=>unknown>();
  const notifications: {level:string;message:string}[] = [], statuses: string[] = [];
  const pi = { registerFlag(){}, getFlag(name:string){return name==='collab'?true:undefined;}, registerCommand(){}, on(name:string,handler:(...args:any[])=>unknown){handlers.set(name,handler);}, getSessionName(){return null;}, getThinkingLevel(){return 'off';} } as unknown as ExtensionAPI;
  const context = { cwd:process.cwd(), hasUI:true, isIdle:()=>true, hasPendingMessages:()=>false, model:null,
    sessionManager:{getBranch:()=>[],getSessionId:()=>'startup-test-session',getLeafId:()=>null},
    ui:{setStatus(_key:string,value:string){statuses.push(value);},notify(message:string,level:string){notifications.push({message,level});}},
  } as unknown as ExtensionContext;
  register(pi); shutdown = () => handlers.get('session_shutdown')?.();
  await handlers.get('session_start')?.({},context);
  await vi.waitFor(() => expect(statuses).toContain('café space: connected'),{timeout:3000});
  expect(notifications.filter(n=>n.level==='warning')).toEqual([]);
  expect(notifications.some(n=>/host connecting|local relay is unavailable/i.test(n.message))).toBe(false);
  expect(statuses.at(-1)).toBe('café space: connected');
});
