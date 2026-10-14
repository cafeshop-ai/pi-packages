# Pi Responses WS 扩展：分析与实施计划

状态：扩展、五次重试/降级及合法 WS 身份已实现；用户最新真实状态为 WS response.completed、1 连接/6 复用/2 增量，用量页问题已确认由服务端显示导致。当前改为按 openai-responses API 自动接入，不再绑定 cafe。已安装本地包需再次 /reload；未发布。未修改模型、认证或 transport 配置，本轮未追加真实请求。

## 当前验收记录

本轮范围（Codex 对齐）：实现结构化 previous_response_not_found 单次全量修复、websocket_connection_limit_reached 换连接、426 立即 SSE、共享预算内 0–10% 抖动和 Retry-After（含上限与取消）。用户选择自动预热：在最终请求准备阶段建连后发送 generate:false/input:[]，有 5 秒总截止和事件/字节上限，验证空 output 后才发送正常全量。预热不写入对话/工具/正式 usage，也不作为增量基线；不兼容时关闭连接，在原预算内直接正常请求，认证/限流不绕过。显式 SSE、自定义 fetch、无 session、禁用缓存及诊断不预热。不是启动时后台建连，也未复制 Codex 的完整提示预填充。未放宽增量比较，未修改模型/认证/transport 设置、Pi 全局文件或服务端；未发真实端点请求。最终验证：Windows 原生 Node 24.21.0 下 191/191 通过（187 常规 + 4 已安装宿主回归），包级及全仓类型检查、git diff --check、npm pack --dry-run（7 文件）通过。没有重跑仓库外 tarball 安装测试，未发布；真实端点对预热的支持和延迟收益尚未验证。

上一轮范围：扫描已知模型的 API，包装所有未被其他扩展占用的 openai-responses provider；混合 provider 的其他 API 原样委托，不改模型/认证，不联网发现模型。冲突 provider 跳过并显示 skippedProviders，不阻塞其余 provider。多 provider 注册/模型选择/重载/清理、同端点不同认证隔离、非 cafe RPC/诊断脚本已加入本地回归。上一轮 Node 24.21.0 完整套件 140/140 通过（136 常规 + 4 已安装宿主回归），包级/全仓类型检查、git diff --check、npm pack dry-run（7 文件）通过；本轮未重新运行仓库外 tarball 安装测试，未发布。

以下按实现阶段保留历史证据；旧的“cafe 定向”范围和“尚未完成 WS”状态不代表当前结果。

101 排查：本地 Aether `protocol.rs:225` 要求 canonical session/thread body metadata；普通 Pi 默认不提供，sub2api 缺省 route-fence 分支也不补身份。在选择上游前可能直接协议拒绝。已添加 `lastWs` 安全诊断及 `live.mjs --diagnose` 单次/请求参数 max_output_tokens=16/无重试/无 SSE 诊断；逐次授权后做了两次真实单请求对照：无身份时 101、385 字节、零数据帧、1011 关闭；仅第二次请求补合法诊断会话身份后为 101、508 字节、一条文本 error 事件。没有正常生成完成，错误码未知且已隐藏，可见 usage 零不等于未计费。模型/auth/settings 元数据均不变；无重试/无 SSE，无 Codex UA 伪造，未改外部仓库或日常身份逻辑。只能支持首阶段身份不匹配线索，线上完整原因仍需 error.type/code/status 及路由日志。身份诊断阶段 Windows 原生 Node 24.21.0 完整套件（含全局宿主）100/100 通过；包级/全仓类型检查、git diff --check、打包 dry-run（7 文件）通过。

预算纠正：Aether `runtime.rs:1960` 的 Codex 规范化会补 instructions，且可能移除 `max_output_tokens`。诊断输出已改名 `requestedMaxOutputTokens`，不能保证服务端硬预算。每轮真实诊断均需明确授权并告知费用边界。

关联信息补齐：前两次没有保存诊断 UUID，不能用当前 Pi 会话 ID 代替。用户再次授权后完成第三次单请求身份对照：仍是 101、508 字节、一条文本 error、无重试/无 SSE。此次脚本已在请求前输出合成诊断的 session/thread/X-Client-Request-ID，并实际记录 UTC 起止及服务端握手响应的 X-Request-ID，详情保留在本地会话工具结果，不把真实关联 ID 写进公开包文档。模型/auth/settings 元数据未变；没有正常生成完成，可见 usage 零不等于未计费。未执行额外真实请求。

