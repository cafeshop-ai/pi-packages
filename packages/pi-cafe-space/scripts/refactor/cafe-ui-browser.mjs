// Opt-in visual/DOM acceptance against the fresh compiled bundle, in a NEW
// off-the-record context of a fresh owned Chrome SxS on the approved port 9333.
// Refuses any existing listener; no user target is touched. HTTP uses staging;
// a synthetic WebSocket fixture cannot contact the user's Relay/Pi.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, sha } from './build.mjs';
import { audit, baseEnv, CDP, delay, launch, until } from './native-support.mjs';
import { controls } from './native-browser.mjs';
import { installUiFixture } from './cafe-ui-fixture.mjs';
if (!process.argv.includes('--allow-browser-context')) throw Error('Requires explicit --allow-browser-context; never runs in ordinary tests');
const report={checks:[],viewports:[],network:[],errors:[],realWebSockets:0};
const managedSessions = process.argv.includes('--managed-sessions');
const sidebarManagement = process.argv.includes('--sidebar-management') || managedSessions;
const sessionLayout = process.argv.includes('--session-layout') || sidebarManagement;
const inputAssist = process.argv.includes('--input-assist') || sessionLayout;
const compactChoices = process.argv.includes('--compact-choices') || inputAssist;
const sessionControls = process.argv.includes('--session-controls') || compactChoices;
const workspace = process.argv.includes('--workspace') || sessionControls;
const composerFocus = process.argv.includes('--composer-focus');
const quietControls = process.argv.includes('--quiet-controls') || composerFocus;
const shadcn = process.argv.includes('--shadcn') || quietControls || workspace;
const radix = process.argv.includes('--radix') || shadcn;
const out=join(root, managedSessions ? '.refactor/reports/R18-managed-sessions' : sidebarManagement ? '.refactor/reports/R15-sidebar-management' : sessionLayout ? '.refactor/reports/R15-session-layout' : inputAssist ? '.refactor/reports/R15-input-assist' : compactChoices ? '.refactor/reports/R15-compact-choices' : sessionControls ? '.refactor/reports/R15-session-controls' : workspace ? '.refactor/reports/R15-session-workspace' : composerFocus ? '.refactor/reports/R15-composer-focus' : quietControls ? '.refactor/reports/R15-quiet-controls' : shadcn ? '.refactor/reports/R15-shadcn' : radix ? '.refactor/reports/R15-radix' : '.refactor/reports/R15-cafe-ui');
await mkdir(out,{recursive:true});
const before=await audit();
if(before.listeners.some(p=>p.LocalPort===9333))throw Error('9333 occupied; refusing to attach to or stop an existing browser');
const chromeExecutable=join(process.env.LOCALAPPDATA,'Google/Chrome SxS/Application/chrome.exe');
let context,page,browser,chromeProcess,runDir;
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const assets=new Map();
const collect=async(dir,prefix='')=>{for(const e of await readdir(dir,{withFileTypes:true})){const name=prefix+e.name;if(e.isDirectory())await collect(join(dir,e.name),name+'/');else assets.set('/'+name,{bytes:await readFile(join(dir,e.name)),type:Object.entries(mime).find(([ext])=>name.endsWith(ext))?.[1]??'application/octet-stream'});}};
await collect(join(root,'.refactor/web'));
report.assets=[...assets].map(([path,asset])=>({path,sha256:sha(asset.bytes)}));
const response=await fetch('http://127.0.0.1:37983/',{method:'HEAD',signal:AbortSignal.timeout(5000)});
const csp=response.headers.get('content-security-policy');
assert.ok(csp&&!csp.includes('unsafe-inline')&&!csp.includes('unsafe-eval'),'Strict existing production CSP required');
const seed=JSON.parse(await readFile(join(root,'protocol/fixtures/parts/ordered.json'),'utf8')).expectedFinal;
const check=(label)=>report.checks.push(label);
try {
  runDir=await mkdtemp(join(root,'.refactor/cafe-ui-browser-'));
  const profile=join(runDir,'profile');
  chromeProcess=await launch(chromeExecutable,[`--user-data-dir=${profile}`,'--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9333','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--metrics-recording-only','about:blank'],{marker:profile,cwd:runDir,env:baseEnv()});
  const endpoint=await until(async()=>{try{return await(await fetch('http://127.0.0.1:9333/json/version',{signal:AbortSignal.timeout(500)})).json();}catch{return false;}},'owned Chrome ready');
  assert.ok((await audit()).listeners.some(p=>p.LocalPort===9333&&p.OwningProcess===chromeProcess.record.pid));
  report.browserVersion=endpoint.Browser;
  browser=await new CDP(endpoint.webSocketDebuggerUrl).open();
  context=(await browser.send('Target.createBrowserContext',{disposeOnDetach:true})).browserContextId;
  const {targetId}=await browser.send('Target.createTarget',{url:'about:blank',browserContextId:context,background:true});
  const target=await until(async()=> (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find(t=>t.id===targetId),'owned page target');
  page=await new CDP(target.webSocketDebuggerUrl).open();
  await page.send('Page.enable');await page.send('Runtime.enable');
  await page.send('Page.bringToFront');
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  // Inspect the installed skill specimen in this owned context, not a user tab.
  await page.send('Page.navigate',{url:pathToFileURL(join(process.env.USERPROFILE,'.pi/agent/skills/cafe-design/assets/reference.html')).href});
  await until(()=>page.evaluate(`!!document.querySelector('.specimen-ticket')`),'Cafe offline specimen');
  assert.equal(await page.evaluate(`getComputedStyle(document.body).backgroundColor`),'rgb(29, 25, 21)');
  await page.evaluate(`document.querySelector('#theme-toggle').click()`);
  assert.equal(await page.evaluate(`getComputedStyle(document.body).backgroundColor`),'rgb(250, 247, 242)');
  check('Installed Cafe specimen opened in dark and paper themes');
  await page.send('Network.enable');
  page.on('Network.webSocketCreated',()=>report.realWebSockets++);
  page.on('Runtime.exceptionThrown',e=>report.errors.push(e.exceptionDetails?.text??'runtime exception'));
  page.on('Runtime.consoleAPICalled',e=>{if(e.type==='error')report.errors.push('console.error');});
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${installUiFixture.toString()})(${JSON.stringify(seed)}); document.addEventListener('securitypolicyviolation',e=>{(window.__cafeCsp??=[]).push(e.violatedDirective);});`});
  page.on('Fetch.requestPaused',event=>{
    void (async()=>{
      const url=new URL(event.request.url);let asset;
      if(url.origin==='http://127.0.0.1:37983') {
        if(url.pathname==='/')asset=assets.get('/index.html');
        else if(url.pathname==='/api/config')asset={type:'application/json',bytes:Buffer.from(JSON.stringify({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',managedSessions:true}))};
        else if(url.pathname==='/api/workspace')asset={type:'application/json',bytes:Buffer.from(JSON.stringify(await page.evaluate(`window.__cafeFixture.workspace(${event.request.postData})`)))};
        else asset=assets.get(url.pathname);
      }
      if(!asset){report.errors.push('Unexpected request (blocked)');await page.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;}
      report.network.push(url.pathname);
      await page.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:asset.type},{name:'Content-Security-Policy',value:csp},{name:'X-Content-Type-Options',value:'nosniff'},{name:'Cache-Control',value:'no-store'}],body:asset.bytes.toString('base64')});
    })().catch(e=>report.errors.push(e.message));
  });
  await page.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  const {evaluate,click,input,link}=controls(page);
  const measure=async(label)=>{
    await delay(160);
    const geometry=await evaluate(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,right:r.right};};const send=[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')==='Send');const main=document.querySelector('main');return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,theme:main?.dataset.theme,background:main&&getComputedStyle(main).backgroundColor,send:send&&rect(send),log:document.querySelector('[role="log"]')&&{...rect(document.querySelector('[role="log"]')),usableHeight:document.querySelector('[role="log"]').clientHeight-parseFloat(getComputedStyle(document.querySelector('[role="log"]')).paddingTop)-parseFloat(getComputedStyle(document.querySelector('[role="log"]')).paddingBottom),empty:document.querySelector('[role="log"]').dataset.empty==='true'},horizontalEscapes:[...document.querySelectorAll('button,input,textarea,select,h1,h2')].filter(n=>n.checkVisibility()&&!n.closest('[role="dialog"]')&&!n.classList.contains('sr-only')).filter(n=>{const r=n.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1;}).map(n=>n.tagName)};})()`);
    assert.ok(geometry.overflow<=0,`${label}: document horizontal overflow ${geometry.overflow}`);
    assert.deepEqual(geometry.horizontalEscapes,[],`${label}: visible controls escape viewport`);
    if(geometry.log&&!geometry.log.empty)assert.ok(geometry.log.usableHeight>=48,`${label}: transcript must retain readable scrolling space (${geometry.log.usableHeight}px)`);
    if(geometry.send){assert.ok(geometry.send.w>=60&&geometry.send.h>=39,`${label}: usable send control`);assert.ok(geometry.send.bottom<=geometry.height+1,`${label}: send below viewport`);}
    report.viewports.push({label,...geometry});
  };
  const resize=async(width,height)=>{await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});await delay(120);};
  await page.send('Page.navigate',{url:'http://127.0.0.1:37983/#/rooms/ui-fixture'});
  await until(()=>evaluate(`!!document.querySelector('input[type="password"]')`),'Cafe login');await click('English');
  assert.equal(await evaluate(`document.querySelector('input[aria-label="Room"]')===null`),true);
  await measure('desktop login');await resize(320,640);await measure('320 login');await resize(1440,900);
  await input('Client token','ui-test-token');await click('Connect');
  await until(()=>evaluate(`!![...document.querySelectorAll('button')].find(n=>n.querySelector('strong')?.textContent==='Café design / 界面验收')`),'synthetic inventory');
  await evaluate(`[...document.querySelectorAll('button')].find(n=>n.querySelector('strong')?.textContent==='Café design / 界面验收').click()`);
  await until(()=>evaluate(`!!document.querySelector('textarea')`),'conversation');
  if (workspace) { assert.equal(await evaluate(`document.querySelector('button[aria-label="Project files"]').getAttribute('aria-expanded')`),'false'); await click('Project files'); }
  await click('Load files');await until(()=>evaluate(`!![...document.querySelectorAll('button')].find(n=>n.textContent==='cafe-theme.scss')`),'file inventory');await click('cafe-theme.scss');
  await click('Load history');await until(()=>evaluate(`!![...document.querySelectorAll('a')].find(n=>n.getAttribute('aria-label')==='Archived layout review / 历史界面检查')`),'history inventory');
  if (workspace) await click('Project files');
  await input('Message','Unsent synthetic draft / 保留草稿');
  await evaluate(`window.__toolBefore=document.querySelector('[data-tool-id="t2"]');window.__inputBefore=document.querySelector('textarea');void 0;`);
  for(const theme of ['dark','light']) {
    if(theme==='light')await evaluate(`document.querySelector('button[aria-label="Switch to light theme"]').click()`);
    for(const [width,height] of [[1440,900],[1280,720],[1024,768],[900,700],[720,450],[390,844],[320,640],[640,360]]){await resize(width,height);await measure(`${theme} ${width}×${height}`);
      if(workspace && [1440,390].includes(width)) { await evaluate(`document.activeElement?.blur();document.querySelector('[role="log"]').scrollTop=0;document.querySelector('[role="log"]').dispatchEvent(new Event('scroll'))`); await delay(180); const shot=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(join(out,`workspace-${theme}-${width}.png`),Buffer.from(shot.data,'base64')); }
    }
  }
  assert.equal(await evaluate(`document.querySelector('textarea')===window.__inputBefore&&document.querySelector('textarea').value==='Unsent synthetic draft / 保留草稿'&&document.querySelector('[data-tool-id="t2"]')===window.__toolBefore`),true);
  assert.equal(await evaluate(`window.__cafeFixture.stats().sockets`),1);
  check('Two Cafe themes; desktop, short laptop, tablet, phone, narrow and short viewport geometry; draft/tool DOM retained');
  if (radix) {
    await resize(1440,900);
    for (const theme of ['light','dark']) {
      if (theme === 'dark') await evaluate(`(()=>{const n=document.querySelector('button[aria-label="Switch to dark theme"]');n.focus();n.click();})()`);
      if (shadcn) {
        await evaluate(`[...document.querySelectorAll('header button')].find(n=>n.textContent==='English').focus()`);
        await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      } else await evaluate(`document.querySelector('button[aria-label="Switch to ${theme === 'light' ? 'dark' : 'light'} theme"]').focus()`);
      await until(()=>evaluate(`!!document.querySelector('[role="tooltip"]')`),'UI focus tooltip');
      const info = await evaluate(`(()=>{const n=document.querySelector('[role="tooltip"]'); const visual=n.closest('[data-side]'); const r=visual.getBoundingClientRect(); return {theme:n.closest('[data-theme]')?.dataset.theme,portal:!!n.closest('[data-ui-portal]'),background:getComputedStyle(visual).backgroundColor,x:r.x,y:r.y,right:r.right,bottom:r.bottom};})()`);
      (report.tooltips ??= []).push(info);
      assert.equal(info.theme,theme); assert.equal(info.portal,true);
      assert.equal(info.background,theme==='light'?'rgb(255, 255, 255)':'rgb(34, 26, 21)');
      assert.ok(info.x>=0&&info.y>=0&&info.right<=1440&&info.bottom<=900);
      await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await until(()=>evaluate(`!document.querySelector('[role="tooltip"]')`),'UI tooltip Escape');
      await evaluate(`document.activeElement.blur()`);
      if (quietControls) {
        await evaluate(`[...document.querySelectorAll('summary')].find(n=>n.textContent==='Model and thinking').parentElement.open=true`);
        for (const selector of ['button[aria-label="Load files"]', 'header button', 'button[aria-label="Send"]', '[data-slot="input"]', 'textarea', '[role="combobox"]', 'a[aria-current="page"]', 'summary']) {
          const resting = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const s=getComputedStyle(n);return {background:s.backgroundColor,border:s.borderTopColor,borderWidth:s.borderTopWidth};})()`);
          await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
          await delay(180); // Let the existing focus transition finish before sampling.
          const focused = await evaluate(`(()=>{const n=document.activeElement,s=getComputedStyle(n);return {visible:n.matches(':focus-visible'),outline:s.outlineStyle,outlineWidth:s.outlineWidth,shadow:s.boxShadow,ring:s.getPropertyValue('--tw-ring-shadow')};})()`);
          (report.controlStyles ??= []).push({theme,selector,resting,focused});
          assert.equal(focused.visible,true,`${selector}: keyboard focus visible`);
          if (selector==='textarea') {
            assert.equal(focused.outline,'none'); assert.equal(focused.shadow,'none','Composer must not draw a separate inner focus box');
            for (const [width,height] of [[1440,900],[390,844]]) {
              await resize(width,height);
              await evaluate(`document.querySelector('textarea').focus()`);
              const shell = await evaluate(`(()=>{const n=document.querySelector('textarea').closest('[data-slot="field-group"]'),s=getComputedStyle(n),r=n.getBoundingClientRect(),b=document.querySelector('button[aria-label="Send"]').getBoundingClientRect();return {outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor,offset:s.outlineOffset,containsActions:n.contains(document.querySelector('button[aria-label="Send"]')),bounds:r.left>=0&&r.right<=innerWidth&&r.bottom>=b.bottom&&r.bottom<=innerHeight};})()`);
              assert.equal(shell.outline,'solid'); assert.equal(shell.width,'2px'); assert.equal(shell.offset,'-1px');
              assert.equal(shell.color,theme==='light'?'rgb(109, 71, 38)':'rgb(225, 184, 143)');
              assert.equal(shell.containsActions,true); assert.equal(shell.bounds,true);
              (report.composerFocus ??= []).push({theme,viewport:[width,height],...shell});
              const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
              await writeFile(join(out,`composer-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
            }
            await resize(1440,900);
            // The responsive sidebar remounts when returning from the phone layout.
            await evaluate(`[...document.querySelectorAll('summary')].find(n=>n.textContent==='Model and thinking').parentElement.open=true`);
          } else if (selector==='summary'||selector.startsWith('a[')) {
            assert.equal(focused.outline,'solid'); assert.equal(focused.outlineWidth,'2px'); assert.equal(focused.shadow,'none');
          } else {
            assert.equal(focused.outline,'none',`${selector}: no duplicate outline`);
            assert.ok(focused.ring.includes('2px')&&focused.shadow.includes((theme==='light'?'rgb(109, 71, 38)':'rgb(225, 184, 143)')+' 0px 0px 0px 2px'),`${selector}: shadcn ring retained`);
          }
          if (selector==='button[aria-label="Load files"]') {
            assert.equal(resting.border,'rgba(0, 0, 0, 0)');
            assert.equal(resting.background,theme==='light'?'rgb(247, 243, 239)':'rgb(42, 33, 26)');
          }
          if (selector==='[data-slot="input"]'||selector==='[role="combobox"]') {
            assert.equal(resting.borderWidth,'1px'); assert.notEqual(resting.border,'rgba(0, 0, 0, 0)');
          }
          await evaluate(`document.activeElement.blur()`);
          if (composerFocus) assert.equal(await evaluate(`getComputedStyle(document.querySelector('textarea').closest('[data-slot="field-group"]')).outlineStyle`),'none','No group focus decoration when focus leaves the message input');
        }
        await evaluate(`[...document.querySelectorAll('summary')].find(n=>n.textContent==='Model and thinking').parentElement.open=false`);
      }
    }
    if (quietControls) {
      await page.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
      await evaluate(`document.querySelector('button[aria-label="Load files"]').focus()`);
      await delay(180);
      const forced = await evaluate(`(()=>{const s=getComputedStyle(document.activeElement);return{outline:s.outlineStyle,width:s.outlineWidth,shadow:s.boxShadow};})()`);
      assert.deepEqual(forced,{outline:'solid',width:'2px',shadow:'none'});
      report.forcedColorsFocus=forced;
      if (composerFocus) {
        await evaluate(`document.querySelector('textarea').focus()`);
        const groupFocus=await evaluate(`(()=>{const n=document.querySelector('textarea'),s=getComputedStyle(n),g=getComputedStyle(n.closest('[data-slot="field-group"]'));return {innerOutline:s.outlineStyle,innerShadow:s.boxShadow,outerOutline:g.outlineStyle,outerWidth:g.outlineWidth};})()`);
        assert.deepEqual(groupFocus,{innerOutline:'none',innerShadow:'none',outerOutline:'solid',outerWidth:'2px'});
        report.forcedColorsComposer=groupFocus;
      }
      await page.send('Emulation.setEmulatedMedia',{features:[]});
      await evaluate(`document.activeElement.blur()`);
      check('Soft ordinary buttons, single 2px focus ring, native link/summary focus, thin fields in both themes and forced-colors focus fallback');
      if (composerFocus) check('Composer has one outer focus boundary including actions, no inner box; desktop/mobile and forced colors');
    }
    const hover = await evaluate(`(()=>{const r=document.querySelector('button[aria-label="Switch to light theme"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});
    await until(()=>evaluate(`!!document.querySelector('[role="tooltip"]')`),'UI pointer hover');
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
    // The first leave creates Floating UI's hoverable-content grace polygon. Move
    // beyond that polygon, rather than teleporting once and stopping in it.
    await delay(50);
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:800});
    await until(()=>evaluate(`!document.querySelector('[role="tooltip"]')`),'UI pointer leave');
    check('UI tooltip real focus/hover/Escape, themed portal inheritance and viewport collision bounds');
  }
  await resize(390,844);await click('Pi hosts');await until(()=>evaluate(`!!document.querySelector('[role="dialog"]')`),'hosts drawer');
  await evaluate(`(()=>{const d=document.querySelector('[role="dialog"]');const nodes=[...d.querySelectorAll('button,a[href],input,select,summary')].filter(n=>!n.disabled&&n.checkVisibility());nodes.at(-1).focus();})()`);
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate(`document.activeElement===document.querySelector('[role="dialog"] button')`),true);
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until(()=>evaluate(`!document.querySelector('[role="dialog"]')&&document.activeElement?.textContent==='Pi hosts'`),'drawer focus restored');
  await click('Project files');await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="Project files"]')`),'files drawer');await click('Close');
  if (radix) {
    await click('Pi hosts'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"]')`),'UI drawer reopen');
    assert.equal(await evaluate(`document.querySelector('[role="dialog"]').closest('[data-theme]')?.dataset.theme`),'dark');
    assert.equal(await evaluate(`document.querySelector('header').closest('[aria-hidden="true"]')!==null`),true);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:4,y:100,button:'left',clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:4,y:100,button:'left',clickCount:1});
    await until(()=>evaluate(`!document.querySelector('[role="dialog"]')&&document.activeElement?.textContent==='Pi hosts'`),'UI outside click focus restoration');
    assert.equal(await evaluate(`document.body.style.pointerEvents`),'');
    await click('Pi hosts'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"]')`),'UI resize drawer');
    await resize(1440,900);
    await until(()=>evaluate(`!document.querySelector('[role="dialog"]')&&document.body.style.pointerEvents===''`),'UI breakpoint cleanup');
    assert.equal(await evaluate(`document.querySelector('header').closest('[aria-hidden="true"]')`),null);
    assert.equal(await evaluate(`document.querySelectorAll('style').length`),0);
    await resize(390,844);
    // Restore the light theme expected by the following bilingual checks.
    await evaluate(`document.querySelector('button[aria-label="Switch to light theme"]').click()`);
    check('UI modal drawer hides background from AT, dismisses outside and releases pointer lock');
  }
  check('Mobile host/files drawers, real Tab trap, Escape and focus restoration');
  await resize(1440,900);
  if (workspace) {
    assert.equal(await evaluate(`(()=>{const n=document.querySelector('aside[aria-label="Pi hosts"]');return n.scrollWidth<=n.clientWidth;})()`),true,'Session sidebar has no horizontal overflow');
    await input('Search sessions…','no-matching-session-xyz');
    await until(()=>evaluate(`document.body.textContent.includes('No matching sessions')`),'search empty state');
    await input('Search sessions…','Archived');
    assert.equal(await evaluate(`document.querySelectorAll('a[href*="/history/"]').length`),1);
    await click('Clear search');
    await until(()=>evaluate(`document.querySelectorAll('a[href*="/history/"]').length===5`),'clear search');
    await click('Pi hosts'); assert.equal(await evaluate(`document.querySelector('[data-layout]').dataset.sidebarOpen`),'false');
    assert.equal(await evaluate(`document.querySelector('textarea')===window.__inputBefore`),true);
    await click('Pi hosts');
    await evaluate(`document.querySelector('textarea').focus()`); await delay(180);
    assert.deepEqual(await evaluate(`(()=>{const n=document.querySelector('textarea');return [getComputedStyle(n).boxShadow,getComputedStyle(n.closest('[data-slot="field-group"]')).outlineWidth];})()`),['none','2px']);
    await evaluate(`document.querySelector('[role="log"]').scrollTop=0;document.querySelector('[role="log"]').dispatchEvent(new Event('scroll'))`);
    await click('Jump to latest');
    assert.equal(await evaluate(`(()=>{const n=document.querySelector('[role="log"]');return n.scrollHeight-n.scrollTop-n.clientHeight<80;})()`),true);
    await page.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
    await evaluate(`document.querySelector('textarea').focus()`); await delay(180);
    assert.deepEqual(await evaluate(`(()=>{const n=document.querySelector('textarea'),s=getComputedStyle(n),g=getComputedStyle(n.closest('[data-slot="field-group"]'));return [s.outlineStyle,s.boxShadow,g.outlineStyle,g.outlineWidth];})()`),['none','none','solid','2px']);
    await page.send('Emulation.setEmulatedMedia',{features:[]});
    await click('Model and thinking'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="Model and thinking"]')`),'model drawer');
    assert.equal(await evaluate(`document.querySelector('textarea').value`),'Unsent synthetic draft / 保留草稿');
    if (compactChoices) {
      for (const language of ['en', 'zh']) {
        if (language === 'zh') { await click('Close'); await click('中文'); await click('模型与思考设置'); }
        for (const width of [1440, 390]) {
          await resize(width, 844);
          const dimensions = await evaluate(`(()=>{const n=document.querySelector('[role="dialog"] [role="combobox"]'),f=n.closest('[data-slot="field"]'),r=n.getBoundingClientRect(),g=f.getBoundingClientRect();return {width:r.width,height:r.height,groupHeight:g.height,groupWidth:g.width,direction:getComputedStyle(f).flexDirection};})()`);
          assert.ok(dimensions.width <= 192 && dimensions.height >= 40);
          assert.ok(dimensions.groupHeight <= 44 && dimensions.groupWidth <= 280);
          assert.equal(dimensions.direction,'row');
          (report.compactChoices ??= []).push({kind:'thinking',language,viewport:width,...dimensions});
        }
      }
      await click('关闭'); await click('English'); await resize(1440,900); await click('Model and thinking');
      assert.equal(await evaluate(`!![...document.querySelectorAll('a')].find(n=>n.textContent==='Live conversation')`),false);
    }
    await click('Close');
    check('Session search/clear, default closed files, desktop sidebar collapse preserves draft, jump to latest, single Composer focus and contextual settings');
  }
  await evaluate(`document.querySelector('[role="log"]').scrollTop=0;document.querySelector('[role="log"]').dispatchEvent(new Event('scroll'));`);
  await click('中文');await evaluate(`document.querySelector('button[aria-label="切换到深色主题"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[role="log"]').scrollTop`),0);await click('English');
  await link('Archived layout review / 历史界面检查');await until(()=>evaluate(`document.body.textContent.includes('Read-only history')`),'read-only history');
  if(workspace) { assert.equal(await evaluate(`document.querySelector('a[href*="/history/"][aria-current="page"]')?.getAttribute('aria-label')`),'Archived layout review / 历史界面检查'); const shot=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(join(out,'history-dark-1440.png'),Buffer.from(shot.data,'base64')); }
  assert.equal(await evaluate(`!!document.querySelector('textarea')`),false);assert.equal(await evaluate(`location.hash`),'#/rooms/ui-fixture/history/saved%2F%252F%3Aid');await measure('read-only history');
  await link('Return to live conversation');await until(()=>evaluate(`!!document.querySelector('textarea')`),'live return');
  await evaluate(`window.__cafeFixture.show('empty')`);await until(()=>evaluate(`document.body.textContent.includes('Start a conversation')`),'empty state');await measure('empty conversation');
  await evaluate(`window.__cafeFixture.show('running')`);await until(()=>evaluate(`!!document.querySelector('[role="combobox"][aria-label="Delivery"],select[aria-label="Delivery"]')`),'running delivery');
  await resize(320,640);await measure('running narrow');
  if (compactChoices) {
    for (const language of ['en', 'zh']) {
      if (language === 'zh') await click('中文');
      for (const width of [1440, 390, 320]) {
        await resize(width, 844);
        const dimensions = await evaluate(`(()=>{const n=document.querySelector('form [role="combobox"]'),f=n.closest('[data-slot="field"]'),r=n.getBoundingClientRect(),g=f.getBoundingClientRect();return {width:r.width,height:r.height,groupHeight:g.height,groupWidth:g.width,direction:getComputedStyle(f).flexDirection,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
        assert.ok(dimensions.width <= 192 && dimensions.height >= 40);
        assert.ok(dimensions.groupHeight <= 44 && dimensions.groupWidth <= 280);
        assert.equal(dimensions.direction,'row'); assert.equal(dimensions.overflow,0);
        (report.compactChoices ??= []).push({kind:'delivery',language,viewport:width,...dimensions});
        const shot=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(join(out,`delivery-${language}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
    }
    await click('English'); await resize(320,640);
    check('No redundant live link; thinking/delivery choices are compact single rows in both languages at desktop/phone/narrow widths, with 40px targets');
  }
  if (shadcn) {
    const key = async (name, code) => { await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:name,code:name,windowsVirtualKeyCode:code}); await page.send('Input.dispatchKeyEvent', {type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code}); };
    await input('Message', 'Synthetic follow-up');
    assert.equal(await evaluate(`document.querySelector('button[aria-label="Send"]').disabled`), true);
    const commandCount = await evaluate(`window.__cafeFixture.stats().commands`);
    await evaluate(`document.querySelector('[role="combobox"][aria-label="Delivery"]').focus()`);
    await key('ArrowDown',40);
    await until(()=>evaluate(`!!document.querySelector('[data-slot="select-content"][data-open]')`),'shadcn keyboard opens Select');
    const selectInfo = await evaluate(`(()=>{const n=document.querySelector('[data-slot="select-content"]');const r=n.getBoundingClientRect();return {theme:n.closest('[data-theme]')?.dataset.theme,portal:!!n.closest('[data-ui-portal]'),x:r.x,right:r.right,y:r.y,bottom:r.bottom,background:getComputedStyle(n).backgroundColor};})()`);
    assert.equal(selectInfo.portal,true); assert.equal(selectInfo.theme,'dark');
    assert.equal(selectInfo.background,'rgb(34, 26, 21)');
    assert.ok(selectInfo.x>=0&&selectInfo.right<=320&&selectInfo.y>=0&&selectInfo.bottom<=640,'Select collision bounds');
    await until(()=>evaluate(`document.activeElement?.getAttribute('role')==='option'&&!!document.activeElement.closest('[data-slot="select-content"][data-open]')`),'delivery Select initial focus');
    await key('End',35);
    await until(()=>evaluate(`document.activeElement?.textContent==='Follow up'`),'End focuses followUp');
    await key('Enter',13);
    await until(()=>evaluate(`document.querySelector('[role="combobox"][aria-label="Delivery"]').getAttribute('aria-expanded')==='false'&&document.querySelector('[role="combobox"][aria-label="Delivery"]').textContent.includes('Follow up')&&![...document.querySelectorAll('[role="listbox"]')].some(n=>n.checkVisibility())`),'Select keyboard commits followUp');
    assert.equal(await evaluate(`window.__cafeFixture.stats().commands`), commandCount, 'selection alone must not send');
    await click('Send');
    assert.deepEqual(await evaluate(`window.__cafeFixture.stats().payloads.at(-1)`),{name:'prompt',content:'Synthetic follow-up',delivery:'followUp'});
    await until(()=>evaluate(`document.querySelector('textarea').value===''`),'followUp acknowledgement');
    await click(workspace ? 'Model and thinking' : 'Pi hosts'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"]')`),'Sheet for nested Select');
    await evaluate(`document.querySelector('[role="dialog"] details').open=true;document.querySelector('[role="combobox"][aria-label="Thinking level"]').focus()`);
    await key('ArrowDown',40); await until(()=>evaluate(`!!document.querySelector('[data-slot="select-content"][data-open]')`),'nested Select open');
    await key('Escape',27); await until(()=>evaluate(`![...document.querySelectorAll('[role="listbox"]')].some(n=>n.checkVisibility())`),'Escape closes only Select');
    assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`),true);
    await key('ArrowDown',40); await until(()=>evaluate(`!!document.querySelector('[data-slot="select-content"][data-open]')`),'nested Select reopen');
    await until(()=>evaluate(`document.activeElement?.getAttribute('role')==='option'&&!!document.activeElement.closest('[data-slot="select-content"][data-open]')`),'nested Select initial focus');
    await key('End',35);
    await until(()=>evaluate(`document.activeElement?.textContent==='max'`),'End focuses last thinking option');
    await key('Enter',13);
    await until(()=>evaluate(`window.__cafeFixture.stats().payloads.at(-1)?.name==='set_thinking'`),'thinking command');
    assert.deepEqual(await evaluate(`window.__cafeFixture.stats().payloads.at(-1)`),{name:'set_thinking',level:'max'});
    await key('Escape',27); await until(()=>evaluate(`!document.querySelector('[role="dialog"]')`),'Sheet closes after nested Select');
    assert.equal(await evaluate(`document.querySelectorAll('style').length`),0);
    report.shadcnSelect=selectInfo;
    check('shadcn/Base Select keyboard, nested Sheet Escape, themed portal, collision, explicit delivery and thinking Gateway payloads');
  }
  await evaluate(`window.__cafeFixture.show('waiting')`);await until(()=>evaluate(`document.body.textContent.includes('Waiting for input in local Pi')`),'local UI wait');await measure('local Pi waiting narrow');
  await evaluate(`window.__cafeFixture.show('content')`);await until(()=>evaluate(`!document.querySelector('[role="combobox"][aria-label="Delivery"],select[aria-label="Delivery"]')`),'idle');await resize(1440,900);
  await input('Message','Synthetic send; no real Relay or model');
  const buttonRect=()=>evaluate(`(()=>{const r=document.querySelector('button[aria-label="Send"]').getBoundingClientRect();return [r.width,r.height];})()`);
  const originalRect=await buttonRect();await click('Send');assert.equal(await evaluate(`document.querySelector('button[aria-label="Send"]').getAttribute('aria-busy')`),'true');assert.deepEqual(await buttonRect(),originalRect);
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.cafe-steam path')).animationName`),'none');
  await until(()=>evaluate(`document.querySelector('textarea').value===''`),'synthetic acknowledgement');
  check('Read-only opaque history, empty/running/local-UI-wait states, stable loading button, reduced motion');
  if (sessionControls) {
    await input('Message', 'Keep draft until switch');
    const escape = async () => { await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); };
    for (const width of [1440, 390, 320]) {
      await resize(width, 844);
      if (width < 1024) await click('Pi hosts');
      await click('New session');
      await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="New session"]')&&document.activeElement?.id==='managed-session-name'`),'new session confirmation and usable field focus');
      assert.equal(await evaluate(`(()=>{const n=document.querySelector('[role="dialog"][aria-label="New session"]');const r=n.getBoundingClientRect();return n.scrollWidth<=n.clientWidth&&r.left>=0&&r.right<=innerWidth;})()`),true);
      await escape();
      await until(()=>evaluate(`!document.querySelector('[role="dialog"][aria-label="New session"]')`),'cancel new session');
      assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label') === 'New session'`), true);
      if (width < 1024) { assert.equal(await evaluate(`!!document.querySelector('[role="dialog"][aria-label="Pi hosts"]')`),true); await escape(); }
      assert.equal(await evaluate(`document.querySelector('textarea').value`),'Keep draft until switch');
    }
    await resize(1440,900);
    await click('Rename current session'); await input('Session name','Renamed synthetic session'); await click('Save');
    await until(()=>evaluate(`!document.querySelector('[role="dialog"]')&&document.querySelector('h2[title]')?.textContent==='Renamed synthetic session'`),'native rename projection fixture');
    assert.equal(await evaluate(`document.querySelector('textarea').value`),'Keep draft until switch');
    await click('New session'); await input('Session name','Independent background session'); await click('Create');
    await until(()=>evaluate(`document.body.textContent.includes('Start a conversation')&&document.querySelector('textarea')?.value===''`),'independent scope clears draft');
    assert.equal(await evaluate(`window.__cafeFixture.stats().payloads.some(p=>p.name==='new_session')`),false,'new must never switch the original client');
    await evaluate(`[...document.querySelectorAll('button')].find(n=>n.querySelector('strong')?.textContent==='Renamed synthetic session').click();window.__cafeFixture.original();`);
    await until(()=>evaluate(`document.querySelector('h2[title]')?.textContent==='Renamed synthetic session'`),'original session retained');
    await link('Archived layout review / 历史界面检查');
    await until(()=>evaluate(`!![...document.querySelectorAll('button')].find(n=>n.textContent==='Continue this session'&&!n.disabled)`),'history continuation available');
    await click('Continue this session'); await click('Confirm');
    await until(()=>evaluate(`location.hash==='#/rooms/ui-fixture'&&!!document.querySelector('textarea')`),'continue returns live');
    assert.ok((await evaluate(`window.__cafeFixture.stats().payloads`)).some(p=>p.name==='resume_session'&&p.sessionId==='saved/%2F:id'));
    check('Session controls: desktop/mobile compact confirmation Escape and focus return, rename preserves draft, Pi cancellation feedback, new scope clears draft, opaque history continues into live view');
  }
  if (sessionLayout) {
    report.sessionLayout = [];report.managedLayout=[];
    for (const language of ['en', 'zh']) {
      await click(language === 'en' ? 'English' : '中文');
      const labels = language === 'en' ? { title:'Client instances', header:'Current session', create:'New session', rename:'Rename current session', cancel:'Cancel', field:'Session name' } : { title:'客户端实例', header:'当前会话', create:'新建会话', rename:'重命名当前会话', cancel:'取消', field:'会话名称' };
      for (const theme of ['dark', 'light']) {
        if (await evaluate(`document.querySelector('main').dataset.theme`) !== theme) await click(language === 'en' ? (theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme') : (theme === 'light' ? '切换到浅色主题' : '切换到深色主题'));
        for (const [width,height] of [[1440,900],[390,844],[320,640],[640,360]]) {
          await resize(width,height);
          assert.equal(await evaluate(`!!document.querySelector('header[aria-label=${JSON.stringify(labels.header)}] button')`),false);
          if(width<1024) await click(language === 'en' ? 'Pi hosts' : 'Pi 实例');
          assert.equal(await evaluate(`!!document.querySelector('aside button[aria-label=${JSON.stringify(labels.rename)}], [role="dialog"] button[aria-label=${JSON.stringify(labels.rename)}]')`),true);
          if(width>=1024) assert.equal(await evaluate(`!![...document.querySelectorAll('aside h2')].find(n=>n.textContent===${JSON.stringify(labels.title)})`),true);
          await click(labels.rename);
          await until(()=>evaluate(`document.activeElement?.tagName==='INPUT'`),'rename input autofocus');
          const geometry = await evaluate(`(()=>{const n=document.querySelector('[role="dialog"][aria-label=${JSON.stringify(labels.rename)}]'),r=n.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,overflow:n.scrollWidth-n.clientWidth};})()`);
          assert.ok(geometry.width<=421&&geometry.left>=0&&geometry.right<=width&&geometry.top>=0&&geometry.bottom<=height&&geometry.overflow<=0);
          assert.ok(Math.abs((geometry.left+geometry.right)/2-width/2)<2);
          report.sessionLayout.push({language,theme,width,height,...geometry});
          if(language==='zh') await writeFile(join(out,`rename-${theme}-${width}.png`),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
          await click(labels.cancel);
          assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(labels.rename)}`),true);
          if(language==='zh') await writeFile(join(out,`sidebar-${theme}-${width}.png`),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
          if(managedSessions){
            await click(labels.create);
            await until(()=>evaluate(`document.activeElement?.id==='managed-session-name'`),'managed name autofocus');
            const g=await evaluate(`(()=>{const n=document.querySelector('[role="dialog"][aria-label=${JSON.stringify(labels.create)}]'),r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,overflow:n.scrollWidth-n.clientWidth,project:!!n.querySelector('[role="combobox"]'),field:!!n.querySelector('input[maxlength="256"]')};})()`);
            assert.ok(g.width<=421&&g.left>=0&&g.right<=width&&g.top>=0&&g.bottom<=height&&g.overflow<=0&&g.project&&g.field);
            report.managedLayout.push({language,theme,width,height,...g});
            if(language==='zh')await writeFile(join(out,`new-independent-${theme}-${width}.png`),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
            await click(labels.cancel);assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(labels.create)}`),true);
          }
          if(width<1024) await click(language === 'en' ? 'Close' : '关闭');
        }
      }
    }
    await click('English'); await resize(1440,900);
    check('Session layout: management actions only in sidebar/drawer, none in conversation header; centered compact forms, rename autofocus, cancel/focus return in both languages/themes at desktop, phone and short viewport');
  }
  if (inputAssist) {
    const key = async (name, code) => { await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:name,code:name,windowsVirtualKeyCode:code}); await page.send('Input.dispatchKeyEvent', {type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code}); };
    await evaluate(`window.__cafeFixture.show('content')`);
    await until(()=>evaluate(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`),'input host ready');
    for (const theme of ['dark', 'light']) {
      const toggle = theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme';
      await evaluate(`document.querySelector('button[aria-label="${toggle}"]')?.click()`);
      for (const [width,height] of [[1440,900],[390,844],[320,640],[640,360]]) {
        await resize(width,height); await input('Message',''); await evaluate(`document.querySelector('textarea').focus()`); await input('Message','/');
        await until(()=>evaluate(`!![...document.querySelectorAll('[role="option"]')].find(n=>n.textContent.includes('/review'))`),'native command suggestions');
        const bounds = await evaluate(`(()=>{const n=document.querySelector('[role="listbox"]').parentElement,r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth-innerWidth};})()`);
        assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=height); assert.equal(bounds.overflow,0);
        await measure(`input completion ${theme} ${width}x${height}`);
        const shot=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(join(out,`input-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        await key('Escape',27); assert.equal(await evaluate(`!!document.querySelector('[role="listbox"]')`),false);
      }
    }
    await resize(1440,900);
    const writesBefore = await evaluate(`window.__cafeFixture.stats().payloads.filter(p=>!['list_commands','list_dir','list_sessions','get_session','read_file'].includes(p.name)).length`);
    await input('Message','/rev');
    await until(()=>evaluate(`document.querySelector('[role="option"] strong')?.textContent==='/review'`),'filtered slash');
    await key('Tab',9); assert.equal(await evaluate(`document.querySelector('textarea').value`),'/review ');
    assert.equal(await evaluate(`window.__cafeFixture.stats().payloads.filter(p=>!['list_commands','list_dir','list_sessions','get_session','read_file'].includes(p.name)).length`),writesBefore);
    await key('Enter',13);
    await until(()=>evaluate(`document.querySelector('textarea').value===''`),'slash dispatched');
    assert.deepEqual(await evaluate(`window.__cafeFixture.stats().payloads.at(-1)`),{name:'run_command',command:'/review'});
    await input('Message','/unknown'); await key('Escape',27); await click('Send');
    await until(()=>evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('COMMAND_UNAVAILABLE')`),'unknown command error');
    assert.equal(await evaluate(`document.querySelector('textarea').value`),'/unknown');
    await input('Message','/model'); await click('Send'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="Model and thinking"]')`),'slash model sheet'); await click('Close');
    await input('Message','/name From slash'); await click('Send'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="Rename current session"]')`),'slash rename confirmation');
    assert.equal(await evaluate(`document.querySelector('[role="dialog"] input').value`),'From slash'); await click('Close');
    await input('Message','/new'); await click('Send'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="New session"]')`),'slash new confirmation'); await click('Close');
    await input('Message','/resume'); await click('Send'); await until(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="History"] a[href*="/history/"]')`),'slash history picker'); await click('Close');
    await evaluate(`document.querySelector('textarea').focus()`); await input('Message','Review @src/');
    await until(()=>evaluate(`!![...document.querySelectorAll('[role="option"]')].find(n=>n.querySelector('strong')?.textContent==='note 中文.txt')`),'nested path suggestions');
    // Real pointer selection must retain textarea focus, not lose the popup on blur.
    const point=await evaluate(`(()=>{const n=[...document.querySelectorAll('[role="option"]')].find(n=>n.querySelector('strong')?.textContent==='note 中文.txt');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+20,y:r.y+r.height/2};})()`);
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1}); await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await until(()=>evaluate(`document.querySelector('textarea').value==='Review @"src/note 中文.txt" '`),'quoted file insertion');
    assert.equal(await evaluate(`document.activeElement===document.querySelector('textarea')`),true);
    await click('Send'); await until(()=>evaluate(`document.querySelector('textarea').value===''`),'reference dispatched');
    assert.deepEqual(await evaluate(`window.__cafeFixture.stats().payloads.at(-1)`),{name:'prompt',content:'Review @"src/note 中文.txt" ',files:['src/note 中文.txt']});
    await evaluate(`window.__cafeFixture.inputAssist(false)`); await input('Message','/review'); await click('Send');
    await until(()=>evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('INPUT_ASSIST_UNAVAILABLE')`),'old host gated');
    assert.equal(await evaluate(`document.querySelector('textarea').value`),'/review');
    await evaluate(`window.__cafeFixture.inputAssist(true)`); await input('Message','');
    check('Input assistance: slash discovery/filter/Tab/Enter, unknown and old-host rejection, native command payload, existing action Sheets, quoted @ subdirectory reference and pointer focus, both themes at desktop/mobile/short sizes');
  }
  await evaluate(`window.__cafeFixture.rejectAuth()`);await until(()=>evaluate(`!!document.querySelector('input[type="password"]')`),'authentication failure login');
  assert.equal(await evaluate(`sessionStorage.getItem('pi-collab-token')`),null);await resize(320,640);await measure('auth failure login');
  await evaluate(`location.hash='#/rooms/'+ 'room'.repeat(16)`);await until(()=>evaluate(`document.querySelector('form strong')?.textContent.length===64`),'long room bookmark');await measure('64-character room login');
  check('Authentication failure revokes token; long room names remain bounded');
  assert.equal(await evaluate(`location.href.includes('ui-test-token')`),false);
  assert.deepEqual(await evaluate(`window.__cafeCsp??[]`),[]);
  report.fixture=await evaluate(`window.__cafeFixture.stats()`);
  assert.equal(report.realWebSockets,0);assert.deepEqual(report.errors,[]);
  check('Strict production CSP, no external assets, no native WebSocket, no real Pi/provider requests');
  report.status='passed';
} catch(error) {report.status='failed';report.failure=error.message;
  report.diagnostic=await page?.evaluate(`({active:document.activeElement?.outerHTML, popups:[...document.querySelectorAll('[data-slot="tooltip-content"],[data-slot="select-content"],[role="tooltip"]')].map(n=>({html:n.outerHTML,display:getComputedStyle(n).display,animation:getComputedStyle(n).animation,animations:n.getAnimations().map(a=>({state:a.playState,timing:a.effect.getTiming()}))})),  csp:window.__cafeCsp??[]})`).catch(()=>null);
  throw error;}
finally {
  await writeFile(join(out,'browser.json'),JSON.stringify(report,null,2));
  page?.close();
  if(context)await browser.send('Target.disposeBrowserContext',{browserContextId:context});
  browser?.close();
  if(chromeProcess)await chromeProcess.stop();
  if(runDir)await until(async()=>(await audit(runDir)).remaining.length===0,'owned Chrome subprocesses exited');
  if(runDir)await rm(runDir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  const after=await audit();assert.deepEqual(after.listeners,before.listeners,'Existing listener owners must remain unchanged');
  report.existingListenersUnchanged=true;report.ownedBrowserContextDisposed=true;
  await writeFile(join(out,'browser.json'),JSON.stringify(report,null,2));
}
console.log(`PASS: ${report.checks.length} Cafe UI browser checks, ${report.viewports.length} layout samples; owned isolated context disposed; no live Relay/Pi commands.`);
