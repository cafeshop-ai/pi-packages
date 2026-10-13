import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverAgents,
  findAgent,
  formatAgentList,
  type AgentDefinition,
  type AgentScope,
} from "./agents.js";
import { buildChildArgs, createTemporaryPrompt } from "./invocation.js";

const MAX_CHILDREN = 4;
const MAX_RETAINED_JOBS = 50;
const DEFAULT_TOOL_SET = "read,bash,grep,find,ls";
const DEFAULT_ROLE_TOOL_SET = "read,grep,find,ls";
const DEFAULT_TIMEOUT = 600;
const NOTIFICATION_LIMIT = 6000;
const WIDGET_ID = "cafecodework-subagents";

type JobState = "running" | "completed" | "failed" | "killed" | "timeout";

type Job = {
  id: string;
  task: string;
  agentName?: string;
  agentSource?: "user" | "project";
  model?: string;
  tools: string;
  process: ChildProcess;
  startedAt: number;
  state: JobState;
  output: string;
  error?: string;
  usage?: { input: number; output: number };
  finished: Promise<void>;
  stop(): void;
};

type ChildMessage = {
  type?: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: { input?: number; output?: number };
    content?: Array<{ type?: string; text?: string }>;
  };
};

type LaunchInput = {
  task: string;
  cwd?: string;
  timeoutSec?: number;
  role?: AgentDefinition;
  model?: string;
  tools?: string;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function resolvePiCommand(): { command: string; prefix: string[] } {
  try {
    const directory = getPackageDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      bin?: { pi?: string } | string;
    };
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (entry) return { command: process.execPath, prefix: [path.join(directory, entry)] };
  } catch {
    // Fall back to the executable available on PATH.
  }
  return { command: "pi", prefix: [] };
}