本轮重试改动已验证：Windows 原生 Node 24.21.0 下 83 项常规测试通过；实际全局 Pi 0.99.1 与工作区宿主的 RPC 续接/部分输出断流重试/降级共 4 项通过。包级与全仓类型检查、打包 dry-run 通过。Windows Node 23.11.0 的 RPC SSE 退出会触发 libuv 断言，直接委托 Pi 原生 SSE 也复现；未切换全局 Node，不把该运行时问题归因为 WS 握手错误。

此前已验证：61/61 常规本地测试（含 RPC 命令发现与执行）、包级类型检查、全仓 `npm run typecheck`、`git diff --check`、npm pack dry-run（7 个发布文件），实际 tarball 在仓库外新目录安装后使用独立 Pi CLI 的 WS 回归（1/1），以及实际全局 Pi 0.99.1 的 RPC 命令/两回合 WS 回归（1/1）。用户确认入口恢复后的最近两次重测（代理、直连）仍为握手 426，未发送生成请求。

| 门槛 | 当前证据 |
| --- | --- |
| 请求/解析复用 | `src/index.ts` 分别包装原生 `stream`/`streamSimple`；实际 loader、raw SDK 参数、工具执行和 compaction 集成测试通过。 |
| 四模式与可靠连接 | 文本/Unicode/思考/图片/usage、并发隔离、取消/超时/容量、帧与队列限制、代理与降级有本机假服务测试。 |
| 增量正确性 | 实际发送 `previous_response_id` + 单条增量；分支/提示/工具/参数/模型/认证变化、空增量与服务端拒绝回归通过。 |
| 恢复与回滚 | 假时钟冷却→真实请求探测→全量→增量；reload/unload/dispose 清理、其他 API 不变及 CLI 子进程测试通过。 |
| 真实 Café | 用户最新状态为 actual=websocket、response.completed、四身份 true、1 连接/6 复用/2 增量。确认完整生成、连接复用和增量发送；缓存命中与恢复不由计数证明。服务端确认“流式”是显示问题。 |

安装、模式、hooks 语义、代理、限额及回滚操作见 [README.md](./README.md)。下文保留设计约束；它们不是服务端兼容性证明。历史故障中 HTTP 101 后断开且无完整用量记录，不代表请求未处理；当前真实成功证据见上表。

最新传输决策已由用户确认，取代最初的“不透明重放”约束：三个 WS 模式均首次尝试 + 最多 5 次重试；握手失败与发送后断流共用预算，耗尽后切 SSE。可能重复生成/计费，但不把失败输出加入请求，不重复执行失败尝试中的工具；冷却和下一次真实请求探测策略仍保留。

服务端关联后确认：最新请求客户端 ID 与全部会话身份匹配；业务错误 400，提取标识 unsupported_value。原始 code/type 未分别留存，内部 codex_ws_official_unsupported_value 不是原始 type。离线以现有模型元数据、虚拟 key、拦截 fetch 验证本次诊断硬编码 none 实际生成 reasoning.effort=none（零真实请求），不同于日常高档 xhigh；仍需确认最终官方请求值及模型支持范围，不能宣布具体参数根因。新增 unsupported_value 安全码及三个 WS 模式的业务错误不重试/不降级回归；最新 Node 24.21.0 全套 103/103 通过（含全局宿主），包级/全仓类型检查、git diff --check 通过。未改日常 reasoning 或追加线上请求。

用户确认当前上游不支持 none，诊断脚本不再硬编码它：必须显式传 --reasoning-effort（当前 gpt-6-astra 使用既有 xhigh），缺参数或 none 拒绝，且在 native onPayload 检查映射/sampling 后的 effort，防止再次生成 none。requestedReasoningEffort 与 payloadReasoningEffort 随关联信息输出。缺参数、none、模型映射回 none 均有零握手/零发送回归，并保留非思考模型兼容性。最新 Node 24.21.0 全套 111/111 通过（含全局宿主），包级/全仓类型检查、git diff --check 通过。未改日常配置或主扩展 reasoning，未追加真实请求；修正后线上成功仍需另行授权验证。

日常 WS 修复：用户 reload 后仍报告 configured=websocket、六次全量 WS、101 后零帧、1011、四个身份标志 false，最终 SSE。正式 transport 已在 WS 专用路径补齐 dash-form 头及 body session/thread：默认使用真实 Pi 会话 ID，保留有效 caller 值，冲突/非法值在握手前拒绝；无 sessionId 时使用单请求临时 UUID，重试内稳定且不保留缓存。身份参与连接隔离和增量属性；SSE body/headers 保持原样，新增身份后的 wire 大小仍受限。native loader 回归确认身份确实来自 SessionManager；未改 reasoning/模型/认证/transport 配置，未追加真实诊断请求。最新 Node 24.21.0 全套 132/132 通过（130 常规 + 2 安装宿主额外回归），包级/全仓类型检查、git diff --check、打包 dry-run（7 文件）通过。当前本地包需再次 /reload 才载入本次正式修复；修复后真实 WS 生成仍待验证。

