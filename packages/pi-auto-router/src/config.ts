import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Tier = "high" | "medium" | "low";
export type RouteTarget = { provider: string; model: string; thinkingLevel: ModelThinkingLevel };
export interface RouterConfig {
	classifier: { provider: string; model: string };
	routes: Record<Tier, RouteTarget>;
	instructions: string;
	criteria: Record<Tier, string>;
}

export const DEFAULT_CONFIG: RouterConfig = {
	classifier: { provider: "typesafe", model: "jev-latest" },
	routes: {
		high: { provider: "cafe", model: "gpt-6-astra", thinkingLevel: "xhigh" },
		medium: { provider: "cafe", model: "gpt-6.1-sol", thinkingLevel: "high" },
		low: { provider: "cafe", model: "gpt-6-luna", thinkingLevel: "max" },
	},
	instructions: "Choose the required reasoning tier for the task in `prompt` and any attached images. Use `recentMessages` (oldest to newest) only to resolve references, not to inherit the tier of unrelated tasks. Evaluate high first: understanding and clarifying new user requirements, exploring an unfamiliar or underspecified request, or understanding a new/unfamiliar project to establish its goals, scope, workflows or constraints is high, even before a solution is designed. All code reviews, substantive engineering design, architecture review, solution trade-offs, or redesigning rules/configuration mechanisms also belongs to high even if called a small feature or configuration change. A request to make model selection, reasoning levels, and classification criteria user-configurable involves configuration-mechanism design, not merely editing existing settings. Evaluate low only for fully specified mechanical work; otherwise choose medium for ordinary implementation, diagnosis, or explanation. A review-only follow-up about code or the latest diff is high, even for a small change. Judge the underlying work, not prompt length, diff size, or the words 'design'/'review' alone. Treat a routine, explicitly approved commit/push of completed work as low, regardless of the changes' complexity; do not inherit the tier of the work being committed. Conflict resolution, choosing what to commit, security review, or diagnosing Git errors requires analysis. If a task is borderline between low and medium, choose medium. Distinguish requirements/project discovery from a minor missing detail in an otherwise understood task: the former is high; the latter alone does not justify high. A new message, the word 'new', or a routine file lookup does not itself mean discovery. Once requirements and the solution are specified, bounded implementation remains medium unless another high-tier criterion applies.",
	criteria: {
		high: "High tier: Understanding and clarifying new user requirements, exploring unfamiliar or underspecified requests, and understanding new/unfamiliar projects to establish goals, scope, workflows or constraints. Includes initial requirements/project discovery without a design yet. All code reviews (including small diffs), substantive architecture or feature design, architecture reviews, comparing engineering approaches and their trade-offs, or redesigning routing rules/workflows/configuration mechanisms (including schemas, defaults, overrides, and compatibility). Also complex algorithms, subtle bugs, security-sensitive work, or critical/cross-cutting refactoring. Includes establishing what the user needs or deciding how the system should work, not just implementing an already-specified bounded solution.",
		medium: "Medium tier (default for ordinary work): Implement an already-specified bounded feature, common bug fixes, routine debugging, technical explanations, existing configuration changes, or general code modifications that require understanding behavior but not substantive design or high-tier risks. Includes small changes and short questions needing analysis, or resolving a minor missing detail in an otherwise understood task. Requirements/project discovery is high, not medium; ordinary implementation after requirements and the solution are specified remains medium. Designing a new configuration mechanism or reviewing architecture is high, not medium. Code review is always high, not medium.",
		low: "Low: Fully specified mechanical work, including an explicitly approved routine commit/push of completed, scoped changes, regardless of their complexity. Also exact typo, format, label or value changes. No conflict resolution, scope selection, security review or error diagnosis.",
	},
};

function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`Unknown field ${field}.${key}`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
	return value.trim();
}

function strings<T extends Record<string, string>>(defaults: T, value: unknown, field: string): T {
	const result = { ...defaults };
	for (const [key, entry] of Object.entries(object(value, Object.keys(defaults), field))) {
		// Validate strings here; constrained values (thinking levels) are checked below.
		(result as Record<string, string>)[key] = text(entry, `${field}.${key}`);
	}
	return result;
}

export function parseConfig(value: unknown): RouterConfig {
	const input = object(value, Object.keys(DEFAULT_CONFIG), "config");
	const tiers = ["high", "medium", "low"] as const;
	const overrides = object(input.routes, [...tiers], "routes");
	const config: RouterConfig = {
		classifier: strings(DEFAULT_CONFIG.classifier, input.classifier, "classifier"),
		routes: { ...DEFAULT_CONFIG.routes },
		instructions: input.instructions === undefined ? DEFAULT_CONFIG.instructions : text(input.instructions, "instructions"),
		criteria: strings(DEFAULT_CONFIG.criteria, input.criteria, "criteria"),
	};
	for (const tier of tiers) {
		const target = strings(DEFAULT_CONFIG.routes[tier], overrides[tier], `routes.${tier}`);
		if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(target.thinkingLevel)) {
			throw new Error(`routes.${tier}.thinkingLevel must be off, minimal, low, medium, high, xhigh or max`);
		}
		if (target.provider === "router" && target.model === "auto") {
			throw new Error(`routes.${tier} must target a physical model, not router/auto`);
		}
		config.routes[tier] = target;
	}
	return config;
}

export function loadConfig(path = join(getAgentDir(), "pi-auto-router.json")): RouterConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
		throw new Error(`[pi-auto-router] ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
