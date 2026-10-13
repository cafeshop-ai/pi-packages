# R12 ordered parts evidence and implementation gate

Status: reviewed for R13 implementation, not a claim that the new producer exists.
Date: 2026-09-18. Baseline: 395eb34. No package/toolchain upgrades in this task.

## Installed evidence

Reviewed installed Pi coding-agent/core/AI 0.84.4 (repository typecheck dependency)
and 0.85.1 (current global Pi). Read current extensions.md in full, session-format.md,
sessions.md, agent-core README and the message-renderer extension example. Followed
session-format references to the installed types and implementations, not remote
main-branch guesses. No TUI or provider integration is being added.

| Source | Verified fact |
| --- | --- |
| pi-ai `dist/types.d.ts` TextContent/ThinkingContent/ToolCall | content array holds text, thinking and toolCall; call uses id/name/arguments, not toolCallId on the raw block |
| pi-ai AssistantMessageEvent (0.85.1 lines 395–454) | text/thinking delta has contentIndex and delta; partial is mutable live response-so-far, not an event-time snapshot |
| coding-agent extension types MessageUpdate/End and ToolExecution* | message_update forwards assistantMessageEvent; tool updates have partialResult, final has result/isError |
| core `dist/agent-loop.js` streamAssistantResponse/runLoop | awaits assistant message_end before executeToolCalls; update copies message shallowly, so WeakMap identity alone cannot join assistant start/end |
| core agent.js processEvents/subscribers | awaits subscribers; AgentSession forwards to extensions before persistence |
| coding-agent agent-session.js lines 383–400, 492–555 | awaits extension message_end; forwards delta/tool fields unchanged; persists the finalized message afterwards |
| extensions/runner.js emit/emitMessageEnd | handlers awaited in load order; later extensions can replace finalized same-role messages; this integration only asserts association when actual retained callId agrees |
| session-manager and session-format | historical message entry id is authoritative for stored transcript; getBranch/current custom sessionDir stay extension-owned |

0.84.4 vs 0.85.1 agent-loop diff is an additional aborted-before-parallel-execute
branch in 0.85.1, not a change to contentIndex or message_end ordering. Core agent.js
and extension runner.js are byte-identical across these installations. No claim is
made about every future Pi version or every third-party message-rewriting extension.

### SHA-256 of reviewed runtime sources

| Source | 0.84.4 | 0.85.1 |
| --- | --- | --- |
| agent-loop.js | `7b75576c0770e8d82c5d74229f5464611d2f1c01b69a6b592eb0862215429f2c` | `6732a1c65c09577d2ffcb716b48e4f4673e57e3e333f10ebfce5132d82e4d7a2` |
| agent.js | `d84351e451b9fef40fe2532c446aca90d26a4be9038b2d77d3d45dd6eab21d41` | same |
| agent-session.js | `e213e4094a3f176b2491e0470ac8ecd88aeab0030d35aabd9ba289ba7b74b923` | `fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f` |
| extensions/runner.js | `0de12ed1275e02595f92476eec3f61ae1f2e54fd2225ced721ddc90af58a5e61` | same |
| extensions/types.d.ts | `df559aed28856ebd459fc31caa9706ac2ebcb744b3dd03886a0af557b31acc4e` | `5baa29ca2f541f71f81a400dec25903abfbd03980bd4d9b691d10353e52d169a` |

## Minimal executed experiment

`.refactor/reports/R12/pi-events.mjs` imports each installed low-level loop module,
passes an explicit synthetic stream, one fake read tool with two call IDs, an
awaited emitter, and shouldStopAfterTurn. No AgentSession is constructed, no CLI or
real Pi is launched, no credentials/config/session file is loaded, no provider
function is called, and fetch is replaced with a throwing guard.

The fake t1 sends partial output and waits on a Promise released by t2's execution
end; t2 throws. This deterministically proves:

1. assistant contentIndex 0/2/4 survives message_update forwarding;
2. awaited assistant message_end completes before either tool starts;
3. starts are t1,t2; completion is t2(error),t1(complete);
4. formal toolResult events are t1(empty success),t2(error), in source order;
5. both installed versions produce exactly the same redacted event sequence.

Native Node 22.23.2 PowerShell `R12/check.ps1` exited 0. Source paths/hashes and
redacted output are in `pi-events.json`; the portable sequence is checked in as
`protocol/fixtures/parts/native-events.json`. This is installed-code/synthetic
validation, **not** R18 real-provider/native-Pi acceptance. The reverse result order
in CONTRACTS §6.4 is retained as a stronger wire-consumer stress case, not falsely
reported as the native parallel persistence order.

## Frozen choices

The original CONTRACTS §6/7 fields and budgets are feasible without a new command
or another AgentSession owner. Details and all ambiguous reducer branches are
fixed in [parts.md](../../protocol/v1/parts.md): missing vs empty, wrong-role fields,
index holes/duplicates, conflicting channel, legacy indexed/unindexed recovery,
whole-array fallback on truncation, explicit false and empty final output.

Raw signatures/images/details are omitted. Overlength IDs cannot create prefix
joins. Duplicate IDs produce no parent hint. Saved entry IDs and live active
assistant lifecycle ID are used separately, with a fresh reverse lookup on snapshot
rebuild. Association is not based on timestamps, names, last assistant, or array
completion order. A later extension replacing/removing a call can make ownership
unavailable; fallback stays honest rather than inventing another parent.

Fixtures now contain 51 codec cases, 11 reducer cases, the ordered scenario,
installed-loop event evidence and 15 projection/association cases. Generated long
strings use bounded test-only repeat templates. Expected values were written from
the contract before production changes; no Go/TS output was used to rewrite them.
Original `protocol/fixtures/v1` is unchanged.

## Required update inventory (R13)

| Layer | Paths/functions that must preserve/budget fields |
| --- | --- |
| TS protocol | src/protocol/index.ts interfaces; isTranscriptMessage/isToolExecution/isCollabEvent; boundedTranscriptMessage/boundedToolExecution; canonicalEvent/canonicalSnapshot/canonicalWireMessage; applyEvent; generic history result JSON budgets |
| Go protocol | relay/internal/protocol/codec.go validMessage/validTool/validEvent and canonical*; reducer.go message delta/tool update; EncodeWire/FitCommandResult graph tests |
| Extension | src/extension/index.ts messageProjection/WasTruncated, historicalMessages, transcriptMessageJson, historicalSnapshot, compactSnapshot; onMessageStart/Update/End; retainTool/onTool*; context and snapshot rebuild/eviction reverse-index invalidation |
| Node baseline Relay | src/relay/server.ts snapshot compaction and any message/tool object reconstruction; retain old fixture expectations for messages without enhancements |
| Go Relay | relay/internal/hub/projection.go compact/smallMessage/smallTool; results/history compaction and revision binding |
| Web | web/src/state/compactSnapshot.ts whole-parts fallback and byte accounting; existing shared applyEvent ingestion; R14 pure converter/association and stable identity |
| History/security | extension get_session maps every message through transcriptMessageJson; keep file commands, opened session ID/cwd, custom sessionDir/64 MiB cap unchanged |

R13.1 must pass old fixtures plus enhanced TS/Go fixtures before any new producer.
R13.2 budgets precede R13.3 production; R13.4 covers callback faults/reconnect/history.
R14 consumes ordered.json and projection-cases.json for actual display association,
including cross-host identical call IDs and missing parent. R12 does not certify
those unimplemented steps as passing. Read-only sa-6 timed out with no usable
report; evidence here is the parent source review and executed deterministic probe.