subagent 传输回归：保留 buildChildArgs 的 --no-extensions，不改生产调用。已在工作区和实际全局宿主分别验证两个子进程路径：settings 中预配置 WS 扩展且 transport=websocket-cached 时，默认参数仍走原生 SSE、零 WS 握手；手动显式 -e 时才走 WS。四项 CLI 回归及 pi-subagent 六项单测通过，全程假服务/虚拟 key、无真实请求。主会话 WS 与默认 café/openai-responses 子任务 SSE 可共存。

## 1. 决策

独立 workspace 包 `@cafeshop-ai/pi-responses-ws` 自动增强现有 openai-responses provider，不限制名称；不改其他 API。

- 保留官方 Pi，不修改全局安装文件，不复制 Codex adapter。
- 复用 Pi 的请求构造、消息转换、响应解析、工具调用和用量计算。
- 复用 OpenAI SDK 的 `ResponsesWS` 完成协议连接、帧收发和事件解码。
- 扩展只负责两者之间的桥接，以及会话连接、续接状态、清理和恢复策略。
- 普通 WS 是第一个验收里程碑；增量续接与断线恢复是后续验收项，不把“连接成功”宣称为“缓存成功”。

无需实现完整 WebSocket 协议，但也不是几行配置或直接调用 Pi 的 Codex WS 函数。

## 2. 已核查的事实

本地依赖：Pi / pi-ai 1.1.0，OpenAI SDK 7.19.0，ws 8.21.3；Windows 原生 Node 23.11.0。

| 项目 | 证据与结论 |
| --- | --- |
| 普通 Responses | `pi-ai/dist/api/openai-responses.js` 通过 OpenAI HTTP client 发请求，接受 `options.fetch`；没有 WS 分支。 |
| Codex WS | `pi-ai/dist/api/openai-codex-responses.js` 将 API key 解析为含账号 ID 的 JWT，并使用 Codex 路径；连接池和缓存算法不是独立公共传输服务。 |
| provider 局部覆盖 | `pi-coding-agent/dist/core/provider-composer.js` 的 `applyExtension()` 在不提供 `models` 时保留原模型；`streamWith()` 只分派当前 provider、匹配 API 的自定义实现。 |
| 鉴权继承 | 同一 composer 继续从 Pi 的配置和凭据层解析认证；无需扩展自己读取或复制 `auth.json`。 |
| SDK 现成能力 | `openai/resources/responses/ws` 导出 `ResponsesWS`；底层使用 ws，支持握手超时、代理 agent、事件迭代器和可选重连。 |

分析期间执行了三个不访问真实服务的 assert 检查，均通过：

1. Pi 公开 Responses adapter 接收自定义 fetch，保留 payload/response/provider-event hooks，并解析合成终止事件、response ID 和用量。
2. SDK 使用虚拟 API Key 连接本机随机端口 `/v1/responses`，发送 `response.create` 并接收响应事件。
3. 使用合成配置验证：只覆盖 cafe 的 streamSimple，模型清单不变、虚拟凭据正常继承、另一个相同 API provider 不受影响。

这些是接口可行性检查，不是完整扩展或服务端兼容性验收。实际 CLI loader、重载及 SDK/子进程调用仍需回归。

## 3. 最小接入方式

使用公开扩展接口，注册内容限定为：

```ts
// providerId 来自 registry.getAll() 中 api === "openai-responses" 的模型；跳过其他扩展已注册的 provider。
const base = ctx.modelRegistry.getProvider(providerId);
if (base) pi.registerProvider(wrapProvider(base, transport));
```

不提供 `models`、`apiKey`、`baseUrl`、`oauth`，不重新注册模型、不发起模型发现、不增加登录流程。

包装器直接调用 `openAIResponsesApi().streamSimple()`，而不是递归调用当前 registry 的请求。

已采用原生 Provider：分别包装 `stream`/`streamSimple`，避免旧式注册将 raw API 参数误作 SimpleStreamOptions。实际 runtime 的 `reasoningEffort`、`serviceTier`、`toolChoice` 已有回归，不按选项来源猜测分派。其他扩展注册过的 provider 跳过且在状态中报告，不覆盖原有认证/stream。

```text
Pi 的模型/鉴权/参数/上下文
        ↓
原生 Responses adapter 构造完整请求
        ↓ fetch 注入点
扩展：转换传输信封 → SDK ResponsesWS
        ↓
WS 原始响应事件 → 进程内 SSE 格式流
        ↓
原生 Responses parser → Pi 文本/思考/工具调用/用量
```

