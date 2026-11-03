import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLoadedThreads, projectLoadedThreads } from './shared-probe.mjs';
import { readTargetsConfig } from './targets.mjs';

const one = '11111111-1111-4111-8111-111111111111';
const two = '22222222-2222-4222-8222-222222222222';
const projects = [{ id:'work', cwd:'C:/work' }];

test('loaded session projection exposes only approved project metadata', () => {
  const response = projectLoadedThreads(projects, [
    { thread: { id:one, cwd:'C:/work', name:'Task', status:{ type:'idle' }, turns:[{text:'private'}] } },
    { thread: { id:two, cwd:'C:/elsewhere', name:'Other', status:{ type:'idle' } } },
  ]);
  assert.deepEqual(response, [{ id:one, projectId:'work', name:'Task', cwd:'C:/work', status:'idle' }]);
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.throws(() => projectLoadedThreads(projects, [{ thread:{ id:one, cwd:'C:/work', status:{} } }]), /metadata/);
});

test('loaded list paginates, reads only metadata, and rejects repeated cursors', async () => {
  const calls=[]; const pages=[{data:[one],nextCursor:'next'},{data:[two],nextCursor:null}];
  const observer={ async request(method,params){
    calls.push([method,params]);
    if(method==='thread/loaded/list')return pages.shift();
    assert.deepEqual(params,{threadId:params.threadId,includeTurns:false});
    return {thread:{id:params.threadId,cwd:'C:/work',name:params.threadId,status:{type:'idle'},turns:[{text:'ignored'}]}};
  }};
  const result=await listLoadedThreads(observer,projects);
  assert.equal(result.threads.length,2);assert.equal(result.truncated,false);
  assert.deepEqual(calls.slice(0,2),[['thread/loaded/list',{limit:20}],['thread/loaded/list',{limit:20,cursor:'next'}]]);
  assert(calls.slice(2).every(([method,params])=>method==='thread/read'&&params.includeTurns===false));
  const repeated={async request(){return {data:[],nextCursor:'same'};}};
  await assert.rejects(listLoadedThreads(repeated,projects),/cursor/);
});

test('loaded session query caps discovery at one hundred IDs', async () => {
  const calls=[];
  const observer={async request(method,params){
    calls.push([method,params]);
    if(method==='thread/loaded/list'){
      const page=Number(params.cursor?.slice('cursor-'.length)??0);
      return {data:Array.from({length:20},(_,i)=>`00000000-0000-4000-8000-${String(page*20+i).padStart(12,'0')}`),nextCursor:`cursor-${page+1}`};
    }
    return {thread:{id:params.threadId,cwd:'C:/work',name:'Task',status:{type:'idle'}}};
  }};
  const result=await listLoadedThreads(observer,projects);
  assert.equal(result.threads.length,100);assert.equal(result.truncated,true);
  assert.equal(calls.filter(([method])=>method==='thread/loaded/list').length,5);
  assert.equal(calls.filter(([method])=>method==='thread/read').length,100);
});

test('list configuration accepts only absolute executable/socket/project paths', async () => {
  const directory=await mkdtemp(join(tmpdir(),'cafe-acp-target-test-'));const file=join(directory,'config.json');
  const config={codex:join(directory,'codex.exe'),socket:join(directory,'app.sock'),projects:[{id:'work',cwd:directory}]};
  try {
    await writeFile(file,JSON.stringify(config));assert.deepEqual(await readTargetsConfig(file),config);
    const special={...config,socket:join(directory,'socket %!^&.sock')};await writeFile(file,JSON.stringify(special));assert.deepEqual(await readTargetsConfig(file),special);
    await writeFile(file,JSON.stringify({...config,socket:join(directory,'界'.repeat(1400))}));await assert.rejects(readTargetsConfig(file),/config/i);
    await writeFile(file,JSON.stringify({...config,token:'should-not-be-accepted'}));await assert.rejects(readTargetsConfig(file),/config/i);
    await writeFile(file,JSON.stringify({...config,socket:'relative.sock'}));await assert.rejects(readTargetsConfig(file),/config/i);
    await writeFile(file,JSON.stringify({...config,socket:join(directory,'bad\nsocket')}));await assert.rejects(readTargetsConfig(file),/config/i);
  } finally {await rm(directory,{recursive:true,force:true});}
});
