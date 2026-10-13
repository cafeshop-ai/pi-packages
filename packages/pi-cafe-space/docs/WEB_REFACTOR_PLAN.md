# Pi Cafe Space Web 与 Relay 重构方案

> 状态：架构规划，尚未实施。目标为 React/Vite Web + Go/Gin Relay + 原生 Pi TypeScript 扩展。本文不表示当前页面或 Relay 已完成技术栈切换。
>
> 本阶段只输出方案，不安装项目依赖、不替换现有页面、不修改运行中的 Pi 或 Relay。
>
> **执行 AI 从 [执行入口](./REFACTOR_EXECUTION.md) 开始**，按 [R00–R19 任务卡](./refactor/TASKS.md) 在授权范围内逐项连续实施，普通 review 在流程内完成，不逐项等待人工确认；不直接把本架构文档整篇一次性执行。

## 1. 目标与范围

将 `web/public/app.js` 中集中的连接管理、状态处理和 DOM 渲染拆开，重构为 React + Vite 的 TypeScript 单页应用。对话界面使用 assistant-ui，样式使用 SCSS Modules，不引入 Tailwind。

同时将当前 Node.js/TypeScript Relay 迁移为 **Go + Gin**，使用专用 WebSocket 库处理连接。原生 Pi extension 与浏览器侧协议实现继续使用 TypeScript，不把 Pi runtime 迁入 Go。Go 服务的模块、并发和安全设计见 [Go Relay 详细方案](./RELAY_GO_REFACTOR_PLAN.md)。

核心目标：

- 工具调用是 assistant 回复中的内容部分，按真实顺序显示，不再放到独立的“工具执行”面板。
- 可靠保留文本流、思考过程、工具状态、prompt、steer、follow-up、abort、thinking 设置、多 host 切换、文件与历史浏览。
- 切换实例、会话、项目或发生重连时，数据和命令不串台。
- 建立可独立测试的协议客户端、状态层和 assistant-ui 适配层。
- 支持桌面与手机布局、中英文界面、键盘操作与可访问状态提示。

不在本次范围内：第二个 Pi runtime、浏览器执行工具、模型 API 代理、任意远程审批、会话编辑/分叉/删除、文件写入、附件上传、Assistant Cloud、SSR。

## 2. 技术栈与职责

| 技术 | 职责与使用约束 |
| --- | --- |
| React + TypeScript | 组件、页面和类型检查；业务状态不散落在组件中 |
| Vite | 开发服务器、HMR、生产静态资源构建；不是生产 Relay |
| `@assistant-ui/react` | Thread、Message、消息 parts 和 ExternalStoreRuntime；不负责调用模型 |
| `*.module.scss` | 组件级样式隔离；全局 SCSS 仅用于主题变量、基础排版和布局约定 |
| axios | 同源 `/api/config`、`/healthz` 等少量 HTTP 请求；不承担 WebSocket 消息和文件命令 |
| clsx | 组合 CSS Modules 类名和状态类名 |
| i18next + react-i18next | 翻译资源、语言切换和 React 文案绑定 |
| immer | 独立状态仓库的不可变更新；协议数据校验在更新之前完成 |
| use-immer | 表单草稿、筛选条件、展开状态等局部交互；不另存一份权威 transcript |
| lodash-es | 按需导入搜索防抖等辅助函数；不用 `merge` 合并不可信协议对象，不对协议事件做丢弃式节流 |
| modern-normalize | 一次性导入浏览器基础样式归一化 |
| nanoid | 新的客户端 request/notice ID；保留已有 peer ID，不替换 Pi 消息和工具调用 ID |
| react-router | SPA 页面与 host 导航，使用 HashRouter；不用 Framework/SSR 模式 |
| Go + Gin | Relay 的 HTTP 路由、中间件、健康检查和静态页面入口 |
| `github.com/gorilla/websocket` | Go Relay 的 WebSocket upgrade、读写、控制帧与截止时间；Gin 本身不提供 WebSocket 协议实现 |
| Go `embed` / `net/http` / `log/slog` | 内嵌 Web 产物、服务器生命周期与结构化日志，不引入数据库或模型 SDK |

必要配套：`react-dom`、`sass`、`@vitejs/plugin-react`、TypeScript 类型包。Markdown 渲染计划使用 `@assistant-ui/react-markdown`，禁用原始 HTML，并限制链接与外部资源。

TypeScript 测试继续使用 Vitest；组件测试增加 React Testing Library 与 DOM 测试环境，浏览器验收使用隔离 Chrome。Go 侧使用 `go test`、race detector 和 fuzz test，TS/Go 使用同一批协议 fixtures。测试依赖不进入生产前端代码。

