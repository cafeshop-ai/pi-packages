import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
let source=true;try{await access(join(root,'src'));}catch(error){if(error.code!=='ENOENT')throw error;source=false;}
if(!source){
  await import('./verify-artifacts.mjs');
  console.log('Prebuilt artifact verification only; full source tests require the source checkout.');
}else{
  const require=createRequire(new URL('../package.json',import.meta.url));
  const run=(command,args,cwd=root)=>{const result=spawnSync(command,args,{cwd,stdio:'inherit'});if(result.error||result.status!==0)throw Error('Source verification failed');};
  if(process.argv[2]==='check'){
    const compiler=require.resolve('typescript/bin/tsc');
    run(process.execPath,[compiler,'-p','tsconfig.json','--noEmit']);
    run(process.execPath,[compiler,'-p','web/tsconfig.json','--noEmit']);
    run('go',['vet','./...'],join(root,'relay'));
  }else if(process.argv[2]==='test'){
    const vitest=join(dirname(require.resolve('vitest/package.json')),'vitest.mjs');
    run(process.execPath,[vitest,'run','--config','vitest.config.ts','--maxWorkers=2']);
    run(process.execPath,[vitest,'run','--config','web/vitest.config.ts','--maxWorkers=2']);
    run('go',['test','./...'],join(root,'relay'));
  }else throw Error('Expected check or test');
}
