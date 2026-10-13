import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { getGlobalDispatcher } from "undici";
import { once } from "node:events";
import { resolveConnection, searchEndpoint, postSearch, DIRECT_ENDPOINT, MAX_RESPONSE_BYTES, safeText } from "../src/client.ts";
import { server, json, registry, request, token } from "./helpers.mjs";

const signal = () => AbortSignal.timeout(5000);
test("endpoint preserves base paths and handles direct normalization", () => {
  const model = registry("https://example.com").model;
  assert.equal(searchEndpoint(model, "https://example.com/v1/"), "https://example.com/v1/alpha/search");
  assert.equal(searchEndpoint(model, "http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/alpha/search");
  for (const base of ["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex/", "https://chatgpt.com/backend-api/codex/responses"]) assert.equal(searchEndpoint({ ...model, provider: "openai-codex" }, base), DIRECT_ENDPOINT);
  for (const base of ["https://evil.com/backend-api", "https://chatgpt.com.evil.com/backend-api", "https://chatgpt.com:444/backend-api", "https://chatgpt.com/other"]) assert.throws(() => searchEndpoint({ ...model, provider: "openai-codex" }, base));
  for (const base of ["http://example.com", "https://user:secret@example.com", "https://example.com/?token=secret", "file:///tmp", "https://example.com/#secret"]) assert.throws(() => searchEndpoint(model, base), (error) => !error.message.includes("secret"));
});
test("proxy uses model-level auth headers, preserves null deletion and respects custom Authorization", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "ok", results: [] }));
  const reg = registry(`${remote.url}/v1`, { headers: { AUTHORIZATION: "Custom existing-provider-auth", "X-Model-Key": "model-secret", "X-Remove": null } });
  reg.model.headers = { "x-remove": "discard", "x-default": "keep" };
  reg.model.api = "openai-codex-responses"; // A proxy using the Codex API is still the current proxy, not direct ChatGPT.
  reg.find = reg.getAll = () => { throw new Error("must not select another model"); };
  const connection = await resolveConnection(reg.model, reg, signal());
  assert.equal(connection.headers.get("x-remove"), null);
  assert.deepEqual(await postSearch(connection, request, signal()), { output: "ok", results: [] });
  assert.equal(remote.requests[0].url, "/v1/alpha/search");
  assert.equal(remote.requests[0].headers.authorization, "Custom existing-provider-auth");
  assert.equal(remote.requests[0].headers["x-model-key"], "model-secret");
  assert.equal(remote.requests[0].headers["chatgpt-account-id"], undefined);
  assert.deepEqual(remote.requests[0].body, request);
  assert.equal(remote.requests[0].body.input, undefined);
});
test("keyless providers work; disabled authorization is not restored", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "ok" }));
  for (const auth of [{ apiKey: undefined }, { headers: { Authorization: null } }]) {
    const reg = registry(remote.url, auth);
    const connection = await resolveConnection(reg.model, reg, signal());
    await postSearch(connection, request, signal());
    assert.equal(remote.requests.at(-1).headers.authorization, undefined);
  }
});
test("auth-resolved base path is used but cross-origin credential forwarding is refused", async () => {
  const reg = registry("https://example.com/v1", { baseUrl: "https://example.com/api" });
  assert.equal((await resolveConnection(reg.model, reg, signal())).endpoint, "https://example.com/api/alpha/search");
  reg.resolved.baseUrl = "https://other.example.com/v1";
  await assert.rejects(resolveConnection(reg.model, reg, signal()), /changed the endpoint origin/);
});
test("direct OAuth resolves account header and stable identity across token refresh", async () => {
  const reg = registry("https://chatgpt.com/backend-api", { apiKey: token() });
  reg.model.provider = "openai-codex";
  const first = await resolveConnection(reg.model, reg, signal());
  assert.equal(first.endpoint, DIRECT_ENDPOINT);
  assert.equal(first.headers.get("chatgpt-account-id"), "account-1");
  assert.equal(first.headers.get("originator"), "pi");
  reg.resolved.apiKey = token("account-1", "refreshed");
  assert.equal((await resolveConnection(reg.model, reg, signal())).identity, first.identity);
  reg.resolved.apiKey = token("account-2");
  assert.notEqual((await resolveConnection(reg.model, reg, signal())).identity, first.identity);
  reg.resolved.headers = { "ChatGPT-Account-ID": "other-account" };
  await assert.rejects(resolveConnection(reg.model, reg, signal()), /does not match/);
  reg.resolved.headers = {}; reg.resolved.apiKey = "ordinary-api-key";
  await assert.rejects(resolveConnection(reg.model, reg, signal()), /account ID is missing/);
  reg.model.baseUrl = "https://evil.com/v1";
  reg.getApiKeyAndHeaders = () => { throw new Error("must not resolve auth"); };
  await assert.rejects(resolveConnection(reg.model, reg, signal()), /official ChatGPT/);
});
test("missing current model fails without selecting another provider or resolving credentials", async () => {
  const reg = registry("https://example.com");
  reg.find = reg.getAll = reg.getApiKeyAndHeaders = () => { throw new Error("must not access another connection"); };
  await assert.rejects(resolveConnection(undefined, reg, signal()), /No active Pi model/);
});
test("auth failure is sanitized and cancellation while resolving prevents request dispatch", async () => {
  const reg = registry("https://example.com", { ok: false, error: "secret-auth-error" });
  await assert.rejects(resolveConnection(reg.model, reg, signal()), (error) => /Pi could not resolve/.test(error.message) && !error.message.includes("secret-auth-error"));
  reg.getApiKeyAndHeaders = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = resolveConnection(reg.model, reg, controller.signal);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
});
test("provider proxy environment is resolved without echoing proxy credentials", async () => {
  const reg = registry("https://example.com/v1", { env: { HTTPS_PROXY: "http://user:password@127.0.0.1:8080", NO_PROXY: "localhost" } });
  assert.equal(new URL((await resolveConnection(reg.model, reg, signal())).proxy.httpsProxy).port, "8080");
  reg.resolved.env.NO_PROXY = "example.com";
  assert.equal((await resolveConnection(reg.model, reg, signal())).proxy.noProxy, "example.com");
  reg.resolved.env = { HTTPS_PROXY: "socks5://user:password@localhost:8080", NO_PROXY: "localhost" };
  await assert.rejects(resolveConnection(reg.model, reg, signal()), (error) => /SOCKS/.test(error.message) && !error.message.includes("password"));
});
test("HTTP proxy tunnel actually carries the search request without changing global dispatcher", async (t) => {
  const origin = await server(t, (_req, res) => json(res, { output: "via proxy" }));
  let tunnels = 0;
  const sockets = new Set();
  const proxy = createServer();
  proxy.on("connect", (_req, socket, head) => {
    tunnels++; sockets.add(socket);
    const upstream = connect(Number(new URL(origin.url).port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); proxy.close(resolve); }));
  const reg = registry(origin.url, { env: { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "not-this-host.invalid" } });
  const globalDispatcher = getGlobalDispatcher();
  const connection = await resolveConnection(reg.model, reg, signal());
  assert.equal((await postSearch(connection, request, signal())).output, "via proxy"); assert.equal(tunnels, 1);
  reg.resolved.env.NO_PROXY = "127.0.0.1";
  const bypass = await resolveConnection(reg.model, reg, signal());
  assert.equal((await postSearch(bypass, request, signal())).output, "via proxy");
  assert.equal(origin.requests.length, 2); assert.equal(tunnels, 1);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
});
test("redirects are refused without forwarding authentication", async (t) => {
  const destination = await server(t, (_req, res) => json(res, { output: "must not be fetched" }));
  const origin = await server(t, (_req, res) => { res.writeHead(307, { location: destination.url }); res.end(); });
  const reg = registry(origin.url);
  const connection = await resolveConnection(reg.model, reg, signal());
  await assert.rejects(postSearch(connection, request, signal()), /Redirect refused/);
  assert.equal(destination.requests.length, 0);
});
test("HTTP failures are descriptive, secret-free and never automatically retried", async (t) => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    const remote = await server(t, (_req, res) => { res.setHeader("Retry-After", "15"); json(res, { error: { code: "test_error", message: "test-secret-key-123 private payload" } }, status); });
    const reg = registry(remote.url);
    const connection = await resolveConnection(reg.model, reg, signal());
    await assert.rejects(postSearch(connection, request, signal()), (error) => error.message.includes(`HTTP ${status}`) && !/private payload|test-secret-key/.test(error.message));
    assert.equal(remote.requests.length, 1);
  }
});
test("non-JSON, wrong protocol and response size limits fail safely", async (t) => {
  for (const [handler, pattern] of [
    [(_req, res) => res.end("<html>secret login page</html>"), /non-JSON/],
    [(_req, res) => json(res, { output: 3 }), /protocol error/],
    [(_req, res) => { res.writeHead(200, { "Content-Length": MAX_RESPONSE_BYTES + 1 }); res.end("x"); }, /2 MiB/],
    [(_req, res) => { res.writeHead(200); res.end("x".repeat(MAX_RESPONSE_BYTES + 1)); }, /2 MiB/],
  ]) {
    const remote = await server(t, handler);
    const reg = registry(remote.url);
    const connection = await resolveConnection(reg.model, reg, signal());
    await assert.rejects(postSearch(connection, request, signal()), pattern);
  }
});
test("deadline covers response body and aborted calls stop promptly", async (t) => {
  const remote = await server(t, (_req, res) => { res.writeHead(200); res.write('{"output":"'); });
  const reg = registry(remote.url);
  const connection = await resolveConnection(reg.model, reg, signal());
  await assert.rejects(postSearch(connection, request, AbortSignal.timeout(50)), /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(postSearch(connection, request, controller.signal), { name: "AbortError" });
});
test("successful response redacts credentials, strips controls and discards ciphertext", async (t) => {
  const remote = await server(t, (_req, res) => json(res, { output: "token test-secret-key-123 \u001b[31mred\u001b[0m\u0007", results: [{ title: "test-secret-key-123", future: { value: "\u001b[2Jhello" } }], encrypted_output: "ciphertext" }));
  const reg = registry(remote.url);
  const connection = await resolveConnection(reg.model, reg, signal());
  const result = await postSearch(connection, request, signal());
  assert.equal(result.output, "token [redacted] red");
  assert.equal(result.results[0].future.value, "hello");
  assert.ok(!JSON.stringify(result).includes("test-secret-key")); assert.equal(result.encrypted_output, undefined);
  assert.equal(safeText("\u001b]52;c;evil\u0007safe"), "safe");
});