版本在实施第一阶段核对 npm peer dependencies、Node engines 和 Go module 要求后，分别锁定到 `package-lock.json` 与 `relay/go.mod` / `go.sum`，不依据示例或 skill 中的版本号直接升级整个仓库。保持 Pi package 当前 `node >=22.19.0` 的兼容承诺；如工具版本不兼容，先选择兼容版本，不静默提高最低 Node 版本。成品 Go Relay 运行不需要 Node/npm/Go 工具链；源码构建才需要 Node 与 Go。

## 3. 总体架构

```text
浏览器：React + assistant-ui + SCSS Modules
    │
    ├─ React Router：登录 / 当前对话 / 历史 / 文件 / 设置
    │
    ├─ features：对话、实例选择、文件、历史、状态提示
    │      │  读取状态 / 发起操作
    │      ▼
    ├─ assistant-ui adapter ← selectors ← CollabStore（immer）
    │                                      ▲
    │                                      │ 顺序应用已验证消息
    ├─ CommandGateway ──────────────── RelayClient
    │      上下文校验、请求关联             │
    │                                      │ 原生 WebSocket /ws
    └─ HTTP client（axios）                │
           │ /api/config、/healthz         │
           ▼                              ▼
                  Go + Gin Relay
         内嵌静态页面、认证、房间、转发、有界缓存
                         ▲
                         │ Pi 主动建立出站 WebSocket
                         │
            原生 Pi + TypeScript Extension
                 唯一 AgentSession owner
                 模型、工具、会话、本地文件
```

assistant-ui 的 runtime 是**界面状态适配器**，不是 Pi 的 `AgentSession`。浏览器不持有 provider API key，不运行模型，不直接访问电脑文件系统。

生产环境可单独部署一个内嵌 Web 产物的 Go Relay 二进制：浏览器和 Pi 都主动连接 Relay，电脑不需要开放入站端口。本次不改变 host/client token、room、命令授权或原生 Pi 的所有权边界。

Go Relay 是对 Node Relay 的替换，不是夹在 Node Relay 前面的额外网关。迁移期在不同测试端口并行验证两个实现；验收后生产只有一个 Go Relay。其内存状态仍不承诺跨进程/重启持久化，首版不引入 Redis、数据库或微服务。

## 4. 前端分层

### 4.1 传输与协议：`services/relay`

`RelayClient` 管理一个页面连接对应的一条 WebSocket：

- 建连、hello/welcome、错误、关闭、指数退避重连。
- socket 实例/连接代次校验，忽略已退休连接的回调。
- 原始帧类型和 UTF-8 字节限制在 JSON 解析前检查。
- Web 与 Pi extension 复用 `src/protocol/index.ts` 中浏览器可用的类型、校验和 canonicalization；Go 实现在同一份 wire contract 与跨语言 fixtures 下独立编译，不通过 Node 子进程复用 TS。
- 保留浏览器侧更小的展示/缓存预算；共享协议的最大值不等于浏览器应常驻保存的大小。
- 模块导入时不自动连接；显式启动、清理和取消 timer，避免 React StrictMode 或 HMR 留下双连接。
- 切换页面不重新建连；切换 room、退出登录或主动 resync 才改变连接生命周期。

`CommandGateway` 是所有远程操作的唯一出口：

- 统一构造 `requestId`、`targetHostId`、`expectedStreamId`、`expectedSessionId`、`expectedCwd`。
- 点击发送时捕获完整上下文，实际发送前再校验；异步回调不能读取一个已经切换的新 host 来替换旧目标。
- pending 请求绑定命令类型、目标上下文和结果数据类型，不能用文件结果满足历史请求。
- 拒绝未认证、未就绪、过大、过期或超出队列上限的命令；abort 不被普通读请求的 UI 队列阻塞。
- 同一 host 内连续打开不同文件时，以请求 ID / 面板请求代次保证较慢的旧结果不覆盖新文件。
- 仅向调用方返回结构化结果，统一由状态层处理；组件不直接解析 wire message。

### 4.2 HTTP：`services/http`

axios 实例限定同源和允许的端点，统一 timeout、AbortSignal、响应类型校验及错误转换，不向所有请求自动附加 client token。token 继续只通过 WebSocket hello 认证。

文件、历史、prompt、abort **仍走 WebSocket command**，不新建 `/api/chat`、`/api/files` 或模型调用接口。健康检查只在有需要时进行，不用轮询代替实时连接。

注意：浏览器 axios 的 `maxContentLength` 不能当作接收前的硬内存限制；该选项不能替代服务端响应上限和 WebSocket 原始帧限制。

### 4.3 状态：`state`

采用轻量外部 store + immer `produce` + React `useSyncExternalStore`，不额外引入 Redux、Zustand 或另一套服务器状态框架。

