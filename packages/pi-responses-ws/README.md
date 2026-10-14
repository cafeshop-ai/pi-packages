# @cafeshop-ai/pi-responses-ws

自动为现有使用 `openai-responses` API 的 provider 增加会话级 WebSocket 传输，**不限 provider 名称**。保留 Pi 的模型、认证、请求参数、消息转换、工具执行和用量计算，不修改 Pi 全局安装或 `models.json`。

**验收状态：用户提供的真实 Café 状态已确认 WS 完整生成、连接复用和增量发送（`response.completed`，1 个连接、6 次复用、2 次增量）；用量页“流式”已确认是服务端显示问题。这不是所有 Responses 端点都支持 WS 的证明，服务端缓存命中与断线恢复仍需分别验证。多 provider 支持只做本地假服务回归，本轮没有追加真实请求。**

## 使用

要让常用 Pi 会话加载本包，在仓库根目录执行**安装**：

```sh
pi install ./packages/pi-responses-ws
```

回到已有 Pi 会话，运行 `/reload`，再运行 `/responses-ws`。本地包源码更新后必须再 `/reload`，无需重复安装或改模型。刚加载还没发请求时 `actual: "not connected"` 正常；选择已有的 `openai-responses` 模型并发送一条短消息后，命令才报告实际网络传输。扩展在会话开始和模型选择时扫描已有模型目录，不创建模型、不联网发现模型、不修改 provider 名称或认证；没有匹配模型时不注册。其他 API（包括 `openai-completions`、`openai-codex-responses`、`azure-openai-responses`）与 `pi-openai-search` 的独立 HTTP client 不受影响。

如果 provider 已由另一个扩展注册，则保留它的认证/stream 实现并跳过，在 `/responses-ws` 的 `skippedProviders` 中列出；其余 Responses provider 照常启用。纯 `models.json` 配置和内置 provider 不受这个限制。同一 provider 内混用 API 时，只有 `openai-responses` 请求被增强。服务端仍需支持 Responses WS；`transport: sse` 保持原生 SSE，其他三个模式沿用下面的重试/降级规则。

仅临时试用时，在**独立的交互终端**运行：

```sh
pi -e ./packages/pi-responses-ws
```

`-e` 只作用于新启动的进程，不是安装，不会给原会话添加命令。在 Pi 内用 `!pi -e ...` 或通过工具启动时，子进程的输入/输出通常被重定向，Pi 会采用非交互模式；没有初始提示时可无输出退出。因此这种调用不能用于给当前会话启用扩展。

需 Node >=22.19.0；已在 Pi 0.99.1（实际全局 CLI）和 Pi 1.1.0 验证命令注册、RPC 状态显示及两回合 WS 增量续接；更早版本未验证。宿主 Pi 包按官方扩展规则声明为 `peerDependencies: "*"`，不会打包或替换另一份 Pi。OpenAI SDK 验证版本为 7.19.0。npm 包发布后可使用 `pi install npm:@cafeshop-ai/pi-responses-ws`；仓库实现不等于已发布。

沿用 Pi 的 `transport` 设置。在 `~/.pi/agent/settings.json` **合并**需要的字段，不要覆盖文件：

```json
{
  "transport": "auto"
}
```

| 模式 | 行为 |
| --- | --- |
| `sse` | 原封不动调用 Pi 的 HTTP Responses adapter。 |
| `websocket` | 复用空闲会话连接，每次完整上下文；连接失败或断流重试耗尽后降级 SSE。 |
| `websocket-cached` | 同一连接上严格匹配已完成请求的上下文前缀与属性时发送 `previous_response_id` + 增量，否则全量；重试耗尽后降级 SSE。 |
| `auto`（默认） | 优先缓存 WS，与其他 WS 模式使用相同的重试和降级策略。 |

三个 WS 模式均采用 Codex 的默认计数：**首次尝试 + 最多 5 次重试，共 6 次 WS 尝试**。握手失败、发送后的 `connection_or_protocol_error`、可重试的事件等待超时及下面的续接/预热恢复共用一次请求的重试预算；耗尽后改走一次 SSE。退避基数依次为 200、400、800、1600、3200 毫秒，增加 0–10% 随机抖动。取消或请求截止时间可以提前终止，不会为了凑足次数继续请求。

