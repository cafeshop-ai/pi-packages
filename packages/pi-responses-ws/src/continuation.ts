import { isDeepStrictEqual } from "node:util";
import { normalizeContext, openAIResponsesApi, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai/compat";

export type Body = Record<string, unknown> & { input: unknown[] };
export type Continuation = { properties: Record<string, unknown>; input: unknown[]; responseId: string };
export const MAX_BYTES = 16 * 1024 * 1024;

export function properties(body: Body): Record<string, unknown> {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return rest;
}

export function continuedBody(body: Body, previous?: Continuation): Body {
  if (!previous || body.previous_response_id != null || !isDeepStrictEqual(properties(body), previous.properties)) return body;
  if (body.input.length <= previous.input.length || !isDeepStrictEqual(body.input.slice(0, previous.input.length), previous.input)) return body;
  return { ...body, previous_response_id: previous.responseId, input: body.input.slice(previous.input.length) };
}

export async function continuationFor(model: Model<"openai-responses">, context: TranscriptContext, body: Body, output: AssistantMessage): Promise<Continuation | undefined> {
  if (!output.responseId || !["stop", "toolUse"].includes(output.stopReason) || body.previous_response_id != null) return undefined;
  let input: unknown[] | undefined;
  // Reuse the host's complete converter; this private build stops before fetch and runs no caller hooks.
  await openAIResponsesApi().stream(model, normalizeContext({ messages: [...context.messages, output] }), {
    apiKey: "payload-only-not-a-credential", maxRetries: 0,
    onPayload: payload => {
      const candidate = (payload as Body).input;
      if (Array.isArray(candidate)) input = JSON.parse(JSON.stringify(candidate));
      throw new Error("responses-ws payload-only build");
    },
    fetch: async () => { throw new Error("Payload-only build must never perform I/O"); },
  }).result();
  if (!input || !isDeepStrictEqual(input.slice(0, body.input.length), body.input)) return undefined;
  // Pi synthesizes missing results for the last assistant's tools; they are not server-side history.
  const tail = input.slice(body.input.length).filter(item => {
    const type = (item as { type?: unknown })?.type;
    return type !== "function_call_output" && type !== "custom_tool_call_output";
  });
  if (!tail.length) return undefined;
  const baseline = [...body.input, ...tail];
  if (Buffer.byteLength(JSON.stringify(baseline)) > MAX_BYTES) return undefined;
  return { properties: properties(body), input: baseline, responseId: output.responseId };
}