| 状态 | 归属 |
| --- | --- |
| 连接状态、room、host 列表、host 就绪状态 | CollabStore |
| 每个 host 的 snapshot / seq / 投影 | CollabStore，按 host 隔离 |
| 有界历史/文件结果和对应上下文 | CollabStore |
| WebSocket、timer、pending Promise 回调 | RelayClient / CommandGateway 私有字段，不放进 Immer |
| 选中的 host / 页面 | Router 为单一选择来源；storage 只提供首次选择建议 |
| 输入草稿、delivery、工具展开、移动端抽屉 | use-immer 局部状态，必要时按上下文保存有界 UI 状态 |
| token | 认证模块内存 + 可用时的 sessionStorage；不进入普通状态调试输出 |
| assistant-ui 消息 | 由已验证投影派生，不维护可独立修改的第二份会话 |

每个 host 使用独立的不可变状态引用，订阅未变化的 host 不触发整页更新。任意 hostId 作为 key 时使用安全的 Map 或等价安全索引，不能写入普通对象原型；若 Immer 状态使用 Map，显式启用并测试 Map 支持。

事件严格按 `seq` 顺序立即进入 store。只合并 React 绘制通知，不 debounce、丢弃或重排消息/工具事件。后台标签页也必须处理全部有效事件，不能让待绘制队列无限增长。

### 4.4 assistant-ui 适配：`features/chat/runtime`

选择 `useExternalStoreRuntime`，不选示例中的 `useChatRuntime`、`useLocalRuntime` 或直接连接另一个 Pi 服务的 adapter。

```text
Host snapshot + events
          ↓
有界、可验证的会话投影
          ↓
消息转换器（text / reasoning / tool-call）
          ↓
useExternalStoreRuntime
          ↓
AssistantRuntimeProvider
          ↓
ThreadPrimitive / MessagePrimitive / 自定义内容组件
```

适配规则：

- `onNew` / 发送入口仅转成现有 `prompt` command；`onCancel` 仅转成 `abort`。
- 不传可启用分支修改的 `setMessages`，不提供 `onEdit`、`onReload`、`onAddToolResult` 等未被现有协议支持的能力。
- 不注册浏览器工具 executor，不使用自动模型续跑、Cloud 持久化或客户端 tool result 回传。
- isRunning、message status 来自 Pi 投影，不把请求 Promise 的结束等同于 Pi 运行结束。
- 使用稳定的消息/part key；重绘时不重新生成 nanoid。
- host/stream/session/cwd 切换时重置对应 runtime scope，旧消息、草稿提交和展开状态不会转移到新上下文。
- 对话合并策略由转换器明确控制，不依赖相邻 assistant 消息的默认自动合并来猜测工具归属。

**输入框单独设计**：assistant-ui 默认运行中发送和本地 queue 语义不等于 Pi 的 steer/follow-up。首版使用自有 `Composer`（React + use-immer），将文本和 delivery 直接交给同一个 CommandGateway，不启用 assistant-ui 的本地排队执行器。不能通过伪造 `isRunning=false` 来绕过发送限制。输入草稿只有一个来源。

## 5. 对话与工具内容模型

### 5.1 展示目标

```text
你：检查项目并修复问题

Pi
  ▸ 思考过程
  我先查看相关文件。
  ▸ read · README.md                         已完成
      参数 / 输出（可展开）
  ▸ edit · src/example.ts                    已完成
  ▾ bash · npm test                          执行中
      实时输出……
  修复完成，以下是结果……
```

工具位于所属 assistant 回复内部的对应位置，不做页面级工具列表，不重复渲染“工具结果消息 + 工具状态卡”。不同轮回复不因为用了同名工具就合并。

- 运行中、完成、失败使用文字及视觉状态，不只靠颜色区分。
- 输出和参数默认紧凑；运行中/失败可默认展开，但用户手动折叠后，后续 delta 不应强行展开。
- 已展开的内容在流式刷新中不丢失，历史消息也使用同一内容渲染组件。
- `tool_finished` 先于正式 `toolResult` 时更新原条目，不暂时消失；result 到达后按真实 `toolCallId` 补全同一条目。
- 工具失败不能因结果消息被笼统标为 complete 而变成成功；映射必须保留原生工具的 isError / 执行终态。
- 空工具输出也是有效结果，不用旧的 partial output 覆盖空的最终输出。

### 5.2 当前协议的限制

仅替换 React 组件不能保证准确归位：

- `TranscriptMessage` 当前把正文、thinking 压平成两个字符串，不包含完整的有序内容 parts。
- extension 当前最多在消息上保留第一个 `toolCallId`；一次 assistant 消息中的多个工具调用无法完整表达。
- `ToolExecution` 有调用 ID、名称、参数、输出、状态，但没有明确的所属 assistant 消息 ID / 内容位置。
- 历史文本投影不会完整保存全部工具调用参数；重连与历史查看不能只依赖浏览器之前见过的 `tool_started`。