- 握手 **426 直接转 SSE**，不白试六次；仍进入同样的 5 分钟冷却。
- `previous_response_not_found` 只在本包自动添加的增量续接上允许一次全量修复；清除旧连接/基线，重新发送原始完整输入。调用者自己提供的 `previous_response_id` 不被删除或改写；全量请求收到相同错误仍终止。
- `websocket_connection_limit_reached` 在共享预算内换新连接，从全量开始。只识别结构化错误码，不根据任意错误正文猜测可重试性。
- 可重试错误优先使用握手或 WS error 顶层/嵌套 `headers` 中的 `Retry-After-Ms` / `Retry-After`（秒数或 HTTP 日期）。最终降级前也尊重服务端等待建议。默认超过 60 秒即报 `retry_delay_exceeded`，不缩短服务端要求或立即绕道 SSE；沿用 `maxRetryDelayMs`，0 表示关闭业务上限，但仍拒绝超出 Node 安全定时器范围的等待。
- HTTP 400/401/403/429、其他提供方业务错误、请求校验或本地连接容量错误不进入这个重试循环。预热不兼容的单次恢复见下节。

降级后保留 5 分钟 SSE 冷却；到期由下一次真实请求探测 WS，恢复先全量，之后才增量，不做后台探测。此冷却恢复策略与 Codex 的会话级永久 HTTP fallback 不同。

**发送后的重试可能重复生成或计费**，这是用户明确选择的行为；不能依据“没有输出”或“没有用量记录”认定服务端未处理请求。失败连接立即关闭并丢弃续接基线；重新生成只使用原始输入，不把失败的部分输出加入上下文。Pi 只执行最终成功响应的工具调用，扩展不重放已执行的工具。SDK 自动重连和桥接路径的 SDK HTTP 重试关闭；Pi 上层自身的重试策略仍存在，因此不能保证 exactly-once 或零重复计费。

### 自动连接准备／预热

三个 WS 模式在**真实请求准备阶段**自动处理：Pi 已完成模型路由、认证、请求 headers 和 `onPayload`，本包先建立新连接，再发送一次 `response.create` / `generate: false` / `input: []`。等收到 `response.completed` 且 output 为空，才在同一连接发送正常请求。保留模型、reasoning、工具声明、身份和 store 策略；不伪造 Codex 客户端。

这是**请求内的连接／路由预热**，不是启动时后台抢先建连，也不是把整个提示词提前送去预填充。当前 Pi 扩展接入点不能在启动阶段可靠取得最终路由和请求 hooks，所以不另读配置、猜认证或提前发送历史。首个正式请求仍为全量；预热 response ID 不参与续接，之后的严格增量判定不变。额外往返可能增加首请求等待，不能宣称已降低延迟或提高缓存命中率。

- 每个新连接最多一次；同一次逻辑请求在重连时不反复预热。成功连接复用时不重复发送。
- 预热总等待最多 5 秒，并受原请求取消/超时、reload/dispose 约束；最多消费 1024 个事件、16 MiB。收到输出/工具调用、非完成终态或协议错误就丢弃该连接，不把它用于正常续接。
- 不支持 `generate: false` 等预热失败，在共享预算内新建连接直接发正常全量请求，不再次预热。认证失败、权限拒绝、额度耗尽和限流仍终止，不借预热绕过。
- `sse`、自定义 fetch、无 session ID、`cacheRetention: none`、调用者已有 previous response ID 或 generate 字段均不预热。冷却期间不预热；到期仍只由下一次真实请求触发恢复。
- 预热不写入 Pi 对话、不执行工具，不调用正常响应 hooks，不计入正式生成的 usage / full / delta；状态单独累计预热次数。**这不代表服务端免费**：网关可能不支持或忽略 `generate: false`，额外请求仍可能计费。严格预算的 SDK 调用可用第三个构造参数 `{ prewarm: false }`；本包真实诊断脚本始终禁用预热。

### 状态命令

`/responses-ws` 显示 `enabledProviders`（本包已包装的 provider）、`skippedProviders`（被其他扩展占用的 provider）、最近请求的 `provider`、配置模式、最近实际传输、创建/复用连接数、WS 全量/增量次数、最近 WS 请求与完整请求的字节数、活动连接数、恢复状态及安全错误原因/HTTP 状态。不显示端点、认证头、密钥、response ID 或对话。计数按当前会话累计（包含本包处理的多个 provider），`provider` / `actual` 描述最近一次经过本包的请求，不代表当前选中的未接管模型。字节数是请求 JSON 大小，不是 token 数或服务端缓存命中率；SSE 请求不累加 WS 计数。

