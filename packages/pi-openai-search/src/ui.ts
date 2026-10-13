import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { parseConfig, type SearchConfig } from "./config.ts";
import { safeText, searchEndpoint, searchModel } from "./client.ts";
import type { SearchCommands } from "./protocol.ts";
import type { Source } from "./output.ts";

export interface SearchDetails {
  provider: string;
  model: string;
  durationMs: number;
  resultCount?: number;
  sources: Source[];
  truncated: boolean;
  fullOutputPath?: string;
}
export function configurationStatus(config: SearchConfig, ctx: Pick<ExtensionCommandContext, "model" | "modelRegistry" | "sessionManager">): string {
  const model = searchModel(ctx);
  return [
    "Connection: 跟随当前 Pi 会话（无需配置连接）",
    `Provider/model: ${model.provider}/${model.id}`,
    `Endpoint: ${searchEndpoint(model)}`,
    `Timeout: ${config.request.timeoutMs / 1000}s; output budget: ${config.request.maxOutputTokens} tokens`,
    "Credentials: resolved by Pi at request time; no secret is stored in this extension.",
  ].join("\n");
}
export async function configureSettings(ctx: ExtensionCommandContext, current: SearchConfig): Promise<SearchConfig | undefined> {
  const text = await ctx.ui.editor("搜索设置与请求限制（JSON，不填写 API Key）", JSON.stringify({ settings: current.settings, request: current.request }, null, 2));
  if (text === undefined) return;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid settings JSON; nothing was saved."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["settings", "request"].includes(key))) {
    throw new Error("This editor accepts only settings and request.");
  }
  return parseConfig({ ...current, ...value });
}
export function renderSearchCall(args: SearchCommands, theme: Theme): Text {
  const summary = args.search_query?.map((query) => query.q).join("; ")
    ?? Object.keys(args).filter((key) => key !== "response_length").join(", ");
  return new Text(theme.fg("toolTitle", theme.bold("OpenAI Search ")) + safeText(summary).slice(0, 300), 0, 0);
}
export function renderSearchResult(result: { content: { type: string; text?: string }[]; details?: SearchDetails; isError?: boolean }, expanded: boolean, partial: boolean, theme: Theme): Text {
  if (partial) return new Text(theme.fg("muted", "Searching…"), 0, 0);
  const details = result.details;
  if (!details || result.isError) return new Text(theme.fg("error", safeText(result.content.find((item) => item.type === "text")?.text ?? "Search failed")), 0, 0);
  const count = details.resultCount === undefined ? "text result" : `${details.resultCount} structured results`;
  const lines = [theme.fg("success", `${count} · ${(details.durationMs / 1000).toFixed(1)}s · ${details.provider}/${details.model}`)];
  for (const source of details.sources) lines.push(safeText(`${source.title}\n${source.url}`));
  if (details.truncated) lines.push(theme.fg("warning", `Truncated: ${details.fullOutputPath}`));
  if (expanded) lines.push(safeText(result.content.find((item) => item.type === "text")?.text ?? ""));
  return new Text(lines.join("\n"), 0, 0);
}
