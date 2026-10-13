# 重构任务卡：R00–R19

> 先读 [执行入口](../REFACTOR_EXECUTION.md)。实际状态见 PROGRESS，写出任务卡不等于授权执行。
>
> 支持单任务或连续范围授权；范围内逐项验证后继续，不因普通 review 中断。复杂卡仍可只授权 `Rxx.1`，子步骤不能跳过前置测试。下列测试名称是目标测试，不能当作已有通过记录。

## 0. 顺序与检查点

```text
R00 基线 → R01 版本与 API 核对 [审查] → R02 契约 fixtures [审查]
 → R03 Go codec/config → R04 HTTP → R05 WS → R06 host 状态
 → R07 command/cache → R08 Go 等价集成 [审查]
 → R09 Web 骨架 → R10 客户端 → R11 store/gateway [审查]
 → R12 parts 契约 [审查] → R13 extension/投影 [审查]
 → R14 assistant-ui → R15 完整页面
 → R16 构建分发 → R17 本地启动 [审查]
 → R18 全链路验收 [审查] → R19 显式切换/清理 [单独授权]
```

与原 A–G 阶段对应：R00–R03/R09 属 A 的基线/工程工作；R04–R08 属 B；R10–R11 属 C；R12–R13 属 D；R14–R15 属 E；R16–R17 属 F；R18–R19 属 G。为了减少并行修改，Web 骨架延后到 Go 基线验收后建立。

图中 `[审查]` 和卡片中的“已审查/已确认”均指执行流程内完成并记录的质量检查，不要求逐项人工批准。普通检查点可由执行者据证据完成，独立只读检查可辅助；不能冒称外部 reviewer 已批准。未决协议/安全变更或无法验证的行为按入口第 7 节升级；R18 特殊测试权限及 R19 单独授权保持不变。

所有任务都允许更新本任务相关文档和 `PROGRESS.md`；所有代码任务都要求原有 TS check/tests 不回退。R03 后首次导入已批准 Go 依赖导致的 go.mod/go.sum tidy 变化也在对应 Go 任务范围内，但不得改核准版本或更新无关依赖。修改白名单是最大范围，不是要求一次重写整个目录。需要白名单外修改就先停。

## R00 — 记录现场与可重复基线

**前置：** 用户授权包含 R00；不由本卡推定后续任务授权。

**先读：** 根/package `package.json`、tsconfig、package `.gitignore`、`src/protocol/index.ts`、`src/relay/{index,server}.ts` 和 6 组当前测试；现有启动脚本只读。

**允许改：** `docs/refactor/BASELINE.md`、PROGRESS；package `.gitignore` 只允许新增 `.refactor/`，以存放后续隔离产物。不得改业务源码。

**步骤：**

1. 记录仓库路径、HEAD、branch、工作区已有修改；不假设文档中的旧 commit 仍是当前 HEAD。
2. 检查 native Node/npm/PowerShell、Go 是否可用，只记录版本/路径，不安装或改 PATH。
3. 按执行入口运行现有三条 typecheck/check/test，保存真实结果。
4. 记录当前 build/prepack 会清理 dist；只读确认旧 Web/Relay 的入口，不 build，不启动生产 Relay/Pi/Chrome。上一步现有测试自身创建并清理的隔离 listener 不等于获准启动用户服务。
5. 给出基线失败、工具缺失、已有用户修改和后续修改范围。

**通过：** 原有检查通过，BASELINE 记录实际证据；缺 Go 记录阻塞 Go 任务但不造假。如果 TS 基线失败则 R00 blocked，不顺手修复。

**交接：** 记录 R00 证据；若 R01 在授权范围内则继续，否则停止。不 commit。

## R01 — 固定版本、API 和未决事项

**前置：** R00 已完成。

**允许改：** `docs/refactor/VERSIONS.md`、PROGRESS；本任务不安装依赖、不生成 lockfile。

**步骤：**

