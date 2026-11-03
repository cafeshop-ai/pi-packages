# 验证记录 — 2026-11-02

## Review handoff — 2026-11-03 (current status)

- Preparing branch `review/cafe-acp-managed-sessions` for independent frontend and architecture review; production deployment must follow review and resolution of blocking findings. Historical stage statements below are not the current installation status.
- The previously audited archive `7f52681e8a46181c05aa710b5798fc31898a30a4add6dd505577b72620da996d` was installed locally with explicit user authorization. Pi package and collaboration entry paths now point to that build. No automatic Pi reload or gateway restart was performed; identity, credentials and model files were preserved. This is not a production deployment or full ACP acceptance.
- Fresh offline rerun: source 662 passed / 2 skipped; frontend 316 passed (57 files); ACP 28 passed / 2 skipped; both TypeScript checks and Go `go test ./...` passed. The skips are optional fixtures. No live Codex prompt was sent; the existing 2/2 prompt budget remains exhausted.
- The current packaging regression rerun exceeded a 180-second outer command deadline; it is inconclusive, not a new 9/9 pass. The earlier 9/9 result remains historical evidence. The isolated source-build test itself allows 180 seconds for build plus 240 seconds for its regression suite, so the outer deadline was insufficient.
- Native Pi loader checks reproduced two legacy `/cafe` registrations in either load order and verified exactly one `/cafe` with both updated real entrypoints in either order; no network requests or model calls.
- Still pending: production-shaped gateway/browser/terminal acceptance, real approval/cancel and crash recovery, a second ACP agent, Linux runtime validation, independent review and server deployment evidence.


**最新：真实 prompt 总计 2/2，已耗尽；共享非回放挂接、同一 turn 文本和用户确认的 Codex 窗口显示已验证。Space ACP 产品接入已通过离线回归，并生成/审计了 Windows amd64 与 Linux amd64 的未安装候选包。生产形态的网关/浏览器/终端验收仍未完成。** 早期段落是按阶段保留的历史记录；文末“产品接入与离线候选包阶段”覆盖此前源码-only与候选包待生成状态。

## 已完成

- Windows 原生工具链，Node 23.11.0；本机 Codex CLI 0.166.0。
- `codex-acp 2.5.0` 隔离安装；其官方 ACP SDK 为 2.1.0。没有安装/更新全局 Codex 或改变 Pi。
- 官方 SDK 协商 ACP **wire v1**；npm SDK 2.1.0 不等于 wire v2。
- 离线测试：13 项通过、0 跳过（指定隔离 SDK）；覆盖预算、拒绝权限、事件归属、历史恢复、取消、连接丢失、版本拒绝及自有进程关闭。
- 本机握手：通过，0 次 prompt。临时新会话 smoke：通过，1 次 prompt，回复匹配固定标记，11 字符，`end_turn`，0 个工具事件。只读模式已由 session/new 返回确认。
- 两次运行的自有 adapter 均已关闭；最终进程检查未发现本次 hooks={} 特征的 Codex App Server 残留。未接入用户原有会话、未开启共享 daemon、未启动网页网关。
- 最终 `npm run acp:test --workspace=@cafecodework/pi-cafe-space`：13 通过、0 跳过；TypeScript check、Trellis JSON/context 路径校验及 whitespace 检查通过。未跑生产全量回归。

## 请求预算

本轮授权上限：2 次 prompt 尝试；实际 **2 次，剩余 0**（自有新会话 1 次、用户确认的已有会话 1 次）。原型无重试，失败不会返还预算。后续只做离线测试。供应商 HTTP 层重试没有抓包统计；不能把 2 次 ACP prompt 表述为保证只有 2 次供应商 HTTP 请求。

原始去敏报告与一次性预算文件保留在本机临时验证目录，不进入公开 Git；没有保存模型正文或凭据。

## 共享会话证据与限制

固定版本 npm 包 `@agentclientprotocol/codex-acp@2.5.0`：