function assistantText(message: ChildMessage["message"]): string {
  return (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…(truncated)` : text;
}

export default function registerSubagent(pi: ExtensionAPI): void {
  const jobs = new Map<string, Job>();
  const executable = resolvePiCommand();
  let sequence = 0;
  let ui: { setWidget?: (id: string, lines: string[] | undefined, options?: unknown) => void } | undefined;
  let ticker: NodeJS.Timeout | undefined;

  const runningJobs = () => [...jobs.values()].filter((job) => job.state === "running");

  const pruneJobs = () => {
    if (jobs.size < MAX_RETAINED_JOBS) return;
    for (const [id, job] of jobs) {
      if (job.state !== "running") jobs.delete(id);
      if (jobs.size < MAX_RETAINED_JOBS) break;
    }
  };

  const refresh = () => {
    if (!ui?.setWidget) return;
    const active = runningJobs();
    const lines = active.length === 0
      ? undefined
      : [
          `● ${active.length} subagent${active.length === 1 ? "" : "s"} running`,
          ...active.map((job) => {
            const seconds = Math.floor((Date.now() - job.startedAt) / 1000);
            const tag = job.agentName ? `[${job.agentName}] ` : "";
            const label = `${tag}${job.task}`.replace(/\s+/g, " ");
            return `  └ ${job.id} · ${seconds}s · ${label.slice(0, 60)}${label.length > 60 ? "…" : ""}`;
          }),
        ];
    try {
      ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
    } catch {
      // Widget rendering must never affect task execution.
    }
  };

  const startTicker = () => {
    if (ticker) return;
    ticker = setInterval(() => {
      if (runningJobs().length === 0) {
        clearInterval(ticker);
        ticker = undefined;
      }
      refresh();
    }, 1000);
    ticker.unref?.();
  };

  const notify = (job: Job) => {
    const body = job.output || job.error || "(no output)";
    const usage = job.usage ? ` (${job.usage.input}+${job.usage.output} tok)` : "";
    const role = job.agentName ? `[${job.agentName}] ` : "";
    try {
      pi.sendMessage(
        {
          customType: "subagent-complete",
          content: `Subagent ${job.id} ${role}${job.state}${usage}:\n\n${shorten(body, NOTIFICATION_LIMIT)}`,
          display: true,
          details: {
            jobId: job.id,
            status: job.state,
            agent: job.agentName,
            agentSource: job.agentSource,
            model: job.model,
            tools: job.tools,
          },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      // Completion remains available through status or wait.
    }
  };

  const launch = (input: LaunchInput, sessionCwd: string): Job => {
    pruneJobs();

    const id = `sa-${++sequence}`;
    const tools = input.role
      ? input.role.tools?.join(",") || DEFAULT_ROLE_TOOL_SET
      : input.tools?.trim() || DEFAULT_TOOL_SET;
    const model = input.role?.model || input.model?.trim() || undefined;
    const prompt = input.role
      ? createTemporaryPrompt(input.role.name, input.role.systemPrompt)
      : undefined;
    const args = [
      ...executable.prefix,
      ...buildChildArgs({ task: input.task, tools, model, promptFile: prompt?.filePath }),
    ];

    let child: ChildProcess;
    try {
      child = spawn(executable.command, args, {
        cwd: input.cwd || sessionCwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      prompt?.cleanup();
      throw error;
    }

    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let lastAssistant: { text: string; usage?: { input: number; output: number } } | undefined;

    const stop = () => {
      child.kill("SIGTERM");
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3000);
      forceKillTimer.unref?.();
    };

    const job: Job = {
      id,
      task: input.task,
      agentName: input.role?.name,
      agentSource: input.role?.source,
      model,
      tools,
      process: child,
      startedAt: Date.now(),
      state: "running",
      output: "",
      finished,
      stop,
    };

    const finish = (state: JobState, error?: string) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      prompt?.cleanup();
      job.state = state;
      job.error = error;
      job.output = lastAssistant?.text ?? "";
      job.usage = lastAssistant?.usage;
      notify(job);
      resolveFinished();
      refresh();
    };

    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as ChildMessage;
        const message = event.message;
        if (
          event.type === "message_end" &&
          message?.role === "assistant" &&
          message.stopReason &&
          message.stopReason !== "pending"
        ) {
          lastAssistant = {
            text: assistantText(message),
            usage: message.usage
              ? { input: message.usage.input ?? 0, output: message.usage.output ?? 0 }
              : undefined,
          };
        }
      } catch {
        // Ignore malformed child output and retain the stderr diagnostic.
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        parseLine(stdout.slice(0, newline).trim());
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1500);
    });
    child.once("error", (error) => {
      const requestedState = job.state === "killed" || job.state === "timeout" ? job.state : "failed";
      finish(requestedState, requestedState === "failed" ? `spawn failed: ${error.message}` : job.error);
    });
    child.once("close", (code) => {
      if (stdout.trim()) parseLine(stdout.trim());
      if (settled) return;
      if (job.state === "killed" || job.state === "timeout") {
        finish(job.state, job.error);
        return;
      }
      if (code === 0 && lastAssistant) {
        finish("completed");
        return;
      }
      const diagnostic = stderr.trim();
      finish(
        "failed",
        code === 0
          ? `no assistant output${diagnostic ? `: ${diagnostic}` : ""}`
          : `exit ${code}${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    });

    const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT;
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      job.state = "timeout";
      job.error = `timed out after ${timeoutSec}s`;
      stop();
    }, timeoutSec * 1000);
    timeoutTimer.unref?.();

    jobs.set(id, job);
    refresh();
    startTicker();
    return job;
  };

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui as unknown as typeof ui;
  });

  pi.on("session_shutdown", async () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    for (const job of runningJobs()) {
      job.state = "killed";
      job.error = "parent session shut down";
      job.stop();
    }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Run an isolated child Pi task asynchronously.",
      "Use agent='quick_explorer' for bounded, low-ambiguity read-only searches and mechanical checks on cafe/gpt-5.6-luna:max.",
      "spawn returns immediately; use status/wait to inspect a job or kill to stop it.",
      "Predefined role model, prompt, and tools are authoritative and cannot be overridden per call.",
    ].join(" "),
    promptSnippet: "Delegate bounded independent work to an asynchronous child agent",
    promptGuidelines: [
      "Prefer quick_explorer for deterministic searches, inventories, comparisons, and mechanical read-only verification.",
      "Keep ambiguous design decisions and code modifications in the parent agent unless the user asks for a different role.",
      "Project-local roles are opt-in via agentScope and may require user confirmation.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("wait"),
        Type.Literal("status"),
        Type.Literal("kill"),
      ]),
      agent: Type.Optional(Type.String({ description: "Predefined role name, such as quick_explorer" })),
      agentScope: Type.Optional(Type.Union([
        Type.Literal("user"),
        Type.Literal("project"),
        Type.Literal("both"),
      ], { description: "Role discovery scope; defaults to user" })),
      task: Type.Optional(Type.String({ description: "Complete task for spawn" })),
      tools: Type.Optional(Type.String({ description: "Raw spawn only: comma-separated tools" })),
      cwd: Type.Optional(Type.String({ description: "Child working directory" })),
      model: Type.Optional(Type.String({ description: "Raw spawn only: model ID or model:thinking shorthand" })),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Timeout in seconds" })),
      jobId: Type.Optional(Type.String({ description: "Job ID for wait/status/kill" })),
    }),
    async execute(_callId, params, _signal, _update, ctx) {
      if (!ui) ui = ctx.ui as unknown as typeof ui;

      if (params.action === "spawn") {
        if (!params.task?.trim()) return textResult("spawn requires a non-empty task", true);
        if (runningJobs().length >= MAX_CHILDREN) {
          return textResult(`concurrency limit reached (${MAX_CHILDREN})`, true);
        }

        let role: AgentDefinition | undefined;
        if (params.agent?.trim()) {
          const scope = (params.agentScope ?? "user") as AgentScope;
          const discovery = discoverAgents(ctx.cwd, scope);
          role = findAgent(discovery.agents, params.agent);
          if (!role) {
            return textResult(
              `unknown agent '${params.agent}'. Available agents: ${formatAgentList(discovery.agents)}`,
              true,
            );
          }

          if (role.source === "project" && !ctx.isProjectTrusted()) {
            if (!ctx.hasUI) {
              return textResult(`project agent '${role.name}' requires an interactive trust confirmation`, true);
            }
            const approved = await ctx.ui.confirm(
              "Run project-local agent?",
              `Agent: ${role.name}\nSource: ${role.filePath}\n\nProject roles are repository-controlled. Continue only if you trust this project.`,
            );
            if (!approved) return textResult("project agent was not approved", true);
          }
        }

        let job: Job;
        try {
          job = launch({
            task: params.task,
            role,
            tools: role ? undefined : params.tools,
            cwd: params.cwd,
            model: role ? undefined : params.model,
            timeoutSec: params.timeoutSec,
          }, ctx.cwd);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`failed to start subagent: ${message}`, true);
        }

        const roleInfo = role ? ` role: '${role.name}' (${role.source}),` : "";
        const modelInfo = job.model ? ` model: '${job.model}',` : "";
        return textResult(
          `subagent ${job.id} started (${roleInfo}${modelInfo} tools: ${job.tools}). ` +
          "Continue working; its completion report will arrive automatically.",
        );
      }

      const job = params.jobId
        ? jobs.get(params.jobId)
        : [...jobs.values()].reverse().find((candidate) => candidate.state === "running");
      if (!job) return textResult(`no matching subagent found: ${params.jobId ?? "latest running job"}`, true);

      const roleLabel = job.agentName ? ` [${job.agentName}]` : "";
      if (params.action === "status") {
        const seconds = Math.floor((Date.now() - job.startedAt) / 1000);
        return textResult(
          `subagent ${job.id}${roleLabel}: ${job.state} (${seconds}s)\n` +
          `model: ${job.model ?? "default"}; tools: ${job.tools}\n\n` +
          shorten(job.output || job.error || "(still running)", 1500),
        );
      }

      if (params.action === "wait") {
        await Promise.race([job.finished, new Promise<void>((resolve) => setTimeout(resolve, 120000))]);
        return textResult(
          `subagent ${job.id}${roleLabel}: ${job.state}\n\n` +
          shorten(job.output || job.error || "(still running; wait limit reached)", NOTIFICATION_LIMIT),
        );
      }

      if (job.state !== "running") return textResult(`subagent ${job.id} is already ${job.state}`, true);
      job.state = "killed";
      job.error = "killed by request";
      job.stop();
      refresh();
      return textResult(`subagent ${job.id}${roleLabel} stopping`);
    },
  });
}
