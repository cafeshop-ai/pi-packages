import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readPrivateJSON } from './private-json.js';
import { homedir } from "node:os";
import { open, stat, unlink } from "node:fs/promises";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../protocol/index.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEVELOPMENT_CLIENT_TOKEN = "local-dev-client-token";
const MAX_HEALTH_RESPONSE_BYTES = 8 * 1024;
const MAX_RELAY_URL_LENGTH = 8_192;
const MAX_HOST_TOKEN_LENGTH = 4_096;
const MAX_CLIENT_TOKEN_LENGTH = 4_096;
const MAX_ALLOWED_ORIGINS_TEXT_LENGTH = 64 * (2_048 + 1);

export interface LocalRelayConfig {
  relayUrl: string;
  hostToken: string;
}

export type LocalRelayStatus = "already_running" | "started" | "remote" | "unavailable";

export function localCredentialFile(relayUrl: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const url = new URL(relayUrl);
  if (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/ws') return null;
  const configured = environment.PI_CAFE_CREDENTIALS_FILE;
  if (configured !== undefined) {
    if (!configured || configured.length > 4096 || configured.includes('\0') || !isAbsolute(configured)) throw Error('Invalid Café Space credential path');
    return configured;
  }
  return join(environment.HOME || homedir(), '.config', 'pi-cafe-space', `credentials-${url.port || '80'}.json`);
}

export function readLocalHostToken(path: string, relayUrl: string): string | null {
  let value: Record<string, unknown>;
  try { value = readPrivateJSON(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (value.version !== 1 || value.port !== Number(new URL(relayUrl).port || 80) || typeof value.hostToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.hostToken)) throw Error('Invalid Café Space credentials');
  return value.hostToken;
}

function hasUrlUserInfo(value: string): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
  return authority?.includes("@") === true;
}

function hasUrlFragment(value: string): boolean {
  return value.trim().includes("#");
}

function healthUrl(relayUrl: URL): URL {
  const url = new URL(relayUrl);
  url.protocol = "http:";
  url.username = "";
  url.password = "";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_HEALTH_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("Health response is too large");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("Health response is not valid UTF-8");
  }
}

async function healthy(url: URL): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(700), redirect: "error" });
    if (!response.ok) return false;
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      if (!/^\d+$/.test(declaredLengthHeader) || declaredLengthHeader.length > 16 || Number(declaredLengthHeader) > MAX_HEALTH_RESPONSE_BYTES) return false;
    }
    const bodyText = await boundedResponseText(response);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return false;
    }
    return body !== null && typeof body === "object" && !Array.isArray(body) &&
      (body as { ok?: unknown }).ok === true && (body as { protocolVersion?: unknown }).protocolVersion === PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function relayEnvironment(bindHost: string, port: string, hostToken: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  // The relay never needs the Pi/provider environment. Pass only the small set
  // of OS variables needed to launch a detached Node process plus relay
  // configuration, rather than trying to maintain an incomplete secret-name
  // blacklist (which could miss a provider's custom credential variable).
  const allowedParentNames = new Set([
    "home", "path", "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "localappdata",
    "appdata", "programdata", "allusersprofile", "public", "userprofile", "homedrive", "homepath", "homeshare",
    "programfiles", "programfiles(x86)", "programw6432", "commonprogramfiles", "commonprogramfiles(x86)",
    "commonprogramw6432", "os", "number_of_processors", "processor_architecture", "processor_identifier",
    "processor_level", "processor_revision",
  ]);
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowedParentNames.has(name.toLowerCase())) environment[name] = value;
  }
  if (parent.PI_CAFE_CREDENTIALS_FILE !== undefined) environment.PI_CAFE_CREDENTIALS_FILE = parent.PI_CAFE_CREDENTIALS_FILE;
  environment.PI_COLLAB_HOST = bindHost;
  environment.PI_COLLAB_PORT = port;
  environment.PI_COLLAB_HOST_TOKEN = hostToken;
  environment.PI_COLLAB_CLIENT_TOKEN = parent.PI_COLLAB_CLIENT_TOKEN?.trim() || DEVELOPMENT_CLIENT_TOKEN;
  if (parent.PI_COLLAB_ALLOWED_ORIGINS !== undefined) {
    environment.PI_COLLAB_ALLOWED_ORIGINS = parent.PI_COLLAB_ALLOWED_ORIGINS;
  }
  return environment;
}

async function acquireStartLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>> | null> {
  for (;;) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return null;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        // The health loop can spend ~24 seconds in fetch timeouts; do not
        // evict a slow but live starter before that window has elapsed.
        if (age > 60_000) {
          await unlink(lockPath);
          continue;
        }
      } catch {
        // The competing starter may have just released the lock.
      }
      return null;
    }
  }
}

async function releaseStartLock(lockPath: string, lock: Awaited<ReturnType<typeof open>>): Promise<void> {
  try { await lock.close(); } catch {}
  try { await unlink(lockPath); } catch {}
}

async function waitForHealthy(url: URL, attempts = 30): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await delay(100);
    if (await healthy(url)) return true;
  }
  return false;
}

