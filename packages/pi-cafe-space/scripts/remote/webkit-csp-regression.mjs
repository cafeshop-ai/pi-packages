import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const {values}=parseArgs({strict:true,options:{report:{type:'string'}}});assert(values.report);
let port=0;const server=createServer((req,res)=>{const variant=new URL(req.url,'http://localhost').pathname;const connect=variant==='/allow'?`ws://127.0.0.1:${port}`:variant==='/foreign'?'ws://127.0.0.1:1':"'none'";res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; connect-src ${connect}; object-src 'none'; frame-ancestors 'none'`});res.end('<!doctype html><title>Isolated CSP check</title>');});
const wss=new WebSocketServer({noServer:true});let accepted=0;
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/room/join'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{accepted++;ws.on('error',()=>{});});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
async function run(variant){return new Promise((resolveResult,reject)=>{const child=spawn('/usr/bin/swift',['scripts/remote/webkit-signal-check.swift',`http://127.0.0.1:${port}/${variant}`],{stdio:['ignore','pipe','pipe']});let output='',errors='';const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('WebKit test timed out'));},40000);child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);try{assert.equal(code,0,errors.slice(0,300));resolveResult(JSON.parse(output.trim()));}catch(e){reject(e);}});});}
const checks=[];
try{
 for(const variant of ['deny','allow','foreign']){const before=accepted,result=await run(variant);if(variant==='allow'){assert.equal(result.opened,true);assert.equal(accepted,before+1);assert.deepEqual(result.violations,[]);}else{assert.notEqual(result.opened,true);assert.equal(accepted,before);assert(result.violations.some(v=>v.directive==='connect-src'));}checks.push({variant,opened:result.opened===true,steps:result.steps,violations:result.violations});}
 await mkdir(values.report,{recursive:true});const report={passed:true,checks,scope:'actual system WKWebView, isolated HTTP and WebSocket; not the user iPhone OS version'};await writeFile(resolve(values.report,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));}