1. 查询精确 npm 版本、engines、peerDependencies，形成完整所需依赖表，包含 React/React DOM、assistant-ui/Markdown、Vite/plugin/sass、所有用户指定库及测试配套。
2. 对照 Node ≥22.19.0、当前 TypeScript/Vitest 和其他 workspace，列出兼容组合。禁止只写 latest。
3. 核对 Go/Gin/Gorilla 的受支持版本及 API 文档，记录来源与日期；Go 未安装列出工具链需求，等待用户允许安装。
4. 读 assistant-ui ExternalStoreRuntime、Message/Thread、Markdown 文档和匹配版本的公开源码/类型（不是尚未安装的本地包），记录实际导入路径/属性，尤其 no-join、tool renderer、status、onNew/onCancel；R09 安装后再以本地类型复核。
5. 标出无法核对的事项。网络/API 文档读不到就标 blocked，不用记忆猜包版本。

**通过：** 精确版本清单、版本兼容与 API 摘要可复核，无 force 方案，无新增未要求的框架。

**内置检查：** 核对精确版本、兼容性与来源证据，补齐已发现问题后可标 done，不等待逐项人工审批。R03/R09 仅在各自获准时安装本卡核定版本；有 peer 冲突或需调整选型时再请求决策。

## R02 — 固定 wire v1 与跨语言 fixtures

**前置：** R00 完成，R01 版本记录已审查。

**先读：** CONTRACTS 第 2 节；TS protocol 全部 validators/canonicalizers/reducer；Relay 认证、routeCommand、snapshot/event/cache/close；extension 历史返回 shapes。

**允许改：** `protocol/v1/`、`protocol/fixtures/v1/`、`src/protocol/fixtures.test.ts`、package `package.json` 中新增 `refactor:contracts:test`。不改现有 wire 行为。

**步骤：**

1. 建 `README.md`：精确消息字段、命令/事件种类、必填/可选/null、角色方向、错误 code 和状态转换。
2. 建 `limits.json`：逐项列出 wire/extension/relay/browser 各自限额、单位和源码符号；不能把字符上限当 byte。
3. 建 `compatibility.md`：legacy 缺字段、重复 key、UTF-16 surrogate、Number 边界、未知字段等现有行为；无法统一的事项先记录。
4. 按 CONTRACTS 的格式提取 codec、reducer、route/cache 轨迹；记录 TS 基线结果与来源，不生成真实聊天内容。
5. 测试 runner 读取 fixtures，assert 内容而不是只统计用例数。

**必须测试：** 10 类 wire、8 类 command、11 类 event；错误/非法类型；hostId 缺省；null/0/false；中文/emoji；raw UTF-8；seq；result fit；原型/cycle/getter 保留 TS 专用回归。

**通过：** 原有测试 + fixtures runner 均通过；每一项安全边界有 fixture 或明确现有测试位置；golden 未引用运行中的 Pi 数据。

**内置检查：** 核对基线来源、fixtures 与已知差异并记录结论后才能 R03。禁止让 Go 实现反过来决定 golden；未决语义差异仍需用户决策。

## R03 — Go module、配置与纯协议层

**前置：** R01/R02 已审查；Go 工具链可用，依赖安装在授权范围。

**允许改：** `relay/go.mod`、`go.sum`、`relay/internal/{config,protocol}/`、`relay/cmd/pi-cafe-relay/main.go` 最小入口。不得改 TS 行为或启用服务自启动。

**分步：**

- **R03.1** 建 module，固定 Go/Gin/Gorilla 版本，构造无网络副作用的配置解析器；测试 empty/missing/raw bounds、loopback、tokens、origins、port。
- **R03.2** 实现精确 field/presence/type 解析与 known-field canonicalization。先限 raw bytes/UTF-8，再 parse；不直接把默认宽容的 struct unmarshal 当完整验证。
- **R03.3** 实现 EncodeWire/ApplyEvent/FitCommandResult，接同一 fixtures；fixtures 差异必须逐个解决。

