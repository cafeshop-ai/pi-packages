# 重构实现约定

> 配套 [执行入口](../REFACTOR_EXECUTION.md) 与 [任务卡](./TASKS.md)。以下新接口、目录和字段是实施目标，不是当前已经存在的代码。
>
> v1 现有行为以 R02 固定的源码基线和 fixtures 为准；新增内容投影以第 6 节为默认方案，在 R12 完成证据核对后才允许实现。普通 review 按执行入口作为内置检查，不要求逐项人工审批；未决协议/安全变更仍须用户决策。执行者不得根据第三方 demo 另造 wire protocol。

## 1. 目录、依赖与构建位置

所有路径相对 `packages/pi-cafe-space/`，明确标注 repo 的例外除外。

| 用途 | 固定位置 |
| --- | --- |
| 语言无关 v1 说明 / limits / compatibility | `protocol/v1/README.md`、`limits.json`、`compatibility.md` |
| 共享 fixtures | `protocol/fixtures/v1/`、增强后再加 `protocol/fixtures/parts/` |
| TS fixtures runner | `src/protocol/fixtures.test.ts` |
| Go module | `relay/go.mod`、`relay/go.sum` |
| Go module path | `github.com/cafecodework/pi-packages/packages/pi-cafe-space/relay` |
| 新 Web 入口 / 配置 | `web/index.html`、`web/vite.config.ts`、`web/tsconfig.json`、`web/vitest.config.ts` |
| 迁移期 Vite publicDir | `web/static/`，只复制 icon 与 Web manifest，不复制旧 app/index/styles |
| 新 Web 源码 | `web/src/` |
| 迁移期 Web 产物 | `.refactor/web/` |
| 迁移期 TS 编译产物 | `.refactor/ts/`，使用单独的迁移 tsconfig，不改当前 dist 输出 |
| 迁移期 Go binary | `.refactor/bin/<goos>-<goarch>/pi-cafe-relay[.exe]` |
| Go embed 暂存 | `relay/internal/webui/assets/`，只放构建器校验并复制的文件，加入 ignore |
| 构建资产清单 | 与 embed 同批生成的内部数据，不提供 HTTP 下载 |
| 临时报告 | `.refactor/reports/Rxx/`，不提交 |
| 最终 Pi 安装入口 | 仍为 `dist/extension/index.js` |
| 最终 Go binary | `dist/relay/bin/<goos>-<goarch>/pi-cafe-relay[.exe]` |

补充：

- Web `publicDir` 在 R19 才能整理回总体方案的 `web/public`；前面的任务不得删除或改写旧 Web 文件。
- Vite `root=web`，`outDir` 固定到 package 的 `.refactor/web`，`emptyOutDir` 只作用于这个目录。配置用配置文件自身路径解析，不依赖调用方 cwd。
- TypeScript Web 使用 bundler/JSX/DOM 配置，不能继承出 Node-only 类型；引用共享 protocol 不导入 extension/relay barrel。根 typecheck 目前不会检查 `web/src`，所以必须有单独 Web check。
- 根 workspace 仍只有一份 `package-lock.json`，不建 `web/package.json` 或第二份 JS lockfile。
- R01 只记录精确版本与证据；R03 才创建 Go module，R09 才安装核准的 Web 依赖。保持 Node 最低 `22.19.0`，不使用 force/legacy-peer-deps。
- DOM 测试环境选 `jsdom`；原 Vitest 3.2.4 经 R09 audit 后用户明确批准该 package 升级为 4.1.11，使用隔离 Node 22.23.2。其他 workspace 的 Vitest 不升级；变更证据见 PROGRESS 第19节。
- 无需 assistant-ui CLI scaffold；消息继续使用assistant-ui既有primitives/runtime。§43用户授权仅在共享UI层接入shadcn/Base与Tailwind，不引入AI SDK或`/api/chat`。
- R16 前 HTTP 服务允许明确报告 Web 尚未构建；不能为了演示偷偷从任意磁盘目录服务资源。
- R16 的 embed 用 `webembed` build tag：`embedded.go` 仅在此 tag 下编译，嵌入 `assets/`；`embedded_stub.go` 用 `!webembed`，只返回明确的 Web 未构建状态。普通 `go test ./...` 用注入的测试 fs，不依赖 Git 中不存在的 assets。
- 生产 binary 必须通过校验脚本以 `go build -tags webembed` 构建；缺 assets 则构建失败。集成验收还运行带此 tag 的 tests。不能把无 tag 的调试 binary 当发行产物。