因此，完整方案需要**小范围、向后兼容的结构化投影增强**，而不是在 Web 里把工具简单追加到最后一条 assistant。

### 5.3 计划中的投影增强

实施时为 `TranscriptMessage` 增加可选的有序 `parts`，涵盖真实 text、thinking 和 tool call；为工具执行增加可选的所属消息引用，必要时为 delta 增加可选 part 索引。

约束：

1. 归属与顺序由 Pi extension 从实际消息内容中生成，不能通过工具名称、时间接近或“最近一条 assistant”猜测。
2. snapshot、message_started/finished、delta 和历史结果使用一致的投影规则；重新构建 snapshot 时重建关联，不沿用过期的临时消息 ID。
3. 继续保留 `text`、`thinking`、`toolName`、`toolCallId` 和现有事件类型；新增字段不作为 v1 的必填字段。
4. 同步更新 TS/Go protocol 校验、canonicalization、event reducer、extension/relay/browser compaction 及历史 JSON 转换，防止新字段被中间层丢掉或绕过预算。
5. parts 数量、字段长度与总 UTF-8 envelope 共同受限；旧字段与新字段的重复文本也计入总预算，不能各自通过后让总帧超限。
6. 未实现该增强的旧 host/relay 仍可连接。无 parts 时走 legacy 转换：能通过真实 ID 唯一匹配才归入 assistant；否则在 transcript 内的已知结果位置展示紧凑工具项，明确关联信息不完整。无可靠位置时标注上下文缺失，不伪造顺序或放回独立面板。
7. 对历史截断、缺失父消息、并行同名工具、跨轮工具和重连恢复建立回归用例。

