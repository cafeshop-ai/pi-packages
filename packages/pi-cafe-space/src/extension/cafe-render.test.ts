import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jsQR from 'jsqr';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CafePanel, qrLines, qrMatrix, qrPreviewHTML, visibleWidth } from './cafe-render.js';
import { browserAction, clipboardAction, createQrPreview, previewBrowserAction } from './cafe-actions.js';
const key = (() => { const pair=generateKeyPairSync('ec',{namedCurve:'P-256'}); const jwk=pair.publicKey.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64url'); })();
const url='https://space.example/#/room/'+key;
afterEach(()=>vi.unstubAllEnvs());
function raster(lines: string[], cellWidth=14, cellHeight=28, gapTop=0, gapBottom=0, gapRight=0) {
 const width=Math.max(...lines.map(visibleWidth))*cellWidth,height=lines.length*cellHeight;
 const data=new Uint8ClampedArray(width*height*4);data.fill(255);
 const fill=(left:number,top:number,right:number,bottom:number,color:number)=>{for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=color;}};
 lines.forEach((line,row)=>{let bg=255,fg=0,col=0;for(const match of line.matchAll(/\x1b\[([0-9;]*)m|([\s\S])/g)){
  if(match[1]!==undefined){const p=match[1].split(';').map(Number);for(let i=0;i<p.length;i++){if(p[i]===0){bg=255;fg=0;}else if((p[i]===48||p[i]===38)&&p[i+1]===2){if(p[i]===48)bg=p[i+2]!;else fg=p[i+2]!;i+=4;}}continue;}
  const char=match[2]!,x=col++*cellWidth,y=row*cellHeight;fill(x,y,x+cellWidth,y+cellHeight,bg);
  const start=y+gapTop,end=y+cellHeight-gapBottom,mid=start+Math.floor((end-start)/2);
  if(char==='█')fill(x,start,x+cellWidth-gapRight,end,fg);else if(char==='▀')fill(x,start,x+cellWidth-gapRight,mid,fg);else if(char==='▄')fill(x,mid,x+cellWidth-gapRight,end,fg);
 }});return{data,width,height};
}
function decode(lines:string[],...metrics:Parameters<typeof raster> extends [string[],...infer P]?P:never){const p=raster(lines,...metrics);return jsQR(p.data,p.width,p.height)?.data;}
it.each([[14,28,0,0,0],[12,24,4,0,1]])('ANSI QR survives real terminal cell metrics %j',(...metrics)=>{
 const matrix=qrMatrix(url);expect(decode(qrLines(matrix,false),...metrics)).toBe(url);
 for(let i=0;i<matrix.length;i++){expect(matrix[0]![i]).toBe(false);expect(matrix[3]![i]).toBe(false);expect(matrix[matrix.length-1]![i]).toBe(false);}
});
it('the old foreground-only glyphs fail with screenshot-like font gaps',()=>{
 const matrix=qrMatrix(url),old:string[]=[];for(let row=0;row<matrix.length;row+=2){let line='\x1b[38;2;0;0;0m\x1b[48;2;255;255;255m';for(let col=0;col<matrix.length;col++){const a=matrix[row]?.[col],b=matrix[row+1]?.[col];line+=a?(b?'█':'▀'):(b?'▄':' ');}old.push(line+'\x1b[0m');}
 expect(decode(old,14,28,5,1,1)).not.toBe(url);
});
it('solid QR uses only full-cell backgrounds, independent of glyph gaps',()=>{
 const lines=qrLines(qrMatrix(url),true);expect(lines.join('').replace(/\x1b\[[0-9;]*m/g,'')).toMatch(/^ +$/);expect(decode(lines,14,28,8,8,8)).toBe(url);
});
it('Apple Terminal 96×36 defaults to reliable solid mode and shows the preview alternative, never a clipped glyph QR',()=>{
 vi.stubEnv('TERM_PROGRAM','Apple_Terminal');const done=vi.fn();
 const panel=new CafePanel({title:'Share',subtitle:'Online',details:[],invitation:url,sharing:true,items:[{action:'preview',label:'Preview'},{action:'copy',label:'Copy'},{action:'open',label:'Open'},{action:'back',label:'Back'}]},()=>36,{title:s=>s,muted:s=>s,selected:s=>s},()=>{},done);
 panel.handleInput('Q');const view=panel.render(96).join('');expect(view).toContain('需要至少');expect(view).toContain('按 P');expect(view).not.toContain('\x1b[48;2;0;0;0m');panel.handleInput('P');expect(done).toHaveBeenCalledWith('preview');
});
it('solid mode decodes under the measured screenshot line spacing',()=>{expect(decode(qrLines(qrMatrix(url),true),14,28,5,1,1)).toBe(url);});
it('preview is static, private, exact-link-only and explicitly disposable',async()=>{
 const html=qrPreviewHTML(url);expect(html).toContain('shape-rendering="crispEdges"');expect(html).toContain("default-src 'none'");expect(html).toContain(url);expect(html).not.toMatch(/<script|<iframe|<img[^>]+src=/);
 expect(()=>qrPreviewHTML(url+'?password=secret')).toThrow();expect(()=>qrPreviewHTML(url.replace('https:','javascript:'))).toThrow();
 const file=await createQrPreview(url);try{expect(await readFile(file.path,'utf8')).toBe(html);if(process.platform!=='win32'){expect((await stat(file.path)).mode&0o777).toBe(0o600);expect((await stat(dirname(file.path))).mode&0o777).toBe(0o700);}expect(previewBrowserAction(file.path,'darwin',{SSH_TTY:'test'})).toBeNull();expect(previewBrowserAction(file.path,'darwin',{})?.command).toBe('/usr/bin/open');}finally{await file.dispose();}await expect(stat(file.path)).rejects.toThrow();
});
it.each([[120,60],[80,40],[40,24],[20,12]])('menu fits %s columns and %s rows without clipped QR', (width,rows)=>{
 const done=vi.fn(),redraw=vi.fn(),style={title:(s:string)=>s,muted:(s:string)=>s,selected:(s:string)=>s};
 const panel=new CafePanel({title:'Café Space · 分享房间',subtitle:'房间在线',details:['共享的是同一房间中的多个 Pi。'],invitation:url,sharing:true,items:[{action:'copy',label:'复制链接'},{action:'open',label:'打开网页'},{action:'back',label:'返回'}]},()=>rows,style,redraw,done);
 const lines=panel.render(width);expect(lines.length).toBeLessThanOrEqual(rows-2);for(const l of lines)expect(visibleWidth(l)).toBeLessThanOrEqual(width);
 panel.handleInput('c');expect(done).toHaveBeenCalledExactlyOnceWith('copy');panel.handleInput('b');expect(done).toHaveBeenCalledTimes(1);
});
it('escape from QR returns to menu without external action',()=>{
 const done=vi.fn();const panel=new CafePanel({title:'Share',subtitle:'Online',details:[],invitation:url,sharing:true,items:[{action:'copy',label:'Copy'},{action:'back',label:'Back'}]},()=>60,{title:s=>s,muted:s=>s,selected:s=>s},()=>{},done);
 panel.handleInput('q');panel.handleInput('\x1b');expect(done).not.toHaveBeenCalled();panel.handleInput('\x1b');expect(done).toHaveBeenCalledWith('back');
});
it('external actions are explicit argv/stdin and unavailable in SSH',async()=>{
 expect(browserAction('http://127.0.0.1:37891/#/rooms/main?panel=share','darwin',{})).toEqual({command:'/usr/bin/open',args:['http://127.0.0.1:37891/#/rooms/main?panel=share']});
 expect(browserAction('http://127.0.0.1:37891/','darwin',{SSH_CONNECTION:'present'})).toBeNull();
 expect(await clipboardAction(url,'darwin',{SSH_TTY:'/dev/pts/1'})).toBeNull();
 expect(await clipboardAction(url,'darwin',{})).toEqual({command:'/usr/bin/pbcopy',args:[],input:url});
 for(const target of ['https://evil.example','http://user:pass@127.0.0.1:37891/','http://127.0.0.1:37891/?token=secret'])expect(()=>browserAction(target,'darwin',{})).toThrow();
 expect((await clipboardAction(url,'win32',{}))?.args.join(' ')).not.toContain(url);
});
