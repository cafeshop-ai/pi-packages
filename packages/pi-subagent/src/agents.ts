import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentDefinition[];
  projectAgentsDir: string | null;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function loadAgentsFromDir(directory: string, source: AgentSource): AgentDefinition[] {
  if (!fs.existsSync(directory)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(directory, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
      const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
      const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      if (!name || !description) continue;

      agents.push({
        name,
        description,
        tools: parseToolList(frontmatter.tools),
        model: typeof frontmatter.model === "string" && frontmatter.model.trim()
          ? frontmatter.model.trim()
          : undefined,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      // One invalid role file must not prevent other roles from loading.
    }
  }

  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue toward the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope = "user",
  userAgentsDir = path.join(getAgentDir(), "agents"),
): AgentDiscoveryResult {
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir
    ? []
    : loadAgentsFromDir(projectAgentsDir, "project");

  const agents = new Map<string, AgentDefinition>();
  for (const agent of userAgents) agents.set(agent.name.toLowerCase(), agent);
  for (const agent of projectAgents) agents.set(agent.name.toLowerCase(), agent);

  return { agents: [...agents.values()], projectAgentsDir };
}

export function findAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return agents.find((agent) => agent.name.toLowerCase() === normalized);
}

export function formatAgentList(agents: AgentDefinition[]): string {
  return agents.length > 0
    ? agents.map((agent) => `${agent.name} (${agent.source})`).join(", ")
    : "none";
}
