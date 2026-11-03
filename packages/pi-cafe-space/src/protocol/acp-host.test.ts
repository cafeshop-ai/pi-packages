import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import * as protocol from './index.js';
import { AcpSpaceHost } from '../../scripts/acp/space-host.mjs';
import { runSpaceHost } from '../../scripts/acp/space-run.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff009';
function fixture(relayUrl = 'ws://127.0.0.1:12345/') {
  let calls = 0, closed = 0, resolvePrompt: (value: unknown) => void;
  const adapter = { state: 'idle', prompt() { calls++; this.state = 'running'; return new Promise(resolve => { resolvePrompt = resolve; }); }, async cancel() { this.state = 'cancelling'; }, close() { closed++; this.state = 'closed'; } };
  const host = new AcpSpaceHost({ protocol, adapter, sessionId: 'test-session', cwd: '/test', name: 'Codex ACP', config: { relayUrl, roomId: 'test', hostId: 'acp-host', token } });
  const command = (payload: unknown = { name: 'prompt', content: 'hello' }, id = 'client-1') => ({ type: 'routed_command', relayRequestId: 'relay-' + id, clientRequestId: id, sourcePeerId: 'client', expectedStreamId: host.snapshot.streamId, expectedSessionId: 'test-session', expectedCwd: '/test', payload });
  return { host, adapter, command, get calls() { return calls; }, get closed() { return closed; }, finish() { adapter.state = 'idle'; resolvePrompt!({ stopReason: 'end_turn' }); } };
}

describe('agent-neutral protocol metadata', () => {
  it('preserves only canonical agent capability fields through codec and reducer', () => {
    const f = fixture();
    const wire = { type: 'snapshot', snapshot: { ...f.host.snapshot, agent: { name: 'Codex ACP', modelControl: false, deliveryControl: false, privateKey: 'must disappear' } } };
    const decoded = protocol.decodeWireMessage(JSON.stringify(wire));
    expect(decoded.type).toBe('snapshot');
    if (decoded.type !== 'snapshot') throw Error();
    expect(decoded.snapshot.agent).toEqual({ name: 'Codex ACP', modelControl: false, deliveryControl: false });
    expect(protocol.applyEvent(decoded.snapshot, { type: 'event', streamId: decoded.snapshot.streamId, sessionId: decoded.snapshot.sessionId, seq: 1, emittedAt: new Date().toISOString(), event: { kind: 'session_state', phase: 'running', hasPendingMessages: false } }).agent).toEqual(decoded.snapshot.agent);
    expect(() => protocol.decodeWireMessage(JSON.stringify({ type: 'snapshot', snapshot: { ...f.host.snapshot, agent: { name: 'bad', modelControl: 'false', deliveryControl: false } } }))).toThrow();
    f.host.close();
  });
});