这里的 SSE 是进程内适配格式，不代表网络实际走 HTTP SSE。

保留任意现有 `provider/model-id`，不要求重命名或迁移路由器/会话。不得全局替换 `openai-responses` 或 monkey-patch `fetch` / `WebSocket`。

## 4. 传输与会话规则

沿用 Pi 的 `transport`、`sessionId`、超时、取消和缓存设置，不再造第二份配置文件。

| transport | 目标行为 |
| --- | --- |
| `sse` | 完全委托 Pi 原实现，不创建 WS。 |
| `websocket` | 会话内复用空闲连接，每次发送完整上下文；可重试故障耗尽五次重试后切 SSE。 |
| `websocket-cached` | 同一有效连接上，满足严格前缀校验时发送 response ID + 增量；不满足则全量。可重试故障耗尽五次重试后切 SSE。 |
| `auto` | 优先缓存 WS；仅在安全边界降级，进入 5 分钟 SSE 冷却；到期由下一次真实请求探测恢复，没有后台探测。 |

实现阶段尚未支持的模式必须明确报错，不能把 `websocket-cached` 悄悄当普通 WS。

连接隔离与清理：

- 按 provider、最终端点、sessionId、模型及有效认证/请求头身份隔离；身份只使用内存摘要，不输出密钥。
- 单连接同一时刻只有一个响应消费者；并发请求不共享正在使用的连接，额外请求采用独立非缓存连接。
- 无 sessionId 或 `cacheRetention: none` 时不保留跨请求续接状态。
- 取消、协议错误、连接断开立即丢弃该连接的续接状态；新连接先全量。
- 有界连接数、空闲释放、帧大小和事件积压限制；接入 Pi session resource cleanup，并处理 reload/shutdown，清理须幂等。

## 5. 增量续接的正确性门槛

只有上一个请求成功终止、获得可用 response ID，且新请求前缀与上次请求及其实际响应严格一致，才允许发增量。

不按消息条数或角色猜测前缀，不跳过所有 assistant 消息；这会在分支切换、编辑、压缩、工具结果变化时丢上下文。

需验证完整链路：文字、思考签名/加密内容、工具调用 ID 与参数、工具结果、图片、提示和工具声明改变、模型切换、空增量。

优先复用 Pi 的已导出消息转换能力建立同一格式的基线。实际扩展 loader 能否加载所需公开子路径必须先测；若不能安全复用，先停在全量 WS，不为凑缓存功能复制整套私有转换实现。

前缀不一致、response ID 缺失、空增量、连接变化或设置变化时全量发送。远端返回结构化 previous_response_not_found 时，只有本包自动添加的续接 ID 允许在共享预算内换连接、全量修复一次；调用者自带 ID 或全量请求上的相同错误保持终态。不把服务端拒绝当作零费用证明。

不自动把 `store: false` 改为 `true`。服务端仅支持 WS 并不足以证明支持连接级续接；必须实测。

## 6. 断线与重试边界

SDK 的自动重连默认不启用。它可以重建 socket，但不会验证 Pi 的上下文连续性或已发送请求的执行结果。

- 连接建立前失败：三个 WS 模式均可重试，最多五次；耗尽后改走 SSE。426 例外，直接降级。增加 0–10% 抖动并优先尊重 Retry-After，过大等待报错而不是缩短或绕过。
- 发送后断流：用户已明确同意按同一预算重试，可能重复生成/计费，不能认定没输出就是没执行。
- 失败的部分输出不加入重新生成输入，只向 Pi 发一次 assistant start 和最终终止事件；只有最终成功的工具响应才会被 Pi 执行。
- 恢复 WS 后先全量一次，建立新续接基线；后续才增量。冷却五分钟后真实请求探测，而非永久停在 SSE。
- 请求校验/本地容量/一般业务错误和 HTTP 400/401/403/429 不进入扩展重试循环；结构化的远端续接丢失/连接到期及可选预热不兼容按上述边界恢复。取消及 dispose 停止正在预热/退避的请求。不安装 pi-retry，不叠加 SDK 重试；Pi 上层重试仍存在，不能承诺 exactly-once 或零重复计费。

401/403、无效请求、额度耗尽不能一律当作网络故障反复重试。错误信息脱敏，不输出原始 headers、凭据或对话正文。

## 7. 代理、hooks 与网络策略