## 2. fixtures 格式与基线规则

### 2.1 每个用例必须记录输入与预期

普通 codec case 存成 UTF-8 JSON：

```json
{
  "id": "command-abort-legacy",
  "operation": "decode",
  "inputText": "{\"type\":\"command\",\"requestId\":\"r1\",\"expectedStreamId\":\"s1\",\"payload\":{\"name\":\"abort\"}}",
  "expected": {
    "accepted": true,
    "value": {
      "type": "command",
      "requestId": "r1",
      "expectedStreamId": "s1",
      "payload": { "name": "abort" }
    }
  }
}
```

这是合法 legacy command 的 codec 样例，不表示新 Web 可以省略目标/context fence，也不表示 Relay 一定会路由它。

- `decode` 比较 accepted/rejected、canonical 值及错误 code；对象键顺序不作为差异，数组顺序必须一致。
- 原始非法 UTF-8 用 `inputBase64`，和 `inputText` 二选一；不能先解码成 replacement character 再测。
- reducer case 用 `operation: "applyEvent"`，带 `snapshot`、`envelope` 及预期 snapshot/失败。
- command/result 预算用单独 fit/encode cases；**按真正发出的 UTF-8 envelope**检查，不只检查 canonical JSON 文本长度。
- 状态机轨迹放 `traces/`，记录 peer、连接代次、输入、预期接收者与输出顺序、clock 推进及关闭。Go 用受控 ID source；旧 Node 不提供注入点时，runner 将第一次收到的随机 ID 绑定为 fixture 符号，以后所有引用必须匹配同一绑定。不能删掉全部 ID 后比较，也不为方便生成 golden 修改旧 Node 业务逻辑。
- 过大输入可以用有界 generator，在用例中记录生成参数和期望 bytes；禁止把几十 MiB 的 JSON 塞进一个单测描述。
- getter/proxy/cycle 属于 JS 对象测试，保留在 TS 单测，不假称这些对象能经过 JSON 原样传到 Go。

### 2.2 基线不可自动更新

R02 用**修改业务逻辑前**的现有 TS 实现记录行为与对应测试，再对照源码/测试核对 golden 并记录检查结论。Go runner 不得根据自己输出重写 expected。

遇到 TS 与 Go 不一致：给出最小输入、TS 输出、Go 输出与涉及字段。若是旧行为的安全缺陷，单独批准协同修正；不能一边修 bug 一边声称完全等价迁移。

必须含：合法/非法的 10 类 wire message、8 类 command、11 类 event、未知字段、legacy 可选字段、null/缺省、大小写、emoji、duplicate key、escaped surrogate、巨大数字和边界预算。

现有名称不得换拼法：`followUp`、`waiting_local_ui`、`tool_updated`、`host_command_result`、`dispatched`。

## 3. Go 服务接口与状态所有权

这些是项目接口约定，不是声称 Gin/Gorilla 自带同名方法。

| 模块 | 对外职责 | 测试 seam |
| --- | --- | --- |
| config | 从显式输入解析配置；返回值或错误，无 listener 副作用 | map/lookup env，不在测试改整个进程环境 |
| protocol | `DecodeWire`、`EncodeWire`、`ApplyEvent`、`FitCommandResult` | fixtures、确定性纯函数 |
| transport | 连接 read/write pump、限定大小、deadline、close | 有界 frame reader/writer、注入 clock |
| hub | `Join`、`Handle`、`Leave`、`Close`，由 room loop 串行修改状态 | fake sender、clock、ID source |
| httpserver | 创建 handler 与 server，显式 Start/Close | `httptest`、允许测试用 loopback port 0 |
| webui | 从校验后的 fs + exact allowlist 按 URL 提供只读资源 | 小型 `fstest.MapFS`，无需完整 React build |

`Join`/`Handle` 返回容量/状态错误，不在失败后创建额外 goroutine 重试。跨模块调用不得持有 registry 锁做网络 I/O 或等待 room 回调/响应，以免形成锁与 actor 相互等待。输出按不可变编码数据排队，不把仍在被 room loop 修改的 map/slice 传给 writer。

### 3.1 必须画出来并测试的状态

