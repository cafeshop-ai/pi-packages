import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ChildInvocation {
  task: string;
  tools: string;
  model?: string;
  promptFile?: string;
}

export interface TemporaryPrompt {
  filePath: string;
  cleanup(): void;
}

export function buildChildArgs(input: ChildInvocation): string[] {
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--tools", input.tools,
  ];

  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.promptFile) args.push("--append-system-prompt", input.promptFile);
  args.push(`Task: ${input.task.trim()}`);
  return args;
}

export function createTemporaryPrompt(agentName: string, content: string): TemporaryPrompt | undefined {
  if (!content.trim()) return undefined;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_") || "agent";
  const filePath = path.join(directory, `${safeName}.md`);
  try {
    fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    filePath,
    cleanup() {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temporary cleanup is best effort.
      }
    },
  };
}