1. README 的 Runtime options 提供 `CODEX_PATH`（替换可执行文件）、`CODEX_CONFIG` 等，未列出已有 App Server URL/socket。
2. `dist/index.js:28097–28105` 的 `startCodexConnection` 通过 spawn 启动 `app-server`；`:54024–54027` 的启动参数仅加 hooks 配置；`:54222–54245` 未选择共享后台连接。默认路径因此是独立 App Server。
3. `dist/index.js:41622–41659` 的 `loadSession` 恢复 thread 并读取历史。**同一个 thread ID 或可恢复历史不证明两客户端共享同一个活动 turn。**
4. 本机 Codex 0.166.0 帮助存在 `--remote`、`app-server proxy --sock`，说明可进一步验证共享后台路径。尚未运行真实 TUI＋第二客户端实验，不声称已支持或绝对不支持。

参考：[codex-acp 源码与说明](https://github.com/agentclientprotocol/codex-acp)、[ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)。本轮结论以固定 npm 包代码和本机 CLI 为准，不依赖网页当前 main 版本。

## 已有后台只读验证（用户启动本机 Codex 后）

- daemon 状态 running：本机 CLI 0.166.0、已运行后台 0.165.0。没有更新或重启它。
- 初次将 JSON 行直接发送给 native proxy，两个版本均在 initialize 等待超时，stdout 为 0。随后核对固定版本源码：control socket 需要 WebSocket upgrade；proxy 只搬运原始字节。修正传输后 0.166.0 proxy 与 0.165.0 后台正常通信，不能将先前超时归因于版本差异。
- `shared-check.mjs` 通过 **已有 Unix socket → native proxy → WebSocket** 建立两个独立连接，只发 initialize / initialized / thread/loaded/list；双方返回同样的 2 个已加载 thread ID，无分页。没有读取 title/preview/history 来猜测哪个是用户当前会话。
- 在仓库外临时建立白名单传输桥，让原版 codex-acp 2.5.0 连到该后台：ACP v1 initialize 成功。桥仅转发了 initialize，阻止了 config/read；没有新建/恢复/发送/取消会话。它只是握手验证，不是可用的完整共享 adapter。原始报告为隔离安装目录中的 `shared-acp-report.json` 和 `shared-bridge-report.json`；临时桥未作为生产代码发布。
- 本轮 0 次模型提示、0 次历史请求、0 次会话修改；全任务累计仍为 1 次 prompt。两个自有 metadata proxy 和临时 ACP adapter 已关闭，检查前后的后台与 TUI PID/启动时间一致。
- 加入只读共享后台与 WebSocket-over-proxy 测试后：18 项全部通过、0 跳过；任务 JSON 与 whitespace 检查通过。
- 用户随后提供 `/status`，确认目标确为这两个 loaded IDs 之一，Server 为 Local background server。具体 ID 仅保留在仓库外 `shared-target.json`；没有读取目标会话正文。原有模型和权限必须保持，不可对已有会话复用新建 smoke 的只读/low 配置覆盖。
- **结论：无需先假定必须新增 Codex 原生 adapter。连接既有运行时的传输路径成立，但指定会话挂接、同一活动 turn 的消息/审批/取消还未验证。** 原型 `sharedLiveSession` 仍为 false，不能提前开放完整控制。

源码依据：[0.165.0 Unix socket 的 WebSocket 接受器](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/app-server-transport/src/transport/unix_socket.rs)、[0.165.0 CLI proxy 分派](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/cli/src/main.rs)。

## 握手阶段门槛（历史）

- 先不增加 Codex 原生 adapter。评估 `codex-acp` 小型共享 transport 扩展或受控 proxy，不复制第二套消息协议。
- 在自有隔离后台中连接两个客户端，验证同一 thread/turn 的状态、文本、审批和取消；再做真实 TUI 验收。
- 共享后台的生命周期不得由借用连接关闭；重连未知结果不得重复发送。
- 网页/网关接入、第二种 Agent、ACP v2、Linux 运行都未验收。当前任务保持进行中。

## 共享挂接与 Space 源码阶段（历史证据）

- 新增 SharedPolicy 与受控 native proxy 桥；剥除 model/provider/permissions/MCP/instructions 等覆盖，thread/resume 不回放历史，turn/start 仅允许绑定 thread 的短文本，禁止静默 steer；只允许中断本连接已确认拥有的 turn。所有工具审批拒绝，未知结果不重发。
- 既有会话零 prompt attach-only 通过；before/after settingsFingerprint 一致。随后用唯一剩余的一次真实提示验证：ACP 与独立 native observer 收到相同活动 turn 的固定文本，end_turn、配置指纹一致、0 工具事件。去敏报告位于既有隔离安装目录的 shared-session-results/shared-attach-report.json 与 shared-live-report.json。未读取对话历史。
- 用户本轮明确确认目标 Codex 窗口出现 `ACP OK`，因此终端显示的文本 smoke 已有人类确认；无新增提示。此前实时报告中的 `nativeTerminalDisplay: requires-human-confirmation` 由这条确认补足。真实审批/取消仍未验收；文本 smoke 不等于审批/取消验证。桥/adapter/proxy 已回收，用户 daemon/TUI 未关闭。
- 新增 space-host.mjs 与 space-run.mjs：显式本机配置、强 token/loopback 网关、既有 host 认证/命令通道、stream/session/cwd fences、按客户端请求 ID 去重、未知断线不重试、有界事件与权威 snapshot。模式 new/attach，共享先读 native cwd 并核对配置指纹；源码入口有独占状态标记，未纳入正式包或托管注册。
- snapshot.agent 为可选显示能力元数据，TS/Go canonical codec 同步支持；网页禁用不支持的模型配置与 steer/followUp。它不是设备授权，host 仍独立拒绝不支持的命令。既有 Pi 缺少字段时行为不变。
- 官方 SDK→本地假 Agent 子进程→Space host WS 的端到端 fixture 通过；没有启动真实 Codex、发送真实模型提示或读取本机凭据。该证据不等于 Go 网关+浏览器+真实终端实测。
- 该阶段的历史回归数据；新的 ACP/源码/Web/Go 回归结果见下方“产品接入与离线候选包阶段”。独立 quick_explorer 默认 600 秒超时，无可用审查结论。
- 该阶段真实提示新增 0；全任务预算仍为 2/2。未修改用户 Pi 身份、模型、凭据或敏感房间配置。

## 产品接入与离线候选包阶段（2026-11-02，最新）

- 浏览器只传不透明 `targetKey`；Go manager 在本机将 key 映射为 Codex 原生 session ID。原生 ID、target key 与 attempt marker 只写本机 registry，公开 managed-session 和 workspace JSON 不包含它们。ACP ready 事件分别校验托管 host ID 与原生 Agent session ID。
- socket 路径策略已对齐：绝对路径、UTF-8 字节数上限 4096、拒绝 ASCII 控制字符/DEL；`%!^&` 等合法路径字符被接受，因为不经 shell 执行。`targets.mjs`、`space-run.mjs` 和 Go manager 均执行对应校验。
- 最近离线回归：ACP 28 通过、2 跳过；源码 Vitest 662 通过、2 跳过；Web 57 文件/316 测试通过；Go `./...` 全通过；源码与 Web TypeScript 检查通过。跳过项只涉及未指定隔离 SDK/子进程 fixture，没有发起真实 Codex 或模型请求。
- `npm run refactor:build:test`：9/9 通过。`npm run refactor:pack` 完成发行 allowlist、二进制身份/摘要、证书材料扫描与 Markdown 本地链接核对。最终离线归档 `.refactor/release/pack-9eR7we/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `7f52681e8a46181c05aa710b5798fc31898a30a4add6dd505577b72620da996d`，62 个文件。Windows amd64 为本机构建；Linux amd64 仅交叉编译、未运行。候选包 4 份 Markdown 的 7 个本地链接/锚点均通过。
- 候选包未安装、未部署；未重载 Pi。未提交或推送。真实 prompt 预算仍为 2/2，后续不执行 prompt-bearing 测试，除非用户再次明确授权。

### 仍需完成

生产形态 Go 网关/浏览器/真实终端验收，真实审批/取消与崩溃恢复，第二种 Agent 和 Linux 实机运行验证。当前任务保持 `in_progress`；离线候选包不等于产品验收通过。
