import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localRelayHealthy, localRelayEnvironment, type LocalRelayConfig, type LocalRelayStatus } from './local-relay.js';
const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export function goPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  return ({ 'win32-x64': 'windows-amd64', 'linux-x64': 'linux-amd64', 'linux-arm64': 'linux-arm64', 'darwin-x64': 'darwin-amd64', 'darwin-arm64': 'darwin-arm64' } as Record<string,string>)[`${platform}-${arch}`] ?? null;
}
export function localGoTarget(config: LocalRelayConfig): { url: URL; health: URL; bind: string; port: string } | null {
  if (!config || typeof config.relayUrl !== 'string' || typeof config.hostToken !== 'string' || config.relayUrl.length > 8192 || config.hostToken.length > 4096 || !config.hostToken.trim()) return null;
  try {
    const url = new URL(config.relayUrl);
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(config.relayUrl.trim())?.[1];
    if (authority?.includes('@') || /[?#]/.test(config.relayUrl) || url.username || url.password || url.protocol !== 'ws:' || url.port === '0' || url.pathname !== '/ws' || !['127.0.0.1','localhost','[::1]','::1'].includes(url.hostname)) return null;
    const health = new URL(url); health.protocol = 'http:'; health.pathname = '/healthz';
    return { url, health, bind: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/[\[\]]/g,''), port: url.port || '80' };
  } catch { return null; }
}
async function ordinary(path: string, directory = false): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('Untrusted relay path');
}
export async function trustedGoBinary(packageRoot: string): Promise<string> {
  const tag = goPlatform(); if (!tag) throw Error('Unsupported relay platform');
  const root = await realpath(packageRoot); let path = root;
  for (const segment of ['dist','relay','bin',tag]) { path = join(path,segment); await ordinary(path,true); }
  const metaPath=join(root,'dist/relay/build.json');await ordinary(metaPath);if((await lstat(metaPath)).size>65536)throw Error('Invalid build metadata');
  const metadata=JSON.parse(await readFile(metaPath,'utf8'));const record=metadata.platforms?.[tag];
  if(!record || record.platform!==tag || record.version!==metadata.version || record.webDigest!==metadata.webDigest)throw Error('Matching relay binary is missing');
  const binary=join(path,tag.startsWith('windows')?'pi-cafe-relay.exe':'pi-cafe-relay');await ordinary(binary);const stat=await lstat(binary);
  if(stat.nlink!==1 || stat.size>64*1024*1024)throw Error('Invalid relay executable');
  const bytes=await readFile(binary);if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Relay checksum mismatch');
  if(tag==='windows-amd64') { if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ')throw Error('Wrong relay executable');const offset=bytes.readUInt32LE(60);if(offset+6>bytes.length || bytes.toString('hex',offset,offset+4)!=='50450000' || bytes.readUInt16LE(offset+4)!==0x8664)throw Error('Wrong relay platform'); }
  return binary;
}
export interface GoOwner { version: 1; pid: number; executable: string; creation: string; instance: string }
interface ProcessRecord { pid: number; executable: string; creation: string; commandLine: string }
export function ownerRequest(root: string, operation: 'Query', pid: number): Promise<ProcessRecord | null>;
export function ownerRequest(root: string, operation: 'Stop', pid: number, owner: GoOwner): Promise<boolean | null>;
export async function ownerRequest(root: string, operation: 'Query'|'Stop', pid: number, owner?: GoOwner): Promise<ProcessRecord | boolean | null> {
  if(process.platform!=='win32' || !Number.isSafeInteger(pid) || pid<=0)return null;
  const script=join(root,'scripts/process-owner.ps1');await ordinary(script);await ordinary(dirname(script),true);
  const powershell=join(process.env.SystemRoot ?? 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Operation',operation,'-ProcessId',String(pid)];
  if(owner)args.push('-Executable',owner.executable,'-Instance',owner.instance,'-Creation',owner.creation);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE)$/i.test(key)));
  try {
    const result=await exec(powershell,args,{env,windowsHide:true,encoding:'utf8',timeout:8000,maxBuffer:32768});
    const value: unknown=result.stdout.trim()?JSON.parse(result.stdout):null;
    if(operation==='Stop')return typeof value==='boolean'?value:null;
    if(!value || typeof value!=='object')return null;
    const record=value as Partial<ProcessRecord>;
    return record.pid===pid && typeof record.executable==='string' && typeof record.creation==='string' && /^\d+$/.test(record.creation) && typeof record.commandLine==='string' ? record as ProcessRecord : null;
  }catch{return null;}
}
export async function ensureLocalRelay(config: LocalRelayConfig, options: { packageRoot?: string; environment?: NodeJS.ProcessEnv } = {}): Promise<LocalRelayStatus> {
  const env=options.environment ?? process.env;
  if((env.PI_COLLAB_CLIENT_TOKEN?.length ?? 0)>4096 || (env.PI_COLLAB_ALLOWED_ORIGINS?.length ?? 0)>64*2049)return 'unavailable';
  const target=localGoTarget(config);if(!target)return 'remote';
  if(await localRelayHealthy(target.health))return 'already_running';
  // Other platform artifacts can run explicitly. Automatic ownership management
  // is currently Windows-only; never substitute untested PID-only termination.
  if(process.platform!=='win32')return 'unavailable';
  const root=await realpath(options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)),'../..')).catch(()=>null);if(!root)return 'unavailable';
  let binary: string;try{binary=await trustedGoBinary(root);}catch{return 'unavailable';}
  const runtime=join(root,'.runtime-go');const key=`${target.bind}-${target.port}`.replace(/[^a-zA-Z0-9_.-]/g,'_');const lockPath=join(runtime,`relay.${key}.lock`);const marker=join(runtime,`relay.${key}.json`);
  const nonce=randomBytes(16).toString('hex');let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {await mkdir(runtime,{recursive:true});await ordinary(runtime,true);lock=await open(lockPath,'wx');await lock.writeFile(nonce);} catch {
    await lock?.close().catch(()=>{});
    // Never evict an unknown/stale lock or spawn a second unmanaged child.
    for(let i=0;i<30;i++){await delay(100);if(await localRelayHealthy(target.health))return 'already_running';}return 'unavailable';
  }
  let child: ReturnType<typeof spawn> | undefined;let published=false;
  try {
    if(await localRelayHealthy(target.health))return 'already_running';
    try{await lstat(marker);return 'unavailable';}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return 'unavailable';}
    if(!await ownerRequest(root,'Query',process.pid))return 'unavailable';
    child=spawn(binary,[`--instance=${nonce}`],{cwd:root,env:localRelayEnvironment(target.bind,target.port,config.hostToken,env),detached:true,windowsHide:true,stdio:'ignore'});
    let failed=false;child.once('error',()=>{failed=true;});
    for(let i=0;i<30;i++){
      await delay(100);if(failed)break;
      if(await localRelayHealthy(target.health)){
        await delay(100);if(child.exitCode!==null || !child.pid)return 'already_running';
        const record=await ownerRequest(root,'Query',child.pid);
        const command=String(record?.commandLine ?? '').trim().toLowerCase();
        if(!record || record.executable?.toLowerCase()!==binary.toLowerCase() || !/^\d+$/.test(record.creation) || ![`${binary} --instance=${nonce}`,`"${binary}" --instance=${nonce}`].map(v=>v.toLowerCase()).includes(command))break;
        const owner: GoOwner={version:1,pid:child.pid,executable:binary,creation:record.creation,instance:nonce};
        const file=await open(marker,'wx');try{await file.writeFile(JSON.stringify(owner));}finally{await file.close();}
        published=true;child.unref();return 'started';
      }
      if(child.exitCode!==null)break;
    }
    return 'unavailable';
  } catch {return 'unavailable';}
  finally {
    // This is the retained handle returned by our spawn, never a persisted PID.
    if(child && !published && child.exitCode===null){try{child.kill();}catch{}}
    await lock?.close().catch(()=>{});
    try{await ordinary(lockPath);if(await readFile(lockPath,'utf8')===nonce)await unlink(lockPath);}catch{}
  }
}
