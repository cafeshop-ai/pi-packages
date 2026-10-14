import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { proxyFor } from '../src/proxy.ts';
import { ResponsesTransport } from '../src/transport.ts';
import { context, modelFor, opts, server } from './helpers.mjs';

const scoped={HTTP_PROXY:'http://proxy.test:80',HTTPS_PROXY:'https://proxy.test:443',ALL_PROXY:'http://fallback.test:80',NO_PROXY:'unused.invalid'};
test('HTTP/HTTPS, scoped/lowercase precedence, NO_PROXY ports/domains/IPv6, SOCKS rejection',()=>{
  const target=s=>new URL(s);
  assert.equal(proxyFor(target('http://example.test'),scoped),'http://proxy.test/');
  assert.equal(proxyFor(target('https://example.test'),scoped),'https://proxy.test/');
  assert.equal(proxyFor(target('https://example.test'),{...scoped,https_proxy:'http://lower.test'}),'http://lower.test/');
  for(const [url,rule] of [['http://example.test','*'],['http://child.example.test','.example.test'],['http://child.example.test','*.example.test'],['http://example.test:80','example.test:80'],['http://[::1]:81','[::1]:81'],['http://example.test','missing.test,example.test']])assert.equal(proxyFor(target(url),{...scoped,NO_PROXY:rule}),undefined,rule);
  assert.ok(proxyFor(target('http://notexample.test'),{...scoped,NO_PROXY:'example.test'}));
  assert.ok(proxyFor(target('http://example.test:81'),{...scoped,NO_PROXY:'example.test:80'}));
  assert.throws(()=>proxyFor(target('https://example.test'),{...scoped,HTTPS_PROXY:'socks5://user:secret@proxy.test'}),/only HTTP/);
  assert.throws(()=>proxyFor(target('https://example.test'),{...scoped,HTTPS_PROXY:'http://['}),/redacted/);
});

for(const fallback of [false,true])test(`CONNECT proxy is used for WS${fallback?' and SSE fallback':''}; scoped NO_PROXY bypasses it`,{timeout:10000},async t=>{
  const s=await server(t),connections=[],sockets=new Set();
  const proxy=createServer((req,res)=>{
    connections.push('forward:'+req.url);
    const upstream=request(req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>res.destroy());req.pipe(upstream);
  });
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
  proxy.on('connect',(req,client,head)=>{
    connections.push(req.url);
    const [host,port]=req.url.split(':');const upstream=connect(Number(port),host);
    sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());
    upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
    client.on('close',()=>upstream.destroy());
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>proxy.close(r));});
  const m=new ResponsesTransport(undefined,async()=>{});t.after(()=>m.clear());if(fallback)s.rejectUpgrade(503);
  const env={HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,NO_PROXY:'unused.invalid'};
  const a=await m.stream(modelFor(s.baseUrl),context(),opts({transport:'auto',env})).result();assert.equal(a.stopReason,'stop',a.errorMessage);
  assert.equal(connections.length,fallback?7:1);assert.equal(s.handshakes.length,fallback?6:1);assert.equal(s.requests[0].transport,fallback?'sse':'websocket');
  s.rejectUpgrade(0);
  const b=await m.stream(modelFor(s.baseUrl),context(),opts({sessionId:'bypass',env:{...env,NO_PROXY:'127.0.0.1'}})).result();assert.equal(b.stopReason,'stop',b.errorMessage);assert.equal(connections.length,fallback?7:1);
});