- 连接：accepted → unauthenticated → authenticated-host/client → closing → closed。
- host：online-not-ready / online-ready / offline-cached / expired。
- pending：created → forwarded → completed；或 timeout/replaced/disconnected；清理只能发生一次。
- 旧连接的 result/close/timer 必须匹配内部 generation；仅 hostId 相同不够。
- sequence 验证保留原行为：同 context 重复/倒退 event 也不能静默按新事件应用；异常先清 readiness，断开并等待权威 snapshot。不同 context 和旧 snapshot 的细分错误由基线 fixtures 固定。
- snapshot 不得回退同 stream/session 的 seq；向 browser 发布 ready 的顺序要与现有状态机等价。

### 3.2 新增资源上限的固定初值

旧上限从 R02 的 `limits.json` 加载/对照，不能只抄总体方案的部分表格。下面是**额外的计划值**，不是现有 Node 常量；需要在 R08 压测/review 后确认：

| 对象 | 初值 / 行为 |
| --- | --- |
| 每连接 application send queue | 最多 128 项，且总 bytes ≤ 1 MiB；含 hello/result/snapshot/event |
| 每 room data inbox | 最多 128 项，且 bytes ≤ 1 MiB；入队前计算 |
| close/control | 与 data inbox 分离；可合并唤醒，不被 data 满队列阻塞；待处理状态按已 admission 连接数有界 |
| 纯结果/历史缓存聚合预算 | 64 MiB，全服务合计，不是每 room |
| 动态投影/缓存/application queue 聚合预算 | 128 MiB；上述缓存是其子集，不重复分配另一份 64 MiB |
| Web 资产数量 / 合计 | 256 项 / 16 MiB；单项仍 ≤ 4 MiB |
| 写 deadline / close grace | 5 秒 / 1 秒；全服务 shutdown 最多等 10 秒后强制关闭本服务连接 |

聚合预算按拥有的数据计算，共享 buffer 可以保守重复计费，不能漏计。替换/逐出/失败/关闭必须释放相应配额。它不是 Go heap/RSS 的硬上限；socket buffer、解析中的单帧和 Go runtime 还受连接/帧/OS 限制。

过载行为固定为：先回收已过期和可淘汰缓存；仍不足则拒绝新 admission 或关闭导致溢出的连接（过载 close 1013）。不丢一条 event 后继续发送后面的 seq，不伪造 command 成功，不驱逐正在执行的 pending 假装未发送。

HTTP 默认不信任代理、不记录 query/body/token、无通配静态路由。Ws 原始完整消息 ≤ 256 KiB，关闭压缩；不因 Gorilla 自动拼接而取消自己的完整消息上限与严格 UTF-8 检查。

## 4. Web 客户端接口

目标文件固定为：

```text
web/src/services/relay/RelayClient.ts
web/src/services/relay/CommandGateway.ts
web/src/services/relay/storage.ts
web/src/services/http/client.ts
web/src/state/CollabStore.ts
web/src/state/selectors.ts
web/src/state/useCollabStore.ts
```

### 4.1 Scope 及生命周期

```ts
type HostScope = Readonly<{
  roomId: string;
  hostId: string;
  streamId: string;
  sessionId: string;
  cwd: string;
}>;
```

- scope key 用 `JSON.stringify([roomId, hostId, streamId, sessionId, cwd])`，不能直接用 `:` 拼接造成碰撞。fence 使用收到的 wire 原值，不对 cwd/ID 擅自改大小写、截短或做路径归一化。
- 连接 generation 与视图 generation 是本地独立计数，不写进未定义的 wire 字段。
- RelayClient 提供 `start`、`stop`、`resync`、`subscribe` 和供 Gateway 使用的 `sendCommand`；构造和 import 不开连接，start/stop 幂等。
- callbacks 携带 generation，旧 callback 不能改变新连接的认证/ready/pending 状态。
- 一个 app owner 创建和清理 client；Router 页面不各建 socket。StrictMode 的 mount/cleanup/remount 与 HMR dispose 必须测试。
- 协议处理同步入 store；React 通知可以合并，但最多保留一个待通知标志，不堆积完整 event 队列。
- Map 状态用 Immer 时显式 `enableMapSet()`。getSnapshot 在状态未变时返回同一引用；host A 变化不替换 host B 的 selector 结果引用。

### 4.2 CommandGateway

对组件暴露 `execute(payload, capturedScope, options)`，返回结构化结果；`options` 只包含本地 timeout/AbortSignal/view generation，不接受任意 wire 字段覆盖。

