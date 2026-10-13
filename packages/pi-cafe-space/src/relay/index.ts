import { hasSufficientTokenEntropy } from "../protocol/index.js";
import { createRelayServer } from "./server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 37_891;
const DEFAULT_HOST_TOKEN = "local-dev-host-token";
const DEFAULT_CLIENT_TOKEN = "local-dev-client-token";
const DEFAULT_TOKENS = new Set([DEFAULT_HOST_TOKEN, DEFAULT_CLIENT_TOKEN]);
function isDefaultToken(value: string): boolean { return DEFAULT_TOKENS.has(value.toLowerCase()); }
const PLACEHOLDER_TOKEN_PATTERN = /^replace-with-(?:(?:a-long-random-)?(?:host|client)|a-long-random|random)-token$/i;
const MAX_ALLOWED_ORIGINS = 64;
const MAX_ALLOWED_ORIGIN_LENGTH = 2_048;
const MAX_ALLOWED_ORIGINS_TEXT_LENGTH = MAX_ALLOWED_ORIGINS * (MAX_ALLOWED_ORIGIN_LENGTH + 1);
const MAX_PORT_TEXT_LENGTH = 16;

function describeError(error: unknown): string {
  try { return error instanceof Error && typeof error.message === "string" ? error.message : String(error); }
  catch { return "Unknown relay error"; }
}

function parsePort(value: string | undefined): number {
  if (value !== undefined && value.length > MAX_PORT_TEXT_LENGTH) throw new Error("PI_COLLAB_PORT must be a valid TCP port");
  const text = value?.trim();
  const port = text === undefined || text === "" ? DEFAULT_PORT : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PI_COLLAB_PORT must be a valid TCP port");
  }
  return port;
}

const rawHost = process.env.PI_COLLAB_HOST;
if (rawHost !== undefined && rawHost.length > 255) throw new Error("PI_COLLAB_HOST is too long");
const host = rawHost?.trim() || DEFAULT_HOST;
const normalizedHost = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
const rawHostToken = process.env.PI_COLLAB_HOST_TOKEN;
const rawClientToken = process.env.PI_COLLAB_CLIENT_TOKEN;
if ((rawHostToken !== undefined && rawHostToken.length > 4_096) || (rawClientToken !== undefined && rawClientToken.length > 4_096)) {
  throw new Error("Host and client tokens must be at most 4096 characters");
}
const configuredHostToken = rawHostToken?.trim();
const configuredClientToken = rawClientToken?.trim();
const hostToken = configuredHostToken || DEFAULT_HOST_TOKEN;
const clientToken = configuredClientToken || DEFAULT_CLIENT_TOKEN;
if (hostToken.length > 4_096 || clientToken.length > 4_096) {
  throw new Error("Host and client tokens must be at most 4096 characters");
}
const isLoopback = normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";

if (!isLoopback && (!configuredHostToken || !configuredClientToken || hostToken.toLowerCase() === clientToken.toLowerCase() ||
    isDefaultToken(hostToken) || isDefaultToken(clientToken) ||
    PLACEHOLDER_TOKEN_PATTERN.test(hostToken) || PLACEHOLDER_TOKEN_PATTERN.test(clientToken) ||
    !hasSufficientTokenEntropy(hostToken) || !hasSufficientTokenEntropy(clientToken))) {
  throw new Error("Explicit high-entropy non-default tokens (at least 16 characters) are required outside loopback mode");
}

const rawAllowedOrigins = process.env.PI_COLLAB_ALLOWED_ORIGINS ?? "";
// Bound the raw environment value before splitting it. Otherwise a malformed
// startup configuration containing millions of separators/whitespace could
// allocate an unnecessarily large temporary array before the entry limits are
// checked below.
if (rawAllowedOrigins.length > MAX_ALLOWED_ORIGINS_TEXT_LENGTH) {
  throw new Error("PI_COLLAB_ALLOWED_ORIGINS is too large");
}
const allowedOrigins = rawAllowedOrigins
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (allowedOrigins.length > MAX_ALLOWED_ORIGINS || allowedOrigins.some((origin) => origin.length > MAX_ALLOWED_ORIGIN_LENGTH)) {
  throw new Error("PI_COLLAB_ALLOWED_ORIGINS is too large");
}

const relay = createRelayServer({
  host,
  port: parsePort(process.env.PI_COLLAB_PORT),
  hostToken,
  clientToken,
  allowedOrigins,
});

const running = await relay.listen();

if (isLoopback && (!configuredHostToken || !configuredClientToken)) {
  console.warn("Using loopback-only development credentials. Set explicit tokens before LAN or server deployment.");
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await running.close();
    process.exit(0);
  } catch (error) {
    console.error(`Relay shutdown failed: ${describeError(error)}`);
    process.exit(1);
  }
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
