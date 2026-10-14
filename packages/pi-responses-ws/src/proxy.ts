import { HttpsProxyAgent } from "https-proxy-agent";
import type { ProviderEnv } from "@earendil-works/pi-ai";

// Pi's extension loader cannot import its node-http-proxy subpath. Keep the same HTTP(S)/NO_PROXY rules locally.
export function proxyFor(target: URL, env?: ProviderEnv): string | undefined {
  const value = (name: string) => env?.[name.toLowerCase()] || env?.[name.toUpperCase()] || process.env[name.toLowerCase()] || process.env[name.toUpperCase()] || "";
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  for (const entry of value("no_proxy").toLowerCase().split(/[,\s]+/).filter(Boolean)) {
    if (entry === "*") return undefined;
    let domain = entry, requiredPort: string | undefined;
    if (entry.startsWith("[")) {
      const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
      if (!match) continue;
      domain = match[1]!; requiredPort = match[2];
    } else if (entry.split(":").length === 2) {
      const match = /^(.*):(\d+)$/.exec(entry);
      if (match) { domain = match[1]!; requiredPort = match[2]; }
    }
    domain = domain.replace(/^\*?\.?/, "");
    if ((!requiredPort || Number(requiredPort) === Number(port)) && domain && (host === domain || host.endsWith(`.${domain}`))) return undefined;
  }
  let raw = value(target.protocol === "https:" ? "https_proxy" : "http_proxy") || value("all_proxy");
  if (!raw) return undefined;
  if (!raw.includes("://")) raw = `${target.protocol}//${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Responses WS: invalid proxy URL (redacted)"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Responses WS: only HTTP(S) proxies are supported, not SOCKS/PAC");
  return url.href;
}

export function proxyAgent(url?: string): HttpsProxyAgent<string> | undefined {
  return url ? new HttpsProxyAgent(url) : undefined;
}
