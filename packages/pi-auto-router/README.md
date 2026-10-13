# pi-auto-router

Classifier-powered virtual model router for Pi. Registers `router/auto`; defaults to Jev classification and Cafe models, with user-configurable classifier, routes, thinking levels and classification rules.

## Requirements

- Pi 1.1.0 or newer
- Credentials for the selected classifier (by default, `TYPESAFE_API_KEY` for `typesafe/jev-latest`)
- Authenticated physical chat models for the configured routes (defaults: `cafe/gpt-6-astra`, `cafe/gpt-6.1-sol`, and `cafe/gpt-6-luna`)

## Install

From the repository root:

```sh
pi install ./packages/pi-auto-router
```

Then choose `router/auto` in Pi or start a session with:

```sh
pi --model router/auto
```

Run `/reload` after installing or changing the extension.

## User configuration

Create `~/.pi/agent/pi-auto-router.json` as a UTF-8 JSON file. If `PI_CODING_AGENT_DIR` is set, the file lives in that directory instead. The extension reads it once on load; run `/reload` after changes. It does not create or modify the file for you.

Only user-level configuration is read, not project files or Pi's `settings.json`. A repository cannot silently redirect classifier input or model requests through this configuration mechanism. Credentials stay in Pi's normal authentication/provider configuration, not this file.

**Every field is optional.** Missing nested fields inherit the current defaults; strings replace, rather than append to, their defaults. For example, this changes only high-tier effort:

```json
{
  "routes": {
    "high": { "thinkingLevel": "high" }
  }
}
```

The following shows all supported fields. The classifier/models/efforts match the defaults; the Chinese instructions and criteria are an **example custom policy**, not a verbatim copy of the built-in rules. Omit `instructions` and `criteria` to keep the built-in policy described below. Exact defaults live in [src/config.ts](src/config.ts).

```json
{
  "classifier": { "provider": "typesafe", "model": "jev-latest" },
  "routes": {
    "high": { "provider": "cafe", "model": "gpt-6-astra", "thinkingLevel": "xhigh" },
    "medium": { "provider": "cafe", "model": "gpt-6.1-sol", "thinkingLevel": "high" },
    "low": { "provider": "cafe", "model": "gpt-6-luna", "thinkingLevel": "max" }
  },
  "instructions": "根据 prompt 判断当前任务，recentMessages 仅用于理解指代。理解和澄清新需求、探索未知或尚不明确的需求、理解新项目的目标与约束归 high，即使还没进入方案设计；代码 review（包括小改动）归 high；需求与方案已明确的常规实现归 medium，已确认范围且完成的改动仅提交、push 归 low。其余先判断是否需要实质设计或高风险分析，再判断是否纯机械操作，其他归 medium；不要按提示长度或关键词判定。",
  "criteria": {
    "high": "理解和澄清新需求、探索未知或尚不明确的需求、理解新项目的目标、范围、流程和约束；所有代码审查（含小改动）、架构或功能方案设计、工程方案权衡、规则和配置机制重设计、复杂算法、隐蔽问题或安全关键工作。",
    "medium": "需求与方案已明确后的常规实现、普通排查、技术解释，以及需要分析行为的现有配置调整。需求或项目探索归 high；已理解任务仅缺少小细节不必升级。",
    "low": "已确认范围且完成的改动仅提交、push；或无需诊断、设计、代码审查或行为判断的指定错字、文案、数值替换。"
  }
}
```

