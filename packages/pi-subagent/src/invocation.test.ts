import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildChildArgs, createTemporaryPrompt, type TemporaryPrompt } from "./invocation.js";

const prompts: TemporaryPrompt[] = [];

afterEach(() => {
  for (const prompt of prompts.splice(0)) prompt.cleanup();
});

describe("child invocation", () => {
  it("uses supported long-form Pi flags", () => {
    const args = buildChildArgs({
      task: "inspect the repository",
      tools: "read,grep,find,ls",
      model: "cafe/gpt-5.6-luna:max",
      promptFile: "C:\\temp\\quick_explorer.md",
    });

    expect(args).toContain("--model");
    expect(args).toContain("cafe/gpt-5.6-luna:max");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--no-approve");
    expect(args).toContain("--tools");
    expect(args).not.toContain("-m");
    expect(args).not.toContain("-s");
    expect(args.at(-1)).toBe("Task: inspect the repository");
  });

  it("writes and removes a temporary role prompt", () => {
    const prompt = createTemporaryPrompt("quick/explorer", "Role instructions.\n");
    expect(prompt).toBeDefined();
    prompts.push(prompt!);

    expect(readFileSync(prompt!.filePath, "utf8")).toBe("Role instructions.\n");
    prompt!.cleanup();
    expect(existsSync(prompt!.filePath)).toBe(false);
  });

  it("does not create a prompt file for an empty role body", () => {
    expect(createTemporaryPrompt("empty", "   \n")).toBeUndefined();
  });
});
