import assert from 'node:assert/strict';
import { until, delay } from './native-support.mjs';
export function controls(page){
 const evaluate=code=>page.evaluate(code);
 const click=async text=>{await until(()=>evaluate(`!![...document.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')===${JSON.stringify(text)}||n.textContent.trim()===${JSON.stringify(text)})&&!n.disabled)`),'enabled '+text);await evaluate(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')===${JSON.stringify(text)}||n.textContent.trim()===${JSON.stringify(text)})&&!n.disabled);n.focus();n.click();})()`);};
 const input=async(label,value)=>evaluate(`(()=>{const label=${JSON.stringify(label)};const n=document.querySelector('[aria-label="'+label+'"]')||[...document.querySelectorAll('label')].find(n=>n.textContent.trim()===label)?.control;if(!n)throw Error('missing input '+label);const p=n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const select=async(label,value)=>evaluate(`(()=>{const n=document.querySelector('select[aria-label=${JSON.stringify(label)}]');if(!n||n.disabled)throw Error('select unavailable');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const link=async text=>{const match=`n.getAttribute('aria-label')===${JSON.stringify(text)}||n.textContent===${JSON.stringify(text)}`;await until(()=>evaluate(`!![...document.querySelectorAll('a')].find(n=>${match})`),'link '+text);await evaluate(`[...document.querySelectorAll('a')].find(n=>${match}).click()`);};
 const send=async(text,delivery)=>{await input('Message',text);if(delivery)await select('Delivery',delivery);await click('Send');};
 return {evaluate,click,input,select,link,send};
}
export async function browserAcceptance({page,rpc,peer,scope,report,ok,outgoing}){
 const {evaluate,click,input,select,send}=controls(page);
 const settled=()=>rpc.wait(e=>e.type==='agent_settled','native agent settled');
 const complete=async(text)=>{const pending=settled();await send(text);await pending;await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'composer ready');};
 await select('Thinking level','high');await until(async()=>(await rpc.call('get_state')).thinkingLevel==='high','native thinking high');
 await input('Provider','r18-local');await input('Model ID','fixture-b');await click('Apply model');await until(async()=>(await rpc.call('get_state')).model.id==='fixture-b','native model changed');ok('Web model/thinking controls reach native Pi');
 const queuedDone=settled();const started=rpc.wait(e=>e.type==='message_update'&&e.assistantMessageEvent?.type==='text_end'&&e.assistantMessageEvent.content==='Native reply: HOLD','HOLD streaming');await send('HOLD');await started;
 await until(()=>evaluate(`!!document.querySelector('select[aria-label="Delivery"]')`),'running delivery');
 await send('STEER_NATIVE','steer');await until(async()=>(await rpc.call('get_state')).pendingMessageCount===1,'steer queued');
 await send('FOLLOW_NATIVE','followUp');await until(async()=>(await rpc.call('get_state')).pendingMessageCount===2,'followUp queued');await queuedDone;
 const users=(await rpc.call('get_messages')).messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
 assert.deepEqual(users.slice(-3),['HOLD','STEER_NATIVE','FOLLOW_NATIVE']);ok('Web steer/followUp queued once in native Pi and delivered in native order');
 const aborted=settled();const holding=rpc.wait(e=>e.type==='message_update'&&e.assistantMessageEvent?.content==='Native reply: HOLD','abort streaming');await send('HOLD');await holding;await click('Abort');await aborted;
 assert.equal((await rpc.call('get_messages')).messages.filter(m=>m.role==='assistant').at(-1).stopReason,'aborted');ok('independent Web Abort cancels the actual native stream');
 const uiDone=settled();const dialog=rpc.wait(e=>e.type==='extension_ui_request'&&e.method==='confirm','native local UI dialog');await send('WAIT_UI');const request=await dialog;
 await until(()=>evaluate(`document.body.textContent.includes('Waiting for input in local Pi')`),'waiting local UI indication');
 assert.equal(await evaluate(`!![...document.querySelectorAll('button')].find(n=>/approve|confirm/i.test(n.textContent))`),false);
 rpc.child.stdin.write(JSON.stringify({type:'extension_ui_response',id:request.id,confirmed:true})+'\n');await uiDone;ok('native RPC local UI wait projected; Web offers no remote approval');
 await complete('LONG');await until(()=>evaluate(`(()=>{const n=document.querySelector('[role="log"]');return n.scrollHeight>n.clientHeight&&n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`),'follow new transcript');
 await evaluate(`(()=>{const n=document.querySelector('[role="log"]');n.scrollTop=0;n.dispatchEvent(new Event('scroll'));})()`);await complete('AFTER_UPSCROLL');await delay(120);assert.equal(await evaluate(`document.querySelector('[role="log"]').scrollTop`),0);ok('real Chrome follows at bottom and preserves manual upscroll');
 await complete('SAFE');assert.equal(await evaluate(`!!document.querySelector('[role="log"] img,[role="log"] a[href^="javascript:"]')||window.__r18Xss===1`),false);
 assert.equal(await evaluate(`!!document.querySelector('[role="log"] a[href="https://example.com/"]')||!!document.querySelector('[role="log"] a[href="https://example.com"]')`),true);ok('actual Markdown renderer: safe link, no remote image or executable markup');
 for(const [width,height] of [[1440,900],[1024,768],[390,844]]){
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});await delay(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'),true,`viewport ${width}`);
 }
 await click('Pi hosts');await until(()=>evaluate(`document.querySelector('[role="dialog"]')?.contains(document.activeElement)`),'drawer focus');
 assert.equal(await evaluate(`document.querySelector('[data-layout] [inert]')!==null`),true);
 const focusProbe=await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');const nodes=[...d.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(n=>n.checkVisibility());const last=nodes.at(-1);last.focus();return {focused:document.activeElement===last,tag:last.tagName,text:last.textContent};})()`);assert.equal(focusProbe.focused,true);report.drawerLastVisible=focusProbe;
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 assert.equal(await evaluate(`document.activeElement===document.querySelector('[role="dialog"] button')`),true,'Tab from the last visible drawer control must wrap to Close');
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>evaluate(`!document.querySelector('[role="dialog"]')&&document.activeElement?.textContent==='Pi hosts'`),'Escape focus restoration');
 await click('Project files');await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="Project files"]')`),'files drawer');await click('Close');ok('mobile drawers: accessible label, inert background, Tab trap, Escape and focus restoration');
 await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await delay(100);
 const before=(await rpc.call('get_messages')).messages.filter(m=>m.role==='user').length;
 await page.send('Page.reload',{ignoreCache:true});await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled&&document.querySelectorAll('[data-tool-id="native-t1"]').length===1`),'real Chrome reconnect final snapshot');
 assert.equal((await rpc.call('get_messages')).messages.filter(m=>m.role==='user').length,before);
 // Language is deliberately memory-only (no additional storage key). A page
 // reload, unlike a socket reconnect, returns to the configured default.
 await click('English');await until(()=>evaluate(`document.querySelector('[data-tool-id="native-t1"]').textContent.includes('Empty output')`),'reloaded English empty output');ok('page reconnect reconstructs actual Pi parts without replaying prompts');
 const prompts=outgoing.filter(m=>m.payload.name==='prompt');assert.equal(prompts.filter(m=>m.payload.content==='STEER_NATIVE'&&m.payload.delivery==='steer').length,1);assert.equal(prompts.filter(m=>m.payload.content==='FOLLOW_NATIVE'&&m.payload.delivery==='followUp').length,1);
 assert.ok(outgoing.every(m=>m.targetHostId==='r18-native-pi'&&m.expectedSessionId===scope.sessionId&&m.expectedCwd===scope.cwd&&m.expectedStreamId===scope.streamId));report.browserCommandCount=outgoing.length;
 assert.equal((await peer.command(scope,{name:'read_file',path:'fixture.txt',offset:0})).status,'applied');
}
