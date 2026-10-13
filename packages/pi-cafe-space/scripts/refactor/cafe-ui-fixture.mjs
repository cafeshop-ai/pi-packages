// Browser-only visual fixture. Installed ONLY into an owned off-the-record CDP
// target; never bundled into the application or used with real Pi sessions.
export function installUiFixture(seed) {
  const state = { socket: null, room: null, commands: [], sockets: 0, mode: 'content', sessionId: seed.sessionId, streamId: seed.streamId, title: 'Café design / 界面验收', cancelNext: false, inputAssist: true, hostId: 'visual-host', managed: [], original: null };
  const message = (id, role, text) => ({ id, role, text, thinking: '', timestamp: 1, status: 'complete', toolName: null, toolCallId: null });
  const emit = value => state.socket?.onmessage?.({ data: JSON.stringify(value) });
  function snapshot() {
    const base = structuredClone(seed);
    base.phase = state.mode === 'running' ? 'running' : state.mode === 'waiting' ? 'waiting_local_ui' : 'idle';
    base.model = { provider: 'synthetic', id: 'visual-fixture' };
    base.sessionName = state.title;
    base.sessionControl = true; base.inputAssist = state.inputAssist;
    base.sessionId = state.sessionId; base.streamId = state.streamId;
    if (state.mode === 'empty') { base.messages = []; base.tools = []; }
    else {
      base.messages.unshift(message('u0', 'user', '请检查工作空间的布局、消息排版和工具结果。\nThis is synthetic UI test content, not a model response.'));
      base.messages.push(message('layout-copy', 'assistant', '## 界面检查 · Layout review\n\n这是专门用于浏览器验收的合成内容，不来自模型或用户会话。\n\n- 实例、历史和文件保持各自的上下文。\n- 长路径应该换行，工具输出可以独立滚动。\n\n```ts\nconst workspace = { room: "ui-fixture", readOnly: false };\n// ' + 'long_identifier_'.repeat(30) + '\n```\n\n| Area | Expected behavior |\n| --- | --- |\n| Conversation | Readable at small widths |\n| Composer | Keeps the active draft |\n\n> 仅验证布局；不要把这里的内容当成执行结果。\n\n' + 'A long reading paragraph checks wrapping and scroll ownership. 中文内容也应保持清晰的行距。 '.repeat(55)));
    }
    emit({ type: 'snapshot', hostId: state.hostId, snapshot: base });
  }
  class FixtureSocket {
    static OPEN = 1;
    readyState = 0; bufferedAmount = 0;
    constructor() { state.sockets++; state.socket = this; setTimeout(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); }, 0); }
    close() { this.readyState = 3; }
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.type === 'hello') {
        state.room = frame.roomId;
        setTimeout(() => {
          emit({ type: 'welcome', protocolVersion: 1, connectionId: 'visual', peerRole: 'client', roomId: state.room, hostConnected: true });
          emit({ type: 'host_status', hostId: 'visual-host', connected: true, streamId: seed.streamId, sessionId: seed.sessionId, hosts: [
            { hostId: 'visual-host', connected: true, ready: true, streamId: seed.streamId, sessionId: seed.sessionId, cwd: seed.cwd, sessionName: 'Café design / 界面验收' },
            { hostId: 'offline-host-with-a-long-identifier-for-wrapping', connected: false, ready: false, streamId: 'offline', sessionId: 'offline', cwd: 'C:/synthetic-other', sessionName: '另一个项目 · Offline fixture' },
          ] }); snapshot();
        }, 0);
      } else if (frame.type === 'command') {
        // Retain only synthetic payloads; never store hello credentials.
        state.commands.push(frame.payload);
        let data;
        switch (frame.payload.name) {
          case 'list_commands': data = { kind: 'commands', truncated: false, commands: [{ name: 'review', description: 'Review fixture', source: 'extension' }, { name: 'skill:fixture', description: 'Fixture skill', source: 'skill' }, { name: 'fixture-template', description: 'Fixture template', source: 'prompt' }] }; break;
          case 'list_dir': data = { kind: 'directory', path: frame.payload.path, truncated: false, entries: [{ name: 'src', kind: 'directory' }, { name: 'cafe-theme.scss', kind: 'file' }, { name: 'note 中文.txt', kind: 'file' }, { name: 'a-very-long-filename-that-must-not-expand-the-layout.md', kind: 'file' }] }; break;
          case 'read_file': data = { kind: 'file', path: frame.payload.path, offset: 0, bytesRead: 128, size: 128, content: '/* Synthetic read-only preview */\n:root {\n  --cafe-page: #1a1511;\n  --cafe-ink: #faf7f4;\n}\n' + 'long_line_'.repeat(60), truncated: false }; break;
          case 'list_sessions': data = { kind: 'sessions', currentSessionId: state.sessionId, historyTruncated: false, sessions: [{ sessionId: 'saved/%2F:id', name: 'Archived layout review / 历史界面检查', cwd: seed.cwd, created: '2026-09-28', modified: '2026-09-28', messageCount: 3, firstMessage: '' }, ...['会话导航与交互', 'Tool output and Markdown', '移动端阅读体验', '项目上下文隔离'].map((name, index) => ({ sessionId: `review-${index}`, name, cwd: seed.cwd, created: new Date(Date.now() - index * 86400000).toISOString(), modified: new Date(Date.now() - index * 86400000).toISOString(), messageCount: 8 + index * 3, firstMessage: '' }))] }; break;
          case 'get_session': data = { kind: 'session', sessionId: frame.payload.sessionId, name: 'Archived layout review', cwd: seed.cwd, activeLeafId: null, model: null, thinkingLevel: 'off', messages: seed.messages, historyTruncated: false, modified: '2026-09-28' }; break;
        }
        setTimeout(() => {
          const control = ['new_session', 'resume_session', 'rename_session'].includes(frame.payload.name);
          const cancelled = control && state.cancelNext; if (control) state.cancelNext = false;
          const unsupported = frame.payload.name === 'run_command' && !/^\/(?:review|skill:fixture|fixture-template)(?:\s|$)/.test(frame.payload.command);
          emit({ type: 'command_result', requestId: frame.requestId, hostId: frame.targetHostId, status: cancelled || unsupported ? 'rejected' : data || frame.payload.name === 'rename_session' ? 'applied' : 'dispatched', code: cancelled ? 'SESSION_CANCELLED' : unsupported ? 'COMMAND_UNAVAILABLE' : null, message: null, ...(data ? { data } : {}) });
          if (control && !cancelled) {
            if (frame.payload.name === 'rename_session') state.title = frame.payload.title;
            else { state.sessionId = frame.payload.sessionId ?? 'new-' + state.commands.length; state.streamId = 'control-' + state.commands.length; state.mode = frame.payload.name === 'new_session' ? 'empty' : 'content'; }
            setTimeout(snapshot, 50);
          }
        }, frame.payload.name === 'prompt' ? 900 : 50);
      }
    }
  }
  // There is intentionally no reference to the native WebSocket constructor:
  // even an accidental application command cannot reach the live Relay.
  window.WebSocket = FixtureSocket;
  window.__cafeFixture = {
    workspace: q => {
      const project={id:'visual-project',name:'Synthetic project',room:state.room,cwd:seed.cwd};
      if(q.operation==='list')return {projects:[project],sessions:structuredClone(state.managed),maxActive:8};
      if(q.operation==='create') {
        const record={id:q.id,projectId:q.projectId,room:q.room,name:q.name,hostId:'managed-'+q.id,status:'ready'};
        state.managed.push(record);
        if(!state.original)state.original={hostId:'visual-host',connected:true,ready:true,streamId:state.streamId,sessionId:state.sessionId,cwd:seed.cwd,sessionName:state.title};
        setTimeout(()=>{state.hostId=record.hostId;state.sessionId=record.id;state.streamId='managed-stream';state.title=record.name;state.mode='empty';emit({type:'host_status',hostId:record.hostId,connected:true,streamId:state.streamId,sessionId:record.id,hosts:[state.original,...state.managed.map(s=>({hostId:s.hostId,connected:true,ready:true,streamId:'managed-stream',sessionId:s.id,cwd:seed.cwd,sessionName:s.name}))]});snapshot();},150);
        return record;
      }
      const record=state.managed.find(s=>s.id===q.id);record.status=q.operation==='close'?'stopped':'ready';return structuredClone(record);
    },
    original: () => {state.hostId='visual-host';state.sessionId=state.original.sessionId;state.streamId=state.original.streamId;state.title=state.original.sessionName;state.mode='content';snapshot();},
    stats: () => ({ sockets: state.sockets, commands: state.commands.length, prompts: state.commands.filter(p => p.name === 'prompt').length, payloads: structuredClone(state.commands) }),
    show: mode => { state.mode = mode; snapshot(); },
    inputAssist: enabled => { state.inputAssist = enabled; snapshot(); },
    cancelNextSession: () => { state.cancelNext = true; },
    rejectAuth: () => emit({ type: 'error', code: 'UNAUTHORIZED', message: 'Synthetic authentication failure' }),
  };
}