**必须测试：** escaping 后超帧、JS UTF-16 长度差异、非法 surrogate 行为、巨大数字、null/false/0、字段大小写、duplicate key、result data 深宽/node/string、unknown fields。

**通过：** `go test ./internal/config ./internal/protocol`、`go vet ./...` 和 TS fixtures 通过；codec 不依赖 Node 子进程、Gin 或 Pi。

**停止条件：** 标准 Go JSON 解码不等价时不能静默替换字符/截数字；优先按既定 v1 实现兼容；无法等价时提交差异等待用户决策，不擅改 v1。

## R04 — Gin HTTP 安全边界与资产服务抽象

**前置：** R03 完成；读 Go 方案第 4 节、CONTRACTS 第 1/3 节。

**允许改：** `relay/internal/{httpserver,auth,webui}/` 的 HTTP/Origin/asset abstraction 与测试；main 仅必要装配。不加生产 embed，不加通用磁盘目录。

**步骤：**

1. 使用 gin.New 配置精确 routes、NoRoute/NoMethod、安全头、关闭 redirect/trusted proxies。
2. 实现 GET/HEAD health/config 及 exact asset allowlist；无生产 Web 时返回清楚的未构建状态，不伪装完整首页。
3. 使用注入 fs 做资源测试；每项 4 MiB、总量/条目上限及 source map/内部清单拒绝。
4. 统一 HTTP admission/header/body/time 上限；Origin/Host 校验与代理 policy 分离。

**必须测试：** GET/HEAD/POST/404/405；`/ws/` 无重定向；路径编码/穿越/大小写；伪造 forwarded headers；恶意 Origin；安全头覆盖错误响应；超 header/body/资源。

**通过：** `go test ./internal/httpserver ./internal/auth ./internal/webui`、go vet；生产路径没有 gin.Static 或 wildcard SPA fallback。

## R05 — WebSocket transport 与有界读写

**前置：** R04 完成；读 Go 方案第 5/8/9 节。

**允许改：** `relay/internal/transport/`、HTTP upgrade 的最小接入与测试。

**步骤：**

1. 建单 read pump、单 write pump、不可变 outbound queue，按 count + bytes admission。
2. 完整消息限制、fragment 累计、严格 UTF-8、binary 拒绝、关闭压缩；解析前拦截超限。
3. hello 超时、心跳、写 deadline、close once、context cancellation。
4. 写/读失败、过载都释放配额；close/control 不被 data queue 饿死。

**必须测试：** N/N+1 bytes、多个 fragments 合计超限、binary、bad UTF-8、slow writer、队列满、ping/close 并发、重复 close、peer 消失、goroutine 清理。

**通过：** transport tests + 支持平台 race；未能运行 race 明确记录，不得在 R08 审查前视为已验证。

## R06 — room/host 状态与投影

**前置：** R05 完成；R02 host/snapshot/event traces。

**允许改：** `relay/internal/hub/` 的 registry/room/host/projection/expiry；必要 protocol 纯函数修正必须保持基线不变。

**分步：**

- **R06.1** registry/global admission + 每 room 单写；host/client 认证后加入；welcome/host_status/snapshot 输出次序。
- **R06.2** readiness、snapshot timeout、seq、replacement、session/cwd 变化、旧 generation 隔离。
- **R06.3** offline state TTL、room 淘汰、全局字节配额、关闭清理。

**必须测试：** 两 room 两 host、同 sessionId 不串台、替换 host 先 not-ready、旧 socket close 不关新 host、旧 snapshot 倒退、重复/跳号 event、未 snapshot host 的 event、offline expiry 与活跃读刷新行为。

**通过：** 同一 traces 的 TS/Go 输出等价；没有 room loop 阻塞网络写，没有无界 map/timer。

## R07 — 命令、pending、去重和离线历史

**前置：** R06 完成。

