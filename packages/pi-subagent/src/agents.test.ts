import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, findAgent } from "./agents.js";

const temporaryRoots: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-agents-"));
  temporaryRoots.push(directory);
  return directory;
}

async function writeAgent(
  directory: string,
  fileName: string,
  name: string,
  model: string,
  tools = "read, grep, find, ls",
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, fileName),
    `---\nname: ${name}\ndescription: test role\nmodel: ${model}\ntools: ${tools}\n---\n\nRole instructions.\n`,
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent discovery", () => {
  it("loads only user roles by default", async () => {
    const root = await tempDirectory();
    const userDir = join(root, "user-agents");
    const project = join(root, "project");
    await writeAgent(userDir, "quick.md", "quick_explorer", "gpt-5.6-luna:max");
    await writeAgent(join(project, ".pi", "agents"), "project.md", "project_worker", "other-model");

    const discovery = discoverAgents(project, "user", userDir);

    expect(discovery.agents.map((agent) => agent.name)).toEqual(["quick_explorer"]);
    expect(discovery.projectAgentsDir).toBe(join(project, ".pi", "agents"));
  });

  it("finds the nearest project role directory and lets project roles override by name", async () => {
    const root = await tempDirectory();
    const userDir = join(root, "user-agents");
    const project = join(root, "project");
    const nested = join(project, "src", "feature");
    await mkdir(nested, { recursive: true });
    await writeAgent(userDir, "quick.md", "Quick_Explorer", "user-model");
    await writeAgent(join(project, ".pi", "agents"), "quick.md", "quick_explorer", "project-model");

    const discovery = discoverAgents(nested, "both", userDir);
    const agent = findAgent(discovery.agents, "QUICK_EXPLORER");

    expect(discovery.projectAgentsDir).toBe(join(project, ".pi", "agents"));
    expect(agent?.source).toBe("project");
    expect(agent?.model).toBe("project-model");
  });

  it("skips invalid role files without hiding valid roles", async () => {
    const root = await tempDirectory();
    const userDir = join(root, "user-agents");
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, "invalid.md"), "---\nname: [invalid\n---\n");
    await writeAgent(userDir, "valid.md", "valid", "test-model", "read, read, ls");

    const discovery = discoverAgents(root, "user", userDir);

    expect(discovery.agents).toHaveLength(1);
    expect(discovery.agents[0].tools).toEqual(["read", "ls"]);
  });
});