顺序：

1. 验证 payload 与大小，验证 capturedScope 仍是当前允许目标。
2. 验证认证、host context、连接 generation 和 readiness。
3. 创建 requestId，构造完整 fence，把 pending 与结果数据 validator 绑定。
4. **先登记 pending 与结果 waiter，再发送**；发送失败立即结算本请求。
5. result 到达时校验 requestId、host/context/generation 与命令对应 data shape；错误类型的 data 不写入 store。
6. timeout、stop、换 room 和旧上下文撤销都释放 timer/pending，不影响其他 host。撤销本地等待不等于撤销 Pi 操作；不得暗发 abort 或声称已取消已经发出的 command。

约定：

- 默认本地等待上限 20 秒，超过 Relay 的 15 秒 ack timeout；每个 pending 都有明确截止时间。
- 最多 256 pending；普通命令最多占 255，保留一格给 abort；对同一 host 的本 browser 普通 pending 最多 31，连 abort 不超过现有 32 上限。
- pending 保留的编码数据合计最多 8 MiB，普通请求不得使用最后一个 MAX_FRAME_BYTES 的预留空间；入队、失败、完成、取消都记账。不要无界保留已结束 Promise、payload 或响应。
- 浏览器历史结果缓存全页面最多 20 份且不超过 4 MiB，按 scope/请求种类/历史ID/版本隔离和 LRU 清理；不在每个 host 再分配同样一份无限缓存。logout/换 room 清空。
- abort 不等待普通 UI 队列，但不绕过 host/Relay 容量与 fence。界面不承诺 abort 一定立即执行。
- 只读白名单只有 `list_dir`、`read_file`、`list_sessions`、`get_session`。只有 `HOST_NOT_READY` 后拿到新权威 snapshot 且原 view 仍有效时，最多重试一次；再次失败交给用户。
- `list_dir/read_file` 不在离线 host 上执行；`list_sessions/get_session` 可按旧 Relay 的离线缓存规则带原上下文请求，不要求把离线 host 伪装成 ready。
- prompt/abort/set_model/set_thinking 一旦可能已发出，不做自动重放；`HOST_TIMEOUT`、连接断开或 host replaced 后也不能一概宣称“没有执行”。
- `REQUEST_PENDING` 是重复请求的非最终提示：保留本地 pending 和原截止时间，不因它是 dispatched 就结算；不得反复延长 timeout。
- 其他合法最终 `dispatched` 回执表示已交给 Pi：结束本次 command 等待/发送态，不清 Pi isRunning。`applied` 也不能跨命令类型解释成“模型已完成”。

### 4.3 HTTP / storage / 路由

- axios 只调用同源 `/api/config`、`/healthz`，timeout 5 秒；不允许页面传任意 URL，不设置全局 Authorization/token header。
- 原生 WebSocket 使用 hello token，不把凭据放 query、hash、日志、普通 store 或 VITE 配置。
- 保留 `pi-collab-token`、`pi-collab-room`、`pi-collab-peer-id`、`pi-collab-host-id`；sessionStorage 抛错退回内存。
- token 错误停止自动认证重试，回登录页；用户改正后显式重连。普通网络错误仍有界退避重连。
- 路由 opaque ID 编码一次、校验一次；文件路径只在内存/命令 payload，不进 URL。
- 房间书签使用 HashRouter `/#/rooms/:roomId`，历史为 `/#/rooms/:roomId/history/:sessionId`。房间名不是凭据，沿用1–64字符ASCII room校验；URL房间优先于已存房间及服务端默认，首次连接前确定。非法房间路径不回退或连接其他房间；房间切换通过原generation/scope边界撤销pending、清草稿/缓存/旧host选择，不重放命令。保留未带房间的根入口及历史书签兼容；登录后生成带房间路径。token仍只通过原登录/sessionStorage与WS hello传递，不进URL。
- 历史详情页为只读投影；不得让历史 sessionId 替换当前 Pi context 去发 prompt。

## 5. UI 可复核验收

§41–42的Radix UI是上一版部署方案。§43用户明确改用shadcn/ui + Tailwind：官方Base Nova源码在`components/ui/shadcn`，Select用于thinking/delivery，Sheet/Tooltip使用Base UI，原生Input/Textarea/Label保留表单语义；Field/FieldGroup组织表单。Tailwind语义tokens映射既有Café palette，页面SCSS Modules保留。portal继承主题/语言、不落在inert面板内；Sheet保留闭合details的Tab边界保护。使用Base公开的`CSPProvider disableStyleElements`和外部CSS，不放宽CSP。详见[SHADCN_UI](./SHADCN_UI.md)；历史实现见[RADIX_UI](./RADIX_UI.md)。