**允许改：** `relay/internal/hub/` 的 command/pending/result/history 模块及测试。

**分步：**

- **R07.1** 目标选择/歧义拒绝/fence/readiness，route 前后二次 envelope bytes 验证，登记 pending 后转发。
- **R07.2** result 关联、timeout/replacement/close 竞态、REQUEST_PENDING、bounded dedupe；复用既有 key/重连语义，不另造 exactly-once 协议。
- **R07.3** history list/get 类型、期望 session、projection revision、cache bytes/count/TTL、离线命中和未命中。

**必须测试：** target 缺失多 host、stale stream/session/cwd、同 peer/request 跨 host、重复请求不重复路由、结果到旧连接、late result 不覆盖新 context；错误 data kind、不匹配 session、write result 伪装 history；RESULT_TOO_LARGE 与 COMMAND_TOO_LARGE；timeout 不冒充“绝未执行”。

**通过：** TS/Go 路由与缓存 traces 通过；没有 Relay 读电脑/session 文件或 provider key。

## R08 — Go v1 全链路基线与生命周期

**前置：** R03–R07 完成。

**允许改：** main 的装配、Go/TS 集成测试、`scripts/refactor/` 的受控测试 helper；必要 Go 模块修复仍遵守各层边界。不改现有启动命令默认目标。

**步骤：**

1. 用 httptest/独立 listener 装配真实 Go HTTP+WS+hub；TS synthetic host/client 跑已有 traces，不只 mock hub。
2. 旧 Web 兼容测试可由测试 harness 注入校验过的旧 assets；不是给生产添加外部 webRoot。尚未 embed 的 CLI 不作为成品。
3. 测 shutdown、listen 失败、inbox 饱和时 close 可达、host 替换/timeout/result 同时发生、global quota 回收。
4. 执行 go test/vet/race；至少 protocol decoder fuzz seed + bounded fuzz。记录 OS 和工具链。
5. 对照 R02 每项原 Node 行为给出通过/差异表，新增限额引起的过载差异单列。

**通过：** Go v1 等价集成通过，race 无报告，所有资源清理有断言；禁止只用一次健康请求证明迁移正确。

**内置检查：** 逐项核对协议、并发和资源边界的测试/race/差异表后才能进入新 Web；可辅以独立只读检查，不需用户逐项确认。空输出的 subagent 不算通过。

## R09 — 隔离 Web 工程骨架

**前置：** R08 已审查，R01 Web 版本已确认。

**允许改：** package `package.json`、repo `package-lock.json`（仅该 workspace 必需变化）；`web/{index.html,vite.config.ts,tsconfig.json,vitest.config.ts,static}/`、`web/src/{main.tsx,app,styles,i18n,test}/`。不改旧 `web/public`。

**步骤：**

1. 安装准确核准版本；校验 peer/engines，不引入第二 lockfile。
2. 建 JSX/SCSS Modules/modern-normalize/i18n/HashRouter 空壳，独立 Vite publicDir/outDir。
3. 建 refactor:web:check/test/build scripts；测试包含 web/src，使用 jsdom。
4. 加最小 render/i18n/SCSS smoke test，不接真实 Relay。

**通过：** 新 Web 三命令 + 原 TS checks/tests；`.refactor/web` 有 hashed JS/CSS，当前 dist 与旧 app 未变化；bundle 不含 Node fs/Pi SDK/服务端 ws。

## R10 — RelayClient、storage、HTTP

**前置：** R09 完成；读 CONTRACTS 第 4 节。

**允许改：** `web/src/services/relay/{RelayClient,storage}.ts`、`web/src/services/http/`、fake transport/clock 及其测试；不在 Chat 组件内写 socket。

**步骤：**

1. 实现显式 start/stop/resync 和连接 generation、hello/welcome、ready 不混为 open。
2. 严格 frame validation/canonicalization、重连退避、限频 notices、auth failure 停重试。
3. storage 兼容旧 key 与内存 fallback；axios 同源固定 endpoints 与 timeout。
4. 清理时撤销所有 timer/listener，迟到回调无效。