日常 WS 自动补齐 `session-id` / `thread-id` 请求头和 `client_metadata.session_id` / `thread_id`，默认使用真实 `options.sessionId`（Pi 会话 UUID）。调用者已有有效身份会保留，缺少的字段从对应头/metadata 或 Pi 会话 ID 补齐；无 sessionId 的 SDK 请求只创建一次临时 UUID，重试内保持一致，不启用跨请求缓存。头和 metadata 冲突、空值/非字符串/非 ASCII/控制字符/超过 160 字节的身份在建立连接前拒绝；其他 metadata 保留。不会伪造 Codex UA/originator，不覆盖 reasoning，不改认证；SSE 与 SSE 降级发送原始 body/headers，不注入这些字段。

`warmupRequests` / `warmupsCompleted` 分别累计已发送/成功完成的预热，`lastWarmup` 为 `completed` 或 `failed`。`lastRetryDelayMs` 显示最近一次恢复调度的等待毫秒（0 表示无需等待）。这些字段不表示缓存命中或实际费用。

`lastWs` 保留最近一次 WS 尝试的安全诊断，即使之后已降级 SSE；`phase` 区分 `warmup` / `generation`，成功预热后计数清零再记录正式请求：握手状态、请求是否已发送、收到的帧/事件计数、文本/二进制帧类型、白名单事件类型、关闭码、客户端拒绝分类，以及白名单提供方错误码。`identity` 只表示 dash-form 身份头与 `client_metadata` 两个身份字段是否存在，不打印其值，也不表示其内容已通过服务端校验。快照是独立副本。

`clientFailure: "binary_frame"` / `"non_json_frame"` 表示客户端因该帧主动终止；`"sdk_error"` / `"buffer_limit"` 表示 SDK 或缓冲上限触发。单独的关闭码不证明哪一方先发起关闭；清理本身也可能导致 1006。关闭码异步到达时可能尚未出现在刚结束的快照中。未知事件类型显示为 `other`，未知服务端错误码/正文/关闭原因仍不输出。

### HTTP 101 后断开：Aether 身份协议

本地源码发现普通 Pi Responses 与 Aether Codex WS 的身份约束不匹配：

- `D:/sh/Aether/apps/aether-gateway/src/codex_ws/protocol.rs:225` 强制要求首帧 `client_metadata.session_id` 和 `client_metadata.thread_id`。
- `session.rs:316` 在首帧解析失败时发送 `aether_codex_ws_protocol_error` 并关闭；此时尚未选择上游候选或建立官方连接。
- `D:/sh/sub2api/backend/internal/service/openai_aether_ws_control.go:405` 的缺省分支只追加 route fence，不补这两个身份字段。
- 普通 Pi Responses 默认有 underscore-form `session_id` 请求头和 `prompt_cache_key`，但不生成上述 body metadata；sub2api 的 route-v1 canonical identity 使用的是 dash-form `session-id` / `thread-id`，不是同一个字段。

本轮经逐次授权完成两次真实单次诊断（同一已配置 Café 模型、合成短提示、无重试/无 SSE）：不补身份时，101 后发送 385 字节，收到零数据帧并以 1011 关闭；仅对照请求补合法诊断会话的两个身份头/两个 metadata 字段后，101 后发送 508 字节，收到一条文本 `error` 事件。后者未报告可显示的白名单错误码，错误正文未输出；两次都没有正常生成完成，可见 usage 为零，不能据此保证未计费。模型、认证、settings 文件元数据未变。**这支持身份不兼容是首阶段的重要线索，但不证明它是唯一原因，也不证明 WS 已兼容。** 两次为独立连接，需服务端错误码/路由日志补齐因果证据。

服务端随后精确关联最新带身份诊断，确认客户端 ID 与会话身份匹配；业务错误记录为 400，提取的错误标识为 `unsupported_value`。原始 `error.type` / `error.code` 未分别留存，不能据此完整还原原始事件，也不能把内部分类 `codex_ws_official_unsupported_value` 当作原始 type。

离线使用当前已配置模型和 Pi 原生请求构造（虚拟 key、拦截 fetch、零真实请求）已确认诊断的 `reasoningEffort: none` 生成 `reasoning.effort: none`。这不同于日常高档路由的 xhigh；用户已确认当前上游不支持 none。已修正诊断脚本的硬编码错误，但尚未用修正后的 effort 验收真实 WS，也未证明此前 Aether 最终转发值或原始错误参数名。未改日常 reasoning，也未追加线上请求。`unsupported_value` 已纳入安全错误码白名单；该业务错误不重试、不降级，不能靠增加网络重试解决。