默认布局不要让执行者重新设计：

- ≥ 1024px：左侧 240px，中央 `minmax(0, 1fr)`，右侧文件栏 300px 可收起。
- 768–1023px：中央对话；实例/历史和文件通过可关闭的侧栏进入，不强塞三个固定栏。
- < 768px：顶部 + 对话 + composer；其余区域抽屉，恢复触发按钮焦点。
- 默认跟随阈值：距底部 ≤ 80px 才自动跟随；用户上滚后新 delta 不夺走位置。
- 工具展开 key：scope + messageId + part index/callId，不能用 render 时 nanoid。缺 owner 的 legacy 工具 key 仍包含 scope + 真实 callId。
- 默认 running/error 展开、complete 折叠；用户明确选择优先于后续 delta/status 默认值。
- 首版不保存多个上下文的发送草稿；scope 切换后清空 composer。草稿不写 localStorage/数据库，防止切 host 误发旧内容。
- composer 最多保留符合协议字段上限的文本，发送还检查实际 envelope bytes；UI disabled 不是唯一校验。
- Enter 发送、Shift+Enter 换行、composition 期间不发送；一次点击只生成一个 command。
- 页内最多 100 条 notice、每条 2,048 字符；展开记录最多当前上下文 500 项，清理已淘汰消息；文件只保留当前目录/预览和有界加载结果，不暗建无限缓存。
- i18n 首版 `zh-CN` 与 `en`；错误码映射，用户原文、模型 ID、工具名不翻译。
- Markdown 禁 raw HTML；首版禁远程图片自动加载，只允许经协议/组件策略确认的安全链接。不要为了渲染代码块加入动态脚本、Mermaid 或 unsafe-inline。

DOM 验收至少在 1440×900、1024×768、390×844：断言 `documentElement.scrollWidth <= clientWidth`；验证可读标签、焦点、抽屉、真实 DOM 顺序，不以截图代替行为断言。

## 6. 有序内容 parts 的默认契约（R12 审核后实施）

### 6.1 固定字段草案

只在既有对象增加可选字段，不增加 v1 必填字段或新的模型/工具执行命令：

```ts
type TranscriptPart =
  | { index: number; type: "text"; text: string }
  | { index: number; type: "thinking"; text: string }
  | { index: number; type: "tool-call"; toolCallId: string; toolName: string; argsText: string };

// TranscriptMessage 的新增可选字段：
// parts?: TranscriptPart[];       // 新版 assistant 投影才提供
// partsTruncated?: boolean;       // 有序投影不完整，不能由 !text 猜测
// toolIsError?: boolean;          // 只给 role === "tool"，来自原生 toolResult.isError

// ToolExecution 的新增可选字段：
// parentMessageId?: string;       // 只能引用实际含该 callId 的 assistant

// 既有 message_delta 的新增可选字段：
// partIndex?: number;             // Pi 原内容数组中的 index，不是裁剪后数组下标
```

字段含义：

- `index` 是原始内容位置，范围 `0..499` 的整数；数组按 index 升序且不能重复。图片/未知内容被省略时允许 index 间有空缺，不能重新编号。
- `parts` 缺省表示 legacy；`parts: []` 表示新版当前没有可投影的部分。不能把空数组当作字段缺失。
- 首版 assistant 使用 parts；user/system 继续旧 text；toolResult 用旧 role/toolCallId/text 加可选 toolIsError，不作为第二次 tool-call。
- `text/thinking` 旧字段继续维护给旧客户端；新 UI 有 parts 时只渲染 parts，不能把 flat text 再渲染一遍。
- 文本/thinking part 初值各不超过 64 Ki UTF-16 code units（对应当前 canonical 文本保留上限），单 tool-call argsText 初值 4,096 UTF-16 code units，toolName/callId 不超过旧 256 上限；都计入完整 envelope bytes，裁剪时可使用旧 snapshot 更小的预算。
- parts 最多 500，但数量通过不代表总 bytes 通过。未知/超出预算的内容要标 incomplete，不添加 `[image]`、`[tool call: ...]` 等假正文。
- 用来关联的 ID 不能靠截短后碰撞合并；原始 ID 超出可表达上限时省略不可靠关联并标 incomplete。

