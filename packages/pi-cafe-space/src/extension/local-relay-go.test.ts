import { describe, it, expect } from 'vitest';
import { goPlatform, localGoTarget, ensureLocalRelay } from './local-relay-go.js';
import { localRelayEnvironment } from './local-relay.js';
describe('Go launcher pure gates',()=>{
 it('uses explicit platform tags and rejects unsupported combinations',()=>{
  expect(goPlatform('win32','x64')).toBe('windows-amd64');expect(goPlatform('linux','arm64')).toBe('linux-arm64');expect(goPlatform('darwin','x64')).toBe('darwin-amd64');expect(goPlatform('darwin','arm64')).toBe('darwin-arm64');expect(goPlatform('win32','arm64')).toBeNull();expect(goPlatform('linux','ia32')).toBeNull();
 });
 it('never locally starts remote/credential/query/fragment/wrong path/port0 URLs',async()=>{
  for(const url of ['wss://example.invalid/ws','ws://example.invalid/ws','ws://u@127.0.0.1/ws','ws://@localhost/ws','ws://localhost:0/ws','ws://localhost/ws?','ws://localhost/ws?x=1','ws://localhost/ws#','ws://localhost/ws/','ws://localhost/%77s','http://localhost/ws']) {
   expect(localGoTarget({relayUrl:url,hostToken:'fixture-host'}),url).toBeNull();expect(await ensureLocalRelay({relayUrl:url,hostToken:'fixture-host'})).toBe('remote');
  }
  expect(localGoTarget({relayUrl:'ws://localhost:12345/ws',hostToken:'fixture-host'})?.bind).toBe('127.0.0.1');
  expect(localGoTarget({relayUrl:'ws://[::1]:12345/ws',hostToken:'fixture-host'})?.bind).toBe('::1');
 });
 it('checks original lengths before trim and keeps provider environment out',async()=>{
  expect(localGoTarget({relayUrl:'ws://localhost/ws',hostToken:' '.repeat(4096)+'x'})).toBeNull();
  expect(await ensureLocalRelay({relayUrl:'ws://localhost/ws',hostToken:'fixture-host'},{environment:{PI_COLLAB_CLIENT_TOKEN:' '.repeat(4097)}})).toBe('unavailable');
  const env=localRelayEnvironment('127.0.0.1','12345','fixture-host',{PATH:'os-path',PROVIDER_KEY:'not-forwarded',NODE_OPTIONS:'--bad',PI_COLLAB_CLIENT_TOKEN:'fixture-client'});
  expect(env).toEqual({PATH:'os-path',PI_COLLAB_HOST:'127.0.0.1',PI_COLLAB_PORT:'12345',PI_COLLAB_HOST_TOKEN:'fixture-host',PI_COLLAB_CLIENT_TOKEN:'fixture-client'});
 });
});
