import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommands, operationError } from "../src/protocol.ts";
import { formatResult } from "../src/output.ts";
import { postSearch, resolveConnection } from "../src/client.ts";
import { server, json, registry, request } from "./helpers.mjs";

test("sports normalizes the optional wire tool discriminant for observed backends", () => {
  const commands = { sports: [{ fn: "standings", league: "nba" }] };
  assert.equal(parseCommands(commands).sports[0].tool, "sports");
  assert.equal(commands.sports[0].tool, undefined);
});
test("known HTTP 200 operation failures remain structured but are flagged", async () => {
  for (const output of ["Error parsing function call: Invalid function_name='run' call", "Internal Error ()\nUnable to resolve screenshot call"]) {
    assert.ok(operationError({ output }));
    assert.ok((await formatResult({ output, results: [] })).error);
  }
  for (const output of ["How to fix Internal Error () in your app", "Documentation\nError parsing function call: example", "No results found", ""]) {
    assert.equal(operationError({ output }), undefined);
  }
});
test("observed affinity conflict gives actionable guidance without replay or arbitrary error text", async (t) => {
  for (const error of [{ code: "search_session_affinity_lost" }, { message: "search_session_affinity_lost: the search request references prior results but no bound session candidate exists SECRET" }]) {
    const remote = await server(t, (_req, res) => json(res, { error }, 409));
    const signal = AbortSignal.timeout(5000);
    const reg = registry(remote.url);
    const connection = await resolveConnection(reg.model, reg, signal);
    await assert.rejects(postSearch(connection, request, signal), (error) => /search_session_affinity_lost/.test(error.message) && /original URL/.test(error.message) && !error.message.includes("SECRET"));
    assert.equal(remote.requests.length, 1);
  }
});