**必须测试：** start 两次只有一 socket；stop/start 旧 welcome/close 无效；StrictMode cleanup；room 切换；malformed/binary/超帧；storage SecurityError/quota；token 不在 URL/日志/header；HTTP 取消。

**通过：** fake transport 确定性 tests；没有组件直连或 module import 自动连接。

## R11 — CollabStore 与 CommandGateway

**前置：** R10 完成。

**允许改：** `web/src/state/`、`web/src/services/relay/CommandGateway.ts`、RelayClient 必要的受限 send 接口与测试。

**分步：**

- **R11.1** Immer store/per-host refs/selectors/useSyncExternalStore；authoritative snapshot、seq、resync、offline stale 状态；不存 socket/Promise。
- **R11.2** Gateway scope/fence/pending validators/timeout/view generation；注册 waiter 后 send；只读重试一次与结果未知语义。
- **R11.3** 清理/logout/context switch、缓存数量/bytes、abort 预留但不绕过 Relay gate。

**必须测试：** host A delta 不改 B 引用；事件不被 debounce 丢弃；同 host 文件 A 慢于 B 不覆盖；history get 结果不满足 list；切 host 后 old promise 不更新视图；offline cached history 可读但文件/写命令拒绝；dispatched 不清 running；未知写结果不重放。

**通过：** state/gateway tests + 类型检查；components 不自行 JSON.parse 协议或拼 command。

**内置检查：** 核对隔离、结果绑定、无丢失通知和 StrictMode 生命周期，记录测试依据；通过后在授权范围内继续。

## R12 — 审核并冻结 parts 契约（不启用 producer）

**前置：** R08/R11 已审查。

**先读：** CONTRACTS 第 6/7 节；extension 的 messageProjection/historicalMessages/transcriptMessageJson/onMessageStart/Update/End/onTool*；已安装 Pi 的扩展/事件/session 文档、types 与示例，不能用猜测字段。

**允许改：** `protocol/v1` 新增 parts 说明、`protocol/fixtures/parts/`、`docs/refactor/PARTS_REVIEW.md`、PROGRESS。尚不改 runtime 生产逻辑。

**步骤：**

1. 以 CONTRACTS 默认字段为起点，用已安装 Pi 类型和最小脱敏事件样例确认 contentIndex、工具参数和 message_end/执行次序。
2. 固定空/缺字段、index 空洞、部分 delta、legacy、裁剪、错误/空最终输出、重复 callId 的处理。
3. 定义稳定 message/call 关联和 snapshot 重建规则，列出所有要改的 canonicalizer/reducer/JSON converter 路径。
4. 写第 6.4 节及异常情形 fixtures 预期；如默认方案不可行提交最小差异，不自行换成时间排序。

**通过：** fixtures/字段/事件映射/各层更新清单可审阅，旧 v1 fixtures 未变化；没有加入新 command 或 second AgentSession。

**内置检查：** 根据已安装类型、文档和脱敏事件证据核定映射后才进入 R13，不必等待人工 review。尚未证明的 Pi API 行为或需要更改默认契约时仍须暂停，不能猜测放行。

## R13 — 实现 parts 的完整投影链

**前置：** R12 已审查。

**允许改：** TS/Go protocol 及测试；`src/extension/index.ts` 中投影/事件/历史转换及其 tests；Node `src/relay/server.ts` 的兼容 compaction；Go hub projection；Web state compaction。不得削弱 file/session/command 安全校验。

**分步，每步验证后才能继续：**

