import {
  buildSessionContext,
  estimateTokens,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Row = { name: string; tokens: number };
type ContextData = {
  used: number | null;
  limit: number;
  percent: number | null;
  systemPrompt: number;
  systemTools: number;
  reserveTokens: number;
  rows: Row[];
};
type Segment = { name: string; tokens: number; color: Color; symbol: string };
type Color = "cyan" | "yellow" | "blue" | "gray" | "dim" | "white";

const WIDGET_ID = "cafecodework-pi-context";
const GRID_COLUMNS = 10;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const ANSI: Record<Color, string> = {
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  dim: "\x1b[2m",
  white: "\x1b[37m",
};
const RESET = "\x1b[0m";
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;

function visibleLength(text: string): number {
  return text.replace(ANSI_ESCAPE, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function color(value: Color, text: string): string {
  return `${ANSI[value]}${text}${RESET}`;
}

function bold(text: string): string {
  return `\x1b[1m${text}${RESET}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatPercent(value: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function addValue(map: Map<string, number>, name: string, value: number): void {
  if (value > 0) map.set(name, (map.get(name) ?? 0) + value);
}

function collectData(ctx: ExtensionCommandContext, pi: ExtensionAPI): ContextData {
  const usage = ctx.getContextUsage();
  const limit = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const settings = SettingsManager.create(ctx.cwd, process.env.PI_CODING_AGENT_DIR, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const reserveTokens = settings.getCompactionEnabled() ? settings.getCompactionReserveTokens() : 0;
  const activeToolNames = pi.getActiveTools();
  const activeTools = pi.getAllTools().filter((tool) => activeToolNames.includes(tool.name));
  const systemTools = Math.ceil(JSON.stringify(activeTools).length / 4);
  const systemPrompt = Math.ceil(ctx.getSystemPrompt().length / 4);
  const counts = new Map<string, number>();
  const context = buildSessionContext(ctx.sessionManager.buildContextEntries());

  for (const message of context.messages) {
    switch (message.role) {
      case "user":
        addValue(counts, "User messages", estimateTokens(message));
        break;
      case "assistant": {
        let text = 0;
        let thinking = 0;
        let tools = 0;
        for (const part of message.content) {
          if (part.type === "text") text += part.text.length;
          if (part.type === "thinking") thinking += part.thinking.length;
          if (part.type === "toolCall") tools += part.name.length + JSON.stringify(part.arguments).length;
        }
        addValue(counts, "Assistant", Math.ceil(text / 4));
        addValue(counts, "Thinking", Math.ceil(thinking / 4));
        addValue(counts, "Tool calls", Math.ceil(tools / 4));
        break;
      }
      case "toolResult":
        addValue(counts, "Tool results", estimateTokens(message));
        break;
      case "bashExecution":
        addValue(counts, "Bash executions", estimateTokens(message));
        break;
      case "branchSummary":
      case "compactionSummary":
        addValue(counts, "Summaries", estimateTokens(message));
        break;
      case "custom":
        addValue(counts, "Extension messages", estimateTokens(message));
        break;
      default:
        addValue(counts, "Other", estimateTokens(message));
    }
  }

  return {
    used: usage?.tokens ?? null,
    limit,
    percent: usage?.percent ?? null,
    systemPrompt,
    systemTools,
    reserveTokens,
    rows: [...counts.entries()].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens),
  };
}

function makeSegments(data: ContextData): Segment[] {
  const rawMessages = data.rows.reduce((sum, row) => sum + row.tokens, 0);
  const rawTotal = data.systemPrompt + data.systemTools + rawMessages;
  const actualUsed = data.used ?? rawTotal;
  const scale = rawTotal > 0 ? actualUsed / rawTotal : 1;

  return [
    { name: "System prompt", tokens: Math.round(data.systemPrompt * scale), color: "cyan", symbol: "⛁" },
    { name: "System tools", tokens: Math.round(data.systemTools * scale), color: "blue", symbol: "⛁" },
    { name: "Messages", tokens: Math.round(rawMessages * scale), color: "yellow", symbol: "⛁" },
  ].filter((segment) => segment.tokens > 0) as Segment[];
}

function renderGrid(data: ContextData): string[] {
  const used = data.used ?? data.systemPrompt + data.systemTools + data.rows.reduce((sum, row) => sum + row.tokens, 0);
  const usableCells = data.limit > 0
    ? Math.max(0, GRID_CELLS - Math.round((data.reserveTokens / data.limit) * GRID_CELLS))
    : GRID_CELLS;
  const usedCells = data.limit > 0 ? Math.min(usableCells, Math.round((used / data.limit) * GRID_CELLS)) : 0;
  const cells: string[] = [];
  let assigned = 0;

  for (const segment of makeSegments(data)) {
    const count = data.limit > 0 ? Math.round((segment.tokens / data.limit) * GRID_CELLS) : 0;
    for (let i = 0; i < count && assigned < usedCells; i += 1) {
      cells.push(color(segment.color, segment.symbol));
      assigned += 1;
    }
  }
  while (cells.length < usedCells) {
    cells.push(color("cyan", "⛁"));
  }
  while (cells.length < usableCells) {
    cells.push(color("dim", "⛶"));
  }
  while (cells.length < GRID_CELLS) {
    cells.push(color("gray", "⛝"));
  }

  return Array.from({ length: GRID_ROWS }, (_, row) =>
    cells.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS).join(" "),
  );
}

function renderLines(data: ContextData, modelName?: string): string[] {
  const used = data.used === null ? "?" : formatTokens(data.used);
  const limit = data.limit > 0 ? formatTokens(data.limit) : "?";
  const percent = data.percent === null ? "?" : `${data.percent.toFixed(1)}%`;
  const estimated = data.systemPrompt + data.systemTools + data.rows.reduce((sum, row) => sum + row.tokens, 0);
  const title = modelName ? `${modelName} · ${used}/${limit} tokens (${percent})` : `${used}/${limit} tokens (${percent})`;
  const segments = makeSegments(data);
  const right = [
    bold(title),
    "",
    bold("Usage by category"),
  ];
  for (const segment of segments) {
    right.push(`${color(segment.color, segment.symbol)} ${segment.name}: ${formatTokens(segment.tokens)} tokens (${formatPercent(segment.tokens, data.limit)})`);
  }
  const free = Math.max(0, data.limit - (data.used ?? estimated) - data.reserveTokens);
  right.push(`${color("dim", "⛶")} Free space: ${formatTokens(free)} tokens (${formatPercent(free, data.limit)})`);
  if (data.reserveTokens > 0) {
    right.push(`${color("gray", "⛝")} Autocompact buffer: ${formatTokens(data.reserveTokens)} tokens (${formatPercent(data.reserveTokens, data.limit)})`);
  }

  const left = renderGrid(data);
  const lines: string[] = [bold("Context Usage"), ""];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    lines.push(`${padVisible(left[i] ?? "", 21)}${right[i] ?? ""}`);
  }
  lines.push("", bold("Messages"));
  for (const row of data.rows) {
    lines.push(`  ${row.name.padEnd(18)} ${color("gray", formatTokens(row.tokens).padStart(7))} (${formatPercent(row.tokens, data.limit)})`);
  }
  lines.push("", color("dim", `Estimated composition: ~${formatTokens(estimated)} tokens`));
  return lines;
}

class ContextWidget implements Component {
  private wrapped: string[] = [];
  private width = 0;

  constructor(private readonly lines: string[]) {}

  invalidate(): void {
    this.width = 0;
  }

  render(width: number): string[] {
    if (this.width !== width) {
      this.wrapped = this.lines.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
      this.width = width;
    }
    return this.wrapped;
  }
}

export default function registerPiContext(pi: ExtensionAPI): void {
  let visible = false;
  const clear = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
    if (visible && ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      visible = false;
    }
  };

  pi.on("before_agent_start", (_event, ctx) => clear(ctx));
  pi.on("agent_end", (_event, ctx) => clear(ctx));

  pi.registerCommand("context", {
    description: "Show Claude-style context-window usage",
    handler: async (_args, ctx) => {
      const lines = renderLines(collectData(ctx, pi), ctx.model?.name);
      if (!ctx.hasUI) {
        process.stdout.write(`${lines.join("\n")}\n`);
        return;
      }
      ctx.ui.setWidget(WIDGET_ID, () => new ContextWidget(lines), { placement: "aboveEditor" });
      visible = true;
    },
  });
}
