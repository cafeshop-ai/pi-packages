import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { parseCafeApprovals, requestCafeApprovals } from './cafe-owner-client.js';
const cleanups:Array<()=>Promise<unknown>>=[];afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const value=()=>({version:1,enabled:true,revision:2,hostId:'pi-a',requests:[{id:'a'.repeat(43),hostId:'pi-a',room:'main',state:'pending',name:'拿铁#abcd1234',expiresAt:Date.now()+90000}]});
async function fixture(handler:RequestListener){
 const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanups.push(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));const port=(server.address() as {port:number}).port;const directory=await mkdtemp(join(tmpdir(),'cafe-owner-ipc-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'credentials.json');await writeFile(file,JSON.stringify({version:1,port,hostToken:'h'.repeat(43),clientToken:'synthetic-owner-token'}),{mode:0o600});return{config:{relayUrl:`ws://127.0.0.1:${port}/ws`,roomId:'main',peerId:'pi-a',token:'h'.repeat(43),credentialsFile:file},directory};
}
it('uses both real credential fields over fixed loopback IPC without an Origin or token in body',async()=>{
 let seen:any;const f=await fixture((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{seen={url:req.url,headers:req.headers,body:JSON.parse(raw)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value()));});});const result=await requestCafeApprovals(f.config,{operation:'status'});expect(result.requests).toHaveLength(1);expect(seen.url).toBe('/api/room/terminal-owner');expect(seen.headers.authorization).toBe('Bearer synthetic-owner-token');expect(seen.headers['x-cafe-pi-authorization']).toBe('Bearer '+'h'.repeat(43));expect(seen.headers.origin).toBeUndefined();expect(seen.body).toEqual({operation:'status',room:'main',peerId:'pi-a'});expect(JSON.stringify(result)).not.toMatch(/synthetic-owner-token|hostToken/);
});
it('rejects foreign requests and terminal escape text',()=>{
 expect(()=>parseCafeApprovals({...value(),hostId:'pi-b'},'pi-a')).toThrow();expect(()=>parseCafeApprovals({...value(),requests:[{...value().requests[0],name:'bad\u001b[2J'}]},'pi-a')).toThrow();expect(()=>parseCafeApprovals({...value(),requests:[{...value().requests[0],hostId:'pi-b'}]},'pi-a')).toThrow();
});
it('rejects symlink credentials and remote URLs without sending secrets',async()=>{
 let calls=0;const f=await fixture((_req,res)=>{calls++;res.end();});const link=join(f.directory,'alias.json');await symlink(f.config.credentialsFile,link);await expect(requestCafeApprovals({...f.config,credentialsFile:link},{operation:'status'})).rejects.toThrow('LOCAL_OWNER_REQUIRED');await expect(requestCafeApprovals({...f.config,relayUrl:'wss://example.invalid/ws'},{operation:'status'})).rejects.toThrow('LOCAL_OWNER_REQUIRED');expect(calls).toBe(0);
});
it('a lost decision response is unknown, never automatically retried',async()=>{let calls=0;const f=await fixture((req)=>{calls++;req.socket.destroy();});await expect(requestCafeApprovals(f.config,{operation:'approve',revision:2,applicationId:'a'.repeat(43)})).rejects.toThrow('RESULT_UNKNOWN');expect(calls).toBe(1);});