- **R13.1** TS/Go validators/canonicalizers/reducers 接纳可选字段，旧 fixtures 全绿，parts fixtures 双端全绿；尚无新 producer。
- **R13.2** 更新 extension/Node/Go/browser compaction、history JSON converter 和完整 envelope budgets；证明中间层不会遗漏字段或放大帧。
- **R13.3** extension 从真实 message content 生成 parts，建立有界 parent 索引，delta 带合法 index，toolIsError/空 final 诚实投影；历史与 snapshot 走相同规则。
- **R13.4** producer/reconnect/historical 链路回归，包括有异常 getter/proxy 的 callback 故障恢复。

**必须测试：** 正常 ordered parts；两个同名 call；tool_finished 早于 result；空最终输出；error 不转成功；500/501 index/parts；图片/未知部分省略；超 ID 不碰撞关联；裁剪后不重编号；old relay 丢 fields；fresh snapshot 重建；custom sessionDir/64MiB/opened cwd 与 ID 验证未退化。

**通过：** TS/Go/Web 所有相关 tests；超预算仍明确截断/拒绝，无 placeholder 假文本，无真实工具在浏览器执行。

**内置检查：** 必须核对所有中间路径并记录回归证据，不只看 UI。这里失败不靠增大 MAX_FRAME_BYTES 解决；修复复验后可连续推进。

## R14 — assistant-ui 转换器和对话组件

**前置：** R13 已审查；CONTRACTS 第 5/6/7 节。

**允许改：** `web/src/features/chat/{runtime,model,components}/` 中 converter/Thread/Message/ToolPart/Reasoning/Markdown 及同位 tests/SCSS；不在此卡写文件历史业务。

**步骤：**

1. 先写纯 converter 和 ordered/legacy/error/empty fixtures tests。
2. 使用实际版本的 ExternalStoreRuntime/Provider/primitives；禁止自动合并相邻 assistant、重复 optimistic transcript 或 tool executor。
3. 构造只读 ToolPart，稳定折叠 key、原位更新；failure 与 run 状态按真实 projection。
4. Markdown 安全 renderer、链接/图片策略，在严格生产 CSP 下验证设计，不复制不兼容模板。

**必须测试：** 第 6.4 固定顺序各一工具；legacy 缺父提示仍在 transcript；新 delta 不重挂整段 DOM；用户折叠保持；空输出保留；没有独立 tools panel、edit/reload/branch/upload/approval 控件。

**通过：** converter/unit/component tests + Web check/build；必须真的使用 assistant-ui，不以名称相似的自写聊天框冒充集成。

## R15 — Composer、导航、文件/历史、响应式与 i18n

**前置：** R14 完成。

**允许改：** `web/src/{app,layouts,pages,components/ui,i18n}/`、`features/{auth,hosts,files,history,connection}/`、chat Composer 及相关 styles/tests。用户后续明确选择Radix UI Primitives时，允许在本package manifest和根lock的该workspace记录中将既有Dialog/Tooltip/Label版本声明为直接依赖；不升级或改动其他workspace依赖图，详见PROGRESS §41。§43用户后续明确授权改用shadcn/ui + Tailwind及安装skill：允许新增components.json、Web Tailwind/Vite/TS别名配置、官方Base组件源码、对应精确package/lock依赖、项目skill及skill-lock；R16构建只扩展合法CSS选择器解析与许可收集，不放宽CSP/引用/容量限制。不含试用部署或R19。

**分步：**

- **R15.1** 单一 Composer：use-immer 草稿、delivery/Enter/IME/send/abort；所有操作进 Gateway；phase 与 sending 分离。
- **R15.2** login/host selection/HashRouter/history read-only；inventory 未完成不能误路由，历史 session 不变成活动 session。
- **R15.3** 文件目录/预览、历史 list/get，bounded data validators + view generation；不写 HTTP files/session endpoint。
- **R15.4** 三档布局、抽屉/focus/滚动、zh-CN/en、错误/连接状态；所有敏感值纯文本且不进 URL。

**必须测试：** 未认证/未ready/多host/等待本地UI/离线缓存；IME；切 scope 清草稿；慢响应不串台；只读历史无发送；回车一条 prompt；工具 delta 保留折叠/阅读位置；1440/1024/390 宽无横向溢出。

