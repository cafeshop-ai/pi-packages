import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { checkSettings, SettingsSchema, validate } from "./protocol.ts";

const RequestSchema = Type.Object({
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 300000 }),
  maxOutputTokens: Type.Integer({ minimum: 128, maximum: 32000 }),
}, { additionalProperties: false });
const ConfigSchema = Type.Object({
  settings: SettingsSchema, request: RequestSchema,
}, { additionalProperties: false });
const InputSchema = Type.Partial(Type.Object({
  ...ConfigSchema.properties, request: Type.Partial(RequestSchema),
}, { additionalProperties: false }));
export type SearchConfig = Static<typeof ConfigSchema>;
export const DEFAULT_CONFIG: SearchConfig = {
  settings: { external_web_access: true, allowed_callers: ["direct"] },
  request: { timeoutMs: 60000, maxOutputTokens: 4000 },
};
export function configPath(): string { return join(getAgentDir(), "pi-openai-search.json"); }

export function parseConfig(value: unknown): SearchConfig {
  // Ignore legacy connection overrides; only the active Pi model determines the connection.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { mode, direct, proxy, ...settings } = value as Record<string, unknown>;
    value = settings;
  }
  validate(InputSchema, value, "Search configuration");
  const config = {
    ...structuredClone(DEFAULT_CONFIG), ...value,
    settings: { ...DEFAULT_CONFIG.settings, ...value.settings },
    request: { ...DEFAULT_CONFIG.request, ...value.request },
  };
  validate(ConfigSchema, config, "Search configuration");
  checkSettings(config.settings);
  return structuredClone(config);
}
export async function loadConfig(path = configPath()): Promise<SearchConfig> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw new Error(`Cannot read search configuration: ${path}`);
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid JSON in ${path}; the file has not been overwritten.`); }
  try { return parseConfig(value); }
  catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
}
export async function saveConfig(next: SearchConfig, expected: SearchConfig, path = configPath()): Promise<void> {
  const validated = parseConfig(next);
  await withFileMutationQueue(path, async () => {
    const current = await loadConfig(path);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Search configuration changed while editing. Reopen /openai-search settings.");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  });
}
