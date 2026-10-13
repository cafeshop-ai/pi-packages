import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const nonempty = () => Type.String({ minLength: 1, maxLength: 8192, pattern: "\\S" });
const integer = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const enums = <const T extends string[]>(values: T) => StringEnum(values);
const optionalList = <T extends TSchema>(item: T, maxItems = 20) => Type.Optional(Type.Array(item, { minItems: 1, maxItems }));
const domains = () => Type.Array(nonempty(), { maxItems: 100 });
const query = object({ q: nonempty(), recency: Type.Optional(integer()), domains: Type.Optional(domains()) });
const date = () => Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

// Wire contract: openai/codex a9b0815167, codex-rs/codex-api/src/search.rs.
export const CommandsSchema = object({
  search_query: optionalList(query, 4),
  image_query: optionalList(query),
  open: optionalList(object({ ref_id: nonempty(), lineno: Type.Optional(integer()) })),
  click: optionalList(object({ ref_id: nonempty(), id: integer() })),
  find: optionalList(object({ ref_id: nonempty(), pattern: nonempty() })),
  screenshot: optionalList(object({ ref_id: nonempty(), pageno: integer() })),
  finance: optionalList(object({ ticker: nonempty(), type: enums(["equity", "fund", "crypto", "index"]), market: Type.Optional(Type.String({ pattern: "^(?:[A-Z]{3})?$" })) })),
  weather: optionalList(object({ location: nonempty(), start: Type.Optional(date()), duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })) })),
  sports: optionalList(object({
    tool: Type.Optional(Type.Literal("sports")), fn: enums(["schedule", "standings"]),
    league: enums(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"]),
    team: Type.Optional(nonempty()), opponent: Type.Optional(nonempty()),
    date_from: Type.Optional(date()), date_to: Type.Optional(date()),
    num_games: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), locale: Type.Optional(nonempty()),
  })),
  time: optionalList(object({ utc_offset: Type.String({ pattern: "^[+-](?:0[0-9]|1[0-4]):[0-5][0-9]$" }) })),
  response_length: Type.Optional(enums(["short", "medium", "long"])),
});
export type SearchCommands = Static<typeof CommandsSchema>;

export const SettingsSchema = object({
  external_web_access: Type.Optional(Type.Union([Type.Boolean(), enums(["cached", "indexed", "live"])])),
  search_context_size: Type.Optional(enums(["low", "medium", "high"])),
  filters: Type.Optional(object({ allowed_domains: Type.Optional(domains()), blocked_domains: Type.Optional(domains()) })),
  user_location: Type.Optional(object({
    type: Type.Literal("approximate"), country: Type.Optional(Type.String({ pattern: "^[A-Z]{2}$" })),
    region: Type.Optional(nonempty()), city: Type.Optional(nonempty()), timezone: Type.Optional(nonempty()),
  })),
  image_settings: Type.Optional(object({ max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), caption: Type.Optional(Type.Boolean()) })),
  allowed_callers: Type.Optional(Type.Array(enums(["direct", "shell", "code_interpreter"]), { minItems: 1, maxItems: 3, uniqueItems: true })),
});
export type SearchSettings = Static<typeof SettingsSchema>;
export interface SearchRequest {
  id: string;
  model: string;
  commands: SearchCommands;
  settings: SearchSettings;
  max_output_tokens: number;
}
export interface SearchResponse { output: string; results?: unknown[] | null }

export const ResultSchema = object({
  output: Type.String(), results: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()])),
  truncated: Type.Boolean(), fullOutputPath: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
});
export type SearchResult = Static<typeof ResultSchema>;

export function validate<T extends TSchema>(schema: T, value: unknown, label: string): asserts value is Static<T> {
  if (!Value.Check(schema, value)) {
    const error = [...Value.Errors(schema, value)][0];
    // Do not echo values: configuration mistakes can contain credentials.
    throw new Error(`${label}: invalid value at ${error?.instancePath || "/"}`);
  }
}

export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\x7f]/.test(value);
  } catch { return false; }
}
export function isReference(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value); }
export function references(commands: SearchCommands): string[] {
  return [commands.open, commands.click, commands.find, commands.screenshot].flatMap((items) => items?.map((item) => item.ref_id) ?? []);
}
function validateDomains(values: string[] | undefined): void {
  for (const value of values ?? []) {
    if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+$/.test(value) || value.length > 253) {
      throw new Error("Domains must be hostnames without scheme, path, port or wildcard (use punycode for international names).");
    }
  }
}
function validateDate(value: string | undefined): void {
  if (value && (!Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
    throw new Error("Date must be a real calendar date in YYYY-MM-DD format.");
  }
}
export function parseCommands(value: unknown): SearchCommands {
  validate(CommandsSchema, value, "Search commands");
  if (!Object.entries(value).some(([key, entry]) => key !== "response_length" && Array.isArray(entry) && entry.length)) {
    throw new Error("At least one search operation is required.");
  }
  if (value.search_query?.length === 4 && !["medium", "long"].includes(value.response_length ?? "short")) {
    throw new Error("Four search queries require response_length medium or long.");
  }
  for (const query of [...value.search_query ?? [], ...value.image_query ?? []]) validateDomains(query.domains);
  for (const ref of references(value)) if (!isReference(ref) && !isWebUrl(ref)) throw new Error("ref_id must be a search reference or an HTTP(S) URL without credentials.");
  for (const weather of value.weather ?? []) validateDate(weather.start);
  for (const sports of value.sports ?? []) {
    validateDate(sports.date_from); validateDate(sports.date_to);
    if (sports.date_from && sports.date_to && sports.date_from > sports.date_to) throw new Error("date_from must not be after date_to.");
  }
  for (const time of value.time ?? []) if (time.utc_offset.slice(1, 3) === "14" && !time.utc_offset.endsWith(":00")) throw new Error("UTC offset cannot exceed 14 hours.");
  const commands = structuredClone(value);
  for (const sports of commands.sports ?? []) sports.tool ??= "sports";
  return commands;
}
export function checkSettings(settings: SearchSettings): void {
  validate(SettingsSchema, settings, "Search settings");
  validateDomains(settings.filters?.allowed_domains); validateDomains(settings.filters?.blocked_domains);
  if (settings.user_location?.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: settings.user_location.timezone }); }
    catch { throw new Error("user_location.timezone must be an IANA time zone."); }
  }
}
export function parseResponse(value: unknown): SearchResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as SearchResponse).output !== "string") {
    throw new Error("Search protocol error: expected a JSON object with string output.");
  }
  const response = value as SearchResponse;
  if (response.results !== undefined && response.results !== null && !Array.isArray(response.results)) throw new Error("Search protocol error: results must be an array, null, or absent.");
  return { output: response.output, ...(response.results !== undefined ? { results: response.results } : {}) };
}

export function operationError(response: SearchResponse): string | undefined {
  // Only recognize observed protocol error prefixes, not words appearing inside ordinary pages.
  if (/^Error parsing function call:/.test(response.output.trimStart())) return "The search service rejected this operation schema.";
  if (/^Internal Error \(\)\r?\n/.test(response.output.trimStart())) return "The search service could not complete this operation.";
  return undefined;
}

export function resultReferences(response: SearchResponse): string[] {
  const refs = new Set(response.output.match(/\bturn\d+[A-Za-z]+\d+\b/g) ?? []);
  const pending: unknown[] = [response.results];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) for (const child of item) pending.push(child);
    else for (const [key, value] of Object.entries(item)) {
      if (key === "ref_id" && typeof value === "string" && isReference(value)) refs.add(value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  return [...refs];
}
