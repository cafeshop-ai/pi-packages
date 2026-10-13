/**
 * Small compatibility patches for two Pi rendering behaviors that are not
 * currently available as extension hooks. The wrappers are idempotent and do
 * not modify files in the host installation.
 *
 * The first patch removes rows that render as blank after a collapsed thinking
 * block. The second removes the transient tool-output status notice so the
 * transcript stays compact.
 */
import { AssistantMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";

// CSI + OSC (BEL or ST terminated) + charset selects. OSC matters: the host
// render wraps a message's first/last row in OSC133 zone marks, which the
// all-blank check must see through.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;

function isBlankRow(line: unknown): boolean {
	return typeof line === "string" && line.replace(ANSI_RE, "").trim() === "";
}

const BLANK_RENDER_FLAG = Symbol.for("cafecodework:assistant-blank-render");
const STATUS_FLAG = Symbol.for("cafecodework:tool-output-status");

/** The exact host notice dropped by patch 2 (interactive-mode.js setToolsExpanded). */
const TOOL_OUTPUT_STATUS_RE = /^Tool output: (?:expanded|collapsed)$/;

export function installHostPatches(): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const amProto = AssistantMessageComponent.prototype as any;
	if (!amProto[BLANK_RENDER_FLAG] && typeof amProto.render === "function") {
		const originalRender = amProto.render;
		amProto.render = function ccUiBlankMessageRender(width: number): string[] {
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			let blank = 0;
			while (blank < lines.length && isBlankRow(lines[blank])) blank++;
			if (blank === lines.length) return [];
			// (b) collapse a run of leading blank rows to one; keep lines[0] — it
			// may carry the OSC133 zone-start mark.
			if (blank > 1) lines.splice(1, blank - 1);
			return lines;
		};
		amProto[BLANK_RENDER_FLAG] = true;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const imProto = InteractiveMode.prototype as any;
	if (!imProto[STATUS_FLAG] && typeof imProto.showStatus === "function") {
		const originalShowStatus = imProto.showStatus;
		imProto.showStatus = function ccUiFilteredShowStatus(message: unknown): unknown {
			if (typeof message === "string" && TOOL_OUTPUT_STATUS_RE.test(message)) return undefined;
			return originalShowStatus.call(this, message);
		};
		imProto[STATUS_FLAG] = true;
	}
}
