import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
const root=fileURLToPath(new URL('../../',import.meta.url));
const css=compile(join(root,'web/src/styles/tokens.scss')).css;
const blocks=[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
const vars=block=>Object.fromEntries([...block.matchAll(/(--cafe-[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
const dark=vars(blocks[0][2]);const light={...dark,...vars(blocks[1][2])};
const luminance=hex=>hex.slice(1).match(/../g).map(n=>parseInt(n,16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
test('Cafe workspace palette has one semantic source for both themes',()=>{
 assert.equal(dark['--cafe-page'],'#1a1511');assert.equal(dark['--cafe-surface'],'#221a15');assert.equal(dark['--cafe-accent'],'#e1b88f');
 assert.equal(light['--cafe-page'],'#faf7f4');assert.equal(light['--cafe-surface'],'#ffffff');assert.equal(light['--cafe-accent'],'#6d4726');
 assert.notEqual(dark['--cafe-accent'],dark['--cafe-action']);
 for(const theme of [dark,light])for(const name of ['serif','sans','mono','ease','radius-control','radius-panel','sidebar-width','files-width'])assert.ok(theme['--cafe-'+name],name);
});
test('normal text, status text, primary labels and control boundaries meet contrast targets in both themes',()=>{
 for(const [name,theme] of [['dark',dark],['light',light]]) {
  for(const surface of ['page','surface','surface-secondary']) {
   for(const text of ['ink','muted','accent','success','danger','warning']) assert.ok(contrast(theme['--cafe-'+text],theme['--cafe-'+surface])>=4.5,`${name}: ${text} on ${surface}`);
   assert.ok(contrast(theme['--cafe-control-line'],theme['--cafe-'+surface])>=3,`${name}: controls on ${surface}`);
  }
  for(const fill of ['action','action-end']) assert.ok(contrast(theme['--cafe-action-ink'],theme['--cafe-'+fill])>=4.5,`${name}: action label`);
 }
});
test('component SCSS uses semantic tokens, not local color palettes or remote fonts',()=>{
 const visit=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.name.endsWith('.scss')&&entry.name!=='tokens.scss'){
  const text=readFileSync(path,'utf8');assert.doesNotMatch(text,/#(?:[0-9a-f]{3,8})\b|\b(?:rgb|hsl)a?\(/i,path);assert.doesNotMatch(text,/@import|https?:\/\//i,path);
 }}};visit(join(root,'web/src'));
});
test('first paint and installed-app shell use the workspace default, not the old blue theme',()=>{
 assert.match(readFileSync(join(root,'web/index.html'),'utf8'),/name="theme-color" content="#1a1511"/);
 const manifest=JSON.parse(readFileSync(join(root,'web/static/manifest.webmanifest'),'utf8'));assert.equal(manifest.theme_color,dark['--cafe-page']);assert.equal(manifest.background_color,dark['--cafe-page']);
 assert.doesNotThrow(()=>compile(join(root,'web/src/styles/global.scss')));
});
