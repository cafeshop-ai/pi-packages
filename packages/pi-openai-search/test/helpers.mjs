import { createServer } from "node:http";
import { once } from "node:events";

export async function server(t, handler) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
    handler(req, res, requests.at(-1));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${http.address().port}`, requests, http };
}
export function json(res, value, status = 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); }
export function registry(url, auth = {}) {
  const model = { id: "search-model", provider: "test-proxy", baseUrl: url, api: "openai-responses" };
  const resolved = { ok: true, apiKey: "test-secret-key-123", env: { NO_PROXY: "*" }, ...auth };
  return {
    model, resolved,
    find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    getAll: () => [model],
    getApiKeyAndHeaders: async (selected) => {
      if (selected !== model) throw new Error("wrong model passed to credential resolver");
      return resolved;
    },
  };
}
export const query = { search_query: [{ q: "public documentation" }], response_length: "short" };
export const request = { id: "session-1", model: "search-model", commands: query, settings: { allowed_callers: ["direct"], external_web_access: true }, max_output_tokens: 4000 };
export function token(account = "account-1", suffix = "one") {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, nonce: suffix })).toString("base64url")}.test-signature`;
}