### 6.2 增量与结果规则

- 新 assistant `message_started` 建立空 parts 与空 flat text/thinking；后续原生 text/thinking delta 带真实 content index，reducer 同时更新对应 part 和旧 flat 字段一次。
- 不存在该 index 时创建与 channel 对应的 text/thinking part；已存在而类型冲突是协议/投影错误，不把工具 part 覆盖成文本。
- indexed delta 到达 legacy message 时，不允许凭一段新 delta 伪造之前全部内容的结构。保留 flat 增量并标 partsTruncated，等待 authoritative message/snapshot；具体可恢复分支在 R12 fixtures 固定。
- tool-call 参数不另造 token 级 delta 协议。extension 在原生 assistant message_end 时提供完整有序 parts；原生工具执行开始前应已有含真实 callId 的 assistant 投影。若已安装 Pi 不满足这个次序，R12 停止并提交证据，不猜 parent。
- message_finished 以相同消息 ID 替换该消息的权威内容，保留原生 complete/error 状态；它也能修复先前未能完整投影的 parts，但 snapshot 的历史截断标记仍按现有语义保留。
- tool_started/updated/finished 继续更新 ToolExecution；输出使用既有 replacement 语义，`tool_updated.output` 不是可累加 delta。
- `parentMessageId` 通过相同 scope 内的 callId → 实际 message parts 反向索引获得；歧义时不写 parent。索引有界，session/stream/cwd 改变和 snapshot 重建时重建。
- 正式 toolResult 存在时，其 text 是最终输出，`""` 也覆盖旧 partial。没有 result 时才使用 ToolExecution.output。
- 可靠执行终态为 error 或 toolIsError 为 true 时显示失败；旧 role=tool 的 status=complete 不能反转该失败。两个显式终态矛盾时显示错误/状态冲突，不悄悄选成功。
- tool_finished 先于 toolResult 时条目保持原位；工具执行状态独立于 assistant 生成状态，不能因 assistant message_end 就把工具标 complete。

### 6.3 裁剪、重连与 legacy

- 每次 message/event/snapshot canonicalization 都保留新字段，不得只在 React converter 中私藏结构。
- 所有 TS/Go reducers、extension/Node-基线/Go/browser compaction、get_session JSON 转换都要更新；字段可能经过 result data 的通用 JSON 深度/节点预算，必须一起测。
- 复用既有优先淘汰旧消息/旧工具和缩小文本的策略；新字段计入预算。无法保留一致 parts 时整体省略该 message 的 parts，保留可投影的旧字段并标 partsTruncated/historyTruncated；不能给出错误 index 或半个 JSON。
- 正常未裁剪投影的要求是：delta 应用后的消息与原生最终完整投影语义一致；裁剪后允许内容减少，但不能错误归属、倒序或伪报完整。
- 新 host → 旧 Relay：旧 canonicalizer 会丢新字段，按 legacy 显示；新 Web 必须能处理这个情况。
- 旧 host → 新 Relay → 新 Web：只用真实 callId 唯一匹配；不能依工具名、时间、最近 assistant 推断。
- 父消息已被裁掉：若有 toolResult，则在它的 transcript 位置展示标注“所属回复不可用”的只读工具项；无结果位置的执行放在 transcript live edge，标“关联信息缺失”。两者都不是页面级工具面板。

### 6.4 固定的最小验收序列

同一 assistant `a1` 的内容：

```text
index 0: text "先检查"
index 1: tool-call t1 / read
index 2: text "再检查"
index 3: tool-call t2 / read
index 4: text "检查结束"
```

事件依次：

```text
message_started(a1)
text deltas / message_finished(a1 with parts)
tool_started(t1) → tool_started(t2)
tool_updated(t1, "partial")
tool_finished(t2, error)
tool_finished(t1, complete)
toolResult(t2, "失败", toolIsError=true)
toolResult(t1, "", toolIsError=false)
```

必须断言：a1 内仍是 0→1→2→3→4；t1/t2 各一项，不因同名或完成先后交换位置；t1 最终输出为空而非 partial；t2 失败；snapshot 重建/重连后结果相同。

还要单独覆盖：旧 Relay 丢 fields、500/501 parts、emoji 超 byte、空 parts、未知内容、缺父消息、重复 callId、跨 host 同 callId、历史回放、自定义 sessionDir。