export async function ensureLocalRelay(config: LocalRelayConfig): Promise<LocalRelayStatus> {
  const configuredClientToken = process.env.PI_COLLAB_CLIENT_TOKEN;
  const configuredOrigins = process.env.PI_COLLAB_ALLOWED_ORIGINS;
  if (configuredClientToken !== undefined && configuredClientToken.length > MAX_CLIENT_TOKEN_LENGTH) return "unavailable";
  if (configuredOrigins !== undefined && configuredOrigins.length > MAX_ALLOWED_ORIGINS_TEXT_LENGTH) return "unavailable";
  if (!config || typeof config.relayUrl !== "string" || typeof config.hostToken !== "string" ||
      config.relayUrl.length > MAX_RELAY_URL_LENGTH || config.hostToken.length > MAX_HOST_TOKEN_LENGTH ||
      !config.hostToken.trim()) return "remote";
  let relayUrl: URL;
  try {
    relayUrl = new URL(config.relayUrl);
  } catch {
    return "remote";
  }
  if (hasUrlUserInfo(config.relayUrl) || hasUrlFragment(config.relayUrl) || relayUrl.username || relayUrl.password || relayUrl.hash || relayUrl.protocol !== "ws:" || relayUrl.port === "0" ||
      relayUrl.search || !LOOPBACK_HOSTS.has(relayUrl.hostname) || relayUrl.pathname !== "/ws") return "remote";

  const checkUrl = healthUrl(relayUrl);
  if (await healthy(checkUrl)) return "already_running";

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(moduleDir, "../..");
  const relayEntry = resolve(packageRoot, "dist/relay/index.js");
  if (!existsSync(relayEntry)) return "unavailable";

  const port = relayUrl.port || "80";
  const bindHost = relayUrl.hostname === "localhost" ? "127.0.0.1" : relayUrl.hostname.replace(/^\[|\]$/g, "");
  const startOptions: StartRelayOptions = {
    checkUrl,
    relayEntry,
    packageRoot,
    bindHost,
    port,
    hostToken: config.hostToken,
  };
  const runtimeDir = resolve(packageRoot, ".runtime");
  try {
    mkdirSync(runtimeDir, { recursive: true });
  } catch {
    // A globally installed package may be read-only. The relay itself does
    // not require the convenience runtime directory or PID file.
    return launchRelay(startOptions);
  }
  const lockKey = `${bindHost}-${port}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const lockPath = resolve(runtimeDir, `relay.start.${lockKey}.lock`);
  const startLock = await acquireStartLock(lockPath);
  if (!startLock) {
    // An absent lock after an acquisition failure usually means the runtime
    // directory is read-only (EACCES/EROFS), not that another starter owns a
    // lock. Fall back immediately; launchRelay rechecks health before spawn.
    if (!existsSync(lockPath)) return launchRelay(startOptions);
    // Another Pi process is probably starting the same local relay. Do not
    // launch a second listener; wait for the winner, then use it.
    if (await waitForHealthy(checkUrl)) return "already_running";
    const retryLock = await acquireStartLock(lockPath);
    if (!retryLock) {
      // Lock creation may remain unavailable when an existing runtime
      // directory is read-only. Fall back to the normal port race;
      // launchRelay rechecks health before spawning.
      return launchRelay(startOptions);
    }
    return startRelayUnderLock(retryLock, lockPath, startOptions);
  }
  return startRelayUnderLock(startLock, lockPath, startOptions);
}

interface StartRelayOptions {
  checkUrl: URL;
  relayEntry: string;
  packageRoot: string;
  bindHost: string;
  port: string;
  hostToken: string;
}

async function launchRelay(options: StartRelayOptions): Promise<LocalRelayStatus> {
  const { checkUrl, relayEntry, packageRoot, bindHost, port, hostToken } = options;
  // Re-check before spawning: a manually started relay (or a starter that did
  // not observe the lock) may have won the port race.
  if (await healthy(checkUrl)) return "already_running";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [relayEntry], {
      cwd: packageRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: relayEnvironment(bindHost, port, hostToken),
    });
  } catch {
    return "unavailable";
  }
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  child.unref();

  for (let attempt = 0; attempt < 30; attempt++) {
    if (spawnError) break;
    await delay(100);
    if (await healthy(checkUrl)) {
      // Give a losing listener enough time to report its bind error before
      // deciding which PID owns the convenience file. This matters when two
      // read-only-runtime starters race without the persistent lock.
      await delay(100);
      if (!spawnError && child.exitCode === null && child.pid) {
        try {
          // Never overwrite another starter's ownership marker in the
          // lockless/read-only fallback path. The PID file is convenience
          // metadata only; a failed atomic create must not affect the relay.
          writeFileSync(relayPidPath(packageRoot, bindHost, port), String(child.pid), { encoding: "utf8", flag: "wx" });
        } catch {
          // The relay can still run if writing the convenience PID file fails.
        }
        return "started";
      }
      // The healthy endpoint belongs to another starter (or this child has
      // already failed). Do not leave a losing detached child alive after the
      // port race; it has no useful work and could retain the inherited relay
      // configuration indefinitely.
      if (child.exitCode === null) {
        try { child.kill(); } catch {}
      }
      return "already_running";
    }
    if (child.exitCode !== null) break;
  }
  if (child.exitCode === null) {
    try { child.kill(); } catch {}
  }
  return "unavailable";
}

// Shared pure environment/health helpers; the existing Node default is unchanged.
export { healthy as localRelayHealthy, relayEnvironment as localRelayEnvironment };

function relayPidPath(packageRoot: string, bindHost: string, port: string): string {
  const lockKey = `${bindHost}-${port}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filename = bindHost === "127.0.0.1" && port === "37891" ? "relay.pid" : `relay.${lockKey}.pid`;
  return resolve(packageRoot, ".runtime", filename);
}

async function startRelayUnderLock(
  startLock: Awaited<ReturnType<typeof open>>,
  lockPath: string,
  options: StartRelayOptions,
): Promise<LocalRelayStatus> {
  try {
    return await launchRelay(options);
  } finally {
    await releaseStartLock(lockPath, startLock);
  }
}