it.skipIf(!process.env.CAFE_ACP_ROOT).each(['new', 'restore'])('offline %s → official ACP SDK → fixture agent → Space host channel; no Codex/model invocation', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'cafe-acp-space-fixture-'));
  const packageRoot = join(root, 'node_modules/@agentclientprotocol/codex-acp');
  const sdkRoot = join(root, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable');
  const actualSdk = pathToFileURL(join(process.env.CAFE_ACP_ROOT!, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js')).href;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address(); if (typeof address !== 'object' || !address) throw Error();
  let snapshot: protocol.SessionSnapshot | undefined;
  let result: protocol.CommandResultMessage | protocol.HostCommandResultMessage | undefined;
  const events: protocol.WireMessage[] = [];
  server.on('connection', ws => ws.on('message', raw => {
    const m = protocol.decodeWireMessage(raw.toString());
    if (m.type === 'hello') ws.send(JSON.stringify({ type:'welcome', protocolVersion:1, connectionId:'fixture', peerRole:'host', roomId:'test', hostConnected:true }));
    if (m.type === 'snapshot' && !snapshot) {
      snapshot = m.snapshot;
      ws.send(JSON.stringify({ type:'routed_command', relayRequestId:'offline-relay',clientRequestId:'offline-client',sourcePeerId:'web',expectedStreamId:snapshot.streamId,expectedSessionId:snapshot.sessionId,expectedCwd:snapshot.cwd,payload:{name:'prompt',content:'offline fixture only'} }));
    }
    if (m.type === 'event') events.push(m);
    if (m.type === 'host_command_result') { result = m; ws.close(); }
  }));
  try {
    await mkdir(join(packageRoot,'dist'),{recursive:true}); await mkdir(sdkRoot,{recursive:true});
    await writeFile(join(packageRoot,'package.json'),JSON.stringify({version:'2.5.0'}));
    await writeFile(join(root,'node_modules/@agentclientprotocol/sdk/package.json'),JSON.stringify({version:'2.1.0',type:'module'}));
    await writeFile(join(sdkRoot,'acp.js'),`export * from ${JSON.stringify(actualSdk)};`);
    await writeFile(join(packageRoot,'dist/index.js'), `
      import {createInterface} from 'node:readline';
      const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
      for await (const line of createInterface({input:process.stdin})) {
        const m=JSON.parse(line); if(m.id==null) continue;
        let result;
        const sessionId='11111111-1111-4111-8111-111111111111';
        const update=u=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:u}});
        if(m.method==='initialize') result={protocolVersion:1,agentInfo:{name:'offline-fixture',version:'1'},agentCapabilities:{loadSession:true}};
        else if(m.method===${JSON.stringify(mode === 'new' ? 'session/new' : 'session/load')}) {
          if(m.method==='session/load') {
            for(let i=0;i<700;i++) update({sessionUpdate:i%2?'agent_message_chunk':'user_message_chunk',content:{type:'text',text:String(i)}});
            update({sessionUpdate:'tool_call_update',toolCallId:'large',status:'completed',content:[{type:'content',content:{type:'text',text:'x'.repeat(600000)}}]});
            update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'RESTORED_TAIL'}});
          }
          result={sessionId,modes:{currentModeId:'read-only',availableModes:[{id:'read-only',name:'Read only'}]}};
        }
        else if(m.method==='session/prompt') {
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OFFLINE_OK'}});
          result={stopReason:'end_turn'};
        } else throw Error('Unexpected ACP method');
        send({jsonrpc:'2.0',id:m.id,result});
      }
    `);
    const config={mode,managed:true,managedSessionId:'22222222-2222-4222-8222-222222222222',...(mode==='restore'?{threadId:'11111111-1111-4111-8111-111111111111'}:{}),relayUrl:`ws://127.0.0.1:${address.port}/ws`,roomId:'test',hostId:'fixture-host',token,acpRoot:root,codex:process.execPath,cwd:root,stateDirectory:join(root,'state'),promptBudget:null};
    await runSpaceHost(config,{protocol});
    expect(result?.status).toBe('applied'); expect(snapshot?.agent?.modelControl).toBe(false);
    expect(events.some(m=>m.type==='event' && m.event.kind==='message_delta' && m.event.delta==='OFFLINE_OK')).toBe(true);
    if(mode==='new') await expect(runSpaceHost(config,{protocol})).rejects.toMatchObject({code:'EEXIST'});
    else {
      expect(snapshot?.messages.some(m=>m.text==='RESTORED_TAIL')).toBe(true);
      expect(snapshot?.historyTruncated).toBe(true); expect(snapshot?.phase).toBe('idle');
      expect(snapshot?.messages.length).toBeLessThanOrEqual(24);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(200000);
    }
  } finally {
    for(const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(root,{recursive:true,force:true});
  }
}, 15000);

describe('ACP Space host', () => {
  it('keeps borrowed native thread IDs out of public host snapshots and uses separate event identity', () => {
    const nativeId = '87654321-4321-4abc-8def-123456789abc';
    const host = new AcpSpaceHost({ protocol, adapter: { close() {} }, sessionId: 'managed-space-session', agentSessionId: nativeId, cwd: '/test', name: 'Borrowed', config: { relayUrl:'ws://127.0.0.1:12345/', roomId:'test', hostId:'acp-host', token } });
    expect(host.snapshot.sessionId).toBe('managed-space-session');
    expect(JSON.stringify(host.snapshot)).not.toContain(nativeId);
    host.event({ sessionId:nativeId, type:'text', text:'borrowed output' });
    expect(host.snapshot.messages[0]?.text).toBe('borrowed output');
    host.event({ sessionId:'managed-space-session', type:'text', text:'must be filtered' });
    expect(host.snapshot.messages[0]?.text).toBe('borrowed output');
    host.close();
  });
  it('rejects nonlocal gateways and weak tokens before opening a connection', () => {
    expect(() => fixture('ws://example.com/')).toThrow(/loopback/);
    expect(() => fixture('ws://127.0.0.1/?token=secret')).toThrow(/loopback/);
    expect(() => new AcpSpaceHost({ protocol, adapter: {}, sessionId: 's', cwd: '/', name: 'ACP', config: { relayUrl: 'ws://127.0.0.1/', token: 'weak' } })).toThrow(/token/);
  });
  it('fences scope and rejects unsupported model/files/delivery/lifecycle controls', async () => {
    const f = fixture();
    const stale = { ...f.command(), expectedSessionId: 'other' };
    expect((await f.host.command(stale)).code).toBe('STALE_SESSION');
    for (const [i, payload] of [{ name: 'set_model', provider: 'x', modelId: 'y' }, { name: 'new_session' }, { name: 'read_file', path: 'x' }, { name: 'prompt', content: 'x', delivery: 'steer' }, { name: 'prompt', content: 'x', files: ['x'] }].entries()) {
      expect((await f.host.command(f.command(payload, String(i)))).code).toBe('CAPABILITY_UNSUPPORTED');
    }
    expect((await f.host.command(f.command({ name: 'abort' }, 'abort'))).code).toBe('NO_OWNED_TURN');
    expect(f.calls).toBe(0); f.host.close();
  });
  it('deduplicates in-flight and completed commands, no optimistic user text, conflicts rejected', async () => {
    const f = fixture(); const message = f.command();
    const first = f.host.command(message), second = f.host.command({ ...message, relayRequestId: 'new-relay' });
    expect(f.calls).toBe(1); expect(f.host.snapshot.messages).toHaveLength(0);
    expect((await f.host.command({ ...message, payload: { name: 'prompt', content: 'different' } })).code).toBe('REQUEST_CONFLICT');
    f.host.event({ sessionId: 'foreign', type: 'text', text: 'private' }); expect(f.host.snapshot.messages).toHaveLength(0);
    f.host.event({ sessionId: 'test-session', type: 'text', text: 'actual agent output' });
    f.finish(); expect((await first).status).toBe('applied'); expect((await second).relayRequestId).toBe('new-relay');
    await f.host.command(message); expect(f.calls).toBe(1);
    expect(f.host.snapshot.messages[0].text).toBe('actual agent output');
    expect(f.host.snapshot.messages[0].status).toBe('complete');
    f.host.close(); f.host.close(); expect(f.closed).toBe(1);
  });
  it('projects tool activity without granting any ACP client filesystem/permission capability', () => {
    const f = fixture();
    f.host.event({ type: 'activity', sessionId: 'test-session', update: { sessionUpdate: 'tool_call', toolCallId: 'source-id', title: 'Read', status: 'in_progress', rawInput: { path: 'fixture.txt' } } });
    f.host.event({ type: 'activity', sessionId: 'test-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'source-id', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fixture output' } }] } });
    expect(f.host.snapshot.tools).toHaveLength(1); expect(f.host.snapshot.tools[0].output).toBe('fixture output');
    expect(f.host.snapshot.tools[0].status).toBe('complete'); expect(f.calls).toBe(0); f.host.close();
  });
  it('authenticates to a real loopback relay transport and publishes bounded canonical snapshots/events', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const address = server.address(); if (typeof address !== 'object' || !address) throw Error();
    const f = fixture(`ws://127.0.0.1:${address.port}/`);
    let acceptedToken = false;
    const received: protocol.WireMessage[] = [];
    server.on('connection', ws => ws.on('message', raw => {
      const message = protocol.decodeWireMessage(raw.toString());
      if (message.type === 'hello') {
        acceptedToken = message.token === token;
        ws.send(JSON.stringify({ type: 'welcome', protocolVersion: 1, connectionId: 'connection', peerRole: 'host', roomId: 'test', hostConnected: true }));
      } else received.push(message);
    }));
    try {
      await f.host.connect();
      f.host.event({ type: 'text', sessionId: 'test-session', text: 'x'.repeat(20000) });
      f.host.state(false, 'completed');
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(acceptedToken).toBe(true); expect(received[0].type).toBe('snapshot');
      expect(f.host.snapshot.messages[0].text.length).toBeLessThanOrEqual(16000);
      expect(received.filter(m => m.type === 'event').length).toBeGreaterThan(1);
    } finally { f.host.close(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
