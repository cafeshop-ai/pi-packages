// Explicit opt-in only: this script uses existing Pi credentials and sends public queries.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/config.ts";
import { postSearch, resolveConnection, SearchError } from "../src/client.ts";
import { operationError, parseCommands, resultReferences } from "../src/protocol.ts";

const { values } = parseArgs({ options: {
  provider: { type: "string" }, model: { type: "string" },
  direct: { type: "boolean", default: false }, all: { type: "boolean", default: false },
} });
if (!values.model || (!values.direct && !values.provider)) {
  console.error("Usage: npm run test:live -- --provider cafe --model <existing-model-id> [--all]\n   or: npm run test:live -- --direct --model <existing-codex-model-id>");
  process.exit(2);
}
const config = parseConfig({});
const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));
const model = registry.find(values.direct ? "openai-codex" : values.provider, values.model);
const id = randomUUID();
let failures = 0;
async function run(label, commands) {
  try {
    const signal = AbortSignal.timeout(config.request.timeoutMs);
    const connection = await resolveConnection(model, registry, signal);
    const response = await postSearch(connection, { id, model: connection.model.id, commands: parseCommands(commands), settings: config.settings, max_output_tokens: 2000 }, signal);
    const error = operationError(response);
    if (error) failures++;
    console.log(JSON.stringify({ operation: label, httpSuccess: true, operationError: error, outputPreview: response.output.slice(0, 650), refs: resultReferences(response).slice(0, 8), resultTypes: response.results?.map((item) => item?.type) }));
    return response;
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ operation: label, httpSuccess: false, error: error instanceof SearchError ? error.message : "Credential or protocol setup failed; inspect Pi configuration without logging credentials." }));
    return undefined;
  }
}
const search = await run("search", { search_query: [{ q: "OpenAI Codex official documentation", domains: ["developers.openai.com"] }], response_length: "short" });
const firstRef = search && resultReferences(search)[0];
if (firstRef) {
  const opened = await run("open-reference", { open: [{ ref_id: firstRef }], response_length: "short" });
  const pageRef = opened && (resultReferences(opened).find((ref) => /view|fetch/.test(ref)) ?? resultReferences(opened)[0]);
  if (pageRef) {
    await run("find-in-page", { find: [{ ref_id: pageRef, pattern: "Codex" }], response_length: "short" });
    const link = opened.output.match(/(?:【|cite)(\d+)†/);
    if (link) await run("click-link", { click: [{ ref_id: pageRef, id: Number(link[1]) }], response_length: "short" });
    else console.log(JSON.stringify({ operation: "click-link", skipped: "Opened page exposed no numbered link." }));
  } else { failures++; console.log(JSON.stringify({ operation: "find-in-page", skipped: "No page reference returned; navigation is not verified." })); }
} else { failures++; console.log(JSON.stringify({ operation: "open-reference", skipped: "No search reference returned; navigation is not verified." })); }
if (values.all) {
  await run("open-url", { open: [{ ref_id: "https://developers.openai.com/codex/cli" }], response_length: "short" });
  await run("find-url", { find: [{ ref_id: "https://developers.openai.com/codex/cli", pattern: "Codex" }], response_length: "short" });
  await run("image-query", { image_query: [{ q: "Mount Fuji" }], response_length: "short" });
  await run("finance", { finance: [{ ticker: "AMD", type: "equity", market: "USA" }], response_length: "short" });
  await run("weather", { weather: [{ location: "France, Paris", duration: 1 }], response_length: "short" });
  await run("sports", { sports: [{ fn: "standings", league: "nba" }], response_length: "short" });
  await run("time", { time: [{ utc_offset: "+00:00" }], response_length: "short" });
  await run("pdf-screenshot", { screenshot: [{ ref_id: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf", pageno: 0 }], response_length: "short" });
}
console.log(JSON.stringify({ failures, note: "HTTP success alone does not prove a usable operation: review outputPreview for provider-side errors. No config or credential was copied to this package." }));
process.exitCode = failures ? 1 : 0;