WS 不会自动继承 HTTP fetch 的代理行为。需要显式使用 Pi 的代理解析规则与 ws 的 HTTP(S) proxy agent，覆盖 HTTP_PROXY、HTTPS_PROXY、NO_PROXY 和 provider-scoped env；不关闭 TLS 校验，不跟随携带凭据的跨站重定向。不额外实现 SOCKS/PAC。

桥接只接受本次模型端点的 Responses 请求；尊重最终 Authorization 和自定义请求头，清除不适用于 WS 的 HTTP-only 字段（如 stream），不改变 prompt、工具、采样参数和 store 策略。

保留 `onPayload` 和 `onProviderStreamEvent` 的调用次序与次数。内部 Response 的 200 是适配器产物，不得冒充真实 WS 握手状态或伪造服务端响应头；`onResponse` 的桥接语义需要文档和测试。

调用方提供的自定义 fetch 可能承载预算、代理或审计策略。WS 无法透明沿用它时，要显式拒绝或采用已说明的 SSE 路径，不能悄悄绕过。普通会话路径与这类 SDK 调用分别测试。

提供一个最小 `/responses-ws` 状态命令：配置模式、最近实际传输、连接复用、全量/增量次数、恢复状态和安全错误原因。显示值来自实际发送结果，不只读取配置。

## 8. 文件与影响范围

计划结构：

```text
packages/pi-responses-ws/
  PLAN.md
  package.json
  tsconfig.json
  README.md
  src/index.ts              # 按 API 多 provider 注册、冲突跳过、状态命令、清理
  src/transport.ts          # SDK 与 fetch 桥接、连接生命周期
  src/continuation.ts       # 增量基线及严格匹配；到缓存阶段再增加
  test/*.test.mjs           # node:test + 本机假服务
```

沿用仓库测试和 TypeScript 配置，不增加测试框架。Pi 包声明为 peerDependencies，不打包另一份 Pi。OpenAI SDK、ws 和实际使用的代理库必须作为本包显式依赖声明，不能依赖 workspace 偶然提升；锁定经过验证的 SDK 版本。

实现时可能更新根 package-lock 和根 README 的包列表，不顺手改现有包。当前工作树已有多个未提交修改，须保留。

关联验收：主会话、压缩/总结、router 路由到 cafe、subagent 独立进程、其他 provider、reload 和退出。`pi-openai-search` 自己通过 HTTP client 发请求，不在本扩展覆盖范围内，也不宣称所有网络请求都会变成 WS。

## 9. 原始分阶段计划与完成条件

以下是开发工作量粗估，不是后台交付承诺；服务端不兼容另计。

1. **接入门槛（30–60 分钟）**：写 provider 局部覆盖与实际 CLI loader 回归；验证模型/鉴权/参数保持不变、低层 stream 与 streamSimple 的兼容边界、卸载恢复。若必须复制私有实现，先重新评估方案。
2. **可靠全量 WS（2–4 小时）**：实现 SDK 桥接、会话连接复用、超时/取消/清理、代理、脱敏和状态命令。用假服务验证文本、思考、图片、工具回合、用量与 SSE 对齐。
3. **增量续接（2–4 小时）**：实现严格前缀匹配及失效规则。第二回合的线上发送体确实减少，工具结果不丢；压缩、分支变化和空增量回归通过。
4. **恢复策略（2–4 小时）**：实现 auto 冷却和真实请求探测；断线后先全量再增量。用假时钟测试，不实际等待 5 分钟；取消、鉴权错误、部分输出失败不造成扩展内部循环重发。
5. **隔离验收（1–2 小时）**：类型检查、包级测试、实际 CLI/路由器/子进程回归；用户同意后，在独立会话用短合成提示测试 Café 的普通 WS、续接及恢复，设置请求/输出预算，再决定启用。

完整功能约 1–2 个开发工作日，不能把接口探针成功当成完整交付。

## 10. 安装与回滚

先通过 `pi -e ./packages/pi-responses-ws` 在隔离 agent/session 目录验收，不覆盖日常配置。真实凭据只经 Pi 正常认证机制提供，不写测试 fixture，不提交仓库。

验证成功后才将本地包加入个人 settings；不修改 models.json 的 provider/API 名称，不迁移会话、不覆盖 auth.json。

回滚只需禁用扩展并 reload；原 provider 配置仍由其原生 adapter 处理。验收必须证明卸载后不存在残留连接或注册状态。

## 尚未通过的最终门槛

真实 Café 已有完整生成、复用和增量发送证据；其他 provider 的线上兼容性、缓存命中及新连接恢复仍需分别验证。生产状态只保留安全诊断，无正文/凭据。未修改服务端、模型或认证配置；仅按此前授权安装本地包，未发布 npm 包；多 provider 改动仅本地回归，不对第三方服务作兼容性承诺。
