import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ExternalBudget } from './external-budget.ts';
const directory=new URL('../../.refactor/',import.meta.url);
const url='https://example.invalid/v1/responses';const apiKey='NON_SECRET_TEST_KEY';
const request=()=>({method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model:'gpt-6-astra',max_output_tokens:1024,stream:true,store:false,input:[],tools:[],tool_choice:'none',reasoning:{effort:'none'}})});
async function fixture(fn){const work=await mkdtemp(new URL('budget-',directory));let budget;try{let calls=0;let now=0;budget=new ExternalBudget({url,apiKey,ledger:join(work,'once.jsonl'),now:()=>now,fetch:async(_url,init)=>{calls++;assert.equal(init.redirect,'error');assert.ok(init.signal);return new Response('data',{status:200});}});await fn({budget,work,calls:()=>calls,setNow:v=>{now=v;}});}finally{budget?.close();await rm(work,{recursive:true,force:true});}}
test('no request before arming; one-use ledger and exactly two reserved calls',async()=>fixture(async({budget,work,calls})=>{
 assert.throws(()=>budget.reserve(),/NOT_ARMED/);budget.arm();assert.throws(()=>budget.arm(),/ALREADY_ARMED/);
 for(let i=0;i<2;i++){const ticket=budget.reserve();await ticket.fetch(url,request());await assert.rejects(ticket.fetch(url,request()),/ALREADY_SENT/);}
 assert.throws(()=>budget.reserve(),/CALL_LIMIT/);assert.equal(calls(),2);
 const other=new ExternalBudget({url,apiKey,ledger:join(work,'once.jsonl'),fetch:async()=>{throw Error('must not run');}});try{assert.throws(()=>other.arm());}finally{other.close();}
 const log=await readFile(join(work,'once.jsonl'),'utf8');assert.ok(!log.includes(apiKey)&&!log.includes(url));assert.equal(log.split('\n').filter(s=>s.includes('"kind":"request"')).length,2);
}));
test('wire checks reject wrong destination/auth/model/cap/method and unknown payload before spending',async()=>{
 for(const variant of [r=>({...r,method:'GET'}),r=>({...r,headers:{Authorization:'wrong'}}),r=>({...r,body:r.body.replace('1024','1025')}),r=>({...r,body:r.body.replace('gpt-6-astra','wrong-model')}),r=>({...r,body:r.body.replace('"store":false','"store":true')}),r=>({...r,body:r.body.replace('"input":[]','"input":[],"metadata":{}')})])await fixture(async({budget,calls})=>{budget.arm();const ticket=budget.reserve();await assert.rejects(ticket.fetch(url,variant(request())));assert.equal(calls(),0);});
 await fixture(async({budget,calls})=>{budget.arm();await assert.rejects(budget.reserve().fetch('https://other.invalid/v1/responses',request()));assert.equal(calls(),0);});
});
test('one total deadline, abort signal and no reserve after closing',async()=>fixture(async({budget,setNow,calls})=>{
 budget.arm();setNow(0.25);const ticket=budget.reserve();assert.equal(Number.isInteger(ticket.timeoutMs),true);assert.equal(ticket.timeoutMs,59999);setNow(60000);await assert.rejects(ticket.fetch(url,request()),/DEADLINE/);assert.equal(calls(),0);budget.close();assert.equal(budget.signal.aborted,true);assert.throws(()=>budget.reserve());
}));
test('the actual 60-second timer aborts an in-flight fetch without external traffic', {timeout:65000}, async()=>{
 const work=await mkdtemp(new URL('budget-',directory));let observedAbort=false;const start=performance.now();
 const budget=new ExternalBudget({url,apiKey,ledger:join(work,'once.jsonl'),fetch:async(_input,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>{observedAbort=true;reject(Error('mock abort'));},{once:true});})});
 // A real pending HTTP socket would keep the process alive; this fake has none.
 const keepAlive=setInterval(()=>{},1000);
 try{budget.arm();await assert.rejects(budget.reserve().fetch(url,request()),/EXTERNAL_REQUEST_FAILED/);assert.equal(observedAbort,true);assert.ok(performance.now()-start>=60000);assert.equal(budget.summary().requests,1);assert.equal(budget.summary().closed,true);}
 finally{clearInterval(keepAlive);budget.close();await rm(work,{recursive:true,force:true});}
});
test('an HTTP failure closes budget and redacts server errors rather than retrying',async()=>{
 const work=await mkdtemp(new URL('budget-',directory));let calls=0;const budget=new ExternalBudget({url,apiKey,ledger:join(work,'once.jsonl'),fetch:async()=>{calls++;return new Response(apiKey,{status:429,headers:{'retry-after':'0'}});}});
 try{budget.arm();const response=await budget.reserve().fetch(url,request());assert.equal(response.status,429);assert.ok(!(await response.text()).includes(apiKey));assert.throws(()=>budget.reserve());assert.equal(calls,1);}finally{budget.close();await rm(work,{recursive:true,force:true});}
});