**通过：** 完整组件测试与 Web build；页面通过 fake transport 工作，不依赖 provider 密钥或改用户 Pi 配置。

## R16 — 资产 embed、构建编排与发行 staging

**前置：** R15 完成。

**允许改：** `scripts/refactor/` 构建/验证/打包脚本、Go webui/main 的 embed 装配、迁移 TS 编译配置、package 新增 refactor scripts、package `.gitignore`。当前标准 build/prepack/relay 默认入口仍不切换。

**分步：**

- **R16.1** 校验 `.refactor/web` 每个 canonical 普通文件、allowed extensions、总量、所有入口/chunk 引用；复制进被忽略的 embed assets。生成精确清单，只允许这批 URL。
- **R16.2** 按 CONTRACTS 的 webembed tag/stub 划分构建本平台 Go binary 与 TS staging；普通 Go 单测不依赖未生成 assets，生产构建必须包含 tag。记录版本/Web digest/平台/checksum。空或陈旧 staging 必须失败，不能沿用上次 assets。
- **R16.3** 建完整矩阵收集与 release staging；只声明实测平台。打包 helper 在 `.refactor/release/` 构造独立 package；不得通过当前 prepack 清空生产 dist。
- **R16.4** 验证 candidate package 的标准 scripts/依赖/自包含结构；按照 CONTRACTS 第 8 节建立受审源码 overlay，最终脚本内容先在 staging 验证，R17 补齐启动接线后重新构建，R19 再接生产默认。

**必须测试：** missing assets、额外 .map/.env、symlink/junction、4MiB/总16MiB超限、不可下载清单、hashed chunk引用；HEAD/MIME/CSP/no-store；错平台/缺binary拒绝；read-only成品运行；Node/Go只在source build必需。

**通过：** 无 assets 时普通 Go 单测仍可跑，带 webembed 的生产构建缺 assets 会失败；刚构建 binary 内嵌刚构建 Web，带 tag 的 tests 通过；staging pack 检查无 credential/runtime/helper，独立安装无需 Go 编译；当前 dist/服务不变。

**注意：** `npm pack --dry-run` 也会触发 prepack。仅在已确认隔离的 candidate 目录按 helper 运行；`--ignore-scripts` 只用于**已显式成功构建**的 candidate，不能借此省略构建。

## R17 — Go 本地自动启动与 PowerShell 所有权

**前置：** R16 完成。

**允许改：** 新 `src/extension/local-relay-go.ts` 及 tests、`scripts/refactor/` 的 Go 启停 helpers/验证脚本；现有 local-relay/PowerShell 中仅可抽取不改变默认行为的共用函数。不得此时停止现有 Node relay 或改默认启动 backend。

**步骤：**

1. 固定 OS/arch 映射与可信 binary 路径；缺 binary/平台不支持/只读目录给安全提示。
2. 复用 URL allowlist/health/锁/环境允许列表，direct spawn；并发失败子进程只回收本轮 owner。
3. Go executable path + creation time + instance marker 双重核对；保留旧 Node marker 的严格识别，不转换未知 PID。
4. 在 candidate-overrides 中记录新 launcher/脚本默认接线，重新编译隔离 candidate，并验证最终脚本参数/env/exit code；源树现有默认仍不切换。目标脚本移除“Pi 启动时缺产物就隐式 build”的行为，提示用户显式构建；不要引入下载 fallback。

**必须测试：** remote wss、credential/query/fragment/wrong-path/port0 不启动本机；token原始上限；同时两个启动器；只读 marker/lock；PID复用/错路径/取不到权限拒绝stop；Windows PowerShell5.1 parse；任意PiArgs与环境恢复。

**通过：** native Windows helper tests + TS tests，且服务归属检查真正执行；没有误停旧进程。其他 OS 未实测如实标注。

