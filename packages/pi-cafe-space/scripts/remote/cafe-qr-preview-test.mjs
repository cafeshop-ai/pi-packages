import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
const { values } = parseArgs({ strict:true, options:{ renderer:{type:'string'}, browser:{type:'string'}, report:{type:'string'} } });
assert(values.renderer&&values.browser&&values.report);
const { qrPreviewHTML }=await import(pathToFileURL(resolve(values.renderer)));
const jwk=generateKeyPairSync('ec',{namedCurve:'P-256'}).publicKey.export({format:'jwk'});
const key=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');
const url='https://space.cafecode.work/#/room/'+key,dir=await mkdtemp(join(tmpdir(),'cafe-qr-pixels-')),path=join(dir,'room-qr.html');
await mkdir(values.report,{recursive:true});await writeFile(path,qrPreviewHTML(url),{mode:0o600});
let browser;const results=[];
try {
 browser=await chromium.launch({executablePath:values.browser,headless:true,chromiumSandbox:true});
 for(const [width,height]of [[1100,900],[390,844],[320,568]]) {
  const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();const requests=[];page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  await page.goto(pathToFileURL(path).href);
  const code=page.locator('svg');const screenshot=await code.screenshot();
  // Decode the screenshot's pixels, not the SVG path or QR source matrix.
  const dataURL='data:image/png;base64,'+screenshot.toString('base64');
  const decoder=await context.newPage();
  const pixels=await decoder.evaluate(async imageURL=>{const image=new Image();image.src=imageURL;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return{width:image.width,height:image.height,data:Array.from(context.getImageData(0,0,image.width,image.height).data)};},dataURL);
  const decoded=jsQR(Uint8ClampedArray.from(pixels.data),pixels.width,pixels.height);
  assert.equal(decoded?.data,url,'Screenshot QR must decode to the invitation');assert.equal(await page.locator('a').getAttribute('href'),url);assert.deepEqual(requests,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(values.report,`preview-${width}.png`),fullPage:true});
  results.push({viewport:[width,height],decodedScreenshot:true,exactInvitation:true,noExternalRequests:true});await context.close();
 }
 await writeFile(join(values.report,'result.json'),JSON.stringify({passed:true,results,scope:'real browser PNG pixels and jsQR, no physical phone camera'},null,2));console.log(JSON.stringify({passed:true,results}));
}finally{await browser?.close();await rm(dir,{recursive:true,force:true});}
