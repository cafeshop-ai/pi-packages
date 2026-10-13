import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachProjectFiles, listProjectDirectory, readProjectFile } from './file-commands.js';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'cafe-private-files-')));roots.push(root);return root;}
it('hides service secrets and identity state without hiding normal project files',async()=>{
 const root=await fixture();
 for(const path of ['.secrets/identity/keys.json','data/identity/sessions.sqlite','.config/pi-cafe-space/credentials-37891.json','docs/keys.json','src/identity.ts']){const full=join(root,path);await mkdir(join(full,'..'),{recursive:true});await writeFile(full,'synthetic data');}
 for(const path of ['.secrets/identity/keys.json','data/identity/sessions.sqlite','.config/pi-cafe-space/credentials-37891.json']){
  await expect(readProjectFile(root,path)).rejects.toMatchObject({code:'SENSITIVE_PATH'});
  await expect(attachProjectFiles(root,'draft',[path])).rejects.toMatchObject({code:'SENSITIVE_PATH'});
 }
 await expect(listProjectDirectory(join(root,'.secrets'),'identity')).rejects.toMatchObject({code:'SENSITIVE_PATH'});
 const list=await listProjectDirectory(root,'.') as any;expect(list.entries.map((e:any)=>e.name)).not.toContain('.secrets');
 for(const path of ['docs/keys.json','src/identity.ts'])expect((await readProjectFile(root,path) as any).content).toBe('synthetic data');
});
it('protects relocated configured credentials and database sidecars without a filename blacklist',async()=>{
 const root=await fixture();const credential=join(root,'private-storage.dat'),database=join(root,'session-data.db');
 vi.stubEnv('PI_CAFE_CREDENTIALS_FILE',credential);vi.stubEnv('CAFE_IDENTITY_DATABASE',database);
 for(const path of [credential,database,database+'-wal',database+'-shm',join(root,'ordinary.db')])await writeFile(path,'synthetic only');
 for(const path of ['private-storage.dat','session-data.db','session-data.db-wal','session-data.db-shm'])await expect(readProjectFile(root,path)).rejects.toMatchObject({code:'SENSITIVE_PATH'});
 expect((await listProjectDirectory(root,'.') as any).entries).toEqual([{name:'ordinary.db',kind:'file'}]);
 expect((await readProjectFile(root,'ordinary.db') as any).content).toBe('synthetic only');
});
it('protects the configured Pi agent directory but not similarly prefixed project folders',async()=>{
 const root=await fixture();await mkdir(join(root,'agent-state'));await mkdir(join(root,'agent-state-example'));await writeFile(join(root,'agent-state','cache.json'),'synthetic only');await writeFile(join(root,'agent-state-example','cache.json'),'public example');vi.stubEnv('PI_CODING_AGENT_DIR',join(root,'agent-state'));
 await expect(readProjectFile(root,'agent-state/cache.json')).rejects.toMatchObject({code:'SENSITIVE_PATH'});expect((await readProjectFile(root,'agent-state-example/cache.json') as any).content).toBe('public example');
});
