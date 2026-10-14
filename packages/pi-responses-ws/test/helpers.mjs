import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { normalizeContext } from '@earendil-works/pi-ai';

export const key = 'fixture-not-a-secret';
export const context = (messages = [{ role: 'user', content: 'hello', timestamp: 1 }]) => normalizeContext({ systemPrompt: 'fixture system', messages });
export const opts = (extra = {}) => ({ apiKey: key, sessionId: 'fixture-session', transport: 'websocket-cached', timeoutMs: 1500, websocketConnectTimeoutMs: 500, env: { NO_PROXY: '*' }, ...extra });
export const modelFor = baseUrl => ({ id: 'fixture', provider: 'cafe', name: 'fixture', api: 'openai-responses', baseUrl, input: ['text','image'], reasoning: true, contextWindow: 32768, maxTokens: 128, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } });

export function reply(n = 1, { text = 'hello 世界🙂', tool = false, thinking = false, empty = false } = {}) {
  const events = [{ type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress' } }];
  const output = [];
  const item = data => {
    const i = output.length;
    output.push(data);
    events.push({ type: 'response.output_item.added', output_index: i, item: { ...data, ...(data.type === 'function_call' ? { arguments: '' } : {}) } });
    if (data.type === 'message') events.push({ type: 'response.output_text.delta', output_index: i, delta: text });
    if (data.type === 'reasoning') events.push({ type: 'response.reasoning_summary_text.delta', output_index: i, delta: 'thinking' });
    if (data.type === 'function_call') events.push({ type: 'response.function_call_arguments.delta', output_index: i, delta: data.arguments });
    events.push({ type: 'response.output_item.done', output_index: i, item: data });
  };
  if (thinking) item({ type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: `encrypted_${n}` });
  if (tool) item({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'echo', arguments: '{"value":"你好"}', status: 'completed' });
  else if (!empty) item({ type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  events.push({ type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } } } });
  return events;
}

export async function server(t, handler = (_body, request) => reply(request.n), warmupHandler = () => reply('warmup', { empty: true })) {
  const requests = [], warmups = [], handshakes = [], sockets = new Set();
  let rejectStatus = 0, rejectHeaders = {};
  const http = createServer(async (req, res) => {
    const parts=[]; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    const record = { n: requests.length + 1, body, headers: req.headers, transport: 'sse' }; requests.push(record);
    const events = await handler(body, record);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture': 'sse' });
    for (const event of events ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    handshakes.push({ path: req.url, headers: req.headers });
    if (rejectStatus) { socket.end(`HTTP/1.1 ${rejectStatus} Test\r\n${Object.entries(rejectHeaders).map(([k,v])=>`${k}: ${v}\r\n`).join('')}Content-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws); ws.on('close', () => sockets.delete(ws)); ws.on('error', () => {});
      ws.on('message', async raw => {
        const body = JSON.parse(raw.toString());
        const records = body.generate === false ? warmups : requests;
        const record = { n: records.length + 1, body, headers: req.headers, transport: 'websocket', ws }; records.push(record);
        const events = await (body.generate === false ? warmupHandler : handler)(body, record);
        for (const event of events ?? []) if (ws.readyState === 1) ws.send(typeof event === 'string' ? event : JSON.stringify(event));
      });
    });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(async () => { for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); });
  return { baseUrl: `http://127.0.0.1:${http.address().port}/v1`, requests, warmups, handshakes, sockets, wss, rejectUpgrade(status, headers = {}) { rejectStatus = status; rejectHeaders = headers; } };
}

export const nextContext = (previous, assistant, content = 'next') => normalizeContext({ messages: [...previous.messages, assistant, { role: 'user', content, timestamp: 2 }] });
export async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return { events, output: await stream.result() }; }