Aether 的 `runtime.rs:1960` 调用 Codex 请求转换，已为缺省请求补 instructions；不能仅凭普通 Pi 的 body 没有 instructions 判定第二阶段原因。该转换还可能删除 `max_output_tokens`（除非对应 body rule 保留），因此请求侧 token 参数不能充当服务端硬预算。

本机假服务已复现 101 后返回该协议拒绝；现在状态会显示 `providerCode: "aether_codex_ws_protocol_error"`、`providerReason: "canonical_identity_required"`，不会只丢弃其安全错误类别。**这只是源码与本地复现证据，不是对已部署版本或线上断开原因的确认。** 若错误帧没有到达客户端，仍需服务端脱敏日志验证。上述为历史排障记录，最新真实成功证据见文首。

不要通过伪造 `codex_cli_rs` User-Agent / originator 绕过官方客户端投影判断。此前身份注入仅在合成诊断；用户随后提供日常状态：六次全量 WS、101 后零帧、1011、四个身份字段 false，最终 SSE。因此当前正式扩展已将合法 Pi 会话身份适配接入 WS 专用路径，保留正常 reasoning 与调用者身份，并以本机 canonical-identity gate 回归。没有改认证、日常 transport 配置或 Aether/sub2api 仓库，没有为此次修复追加真实诊断请求。

### 服务端 426

已观察到 Café 在发送生成请求之前返回 `426 / websocket_unavailable`，直连和代理结果相同；标准 Upgrade/Connection/WS version 头已确认正常。

若部署使用 sub2api，参考其 `backend/internal/handler/openai_gateway_handler.go` 的 `openAIWSIngressGlobalUnavailableReason()`，核查以下**服务端**开关：

```yaml
gateway:
  openai_ws:
    enabled: true
    force_http: false
    responses_websockets_v2: true
```

这是本地 sub2api 源码中的入口条件，不是对线上配置的断言。入口开启后还需上游账号/路由支持 WS。扩展不会更改服务端配置；三个 WS 模式在 426 时均直接降级 SSE。若握手已为 101 但仍断流，需要核对服务端关闭码及最后一个事件类型，不能继续当作入口未启用处理。

## 连接和缓存边界

连接按 provider、最终 URL、session ID、模型、有效请求头/认证与代理身份隔离，身份摘要只在内存中使用。一个连接只有一个消费者；并发请求用独立连接，不共享活动连接的续接状态。

- 无 `sessionId` 或 `cacheRetention: "none"` 时不保留连接或跨请求基线。
- 分支、压缩、修改历史消息/系统提示/工具声明/采样参数使严格前缀失效，发送全量；缺 response ID、空增量、未正常完成也不建立基线。
- 取消、断线、协议/提供方错误会关闭连接并丢弃基线；取消、reload 或 dispose 也会终止预热和退避中的请求，不能在清理后重新开连接。本包自动续接的 `previous_response_not_found` 可在原预算内全量修复一次；调用者自带 ID 或修复后仍失败则报错。
- 最多 16 个连接，最多 64 个状态/冷却记录；空闲 5 分钟关闭，使用超过 55 分钟的连接不再复用。单帧/请求/事件积压字节上限 16 MiB，事件积压上限 1024。
- reload、关闭会话和 SDK dispose 清理资源，卸载恢复原 provider；不主动改写 `store: false` 为 `true`。

续接基线复用宿主 Pi adapter 的 payload 构建，通过一个在 `onPayload` 阶段终止的内部请求获取消息转换结果；不联网、不执行调用方 hooks，也不复制 Pi 私有消息转换器。严格校验的是**Pi 实际序列化的请求**，不是角色或消息条数。

参考了本地 Codex 源码 `a9b0815167`：`core/src/client.rs` 的请求属性/前缀续接约束、426 fallback、WS v2 beta 头及 `generate: false` 预热；`core/src/responses_retry.rs` 的 5 次重试后切换传输计数；`codex-api/src/endpoint/responses_websocket.rs` 的已知可恢复错误和 Retry-After。未复制 Codex adapter，也不发送其 ChatGPT 账号头或使用 Codex 专用路径。当前不复制 Codex 的后台预连接、完整提示预热续接或会话永久 HTTP fallback。

## SDK / hooks / 代理

原生 provider 分别包装 `stream` 与 `streamSimple`，保留低层 `reasoningEffort`、`serviceTier`、`toolChoice` 等选项。其他 API 继续调用原 provider。已注册的自定义 provider 扩展与本包冲突时跳过该 provider，不覆盖且不阻塞其他 provider。卸载/资源清理只撤销本包仍持有的注册，不删除后来由其他扩展替换的 provider。