## 7. assistant-ui 适配限制

目标文件：`web/src/features/chat/runtime/convertMessages.ts`、`usePiRelayRuntime.tsx`；纯转换先测，不在 converter 里发命令或读 storage。

- 将已验证 text → text、thinking → reasoning、tool-call → tool-call；关联结果一次性折入正确 call。
- 原始 argsText 是显示证据；只有通过有界 JSON 对象校验才作为 typed args。截断/非法参数不能伪装成有效 `{}` 的真实调用。
- 禁用相邻 assistant 自动合并（若用 `useExternalMessageConverter`，固定 `joinStrategy: "none"`），不能靠 runtime 合并策略猜 owner。
- 孤立 toolResult 不能强行作为未知的 `role: "tool"` 传给不接受该 role 的 ThreadMessageLike。用已核对的只读 data part/custom renderer 在 transcript 原位置表示，并加明确 fallback 标签；不假造新的模型回复。
- 转换器必须保留 tool 执行状态作为受限 metadata/data，custom ToolPart 读这个状态；不要从 assistant 的 message.status 推断 tool 已执行完。
- 外部 runtime 的 onNew 是必需适配点时，转到与自有 Composer 相同的单一发送函数；不得同时调用 runtime.append 和 Gateway 再发一遍。
- 自有 Composer 是唯一输入草稿来源；onCancel 转 abort；不提供 setMessages/onEdit/onReload/onAddToolResult/queue/attachments/Cloud 等能力。
- 活动对话 isRunning 为 `phase === "running" || phase === "waiting_local_ui"`，不从 Promise 推断；waiting_local_ui 另作状态提示，不提供未实现的远程审批按钮。历史 runtime 固定只读、isRunning=false，onNew 必须拒绝发送。
- `@assistant-ui/react`、Markdown primitives 的实际 types 在 R01/R14 核对，不能用 `as any`、`@ts-ignore` 或关闭 TypeScript 检查掩盖版本 API 差异。

## 8. 进程与交付约定

- 平台标签用 Go 的命名：`windows-amd64`、`linux-amd64`、`linux-arm64`、`darwin-amd64`、`darwin-arm64`；Node 的 `win32/x64` 需要显式映射，不直接拼接。
- 普通构建只保证当前平台；完整发行流程逐一收集矩阵 binary。缺某个平台不能用另一个架构的文件改名充数。
- R16/R17 测试使用 `.refactor/` 里的独立 package staging/runtime，不改变当前生产默认启动行为。candidate 的未来默认接线由 `scripts/refactor/candidate-overrides/` 中的小型受审源码 overlay 明确记录，先应用到隔离源码副本再编译；不手改 dist JavaScript。R19 只采用已经测试的同一接线，不能现场再造一个 launcher。
- staging 只复制显式源码/配置/必要脚本允许清单，不递归复制用户 env、runtime、node_modules 或其他项目。candidate-overrides 和测试 helper 不进入最终发行包；Go module 依赖锁的必要维护只允许已核准版本的 tidy 变化，不借机 go get -u。
- 最终源码 build/prepack 要 Node + Go；成品运行 Go Relay 不需要 Node/Go，Pi 扩展仍需 Node ≥22.19.0。
- auto-start 只选择本 package 的可信 binary，绝不 PATH 搜索、自动下载或 go build。对 remote wss 和不安全 URL 只连接/拒绝，不 fallback 本地。
- PID marker 是辅助证据；停止前重新核对 PID + canonical executable path + creation time + 本次实例记录。不能获得证据就不停止，也不随手删除 marker。
- 锁/marker/runtime 不可写时安全降级，不能强制用户给 package 安装目录写权限。
- file/session 安全逻辑继续在 extension：canonical root、敏感文件拒绝、symlink/junction/reparse/ADS/device 检查、严格 UTF-8、SessionManager 当前自定义 sessionDir 和 64 MiB cap。不要把它们迁到 Go。
- 发布前检查 MIT 与第三方 license/notice；Web 成品不得含 source map，发行包不得含凭据、provider 配置、runtime、测试临时 helper。构建输出不提交 Git。

以上接口和默认值在对应内置检查完成后作为实现约束。既定契约内的实现修正可在授权范围内验证后继续；需要改变协议语义、安全边界或技术选型时，先提出决策与 fixtures 差异，得到用户确认后再改实现。不要让文档与代码各用一套约定。