默认字段类型、增量/结果规则和固定验收序列已细化到 [实现约定第 6 节](./refactor/CONTRACTS.md#6-有序内容-parts-的默认契约r12-审核后实施)。必须在 R12 核对 Pi 事件并审查，再于 R13 实现；本规划不提前改变已部署 wire protocol。

## 6. 页面布局与路由

### 6.1 桌面

```text
┌─────────────────────────────────────────────────────────────────┐
│ Pi Cafe Space     项目 / Pi 实例    连接状态     模型 / 思考 / 设置 │
├────────────────┬───────────────────────────────┬────────────────┤
│ 实例与历史      │ 当前对话                      │ 项目文件       │
│                │                               │                │
│ 在线 Pi A      │ 用户消息                      │ 目录 / 文件    │
│ 在线 Pi B      │ Pi 回复                       │ 只读内容预览   │
│                │   思考 → 工具 → 后续文字      │                │
│ 历史会话列表   │                               │ 可收起         │
│ 只读查看       ├───────────────────────────────┤                │
│                │ 输入框 / delivery / 发送 / 停止│                │
└────────────────┴───────────────────────────────┴────────────────┘
```

中间对话是视觉主体，左右栏可收起。状态优先显示在顶部，重复断线错误不挤占 transcript。历史查看有明显“只读”标记，不能误把输入发给正在浏览的历史 session。

手机默认只显示顶部状态、对话和底部输入；实例/历史与文件从抽屉进入，支持安全区域、软键盘和键盘焦点恢复。输入框保持可见，阅读旧消息时不强制跳回底部。

### 6.2 路由

使用 `react-router` 的 HashRouter，生产不需要 Relay 对任意路径回退 `index.html`：

```text
/#/login
/#/hosts/:hostId/chat
/#/hosts/:hostId/history
/#/hosts/:hostId/history/:sessionId
/#/hosts/:hostId/files
/#/settings
```

- hostId / sessionId 是 opaque ID，编码并校验；URL 中不出现 token、prompt、cwd 或实际文件路径。
- 路由只有导航含义，不是授权证据；等认证及 host inventory 完成后再解析目标，不把未知 ID 静默映射到另一个 host。
- 历史路由只调用 `get_session`，不等于让原生 Pi `/resume`，不切换真实 AgentSession。
- 刷新页面先恢复认证和连接，再加载有权限、上下文一致的数据。
- 兼容现有 `pi-collab-token`、`pi-collab-room`、`pi-collab-peer-id`、`pi-collab-host-id` storage keys；storage 不可用时退回页面内存。

## 7. 目录与依赖方向

继续放在同一个自包含 Pi package 中。Web 不单独运行应用服务器；Go Relay 是独立 Go module，也可作为单二进制单独分发：

```text
packages/pi-cafe-space/
├─ protocol/
│  ├─ v1/                       # 语言无关的 wire contract / schema / 限额说明
│  └─ fixtures/                 # TS、Go、浏览器共用的协议测试数据
├─ src/
│  ├─ protocol/                 # Web 与 Pi extension 使用的 TS 协议实现
│  ├─ relay/                    # 旧 Node Relay：仅迁移期保留作兼容性基线
│  └─ extension/                # 原生 Pi host connector，保持 TypeScript
├─ relay/
│  ├─ go.mod / go.sum
│  ├─ cmd/pi-cafe-relay/         # Go 可执行入口
│  └─ internal/
│     ├─ config/                # PI_COLLAB_* 配置及边界校验
│     ├─ protocol/              # Go codec、校验、canonicalization、projection
│     ├─ auth/                  # token、Origin 与握手策略
│     ├─ hub/                   # room/host 状态、fence、请求及有界缓存
│     ├─ transport/             # WebSocket read/write pump、背压
│     ├─ httpserver/            # Gin 路由与服务生命周期
│     └─ webui/                 # go:embed 与构建资源精确允许清单
├─ web/
│  ├─ index.html                # Vite HTML 入口
│  ├─ vite.config.ts
│  ├─ tsconfig.json             # 浏览器 bundler/JSX 配置，与 NodeNext 隔离
│  ├─ public/                   # 只放 icon、manifest 等原样静态资源
│  └─ src/
│     ├─ main.tsx
│     ├─ app/                   # App、Providers、Router、ErrorBoundary
│     ├─ layouts/               # WorkspaceLayout、MobileDrawer
│     ├─ pages/                 # Login、Chat、History、Files、Settings
│     ├─ features/
│     │  ├─ auth/
│     │  ├─ hosts/
│     │  ├─ chat/
│     │  │  ├─ runtime/         # usePiRelayRuntime、message converter
│     │  │  ├─ components/      # Thread、AssistantMessage、ToolPart、Composer
│     │  │  └─ model/           # 会话选择器、工具关联与显示模型
│     │  ├─ files/
│     │  ├─ history/
│     │  └─ connection/
│     ├─ services/
│     │  ├─ relay/              # RelayClient、CommandGateway、storage adapter
│     │  └─ http/               # axios 实例和 HTTP endpoint 封装
│     ├─ state/                 # CollabStore、reducers、selectors、React hooks
│     ├─ components/ui/         # Button、Field、Badge、Dialog 等基础组件
│     ├─ i18n/                  # 配置与 zh-CN / en 翻译资源
│     ├─ styles/                # global.scss、tokens.scss
│     └─ test/                  # fixtures、测试环境、fake transport
├─ scripts/                    # TS/Web/Go 构建、二进制打包与进程管理
└─ docs/
   ├─ WEB_REFACTOR_PLAN.md
   └─ RELAY_GO_REFACTOR_PLAN.md
```

组件的 `.tsx`、`.module.scss` 和测试就近放置。小功能不强制创建空目录或多层抽象。

前端依赖方向：`pages → features → services/state → protocol`。UI 不能导入 `src/extension`、`src/relay`、Pi SDK、Node fs 或 `ws` 服务端实现；前端只能使用浏览器原生 WebSocket。可用 Vite alias 引用 TS protocol，但不通过导出整个服务端的 barrel 间接导入。

Go 侧依赖方向：`cmd → httpserver/transport → hub → protocol`。Go Relay 不导入或启动 Pi SDK，也不把 TypeScript extension 编译到服务端。

## 8. 重连、命令与安全规则

### 8.1 保留的边界

- 帧最大 `256 KiB`；原始帧、JSON、snapshot、event、command、result 均保持已有边界。
- 浏览器最多保存 64 个 host，单 host 展示投影维持最近 100 条消息、100 个工具的上限，并继续按字节裁剪。
- pending 请求不超过现有 256 项，并增加明确的超时/清理路径；历史、文件预览、工具展开状态和通知缓存也必须有条数、字节或生命周期上限。
- 保留 seq、stream/session/cwd fence、host readiness、多 host 歧义拒绝、过期结果隔离与权威 resync。
- 截断信息如实展示，不把 `historyTruncated` 一律解释成“历史超过 100 条”；也可能是图片、未知内容或字节预算导致缺失。
- 读文件/历史继续由 Pi extension 执行，保留项目根、敏感路径、symlink/reparse、UTF-8 和历史 session 路径校验。

### 8.2 重试与提交语义

- 网络故障使用指数退避重连，状态常驻顶部；同一故障的重复通知按窗口去重。
- token 无效返回登录页并停止无效认证重试，不无限弹错。
- seq 缺口或未知/歧义 host 触发 resync；未就绪 snapshot 不可发送写命令。
- 只有明确的只读操作在 `HOST_NOT_READY` 后可等待新权威 snapshot，再按新上下文重试；历史结果还需通过历史身份和请求类型校验。
- prompt、abort、set_model、set_thinking 在结果不明的断线后不盲目重发。当前 v1 不提供可验证的 Relay 重启身份，单凭 requestId 无法保证跨 Relay 重启去重；这类请求应显示“结果未知，请确认 Pi 状态”。
- `dispatched` 只表示已交给 Pi，不表示模型完成、落盘或 abort 已终止。输入发送状态与 Pi 运行状态分开管理。
- 不把 UI 草稿队列当成 Pi pending queue；只保留真实的 `hasPendingMessages` 提示。

### 8.3 内容与凭据

- 不把 token 写入 URL、`VITE_*` 环境变量、构建产物、日志或分析上报。所有 `VITE_*` 都按公开配置对待。
- 保留 loopback 才可使用开发默认 token 的行为；不能因 Vite 开发环境而放宽生产认证和 Origin。
- React 默认文本转义；禁止未经审计的 `dangerouslySetInnerHTML`、原始 Markdown HTML、可执行 URL 或工具输出脚本。
- 远程 Markdown 图片默认不自动加载，避免对话内容触发第三方请求；工具参数/输出只读展示。
- i18n 按已知错误 code 映射文案，未知服务器文本作有界纯文本展示；不将未知数据用作翻译模板或 HTML。
- 优先维持现有 CSP，不为组件方便加入 `unsafe-eval` / 广泛 `unsafe-inline`。assistant-ui primitives、弹层和 Markdown 的实际样式行为必须在生产 CSP 下验证，不兼容时改 renderer。

## 9. 样式、国际化与交互约定

- `modern-normalize` 在 `main.tsx` 导入一次，之后导入全局 tokens/base SCSS；组件统一 `import styles from './X.module.scss'`。
- 色彩、间距、圆角和字体使用 CSS 自定义属性；主题通过根元素 data 属性切换，不复制两套组件。
- clsx 只组合样式类；样式逻辑不影响真实工具/会话状态。
- i18next 首版资源为 `zh-CN` / `en`，按 common、connection、chat、files、history、settings 分组；资源随构建打包，不依赖第三方语言服务。
- 用户内容、工具名、模型标识、文件路径不翻译；时间和数字用 `Intl`。
- nanoid 仅在创建请求/通知时调用，不在 render 中调用；安全随机能力不可用时明确报错，不为凭据生成回退到 `Math.random`。
- 不在每个 delta 时重新挂载整段 transcript；保存展开、选区和滚动状态。仅在用户接近底部时自动跟随，否则提供“有新内容”按钮。
- 中文输入法 composition 期间不能触发发送；Enter/Shift+Enter、移动端按钮、disabled 状态和 focus-visible 统一设计。

## 10. 构建与部署

### 10.1 生产产物

```text
TS 编译 ──────────→ dist/extension、dist/protocol
Vite build ───────→ dist/relay/public/（构建中间产物与兼容目录）
                           │ 校验文件 / 生成精确清单
                           ▼
                    Go webui 嵌入暂存区
                           │ go build
                           ▼
                    dist/relay/bin/<os>-<arch>/
                           pi-cafe-relay[.exe]
                           （二进制内含同批 Web 资源）
```

- 前端依赖放在现有 package 的依赖清单，继续使用根 workspace lockfile；不创建第二份 `web/package-lock.json`。Go 依赖使用 `relay/go.mod` / `go.sum`。
- TS core 与 Web 独立 typecheck，Go 独立编译/测试。总 `check`、`test`、`build`、`prepack` 必须覆盖三部分及协议契约测试。
- 源码构建需要 Node 与 Go；安装已构建的 Pi package 不需要用户安装 Go。远程 Go Relay 可单独运行，不需要 Node。
- Vite 只清理自己的输出目录；总 build 编排 clean、Web 构建、嵌入资源验证和 Go 构建，避免旧 Web 混入新二进制。
- 迁移验收前，新 Web 产物写到隔离的构建目录，不覆盖正在使用的旧 `dist/relay/public`。上图是最终布局，不作为直接覆盖在线实例的指令。
- 保持 `dist/extension/index.js` 安装入口及现有 PowerShell/npm 启动命令名，内部改为选择并启动对应平台的 Go 二进制。
- 二进制、嵌入暂存区、dist、node_modules、runtime 和 token 不提交 Git；发行时附平台/版本/校验和清单。package 继续 `private: true`。

### 10.2 内嵌静态资源

最终 Go Relay 默认用 `go:embed` 内嵌 Vite 产物，并用构建期生成的**精确资源允许清单**提供文件：

1. 只嵌入经过校验的 Web 构建暂存区，不把源码、环境文件、source map 或整个 package 目录一起嵌入。
2. 清单覆盖入口、动态 chunk、CSS、icon、manifest；限制条目数、单项与总资源大小。每个资源继续不超过 `4 MiB`。
3. Gin 按允许清单命中资源，禁止目录列表、任意磁盘路径和 `/* → index.html`；HashRouter 不需要宽泛的 SPA fallback。
4. embed 模式下请求不读取可变磁盘文件，从运行时消除静态资源 symlink/junction 替换问题；构建拷贝阶段仍必须拒绝 symlink、路径穿越和非普通文件。
5. 如后续确需磁盘 webRoot 覆盖，必须单独设计并保留 canonical/regular-file/大小、POSIX `O_NOFOLLOW`、Windows reparse/ADS/device 校验；不能直接调用 `gin.Static` 暴露目录。首版生产模式不启用该覆盖。
6. 正确处理 JS/CSS MIME、HEAD、404、CSP 和缓存策略；首版继续 `no-store`。清单本身和二进制不通过 Web 静态接口暴露。

### 10.3 Go 二进制与本地自动启动

- 本地 extension 从 package 的受信产物路径选择 OS/arch 对应的 Go 二进制，不执行 PATH 中的同名文件。
- 只对安全的 loopback `ws://.../ws` 自动启动；远程 `wss://`、query/fragment/credential、错误路径和端口 0 仍不得触发本地 fallback。
- 保留健康检查、启动锁、只读安装目录降级和并发启动失败子进程清理；不在 Pi 启动过程中自动下载、编译或安装 Go。
- 旧脚本的“Node 可执行文件 + 入口脚本”归属检查需改为 Go 二进制的 canonical executable path、进程创建时间和启动实例记录；不能仅凭 PID 或进程名停止服务。
- 已有 Node Relay 可作为迁移期兼容端点继续使用；不能自动杀掉它以抢占 37891。新旧切换须在独立端口验证后由用户明确执行。
- PowerShell 保持 5.1 兼容、任意 PiArgs 转发与调用方原有 `PI_COLLAB_*` 环境恢复。更多平台/打包细节见 [Go Relay 方案](./RELAY_GO_REFACTOR_PLAN.md)。

### 10.4 远程与开发部署

远程推荐：HTTPS/WSS 反向代理 → Go/Gin Relay（内嵌 Web）。只公开 HTTPS 入口，Pi 电脑只需出站网络；代理的公开 Origin 必须显式加入允许列表，不能信任任意客户端的 forwarded headers。

开发时 Vite 仅监听 loopback，代理 `/ws`、`/api/config`、`/healthz` 到显式配置的隔离 Go Relay。开发 Origin 显式允许；不默认抹掉 Origin 或扩大生产允许列表。

Vite 可使用 `5173`，开发 Relay 使用独立端口，不占用已有 `37891`。浏览器集成验收继续使用隔离 Relay `37983`、Chrome SxS CDP `9333` 和新 profile，不碰现有 Chrome `9222` 或用户正在运行的 Pi。

保留 Web manifest，但首版不引入缓存聊天/凭据的 service worker；“离线历史”仍指 Relay 已返回/缓存的只读数据，不承诺离线运行模型。

## 11. 实施阶段与验收门槛

当前进度见 [PROGRESS](./refactor/PROGRESS.md)。以下为架构阶段概览，具体顺序、修改白名单、测试和审查点以 [任务卡](./refactor/TASKS.md) 为准。每个阶段先补测试，新入口在隔离目录验证，只有最后显式授权的 R19 才切换生产；不以“React 页面能打开”代替功能验收。

| 阶段 | 主要工作 | 完成门槛 |
| --- | --- | --- |
| A. 契约与工程骨架 | 固定 v1 行为 fixtures；核对版本；Vite/TS/SCSS/i18n/Router 与 Go module/Gin 骨架 | 原页面/Node Relay 不受影响；新空壳独立构建；TS/Go 对现有契约一致 |
| B. Go Relay 等价迁移 | 认证、rooms、snapshot/event reducer、命令 fence、缓存、背压、关闭生命周期 | 现有 TS host/客户端连接 Go；协议/并发/安全差分测试通过，不降低旧边界 |
| C. Web 客户端与状态 | 提取 RelayClient、CommandGateway、store、selectors；连接 Go Relay | 多 host、ready gate、seq、断线、旧回调、请求关联与边界测试通过 |
| D. 内容投影增强 | 可选 parts/工具归属；同步 TS/Go canonicalization、compaction 和历史路径 | 多工具、历史、截断与旧协议降级通过；所有帧仍小于上限 |
| E. React 页面 | ExternalStoreRuntime、对话/Composer/工具 parts、文件历史、响应式和中英文 | 工具准确嵌入回复；控制走原生 Pi；结果不串台；历史页只读 |
| F. 打包与进程迁移 | Web embed、跨平台二进制、extension 自动启动与 PowerShell 归属校验 | 成品无需 Go；只读安装可用；不误停旧进程；环境/参数兼容 |
| G. 切换与收尾 | 聚合脚本、完整回归、新 Go 二进制 + 新 Web + 新 Pi 验证、包扫描 | 所有验收有证据后才移除旧 Node Relay 与原生 DOM 页面，保留 Git 可回退点 |

阶段 A 到 F 在隔离入口验证，只有 G 才默认切换生产。不要让 Node 与 Go 同时接管同一监听端口，也不在同一页面共享两套连接控制器。先完成 v1 等价迁移，再增加 parts，便于区分语言迁移缺陷和协议增强缺陷。

### 必须覆盖的测试

- 协议：UTF-8 超大帧、非法结构、边界 ID、可选字段兼容、parts 总预算、未知字段 canonicalization；TS/Go 的字符串长度、数字、null/缺省和 JSON 编码语义必须对齐。
- 状态：多 host 并发事件、重复/跳号事件、stream/session/cwd 切换、离线 snapshot、旧 socket 回调、StrictMode 挂载清理。
- 命令：结果类型绑定、慢文件结果、HOST_NOT_READY 只读重试、未确认写命令不盲重放、dispatched 与完成分离。
- 转换器：同名并行工具、多工具一次回复、tool_finished 早于 toolResult、失败和空结果、历史缺父消息、legacy 降级、刷新/重连后顺序一致。
- UI：折叠状态在 delta 后保留、滚动跟随与阅读旧消息、中文输入法、语言切换、键盘操作、移动端无横向溢出。
- 安全：Markdown/工具输出注入、外链/外图、token 不泄漏、Origin、静态路径穿越、symlink/junction、源码/清单不可被 HTTP 下载。
- Go 并发：`go test -race`、read/write pump 单写保证、慢客户端、hub 队列满、替换/超时/结果竞态、断开与 shutdown 后无 goroutine/timer 泄漏。race 验证在支持的原生平台执行，不用编译成功替代。
- 集成：新构建 Go 二进制（内嵌新页面）+ 隔离模拟 host 的确定性事件测试；再用明确归属的新 Pi 进程验证真实流程。模拟 host 不算真实 Pi 执行证明。
- 打包：构建/预打包带齐对应平台二进制，Web chunks 与二进制版本一致；没有生成文件提交、runtime、临时文件、token 或 provider 配置；不破坏 package 自包含安装。

## 12. 关键决策汇总

1. 使用用户指定技术栈，并加入 React/Vite/SCSS 必需配套和 assistant-ui；不换成 Next.js、Tailwind 或 AI SDK 服务端模板。
2. Web 是 React SPA；Relay 从 Node.js 迁移到 Go + Gin + Gorilla WebSocket，作为内嵌 Web 的单二进制服务独立部署。
3. ExternalStoreRuntime 适配现有 Pi Cafe Space 协议，Pi 仍是唯一 AgentSession owner。
4. immer 管协议投影的不可变更新，use-immer 管局部 UI；不引入额外全局状态框架。
5. axios 管 HTTP，原生 WebSocket 管会话协议；不新增模型或磁盘访问 HTTP 接口。
6. 工具内容以真实调用 ID 和所属消息构成有序 parts；兼容旧协议但不伪造归属。
7. HashRouter 避免任意路径回退；Vite 资源经校验后用 go:embed 内嵌，并由精确允许清单控制访问。
8. TS/Go 共享语言无关的协议契约与 fixtures；先等价迁移 v1，再添加有序 parts。
9. 本地自动启动迁移为平台二进制，保留旧配置/命令名与严格归属校验，不杀旧 Relay 抢占端口。
10. 先验证连接/投影/命令，再切换生产；不因前后端改造丢失已有安全与兼容性保护。

## 13. 参考

- [当前 Web 功能与边界](./WEB.md)
- [项目总体实施方案](./IMPLEMENTATION_PLAN.md)
- [当前 Node Relay 说明](./RELAY.md)
- [目标 Go/Gin Relay 详细方案](./RELAY_GO_REFACTOR_PLAN.md)
- [Pi Extension 说明](./PI_EXTENSION.md)
- [assistant-ui 文档索引](https://www.assistant-ui.com/llms.txt)
- [assistant-ui Agent Skills](https://www.assistant-ui.com/docs/llm)
- [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
- [Message primitive 与 parts](https://www.assistant-ui.com/docs/primitives/message)

实施时以已安装并锁定版本的类型定义与官方文档交叉核对 API。本文件是目标方案，不是已经完成的迁移记录。
