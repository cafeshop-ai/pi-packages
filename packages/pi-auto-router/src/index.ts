import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, type RouterConfig, type RouteTarget, type Tier } from "./config.ts";

type RouterState = RouteTarget;

type RouterRequest = ModelRouteRequest<RouterState>;

function routeTo(
	pi: ExtensionAPI,
	request: RouterRequest,
	ctx: ExtensionContext,
	target: RouteTarget,
): ModelRoute<RouterState> {
	request.signal?.throwIfAborted();
	const { provider, model: id } = target;
	const model = ctx.modelRegistry.find(provider, id);
	if (!model) throw new Error(`[pi-auto-router] Model ${provider}/${id} is not in the catalog`);
	if (model.api === "pi-virtual") throw new Error(`[pi-auto-router] ${provider}/${id} must be a physical model`);
	const thinkingLevel = clampThinkingLevel(model, target.thinkingLevel);
	if (request.reason !== "direct") {
		// Custom spinners repaint the working message; send them structured route data too.
		pi.events.emit("pi-auto-router:route", { provider, model: id, thinkingLevel });
		ctx.ui.setWorkingMessage(`Thinking with ${thinkingLevel} effort · ${provider}/${id}`);
	}
	// Pi retains the current state when undefined is returned; avoid duplicate session entries.
	const unchanged = request.state?.provider === provider && request.state.model === id && request.state.thinkingLevel === thinkingLevel;
	const state = request.reason !== "direct" && !unchanged ? { provider, model: id, thinkingLevel } : undefined;
	return { model, thinkingLevel, state };
}

function messageText(message: RouterRequest["messages"][number]): string {
	const { content } = message;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function chooseTier(request: RouterRequest, ctx: ExtensionContext, config: RouterConfig): Promise<Tier> {
	const classifier = ctx.modelRegistry.findOfType("classifier", config.classifier.provider, config.classifier.model);
	if (!classifier) return "medium";
	const lastUser = request.messages.findLastIndex((message) => message.role === "user");
	if (lastUser < 0) return "medium";
	const current = request.messages[lastUser];
	const prompt = messageText(current).slice(0, 16_000);
	const images = classifier.input.includes("image") && Array.isArray(current.content)
		? current.content.filter((block) => block.type === "image").map(({ type, data, mimeType }) => ({ type, data, mimeType }))
		: [];
	// Bound classifier uploads; fall back rather than judge a partially supplied image set.
	if (images.length > 4 || images.reduce((bytes, image) => bytes + image.data.length, 0) > 8 * 1024 * 1024) return "medium";
	if (!prompt.trim() && images.length === 0) return "medium";
	// shortcut: last four text messages only; add a task summary if longer-range references need routing.
	const recentMessages = request.messages.slice(0, lastUser)
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => ({ role: message.role, content: messageText(message) }))
		.filter((message) => message.content.trim())
		.slice(-4)
		.map((message) => ({ ...message, content: message.content.slice(-2_000) }));
	const result = await ctx.modelRegistry.classify(
		classifier,
		{
			state: { prompt, recentMessages },
			...(images.length ? { images } : {}),
			questions: {
				complexity: {
					type: "choice",
					instructions: config.instructions,
					criteria: config.criteria,
				},
			},
		},
		{ signal: request.signal, timeoutMs: 5_000, maxRetries: 0 },
	);

	request.signal?.throwIfAborted();
	if (result.stopReason === "aborted") throw new DOMException("Classification aborted", "AbortError");
	const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
	if (answer?.type === "choice") {
		if (answer.choice === "high" || answer.choice === "low") return answer.choice;
	}
	return "medium";
}

export default function (pi: ExtensionAPI): void {
	const config = loadConfig();
	pi.on("model_select", (_event, ctx) => ctx.ui.setWorkingMessage());

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "auto",
		name: "Auto Router",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		async route(request, ctx) {
			request.signal?.throwIfAborted();
			if (request.reason === "direct") return routeTo(pi, request, ctx, config.routes.low);
			if (request.reason !== "user") {
				const saved = request.state;
				const recover = (response: RouterRequest["previous"]): RouteTarget | undefined => {
					if (!response) return undefined;
					const target = [saved, config.routes.medium, config.routes.high, config.routes.low].find(
						(r) => r?.provider === response.model.provider && r.model === response.model.id,
					);
					return target && { ...target, thinkingLevel: response.thinkingLevel ?? target.thinkingLevel };
				};
				const failed = request.reason === "retry" ? recover(request.failed) : undefined;
				const target = failed ?? saved ?? recover(request.previous);
				if (target) return routeTo(pi, request, ctx, target);
			}
			const tier = await chooseTier(request, ctx, config);
			return routeTo(pi, request, ctx, config.routes[tier]);
		},
	});
}
