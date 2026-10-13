import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { stageRelease, releaseFiles } from './release.mjs';
import { buildCandidate, run, sha } from './build.mjs';
import { parseArgs } from 'node:util';
import { buildAdditionalPlatforms, parsePlatforms } from './matrix.mjs';
const { values } = parseArgs({ options: { platforms: { type: 'string' } }, strict: true });
const targets = parsePlatforms(values.platforms);
const npm=process.env.npm_execpath;
if(!npm)throw Error('Run this helper through npm run pack');
// Never use --ignore-scripts as a shortcut around the fresh source build.
const primary=await buildCandidate();
await buildAdditionalPlatforms(targets);
const {target,metadata}=await stageRelease(false,[...new Set([primary.platform,...targets])]);
run(process.execPath,[join(target,'scripts/verify-artifacts.mjs')]);
// Each invocation owns a new directory; a failed pack cannot be mistaken for
// a successful overwrite of a previous package or remove an unknown archive.
const directory=await mkdtemp(join(dirname(target),'pack-'));let accepted=false;
try{
 const output=JSON.parse(run(process.execPath,[npm,'pack','--ignore-scripts','--workspaces=false','--json','--pack-destination',directory],{cwd:target}));
 if(output.length!==1 || !output[0].files?.length || !/^[a-zA-Z0-9_.-]+\.tgz$/.test(output[0].filename))throw Error('Unexpected npm pack result');
 if(JSON.stringify(output[0].files.map(file=>file.path).sort())!==JSON.stringify(releaseFiles(Object.keys(metadata.platforms))))throw Error('Packed file set does not match the exact release allowlist');
 for(const file of output[0].files){
  if(!/^(?:(?:package\.json|README\.md|INSTALL\.md|AI_INSTALL\.md|LICENSE|THIRD-PARTY-NOTICES\.txt)$|(?:dist|scripts)\/)/.test(file.path) || /[\\:\u0000-\u001f]/.test(file.path) || file.path.split('/').some(part=>!part||part==='.'||part==='..') || /(^|\/)(\.env|\.runtime|\.runtime-go|\.refactor|node_modules|candidate-overrides|refactor)(\/|$)|\.map$|\.test\.|\.pid$|\.log$/.test(file.path))throw Error('Unexpected packed path');
  if(/\.(js|mjs|json|ps1|md|txt)$/.test(file.path)){
   const text=await readFile(join(target,file.path),'utf8');if(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/.test(text))throw Error('Potential credential material in candidate');
  }
 }
 const archive=join(directory,output[0].filename);
 const report={directory:basename(directory),archive:output[0].filename,sha256:sha(await readFile(archive)),files:output[0].files.map(file=>file.path),version:metadata.version,webDigest:metadata.webDigest,platforms:Object.keys(metadata.platforms)};
 await writeFile(join(directory,'pack-report.json'),JSON.stringify(report,null,2));accepted=true;
 console.log(JSON.stringify({...report,files:report.files.length}));
}finally{if(!accepted)await rm(directory,{recursive:true,force:true});}
