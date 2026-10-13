// Acceptance-only local provider. Never included in a release package.
// The real Pi CLI/AgentSession performs lifecycle, execution and persistence;
// this deterministic stream is NOT evidence of an external model request.
import { createAssistantMessageEventStream, type AssistantMessage, type TextContent, type ThinkingContent, type ToolCall } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { setTimeout as wait } from 'node:timers/promises';
export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.on('session_start', (_event,ctx) => { ctx.ui.notify('R18_READY'); });
  pi.registerProvider('r18-local', {
    baseUrl: 'http://127.0.0.1:1/never-requested', apiKey: 'fixture-only', api: 'r18-local-stream',
    models: ['fixture-a','fixture-b'].map(id => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
      void (async () => {
        try {
          if (++calls > 20) throw Error('Acceptance stream call budget exceeded');
          stream.push({ type: 'start', partial: output });
          const text = async (value: string, thinking = false) => {
            const index = output.content.length;
            const block: TextContent | ThinkingContent = thinking ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }; output.content.push(block);
            stream.push({ type: thinking ? 'thinking_start' : 'text_start', contentIndex: index, partial: output });
            await wait(35, undefined, { signal: options?.signal });
            if (block.type === 'thinking') block.thinking = value; else block.text = value;
            stream.push({ type: thinking ? 'thinking_delta' : 'text_delta', contentIndex: index, delta: value, partial: output });
            stream.push({ type: thinking ? 'thinking_end' : 'text_end', contentIndex: index, content: value, partial: output });
          };
          const tool = (id: string, outcome: string) => {
            const index = output.content.length; const block: ToolCall = { type: 'toolCall', id, name: 'r18_tool', arguments: { outcome } }; output.content.push(block);
            stream.push({ type: 'toolcall_start', contentIndex: index, partial: output });
            stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: output });
          };
          const last = context.messages.at(-1);
          const prompt = last?.role === 'user' ? (typeof last.content === 'string' ? last.content : last.content.filter(p => p.type === 'text').map(p => p.text).join('')) : '';
          if (prompt === 'PARTS') {
            await text('Native thinking evidence', true); await text('Before tools'); tool('native-t1','empty'); await text('Between tools'); tool('native-t2','error'); await text('After tools'); output.stopReason = 'toolUse';
          } else if (prompt === 'WAIT_UI') {
            tool('native-ui','ui'); output.stopReason = 'toolUse';
          } else {
            await text(prompt === 'LONG' ? Array.from({ length: 90 },(_,i)=>`Paragraph ${i}: fixture content for real scrolling.`).join('\n\n') : prompt === 'SAFE' ? '[safe](https://example.com) ![omitted](https://example.invalid/r18.png) <img src=x onerror="window.__r18Xss=1"> [bad](javascript:alert(1))\n\n```text\n'+ 'long-unbroken-'.repeat(100)+'\n```' : `Native reply: ${prompt || 'tools complete'}`);
            if (prompt === 'HOLD') await wait(5000,undefined,{signal:options?.signal});
            output.stopReason = 'stop';
          }
          stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'; output.errorMessage = String(error);
          stream.push({ type: 'error', reason: output.stopReason, error: output }); stream.end();
        }
      })();
      return stream;
    },
  });
  pi.registerTool({ name: 'r18_tool', label: 'R18 controlled tool', description: 'Controlled acceptance-only tool', parameters: Type.Object({ outcome: Type.String() }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: 'text', text: 'partial' }], details: {} });
      if (params.outcome === 'ui') await ctx.ui.confirm('R18 controlled dialog','Acceptance only',{timeout:10000});
      await wait(params.outcome === 'empty' ? 300 : 30,undefined,{signal});
      if (params.outcome === 'error') throw Error('Controlled native tool failure');
      return { content: [{ type: 'text' as const, text: '' }], details: {} };
    },
  });
  pi.registerCommand('r18-history',{description:'Create only controlled acceptance history',handler:async(_args,ctx)=>{
    const manager=SessionManager.create(ctx.cwd,ctx.sessionManager.getSessionDir());
    manager.appendSessionInfo('R18 large legal history');
    for(let i=0;i<700;i++){
      manager.appendMessage({role:'user',content:`Owned history ${i} ${'x'.repeat(1800)}`,timestamp:Date.now()});
      manager.appendMessage({role:'assistant',content:[{type:'text',text:`Historical reply ${i}`}],api:'r18-local-stream',provider:'r18-local',model:'fixture-a',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
    }
    ctx.ui.notify('R18_HISTORY:'+JSON.stringify({id:manager.getSessionId(),file:manager.getSessionFile()}));
  }});
  pi.registerCommand('r18-shutdown',{description:'Stop only this acceptance Pi',handler:async(_args,ctx)=>ctx.shutdown()});
}
