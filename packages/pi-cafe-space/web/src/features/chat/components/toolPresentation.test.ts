import { expect, it } from 'vitest';
import { editDiff, outputDiff, toolPresentation } from './toolPresentation';
import type { ToolView } from '../runtime/convertMessages';
const view:ToolView={key:'test',callId:'call',name:'edit',argsText:JSON.stringify({path:'src/example.ts',oldText:'const value = 1;\n中文😀\n',newText:'const value = 2;\n中文😀\n'}),argsValid:true,output:'',hasOutput:false,status:'pending',conflict:false,association:'attached'};
it('edit preview preserves code, Unicode and separate old/new snippet numbers',()=>{
 expect(editDiff('old\n中文😀\n','new\n中文😀\n')).toEqual([{kind:'remove',text:'old',oldLine:1,newLine:null},{kind:'add',text:'new',oldLine:null,newLine:1},{kind:'context',text:'中文😀',oldLine:2,newLine:2}]);
 const p=toolPresentation(view);expect(p.source).toBe('requested-edit');expect(p.target).toBe('src/example.ts');expect(p.added).toBe(1);expect(p.removed).toBe(1);
});
it('only a complete structurally valid returned patch is marked as a result diff',()=>{
 const patch='--- a/file.ts\n+++ b/file.ts\n@@ -5,2 +5,2 @@\n-old\n+new\n same\n';
 const p=toolPresentation({...view,output:patch,hasOutput:true,status:'complete'});expect(p.source).toBe('result');expect(p.diff?.[1]).toMatchObject({oldLine:5,kind:'remove'});expect(p.diff?.[2]).toMatchObject({newLine:5,kind:'add'});
 expect(outputDiff('@@ -1,5 +1,5 @@\n-one\n+two')).toBeNull();expect(outputDiff('plain output\n+plus')).toBeNull();
 expect(toolPresentation({...view,output:patch,hasOutput:true,status:'error'}).source).toBe('requested-edit');
});
it('bounded inputs fall back to raw details without quadratic allocation',()=>{
 expect(editDiff('x\n'.repeat(201),'y')).toBeNull();expect(editDiff('x'.repeat(13000),'y')).toBeNull();expect(outputDiff('@@ -1 +1 @@\n'+'x'.repeat(17000))).toBeNull();
 expect(toolPresentation({...view,argsValid:false}).diff).toBeNull();expect(toolPresentation({...view,name:'write'}).diff).toBeNull();
});
it('compact output previews are bounded, keep tail while running and never infer an edit from write contents',()=>{
 const output=Array.from({length:15},(_,i)=>'line'+i).join('\n');const p=toolPresentation({...view,name:'bash',argsText:'{"command":"npm test"}',hasOutput:true,status:'running',output});
 expect(p.outputPreview.startsWith('line11')).toBe(true);expect(p.outputTruncated).toBe(true);expect(p.diff).toBeNull();expect(p.target).toBe('npm test');
 expect(toolPresentation({...view,name:'read',output,hasOutput:true,status:'complete'}).outputPreview.startsWith('line0')).toBe(true);
});
