import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

const base = new URL("../../", import.meta.url);
const fixtureRoot = new URL("protocol/fixtures/v1/", base);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(name, fixtureRoot), "utf8"));
const values = load("values.json") as Record<string, unknown>;
function expand(value: unknown, bindings: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map(v => expand(v, bindings));
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length === 1) {
    if (typeof o.$ref === "string") {
      if (bindings.has(o.$ref)) return bindings.get(o.$ref);
      if (!Object.hasOwn(values, o.$ref)) throw new Error("Unknown fixture ref");
      return expand(values[o.$ref], bindings);
    }
    if (Array.isArray(o.$merge)) return Object.assign({}, ...o.$merge.map(v => expand(v, bindings)));
  }
  return Object.fromEntries(Object.entries(o).map(([k,v]) => [k, expand(v, bindings)]));
}
function match(actual: unknown, expected: unknown, bindings: Map<string, unknown>): void {
  const wanted = expand(expected, bindings);
  if (wanted && typeof wanted === "object" && !Array.isArray(wanted)) {
    const o = wanted as Record<string, unknown>;
    if (typeof o.$bind === "string") {
      expect(actual).toEqual(expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/));
      if (bindings.has(o.$bind)) expect(actual).toBe(bindings.get(o.$bind));
      else { expect([...bindings.values()]).not.toContain(actual); bindings.set(o.$bind, actual); }
      return;
    }
    expect(actual).toBeTypeOf("object");
    const a = actual as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(o).sort());
    for (const k of Object.keys(o)) match(a[k], o[k], bindings);
  } else if (Array.isArray(wanted)) {
    expect(Array.isArray(actual)).toBe(true); expect((actual as unknown[]).length).toBe(wanted.length);
    wanted.forEach((v,i) => match((actual as unknown[])[i], v, bindings));
  } else expect(actual).toStrictEqual(wanted);
}
async function deadline<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p,new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error("Go trace deadline")),5000); })]); }
  finally { clearTimeout(timer); }
}
class FIFO<T> {
  queue: T[] = [];
  waiter: ((v:T)=>void) | undefined;
  push(v:T): void { if(this.waiter) { const f=this.waiter;this.waiter=undefined;f(v); } else this.queue.push(v); }
  async next(): Promise<T> { if(this.queue.length) return this.queue.shift()!; return deadline(new Promise(resolve => {this.waiter=resolve;})); }
}
class Peer {
  socket: WebSocket;
  messages=new FIFO<unknown>();
  closed: Promise<{code:number;reason:string}>;
  opened: Promise<void>;
  constructor(url:string) {
    this.socket=new WebSocket(url);
    this.opened=deadline(new Promise((resolve,reject)=>{this.socket.once("open",resolve);this.socket.once("error",reject);}));
    this.closed=new Promise(resolve=>this.socket.once("close",(code,reason)=>resolve({code,reason:reason.toString()})));
    this.socket.on("error",()=>{});
    this.socket.on("message",(data,binary)=>{if(binary) this.messages.push({unexpectedBinary:true});else this.messages.push(JSON.parse(data.toString()));});
  }
  async barrier():Promise<void> {
    if(this.socket.readyState!==WebSocket.OPEN)return;
    await deadline(new Promise<void>((resolve,reject)=>{this.socket.once("pong",()=>resolve());this.socket.ping("trace",undefined,(error?:Error)=>{if(error)reject(error);});}));
  }
}
class Bridge {
  process: ChildProcessWithoutNullStreams;
  responses=new FIFO<Record<string,unknown>>();
  exited: Promise<number|null>;
  diagnostics="";
  constructor(binary:string) {
    this.process=spawn(binary,["-test.run=^TestTraceBridge$","-test.timeout=30s"],{
      cwd:fileURLToPath(base),stdio:"pipe",windowsHide:true,
      env:{ SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, TEMP:process.env.TEMP, TMP:process.env.TMP, PI_CAFE_TRACE_BRIDGE:"1" },
    });
    this.exited=new Promise((resolve,reject)=>{this.process.once("exit",resolve);this.process.once("error",reject);});
    createInterface({input:this.process.stdout}).on("line",line=>{if(line.startsWith("TRACE "))this.responses.push(JSON.parse(line.slice(6)) as Record<string,unknown>);else this.diagnostics=(this.diagnostics+line+"\n").slice(-12000);});
    this.process.stderr.on("data",(data:Buffer)=>{this.diagnostics=(this.diagnostics+data.toString()).slice(-12000);});
  }
  async command(action:string,ms?:number):Promise<void>{this.process.stdin.write(JSON.stringify({action,ms})+"\n");await this.responses.next();}
  async close():Promise<void>{
    this.process.stdin.end('{"action":"close"}\n');
    try { expect(await deadline(this.exited),this.diagnostics).toBe(0); }
    finally { if(this.process.exitCode===null) { this.process.kill(); await deadline(this.exited); } }
  }
}
interface Step { action:string;peer?:string;message?:unknown;inputBase64?:string;binary?:boolean;code?:number;reason?:string;ms?:number; }
interface Trace {id:string;steps:Step[];}
const enabled=process.env.PI_CAFE_GO_TRACE_TESTS==="1";
describe("Go HTTP + WS + hub frozen traces",()=>{
  it("is explicitly enabled by the isolated integration runner",()=>{
    // Normal TS regression does not build/start an undeclared Go binary.
    if(!enabled) expect(process.env.PI_CAFE_GO_TRACE_BINARY).toBeUndefined();
    else expect(existsSync(process.env.PI_CAFE_GO_TRACE_BINARY ?? "")).toBe(true);
  });
  const traces = [...readdirSync(new URL("traces/",fixtureRoot)).filter(n=>n.endsWith(".json")).sort().map(name => "traces/"+name), "../parts/transport-trace.json"];
  if(enabled) for(const name of traces) {
    const trace=load(name) as Trace;
    it(trace.id,async()=>{
      const binary=process.env.PI_CAFE_GO_TRACE_BINARY;
      if(!binary)throw new Error("Integration test binary not specified");
      const bridge=new Bridge(binary);const peers=new Map<string,Peer>();const bindings=new Map<string,unknown>();
      try {
        const {url}=await bridge.responses.next();expect(url).toEqual(expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/));
        for(const [index,step] of trace.steps.entries()) {
          try {
            if(step.action==="advance") {
              for(const peer of peers.values())await peer.barrier();
              await bridge.command("advance",step.ms);continue;
            }
            if(!step.peer)throw new Error("Missing peer");
            if(step.action==="connect") {const peer=new Peer(String(url));peers.set(step.peer,peer);await peer.opened;continue;}
            const peer=peers.get(step.peer);if(!peer)throw new Error("Unknown peer");
            switch(step.action) {
              case "send":peer.socket.send(step.inputBase64===undefined?JSON.stringify(expand(step.message,bindings)):Buffer.from(step.inputBase64,"base64"),{binary:step.binary??false});break;
              case "receive":match(await peer.messages.next(),step.message,bindings);break;
              case "close":peer.socket.close(step.code??1000,step.reason??"fixture complete");await deadline(peer.closed);break;
              case "expectClose":expect(await deadline(peer.closed)).toEqual({code:step.code,reason:step.reason});break;
              default:throw new Error("Unknown trace action");
            }
          } catch(error) {throw new Error(`${trace.id} step ${index} (${step.action}/${step.peer??"clock"}): ${String(error)}\n${bridge.diagnostics}`,{cause:error});}
        }
        for(const peer of peers.values()){await peer.barrier();expect(peer.messages.queue).toEqual([]);}
      } finally {for(const peer of peers.values())peer.socket.terminate();await bridge.close();}
    },20000);
  }
});
