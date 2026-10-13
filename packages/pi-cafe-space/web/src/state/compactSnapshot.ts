import { MAX_FRAME_BYTES, compactTranscriptMessage, type SessionSnapshot } from '../../../src/protocol/index';
const encoder = new TextEncoder();
function suffix(text: string, limit: number): string {
    if (text.length <= limit)
        return text;
    let start = text.length - limit;
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff)
        start++;
    return text.slice(start);
}
// Preserve the old browser's 100 message/tool window and actual UTF-8 envelope
// budget. Context fields are fences and must never be normalized or truncated.
export function compactSnapshot(value: SessionSnapshot, hostId: string): SessionSnapshot {
    let messages = value.messages.slice(-100);
    let tools = value.tools.slice(-100);
    let truncated = !!value.historyTruncated || messages.some(message => message.partsTruncated === true) || messages.length < value.messages.length || tools.length < value.tools.length;
    const trim = (messageLimit: number, toolLimit: number) => {
        messages = messages.map(message => {
            const text = suffix(message.text, messageLimit), thinking = suffix(message.thinking, messageLimit);
            if (text === message.text && thinking === message.thinking)
                return message;
            truncated = true;
            return compactTranscriptMessage(message, text, thinking);
        });
        tools = tools.map(tool => {
            const argsText = suffix(tool.argsText, toolLimit), output = suffix(tool.output, toolLimit);
            if (argsText === tool.argsText && output === tool.output)
                return tool;
            truncated = true;
            return { ...tool, argsText, output };
        });
    };
    trim(65536, 65536);
    const snapshot = (): SessionSnapshot => ({ ...value, messages, tools, historyTruncated: truncated });
    const size = () => encoder.encode(JSON.stringify({ type: 'snapshot', hostId, snapshot: snapshot() })).length;
    // Subtract exact array member bytes instead of repeatedly encoding the full
    // snapshot for each eviction. Mark truncated before measuring its envelope.
    if (size() > MAX_FRAME_BYTES - 1024) {
        truncated = true;
        let bytes = size();
        while (messages.length > 1 && bytes > MAX_FRAME_BYTES - 1024) {
            bytes -= encoder.encode(JSON.stringify(messages[0])).length + 1;
            messages = messages.slice(1);
        }
        while (tools.length && bytes > MAX_FRAME_BYTES - 1024) {
            bytes -= encoder.encode(JSON.stringify(tools[0])).length + (tools.length > 1 ? 1 : 0);
            tools = tools.slice(1);
        }
        if (bytes > MAX_FRAME_BYTES - 1024) {
            messages = messages.map(message => compactTranscriptMessage(message, message.text, message.thinking, true));
            trim(8192, 4096);
        }
        if (size() > MAX_FRAME_BYTES - 1024)
            trim(1024, 1024);
        if (size() > MAX_FRAME_BYTES - 1024) {
            messages = [];
            tools = [];
        }
        if (size() > MAX_FRAME_BYTES - 1024)
            throw new Error('Snapshot context exceeds client budget');
    }
    return snapshot();
}