- `classifier` must identify a model in Pi's **classifier** catalog. Ordinary chat models do not become classifiers by naming them here. The selected classifier receives bounded conversation text and, when its catalog `input` includes `image`, current user attachments. Capabilities come from Pi's model directory; the router does not duplicate them in user configuration.
- Each route accepts its own provider, model ID (including IDs containing `/`), and `thinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Targets must be physical chat models; Pi handles their credentials. Several tiers may share a model with different efforts.
- `instructions` and each `criteria.high/medium/low` value must be non-empty strings; Chinese is supported. Overrides replace the supplied strings completely. When changing category meanings, update both instructions and relevant criteria to avoid conflicting guidance. The three tier names remain fixed.
- A missing file (or `{}`) uses defaults. Invalid JSON, unknown keys, invalid types, blank strings, unsupported thinking levels, or self-routing to `router/auto` fail extension loading with a file/field error instead of silently using a different configuration. Fix the file and reload. Missing or virtual target models fail when selected, without silently changing provider. An unavailable classifier instead uses the configured medium fallback.

## Luna classifier and images

To use GPT-6 Luna through OpenAI's Decisions API, set:

```json
{
  "classifier": { "provider": "openai", "model": "gpt-6-luna" }
}
```

This requires `OPENAI_API_KEY` (or a stored OpenAI API key). ChatGPT OAuth credentials do not work with Decisions; Pi 1.1.0 prioritizes a stored OpenAI login, so log out of `openai` before using the environment key if it is currently signed in with ChatGPT. `cafe/gpt-6-luna` is a separate chat-model route, not this classifier.

Images are sent **automatically only if the selected classifier declares `image` input**. GPT-6 Luna supports text and images; Jev currently supports text only. Only image blocks attached to the current user message are supplied, never older user images, assistant images or tool images. With a text-only classifier, text is still classified and images are ignored; an image-only message falls back to medium.

The upload bound is four images and 8 MiB of combined base64 data per classification. Images are reused as already encoded by Pi, without extra resizing. Over-limit input falls back to the configured medium route without uploading a partial image set. These limits do not affect attachments sent to the answering model. Image classification can add latency/cost and sends attachments to the classifier provider; select a text-only classifier if you do not want image uploads.

## Routing

Every new user message (including steering and follow-ups) starts a fresh classification, even if the session already has a route or a previous physical model. The configured classifier receives:

- The latest user message, up to 16,000 characters.
- Up to four preceding non-empty user/assistant text messages, in chronological order, keeping the last 2,000 characters of each.
- Current user image attachments, within the upload bound above, only for image-capable classifiers.

This bounds the supplied text to 24,000 characters. System prompts, tool results, tool-call arguments, thinking blocks and historical images are not sent to the classifier. The 24,000-character bound covers text only; image data is bounded separately above. Recent dialogue resolves references such as “continue” or “implement that plan”; unrelated past tasks should not determine the current task’s difficulty. Longer-range references outside this window are not included. These limits apply only to classification, not the answering model’s conversation.

The default routes and policy are:

| Classification | Model | Thinking |
|---|---|---|
| High: understanding/clarifying new requirements, exploring unfamiliar or underspecified requests and new/unfamiliar projects, all code reviews (including small diffs), substantive architecture/feature design, architecture reviews, engineering trade-offs, rule/workflow/configuration-mechanism redesign, complex algorithms, subtle bugs, security or critical refactoring | `cafe/gpt-6-astra` | `xhigh` |
| Medium (ordinary-work default): implementing bounded specified features, common fixes, routine debugging, technical explanations or changing existing settings | `cafe/gpt-6.1-sol` | `high` |
| Low (narrow): explicitly approved routine commit/push of completed scoped work, regardless of its complexity; or exact mechanical changes | `cafe/gpt-6-luna` | `max` |

The classifier evaluates high-tier work first, mechanical low-tier work second, and otherwise uses medium. Code review always uses high, even for a small diff or a review-only follow-up. Requirements/project discovery and substantive design take precedence over the ordinary-feature/configuration category. Establishing user needs, project goals, scope, workflows or constraints uses high even before designing a solution. Once requirements and the solution are specified, ordinary bounded implementation remains medium unless another high-tier criterion applies; neither prompt length nor the words “new”/“design”/“review” alone decide the tier.

Examples:

- “我有个新需求，先帮我理解业务目标和使用流程” or “用户提出了一个我们不熟悉的需求，先梳理需要明确的问题” → high / Astra.
- “这是一个新项目，先理解它的目标、范围和约束” → high / Astra; “新项目里把这个指定标题改为给定文字” remains low / Luna.
- “Design user-configurable model routing, reasoning levels and classification rules” → high / Astra.
- “Review the router architecture and compare redesign options” or “review this small code change” → high / Astra.
- “Assess the existing timeout/retry behavior and adjust settings” or “implement the specified name filter” → medium / Sol.
- “Commit and push the completed, already-scoped changes” → low / Luna, regardless of the changes' complexity.
- “Replace this exact button label/value, without other changes or behavioral judgment” → low / Luna.
- Resolving conflicts, choosing what to commit, security review or diagnosing Git errors is not mechanical; classify that work by its actual complexity.

Small changes and short questions are not automatically low complexity. Borderline low/medium tasks favor Sol. A minor missing detail in an otherwise understood task or a routine file lookup alone does not justify Astra; discovering requirements or understanding an unfamiliar project does. These are classification guidelines, not guaranteed labels or keyword rules. Direct requests such as compaction use the configured low route (Luna by default).

The table lists requested efforts. The router uses Pi’s `clampThinkingLevel` to adapt them to the selected model’s supported levels before returning the route or updating the UI; the displayed effort therefore matches Pi’s dispatched effort.

Tool follow-ups keep the current round’s provider, model and actual thinking level: a successful `edit`, `write` or shell command does **not** trigger a downgrade. Retries prefer the failed model when it matches a configured route or the saved route, including its recorded effort, then use the saved route. Without saved state, a previous configured model and its recorded effort can recover the route; if the effort is absent and several tiers match, medium takes precedence, then high, then low. If no route can be recovered, the classifier runs.

A saved route is a snapshot: continuations/retries keep it even after reloading changed configuration; the next user turn classifies using the new settings. This also preserves different efforts when multiple tiers share one model. Direct requests (such as compaction) use the configured low route and do not change the main route.

While generating, Pi's native working indicator shows the routed model and effort, for example `Thinking with xhigh effort · cafe/gpt-6-astra`. With `pi-theme-cafecode`, the same data is composed into its animated spinner: `Ebbing… (2m 15s · ↓ 3.9k tokens · thinking with xhigh effort · cafe/gpt-6-astra)`. The model label takes priority over time/token counters in narrow terminals.

The router emits `pi-auto-router:route` on Pi's shared extension event bus with `{ provider, model, thinkingLevel }` for main-loop requests. This lets the theme retain the route on every animation tick instead of overwriting a one-off working message. Direct requests (for example compaction) do not replace the main request's display.

Classification has a 5-second request timeout and no automatic retries. If the configured classifier is unavailable, times out, reports an error, returns no valid choice, or the latest user message has neither text nor eligible images, the router falls back to the configured medium route (Sol by default). User cancellation aborts routing rather than selecting a fallback, including cancellation while a fast fallback is pending; no route event or working-message update is emitted. Routing state is stored on the session branch, but never bypasses classification of a new user message. State stores `{ provider, model, thinkingLevel }`.

## Checks

Development SDK dependencies are pinned to Pi 1.1.0 in the repository and lockfile; runtime SDKs remain host-provided peer dependencies requiring 1.1.0 or newer. Use Node.js 22.19+ LTS or 24 LTS for development.

From the repository root (tests make no external model calls):

```sh
npm ci
npm run pi-auto-router:check
npm run pi-auto-router:test
node --test packages/pi-theme-cafecode/test/spinner.test.mjs
```
