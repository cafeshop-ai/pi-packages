import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, type SessionSnapshot } from "../protocol/index.js";
import { compactSnapshot } from "./index.js";

describe("snapshot compaction", () => {
  it("keeps reconnect snapshots under the relay frame limit", () => {
    const snapshot: SessionSnapshot = {
      protocolVersion: PROTOCOL_VERSION,
      streamId: "stream-large",
      sessionId: "session-large",
      sessionName: "large session",
      cwd: "D:/work",
      activeLeafId: null,
      model: { provider: "cafe", id: "gpt-5.6-sol" },
      thinkingLevel: "high",
      phase: "idle",
      hasPendingMessages: false,
      messages: Array.from({ length: 100 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        text: "t".repeat(32_000),
        thinking: "r".repeat(32_000),
        timestamp: index,
        status: "complete" as const,
        toolName: null,
        toolCallId: null,
      })),
      historyTruncated: false,
      tools: Array.from({ length: 100 }, (_, index) => ({
        toolCallId: `tool-${index}`,
        toolName: "bash",
        argsText: "a".repeat(32_000),
        output: "o".repeat(32_000),
        status: "complete" as const,
      })),
      lastEventSeq: 100,
    };

    const compacted = compactSnapshot(snapshot);
    const bytes = Buffer.byteLength(JSON.stringify({ type: "snapshot", snapshot: compacted }), "utf8");
    expect(bytes).toBeLessThan(MAX_FRAME_BYTES);
    expect(compacted.historyTruncated).toBe(true);
    expect(compacted.tools.length).toBeLessThanOrEqual(24);
  });
});
