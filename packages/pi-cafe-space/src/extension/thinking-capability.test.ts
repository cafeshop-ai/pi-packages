import { expect, it, vi } from 'vitest';
import { applyThinkingLevel, thinkingCapability } from './thinking-capability.js';
it('declared false exposes only off and never invokes an unsupported change',()=>{
 const api={getThinkingLevel:()=> 'off',setThinkingLevel:vi.fn()};expect(thinkingCapability({id:'gemini-3.8-flash',reasoning:false})).toEqual({reasoning:false,thinkingLevels:['off']});expect(applyThinkingLevel(api,{reasoning:false},'high')).toEqual({actual:'off',code:'THINKING_UNSUPPORTED'});expect(api.setThinkingLevel).not.toHaveBeenCalled();
});
it('uses actual declared mappings without guessing by model name',()=>{
 expect(thinkingCapability({reasoning:true,thinkingLevelMap:{off:null,minimal:null,xhigh:null,max:'max'}})?.thinkingLevels).toEqual(['low','medium','high','max']);expect(thinkingCapability({id:'gemini-3.8-flash'})).toBeUndefined();expect(thinkingCapability({reasoning:true})?.thinkingLevels).not.toContain('xhigh');
});
it('silent native clamping cannot be reported as successful',()=>{
 const api={getThinkingLevel:()=> 'off',setThinkingLevel:vi.fn()};expect(applyThinkingLevel(api,{},'high')).toEqual({actual:'off',code:'THINKING_NOT_APPLIED'});expect(api.setThinkingLevel).toHaveBeenCalledExactlyOnceWith('high');
});
it('accepts only a matching native readback and propagates errors',()=>{
 let actual='off';const api={getThinkingLevel:()=>actual,setThinkingLevel:vi.fn((level:string)=>{actual=level;})};expect(applyThinkingLevel(api,{reasoning:true},'high')).toEqual({actual:'high',code:null});expect(applyThinkingLevel(api,{reasoning:true},'xhigh').code).toBe('THINKING_LEVEL_UNAVAILABLE');expect(actual).toBe('high');expect(()=>applyThinkingLevel({getThinkingLevel:()=> 'off',setThinkingLevel:()=>{throw Error('native failure');}},{reasoning:true},'low')).toThrow('native failure');
});