- `onPayload` 与 `onProviderStreamEvent` 委托 Pi；单次成功请求的调用顺序/次数不变。握手重试复用同一序列化 payload；发送后的重新生成会再次执行请求 hooks，事件 hook 可以看到之后被丢弃的失败尝试事件，观察者应避免不可重复的副作用。
- WS 事件被转为**进程内** SSE 流交给 Pi parser；这不代表网络走 SSE。
- WS `onResponse` 返回真实握手 101 和握手响应头，附加 `x-pi-responses-transport: websocket`、`x-pi-responses-connection-reused`；复用时引用原连接的握手。它不伪造内部适配器 Response 的 200。
- 调用方提供自定义 `fetch` 时，`auto` 使用该 fetch 的 SSE 路径；显式 WS 报 `custom_fetch_requires_sse`，不绕过调用方预算/审计策略。
- WS 以及三个 WS 模式的 SSE 降级支持 HTTP(S) proxy、`NO_PROXY`、provider-scoped `env`，不支持 SOCKS/PAC；不关闭 TLS 校验，不允许桥接重定向。

`timeoutMs` 默认 300000，用于 Pi 请求超时及 WS 事件等待超时；`websocketConnectTimeoutMs` 默认 15000。取消使用调用方 AbortSignal。服务端错误正文脱敏，只保留已知安全错误码，因此不会保留任意服务端文案或全部未知错误的重试分类。

`pi-subagent` 当前主动使用 `--no-extensions`，所以对于本包增强的 `openai-responses` 模型，默认子进程仍使用原生 SSE，主会话可继续用 WS；无需把全局 transport 改成 sse。已在工作区与已安装 Pi 宿主实际启动子进程验证：即使 settings 已声明 WS 扩展且 transport=websocket-cached，默认 subagent 参数仍为 SSE、零 WS 握手；只有手动显式加 `-e` 加载本包时才为 WS。该结论不泛化到其他 API 的原生 transport 实现。不要为强制子进程使用 WS 而修改全局 Pi 文件。

## 验证

从仓库根目录执行（普通测试全部使用本机假服务和虚拟 key）：

```sh
npm run check --workspace=@cafeshop-ai/pi-responses-ws
npm run test --workspace=@cafeshop-ai/pi-responses-ws
npm pack --workspace=@cafeshop-ai/pi-responses-ws --dry-run
```

最新完整回归在 Windows 原生 Node 24.21.0 下 **191/191 通过**（187 常规 + 4 已安装宿主回归）。新增 51 项恢复／预热回归，覆盖 426 立即降级、已知续接错误修复、共享重试预算、抖动、Retry-After/上限/取消、预热成功/不支持/意外输出/超时/认证限流边界及独立诊断预算；保留无 café 配置的任意 provider、多 provider 认证/连接隔离、注册冲突跳过与独立清理验证。覆盖四种传输、中文/Unicode、思考签名、完整工具回合、图片、usage/cost、hooks、严格增量及失效、并发/连接容量、五次握手/断流重试、混合故障的共享预算、部分输出丢弃、工具不重复执行、冷却恢复、超时/取消、帧与队列上限、错误脱敏、代理/降级，以及真实 Pi loader/agent/compaction/router/reload/unload/bundled CLI 子进程。

Windows Node 23.11.0 的 RPC SSE 路径在进程退出时会触发 libuv `UV_HANDLE_CLOSING` 断言；直接使用 Pi 原生 SSE 也复现，不是 WS 握手故障。Node 24.21.0 下同一 RPC 降级测试正常退出。此验证使用临时 Node 24 运行器，没有切换全局 Node 或更改 Pi 配置。建议 Windows CLI 使用维护中的 Node LTS。

`test/rpc.test.mjs` 还验证 `/responses-ws` 在 RPC `get_commands` 中可发现、被命令处理而不生成、通知显示 WS 状态，以及第二回合使用增量。设置 `PI_WS_HOST_CLI` 指向另一个 Pi 的 `dist/bundle/cli.js` 可同时回归该宿主；已用此方式验证全局 Pi 0.99.1。

另已通过实际 tarball 的仓库外安装验证：新目录安装本包、`@earendil-works/pi-ai@1.1.0` 与 `@earendil-works/pi-coding-agent@1.1.0`，从该目录的独立 CLI 加载已安装扩展并连接本机假服务。它不依赖工作区提升的依赖。该检查单独运行，不让常规 `npm test` 下载依赖：

