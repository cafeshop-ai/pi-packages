import { expect, it } from 'vitest';
import { parseManagedInventory, parseManagedTargets } from './workspace';

const inventory=parseManagedInventory({projects:[{id:'work',name:'Approved',room:'main',cwd:'C:/work'}],sessions:[],agents:['pi','codex-acp'],acpAttach:true,maxActive:8},'main');
const thread={key:'a'.repeat(64),projectId:'work',name:'Loaded work',cwd:'C:/work',status:'idle'};

it('accepts only bounded metadata for configured project targets',()=>{
 expect(parseManagedTargets({threads:[thread],truncated:false},inventory)).toEqual({threads:[thread],truncated:false});
 expect(()=>parseManagedTargets({threads:[{...thread,cwd:'C:/outside'}],truncated:false},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:[{...thread,id:'11111111-1111-4111-8111-111111111111'}],truncated:false},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:[{...thread,key:'not-a-capability'}],truncated:false},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:[thread,thread],truncated:false},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:Array(101).fill(thread),truncated:false},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
});

it('rejects attachment capability without Codex runtime and rejects unbounded responses',()=>{
 expect(()=>parseManagedInventory({projects:[],sessions:[],agents:['pi'],acpAttach:true,maxActive:8},'main')).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:[thread],truncated:false},{...inventory,acpAttach:false})).toThrow('INVALID_MANAGED_RESPONSE');
 expect(()=>parseManagedTargets({threads:[],truncated:'false'},inventory)).toThrow('INVALID_MANAGED_RESPONSE');
});