**内置检查：** 进程终止的所有权验证和只读降级必须有测试与 diff 核对记录，可辅以独立检查；未通过不得 R18 真实启动 candidate。不需要例行人工 review，但不免除 R18 专项授权。

## R18 — 候选产物全链路验收

**前置：** R16/R17 已完成内置检查；R18.1 可在普通范围授权内执行。涉及真实 Pi/Chrome 进程、模型额度或 candidate 安装的步骤须有用户明确专项授权（可预先授予），否则停在对应步骤，不阻止已获准的确定性验收。

**允许改：** 集成 tests/`scripts/refactor/` helpers、package `package.json` 中新增 `refactor:integration:test`、PROGRESS/验收记录；发现业务缺陷退回对应任务修复，不在本卡混写大功能。

**分步：**

- **R18.1 确定性端到端**：fresh Go binary + embedded Web + isolated synthetic hosts；测试 multiple hosts、seq、parts、command、reconnect、offline、慢客户端、超帧。
- **R18.2 真实原生 Pi**：新建明确归属的 native Pi，加载 candidate extension，显式测试 room/项目/端口。验证真实 text/thinking/tools、prompt/steer/followUp/abort、model/thinking设置、host readiness与session/context变化；不改全局provider配置。
- **R18.3 历史与文件**：在专用测试项目/session目录生成无秘密数据；custom sessionDir、合法大历史、opened ID/cwd、敏感路径与symlink拒绝。不对真实用户JSONL做破坏测试。
- **R18.4 包与平台**：candidate tarball安装、独立relay无Node/Go runtime、源码构建工具链、检查licenses与产物秘密；平台结果逐一记录。

**浏览器方式：** Chrome SxS独立profile/37983/9333；使用page target，waiter先登记；DOM断言，不抓取终端内容。finally只清理本次重新核对owner的进程/profile。

**通过：** 真实Pi与模拟host证据分别列出，测试产物digest/构建版本一致；所有必须项pass，无skipped被当pass；若缺模型能力或平台条件明确blocked/未支持。

**内置检查：** 核对真实执行证据、包、安全和清理后才能建议 R19。检查通过不等于切换授权；执行者不能凭“页面能打开”批准切换。

## R19 — 显式切换与旧实现移除

**前置：** R18审查通过；用户明确授权切换。此前没有任何“自动进入R19”。

**允许改：** package及必要root聚合scripts、extension默认launcher、生产PowerShell启动路径、旧Node Relay/DOM的受控移除、最终publicDir与文档；只改本迁移范围。

**分两个授权检查点：** R19.1 权限可以提前授予，但仍须 R18 验收通过。R19.2 必须在 R19.1 接线及新版本验证后取得用户可用性确认和清理同意；提前授予的清理权限不能替代这项事后确认。

- **R19.1 接线，不抢占进程**：将已经在candidate验证的build/check/test/prepack/launcher接为默认。保留所有npm/CLI/env/storage入口；移除旧实现前完成回归映射。用户决定何时停止自己的旧实例；不能发现37891占用就kill。
- **R19.2 用户确认新版本可用后收尾**：删除旧Node Relay与旧app/index/styles，整理web/static回最终web/public并重跑构建；旧Node测试的安全语义必须已有Go/fixtures承接，不能直接删除测试掩盖失败。

**回退规则：** 保留已验证旧源码版本和旧成品；用户选择回退时只停本次拥有的新实例，恢复兼容产物，不回放未知命令，不合并新旧内存缓存，不reset覆盖用户工作区。提交/推送仍需用户授权。

**通过：** 最终聚合check/test/build覆盖TS/Web/Go/contract；fresh产物验收、pack检查；生产文档不再把Node描述为目标Relay；PROGRESS全部有证据，未测试平台不宣称支持。

**结束：** 输出最终变更、验证、已知限制和回退点。没有GitHub凭据则明确未push，不重试无休止地等待认证。