```powershell
# 先在仓库外的目录安装 tarball 与上述 Pi 包；填入该目录，不是 agent 配置目录。
$env:PI_WS_PACKAGE_TEST_DIR = "C:/Temp/pi-ws-install"
node --experimental-strip-types --test packages/pi-responses-ws/test/packaged.mjs
Remove-Item Env:PI_WS_PACKAGE_TEST_DIR
```

真实端点测试**不由 npm test 自动运行**。101 后断开优先使用单次诊断；明确授权后，在仓库根目录传入已有的 `provider/model-id`（按第一个 `/` 分隔，model ID 自身可含 `/`；不再接受省略 provider 的旧参数）：

```sh
node --experimental-strip-types packages/pi-responses-ws/test/live.mjs --allow-live <provider/model-id> --diagnose --reasoning-effort <supported-effort>
```

必须显式指定该模型支持的 `--reasoning-effort`（minimal/low/medium/high/xhigh），不再默认或接受 none；当前 gpt-6-astra 的既有高档路由使用 xhigh。缺参数/none 在网络请求前拒绝。Pi 在省略 effort 时也可能生成 none，因此不能仅删除旧硬编码。脚本额外检查原生生成的 payload，阻止模型映射或 samplingParams 再次把 reasoning effort 改成 none/未知值；输出 requestedReasoningEffort 与 payloadReasoningEffort 便于核对。非思考模型可不生成 reasoning；如仍生成 effort，也必须是上述有效值。

只发合成提示，最多一次 WS 生成请求，客户端设置 `max_output_tokens: 16`；该字段可能被网关转换/删除，**不保证服务端硬限额或最多 16 个计费 token**。诊断模式显式禁用预热、重试与 SSE 降级（包括 426），断线直接报告失败，不再依赖在退避回调里取消来限制请求次数。诊断脚本还在请求前输出 `diagnosticRequest`，在结果中输出 `correlation`：本次合成诊断创建的 session/thread/client request UUID、UTC 开始/payload 就绪/响应回调/结束时间，以及服务端响应头的 `X-Request-ID`（仅允许已知 UUID、hex、OpenAI req_ 或 ULID 格式）。`clientRequestId` 明确发送为 `X-Client-Request-ID`；有身份对照时同一个 UUID 也用于 session/thread 的头和 metadata。响应回调时间不等于精确握手时刻。

`serverRequestIdState` 区分 `recorded`、`absent`（已收到响应但没有该头）、`redacted`（格式未知不输出）和 `not_observed`（没有触发响应回调，不能推断服务端是否发送了该头）。上述诊断 ID 不是当前 Pi 对话 ID；日常 `/responses-ws` 状态仍只显示身份存在性。不会输出密钥、端点、完整 headers、正文或关闭原因，也不修改模型/认证/transport 配置。可能产生服务商费用。输出字段 `requestedMaxOutputTokens` 只表示客户端请求参数。

旧 `--with-session-identity` 参数仍仅允许与 `--diagnose` 同时使用，显式在 caller 层填同一个诊断 UUID；当前扩展即使不传此参数也会自动补齐合法 WS 身份。因此该参数不再代表“有/无身份”对照，仅用于验证显式 caller 身份会被保留。不会伪造 Codex User-Agent / originator。`test/diagnostic.test.mjs` 用本机假服务覆盖 caller 显式/transport 自动身份、成功、断线、协议拒绝、握手拒绝，以及错误 reasoning 在发送前阻止的一次尝试预算。

完整服务端验收另需授权，并确认入口可用后执行：

```sh
node --experimental-strip-types packages/pi-responses-ws/test/live.mjs --allow-live <provider/model-id> --reasoning-effort <supported-effort>
```

最多 5 次逻辑请求，禁用预热，每次客户端设置 `max_output_tokens: 128`；中间网关可能规范化/删除此字段，不能保证服务端硬限额。只发送合成提示，通过 Pi 正常认证路径取认证，模型缓存写临时目录，不打印认证或输出文本，不保存会话/配置。验证普通 WS、连续两回合增量、新连接全量和再次增量；中途失败立即停止。可能产生服务商费用。`--direct` 仅在允许直连的环境中用于诊断代理差异。

## 回滚

临时 `-e` 加载：退出该进程后不带 `-e` 重启。持久安装：用 `pi remove <安装来源>` 移除，运行 `/reload`。无需改模型名称或认证文件。包没有后台探测、迁移或跨进程共享连接。
