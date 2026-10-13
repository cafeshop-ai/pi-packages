import { createHash } from "node:crypto";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { EnvHttpProxyAgent, fetch, Headers } from "undici";
import { parseResponse, type SearchRequest, type SearchResponse } from "./protocol.ts";

export const DIRECT_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export class SearchError extends Error {}
export interface Connection {
  model: Model<Api>;
  endpoint: string;
  headers: Headers;
  identity: string;
  proxy: { httpProxy: string; httpsProxy: string; noProxy: string };
  secrets: string[];
}
export function searchModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">): Model<Api> {
  if (!ctx.model) throw new SearchError("No active Pi model. Select a model with /model before searching.");
  if (ctx.model.api !== "pi-virtual") return ctx.model;
  // ctx.model is the virtual selection; assistant messages record the dispatched physical model.
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === "model_change") break;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.api === "pi-virtual") continue;
    const model = ctx.modelRegistry.find(message.provider, message.model);
    if (model && model.api !== "pi-virtual") return model;
    throw new SearchError("当前路由使用的实际模型已不在 Pi 目录中；不会改用其他连接。");
  }
  throw new SearchError("当前虚拟模型尚未产生可用的实际模型响应；先发送一条消息，再使用搜索。无需配置连接。");
}
function baseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SearchError("Invalid provider Base URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new SearchError("Provider Base URL must use HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.");
  }
  return url;
}
export function searchEndpoint(model: Model<Api>, url = model.baseUrl): string {
  const base = baseUrl(url);
  if (model.provider === "openai-codex") {
    if (base.origin !== "https://chatgpt.com" || !["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(base.pathname.replace(/\/$/, ""))) {
      throw new SearchError("The current openai-codex model must use the official ChatGPT Base URL; refusing to forward its credentials elsewhere.");
    }
    return DIRECT_ENDPOINT;
  }
  if (base.origin === "https://chatgpt.com") throw new SearchError("ChatGPT search requires the openai-codex provider.");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/alpha/search`;
  return base.toString();
}
export function safeText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function redact(text: string, secrets: string[]): string {
  let result = safeText(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted]");
  return result.replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [redacted]");
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
export async function resolveConnection(model: Model<Api> | undefined, registry: ModelRegistry, signal: AbortSignal): Promise<Connection> {
  signal.throwIfAborted();
  if (!model) throw new SearchError("No active Pi model. Select a model with /model before searching.");
  searchEndpoint(model); // Validate the destination before asking Pi to resolve credentials.
  const auth = await abortable(registry.getApiKeyAndHeaders(model), signal);
  if (!auth.ok) throw new SearchError("Pi could not resolve search credentials. Check /login and the selected provider configuration.");
  signal.throwIfAborted();
  const endpoint = searchEndpoint(model, auth.baseUrl ?? model.baseUrl);
  if (new URL(endpoint).origin !== new URL(model.baseUrl).origin) throw new SearchError("Authentication changed the endpoint origin; refusing to forward credentials.");
  const headers = new Headers();
  if (auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
  const secrets = auth.apiKey ? [auth.apiKey] : [];
  for (const source of [model.headers, auth.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(key);
      else {
        headers.set(key, value);
        if (value.length >= 8) secrets.push(value);
      }
    }
  }
  let accountId: string | undefined;
  let userId: string | undefined;
  if (model.provider === "openai-codex") {
    const token = headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new SearchError("Direct mode requires /login openai-codex.");
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      const claim = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof claim !== "string" || !claim.trim()) throw new Error();
      accountId = claim;
      const user = payload?.["https://api.openai.com/auth"]?.chatgpt_user_id ?? payload.sub;
      if (typeof user === "string") userId = user;
    } catch { throw new SearchError("Codex account ID is missing from the access token. Reconnect with /login openai-codex."); }
    const configuredAccount = headers.get("chatgpt-account-id");
    if (configuredAccount && configuredAccount !== accountId) throw new SearchError("Codex account header does not match the access token.");
    headers.set("ChatGPT-Account-ID", accountId);
    headers.set("originator", "pi");
    headers.set("User-Agent", "pi-openai-search/0.1.0");
    secrets.push(token, accountId);
  }
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const env = (key: string) => auth.env?.[key.toLowerCase()] ?? auth.env?.[key] ?? process.env[key.toLowerCase()] ?? process.env[key] ?? "";
  const proxy = {
    httpProxy: env("HTTP_PROXY") || env("ALL_PROXY"),
    httpsProxy: env("HTTPS_PROXY") || env("HTTP_PROXY") || env("ALL_PROXY"), noProxy: env("NO_PROXY"),
  };
  for (const value of [proxy.httpProxy, proxy.httpsProxy]) {
    if (!value) continue;
    try { if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error(); }
    catch { throw new SearchError("Invalid network proxy configuration. Use an HTTP(S) proxy URL; SOCKS/PAC are not supported."); }
  }
  // Hash the account identity, not the rotating direct OAuth token. Never persist request headers.
  const identity = createHash("sha256").update(JSON.stringify([
    model.provider, model.id, endpoint,
    accountId ? [accountId, userId] : [...headers].filter(([name]) => !["content-type", "accept", "user-agent"].includes(name)).sort(),
  ])).digest("hex");
  return { model, endpoint, headers, identity, proxy, secrets };
}

async function readBody(response: Awaited<ReturnType<typeof fetch>>, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SearchError("Search response exceeds the 2 MiB safety limit. Request a shorter response.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SearchError("Search response exceeds the 2 MiB safety limit. Request a shorter response.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function postSearch(connection: Connection, request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
  signal.throwIfAborted();
  const dispatcher = new EnvHttpProxyAgent(connection.proxy);
  try {
    const response = await fetch(connection.endpoint, {
      method: "POST", headers: connection.headers, body: JSON.stringify(request), signal,
      redirect: "manual", dispatcher,
    });
    const body = await readBody(response, signal);
    if (!response.ok) {
      const hints: Record<number, string> = {
        401: "Authentication rejected; check Pi login/provider credentials.",
        403: "Access denied by the service or gateway; account access is not confirmed.",
        404: "The current Pi provider does not expose /alpha/search at its Base URL; check whether it supports this search protocol.",
        429: "Search is rate limited; wait before retrying.",
      };
      let code = "";
      try {
        const parsedError = JSON.parse(body)?.error;
        if (response.status === 409 && (parsedError?.code === "search_session_affinity_lost" || (typeof parsedError?.message === "string" && parsedError.message.startsWith("search_session_affinity_lost:")))) {
          throw new SearchError("Search HTTP 409 (search_session_affinity_lost): the proxy lost the upstream account binding for this reference. Open/find by the original URL or ask the proxy administrator to fix session affinity; do not retry the same reference.");
        }
        const errorCode = parsedError?.code;
        if (typeof errorCode === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(errorCode)) code = ` (${redact(errorCode, connection.secrets)})`;
      } catch (error) {
        if (error instanceof SearchError) throw error;
        // Error bodies may be HTML; do not leak them into the transcript.
      }
      const retry = response.headers.get("retry-after");
      const retryHint = retry && /^\d{1,8}$/.test(retry) ? ` Retry-After: ${retry}s.` : "";
      throw new SearchError(`Search HTTP ${response.status}${code}: ${response.status >= 300 && response.status < 400 ? "Redirect refused; configure the final URL in Pi." : hints[response.status] ?? "The search service rejected the request or is unavailable."}${retryHint} No automatic POST retry was attempted.`);
    }
    let value: unknown;
    try { value = JSON.parse(body); }
    catch { throw new SearchError("Search returned non-JSON data; verify the route and gateway compatibility."); }
    const parsed = parseResponse(value);
    // Redact before results can reach the transcript, temporary files or terminal.
    return JSON.parse(JSON.stringify(parsed), (_key, value) => typeof value === "string" ? redact(value, connection.secrets) : value) as SearchResponse;
  } catch (error) {
    if (signal.aborted) throw new SearchError(signal.reason?.name === "TimeoutError" ? "Search timed out; the server may already have processed the request." : "Search cancelled; the server may already have processed the request.");
    if (error instanceof SearchError) throw error;
    if (error instanceof Error && error.message.startsWith("Search protocol error:")) throw new SearchError(error.message);
    throw new SearchError("Search network/transport failure. Check connectivity, TLS certificates and HTTP(S)_PROXY; no automatic POST retry was attempted.");
  } finally { await dispatcher.destroy(); }
}
