# R01 版本与 API 记录

状态：`done`。精确版本/API 记录及来源/integrity 缺口已完成内置核对；未安装依赖，R03/R09 仍须实际 module/peer/type 验证。

查询日期：2026-09-10（Asia/Shanghai）

## 1. 现场工具链

| 工具 | 现场版本 / 约束 | 来源 |
| --- | --- | --- |
| Node.js | `v23.11.0`；项目最低要求 `>=22.19.0` | R00 baseline；原生 Windows |
| npm | `10.9.2` | R00 baseline；原生 Windows |
| TypeScript | `5.9.3` | 根 workspace `node_modules/typescript/package.json`；npm registry |
| Vitest（package） | `3.2.4` | `packages/pi-cafe-space/node_modules/vitest/package.json` |
| Vitest（root lock） | `3.2.7` | 根 `package-lock.json` / root `node_modules` |
| Go | `go1.24.2 windows/amd64` | R00 baseline；原生 Windows |

项目仍固定 Node `>=22.19.0`。不在 R01 升级 TypeScript 或 Vitest；R09 安装 Web 依赖后必须用实际本地类型重新检查一次。

## 2. Web 直接依赖候选

以下是建议在 R09 使用的精确版本。版本是 registry 查询得到的明确 pin，不使用 `latest`；R09 才安装并写入根唯一 `package-lock.json`。

| 包 | 建议 pin | 查询时 registry 版本 | engines | peerDependencies / 备注 |
| --- | --- | --- | --- | --- |
| `react` | `19.2.4` | `19.3.0` | `>=0.10.0` | 与 React DOM 19.2.4 配套 |
| `react-dom` | `19.2.4` | `19.3.0` | 未声明 | peer `react: ^19.2.4` |
| `@types/react` | `19.2.14` | `19.3.0` | 未声明 | 无 peer；依赖 `csstype ^3.2.2` |
| `@types/react-dom` | `19.2.3` | `19.3.0` | 未声明 | peer `@types/react: ^19.2.0` |
| `@assistant-ui/react` | `0.15.18` | `0.15.18` | 未声明 | peer React/DOM `^18 || ^19`，React types `*`；tarball integrity 已核对 |
| `@assistant-ui/react-markdown` | `0.14.14` | `0.14.14` | 未声明 | peer `@assistant-ui/react: ^0.15.0`、React `^18 || ^19` |
| `vite` | `6.4.1` | `8.2.2` | `^18.0.0 || ^20.0.0 || >=22.0.0` | 可选 peer 包含 `@types/node >=22`、`sass` 等 |
| `@vitejs/plugin-react` | `4.7.0` | `6.1.1` | `^14.18.0 || >=16.0.0` | peer Vite `^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`；与 Vite 6.4.1 匹配 |
| `sass` | `1.97.3` | `1.104.0` | `>=14.0.0` | SCSS Modules 编译器 |
| `axios` | `1.13.6` | `1.20.0` | 未声明 | 仅同源 `/api/config`、`/healthz`，不设置全局凭据 header |
| `clsx` | `2.1.1` | `2.1.1` | `>=6` | CSS Modules 类名组合 |
| `i18next` | `25.8.13` | `26.4.2` | 未声明 | peer TypeScript `^5` |
| `react-i18next` | `16.5.4` | `17.0.13` | 未声明 | peer React `>=16.8.0`、i18next `>=25.6.2`、TypeScript `^5` |
| `immer` | `11.1.4` | `11.1.18` | 未声明 | `enableMapSet()` 由实现显式调用 |
| `use-immer` | `0.11.0` | `0.11.0` | 未声明 | peer Immer `>=8`、React `^16.8 || ^17 || ^18 || ^19` |
| `lodash-es` | `4.17.23` | `4.18.1` | 未声明 | 只按需导入辅助函数；不用于不可信协议对象 merge |
| `@types/lodash-es` | `4.17.12` | `4.17.12` | 未声明 | 依赖 `@types/lodash` |
| `modern-normalize` | `3.0.1` | `3.0.1` | `>=6` | 一次性导入基础样式 |
| `nanoid` | `5.1.6` | `6.0.1` | `^18 || >=20` | 仅生成本地 request/notice ID，不替换 wire ID |
| `react-router` | `7.13.0` | `8.3.1` | `>=20.0.0` | peer React/DOM `>=18`；只使用 `HashRouter` 路由 API |

选择较旧的稳定 minor/major 线是为了保持与当前 Node、Vite plugin、assistant-ui 版本和既定 API 范围的可复核组合；它们不是自动追随 registry 最新版本。R09 若发现该组合的实际 peer resolution 不可接受，必须停止并提交最小版本调整供 review，不得使用 `--force` 或 `--legacy-peer-deps`。

### 2.1 assistant-ui 传递依赖提醒

`@assistant-ui/react@0.15.18` 的发布包声明了 `@assistant-ui/core ^0.3.17`、`@assistant-ui/store ^0.3.12`、`assistant-stream ^0.3.41`、`zustand ^5.0.15` 等运行时依赖。这里的 `zustand` 是 assistant-ui 自身的传递实现依赖，不改变本项目禁止直接采用 Zustand 作为业务状态源的决定。R09 安装后必须检查 lockfile 的实际解析结果和许可证清单。

`@assistant-ui/react-markdown@0.14.14` 依赖 `react-markdown ^10.1.0`，并发布 `MarkdownTextPrimitive`；它的 peer 要求与上表匹配。

## 3. 测试配套候选

| 包 | 建议 pin | engines / peer | 用途 |
| --- | --- | --- | --- |
| `jsdom` | `26.1.0` | Node `>=18`；`canvas ^3.0.0` 为 optional peer | Vitest DOM 环境 |
| `@testing-library/react` | `16.3.2` | Node `>=18`；React/DOM types 18/19；`@testing-library/dom ^10.0.0` | React component tests |
| `@testing-library/dom` | `10.4.1` | Node `>=18` | Testing Library peer |
| `@testing-library/jest-dom` | `6.9.1` | Node `>=14` | DOM assertions |
| `vitest` | `3.2.4` | Node `^18 || ^20 || >=22`；Vite `^5 || ^6 || ^7`；jsdom optional peer | 保持现有 package 版本 |
| `typescript` | `5.9.3` | Node `>=14.17` | 保持 root 版本 |
| `@types/node` | `22.20.1` | TypeScript version floor `5.6` | 保持 root 解析版本 |

`jsdom` 的 `canvas` peer 是 optional；R09 不因它自动引入不需要的 native canvas 依赖。现有 package Vitest 3.2.4 与 Vite 6.4.1 的 peer 范围匹配，root 的 Vitest 3.2.7 差异必须保持可见，不在本任务顺手统一 workspace。

## 4. assistant-ui 公共 API 核对

核对对象为公开文档和发布 tarball 的 `dist/*.d.ts` / `src`，不是未安装的项目依赖。来源：

- [ExternalStoreRuntime 文档](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
- [Message primitive 文档](https://www.assistant-ui.com/docs/primitives/message)
- [LLM 文档](https://www.assistant-ui.com/docs/llm)
- `@assistant-ui/react@0.15.18` tarball，registry `https://registry.npmjs.org/@assistant-ui/react/-/react-0.15.18.tgz`
- `@assistant-ui/core@0.3.17` tarball，作为 react 的已声明核心依赖 API 来源
- `@assistant-ui/react-markdown@0.14.14` tarball

已核实的导出和类型：

- 从 `@assistant-ui/react` 导入 `AssistantRuntimeProvider`、`useExternalStoreRuntime`、`ThreadPrimitive`、`MessagePrimitive`、`ComposerPrimitive`、`ThreadMessageLike`、`AppendMessage`。
- `useExternalStoreRuntime<T>(store: ExternalStoreAdapter<T>): AssistantRuntime`。
- `ExternalStoreAdapter<T>` 具有 `messages`、`convertMessage`、`isRunning`、`isLoading`、`isDisabled`、`isSendDisabled`、必需 `onNew(message: AppendMessage): Promise<void>`，以及可选 `onCancel(): Promise<void>`、`onRefetchThread` 等能力回调。
- `AppendMessage` 包含 `parentId`、`sourceId`、`runConfig`，并允许 `startRun`、`steer`；本项目只将它作为 UI 适配输入，不绕过 `CommandGateway`。
- `ThreadMessageLike` 的 role 只有 `assistant | user | system`。content 可为字符串或 parts；已核实 `text`、`reasoning`、`image`、`file`、`data`、`generative-ui` 和 `tool-call` 等 part 形状。tool-call 支持 `toolCallId`、`toolName`、`args`、`argsText`、可选 `result`、`isError`、`parentId` 等。
- `MessagePrimitive.Parts` 的 children API 接收 `{ part }`。工具 part 的 `EnrichedPartState` 暴露 `toolUI`、`addResult`、`resume`、`respondToApproval`；data part 暴露 `dataRendererUI`。这支持按真实 call ID 将工具放在 transcript 的原位置。
- `MessagePrimitive.Parts` 可使用 `components` 或 children render function；本项目后续优先使用 children API，不依赖已标 deprecated 的 components 路径。
- `ThreadPrimitive.Messages` 的 children API 接收 `{ message }`；`ThreadPrimitive.MessageByIndex` 和 `ThreadPrimitive.Unstable_MessageById` 也已出现在发布类型中，但后者标记为 unstable，不能作为协议身份来源。
- `useExternalMessageConverter` 的 join strategy 是 `none` 或 `concat-content`；Pi Cafe 契约固定使用 `joinStrategy: "none"`，禁止相邻 assistant 消息隐式合并。
- `@assistant-ui/react-markdown@0.14.14` 发布 `MarkdownTextPrimitive`，并依赖 `react-markdown ^10.1.0`。`react-markdown@10.1.0` 的公开 `Options` 已核实 `skipHtml`、`allowedElements`、`disallowedElements`、`allowElement`、`remarkPlugins`、`rehypePlugins` 和 `urlTransform`。R09/R10 必须继续保持 URL、HTML 和资源渲染的安全边界；不得把不可信协议内容直接作为 HTML 注入。

未在 R01 采用的 API 假设：

- 没有假设 `@assistant-ui/react` 会理解 Pi 的自定义 wire part；必须先通过受限的 `ThreadMessageLike` 转换器。
- 没有使用 `useChatRuntime`、`useLocalRuntime`、`usePiRuntime`、AI SDK transport 或 assistant-ui tool executor。
- assistant-ui 公开类型中 `ToolCallMessagePart` 的 `args` 是受限对象形状，不允许把未经验证的任意 JSON 直接塞入 typed args；契约要求只有有界 JSON 对象校验通过时才填 `args`，始终保留受界的 `argsText`。
- 孤立的 tool result 不能强制伪造成 `role: "tool"`；需通过受限 `data`/custom fallback 展示。
- tool 执行状态必须在允许的 metadata/data 中保留，不能依赖 assistant-ui 运行时自行重新执行工具。

## 5. Go 依赖候选与来源

R01 只下载/读取模块元数据和源码，没有在仓库建立 `relay/go.mod` 或 `relay/go.sum`。生产 module 由 R03 创建。

| 模块 | 精确 pin | Go module 声明 | registry/module evidence |
| --- | --- | --- | --- |
| `github.com/gin-gonic/gin` | `v1.11.0` | `go 1.23.0` | `go list -m -json github.com/gin-gonic/gin@v1.11.0`；本地 module cache `go.mod` |
| `github.com/gorilla/websocket` | `v1.5.3` | `go 1.12` | `go list -m -json github.com/gorilla/websocket@v1.5.3`；本地 module cache `go.mod` |

现场 Go `1.24.2` 满足 Gin `v1.11.0` 的 `go 1.23.0`。查询 `github.com/gin-gonic/gin@latest` 得到 `v1.12.0`，其 `GoVersion` 为 `1.25.0`，因此 R01 不选择它。WebSocket latest 仍为 Gorilla `v1.5.3`，发布时间 `2024-06-14`。

已获取并保留在本机 Go module cache 的校验信息；R03 生成 module 时必须让 `go mod tidy` 产生提交的 sums，并复核供应链 diff。

### 5.1 Gin API evidence

对 Gin `v1.11.0` module source 执行 `go doc`，得到：

- `gin.New(opts ...OptionFunc) *Engine` 返回没有 middleware 的空 Engine；默认 `RedirectTrailingSlash=true`、`RedirectFixedPath=false`、`HandleMethodNotAllowed=false` 等。
- `(*Engine).NoRoute(handlers ...HandlerFunc)` 注册 404 fallback。
- `(*Engine).NoMethod(handlers ...HandlerFunc)` 仅在 `HandleMethodNotAllowed=true` 时调用。
- `(*Engine).SetTrustedProxies([]string) error`；默认会信任 proxies，Relay 若不需要 forwarded client IP 应显式调用 `SetTrustedProxies(nil)`。
- `Engine.HandleMethodNotAllowed` 可产生 405；`RedirectTrailingSlash` 和 `RedirectFixedPath` 是独立路由重定向行为。

Relay 实现必须显式设置路由重定向、trusted proxies、method handling、静态资源 fallback 和错误响应策略，不得把 Gin 默认值当作安全策略。

### 5.2 Gorilla WebSocket API evidence

对 Gorilla WebSocket `v1.5.3` module source 执行 `go doc`，得到：

- `Upgrader.CheckOrigin` 默认在 Origin 存在且 host 不同于 request Host 时拒绝；应用必须保留明确的 Origin policy，不能无条件 `return true`。
- `Conn.SetReadLimit(int64)` 超限时发送 close 并返回 `ErrReadLimit`。
- `Conn.NextReader()` 返回 text/binary data reader；返回错误是永久错误，应用必须离开读取循环。
- `SetReadDeadline` 和 `SetWriteDeadline` 在超时后连接状态不可继续使用，必须关闭并清理 session。
- `WriteControl` 可并发于其他方法；普通连接支持一个并发 reader 与一个并发 writer，应用负责串行化写入。
- `EnableWriteCompression` 只影响后续数据写入，未协商 compression 时是 no-op；Relay 默认不因该 API 开启压缩。

这些 API facts 支持既定的 Relay 设计：有界读取、单 writer、明确 read/write deadline、显式 close、同源/允许来源检查，并由 Pi Extension 保持唯一 AgentSession 所有权。

## 6. Lockfile 与安装边界

- R01 没有执行 `npm install`、`npm update`、`npm ci`、`go mod init` 或 `go mod tidy`。
- 当前 package 没有 React/Vite/assistant-ui 直接依赖；R01 不改变 package manifests 或任何 lockfile。
- R09 必须在批准的精确版本下执行一次受控安装，使用 npm 默认 peer resolution，禁止 `--force` 和 `--legacy-peer-deps`；安装前后应记录 lockfile diff、实际 peer tree、Node engine warnings、audit/许可证结果。
- `package-lock.json` 仍是根 workspace 唯一锁文件；不得在 `packages/pi-cafe-space` 生成第二份 lockfile。
- Go 依赖版本在 R03 通过仓库内 `relay/go.mod`/`go.sum` 固定；R01 的 module cache 不属于提交内容。

## 6.1 R09 用户批准的实际版本修正（2026-09-18）

用户批准最小版本调整、Vitest4.1.11、隔离Node22和根唯一lockfile跟踪。上表与第8节原SRI保留为R01历史证据，不是当前manifest。当前新增pin：axios1.18.0、lodash-es4.18.1、nanoid5.1.16、react-router7.18.2、vite6.4.3、vitest4.1.11。六个tarball已重新下载校验SHA512，具体SRI固定在根`package-lock.json`及`.refactor/reports/R09/integrity-approved.json`。其余直接pins未变。

实际runtime：便携Node22.23.2（最低engine仍22.19.0），SHA256 `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` 匹配nodejs.org SHASUMS。npm10在Vitest4 optional peer递归时报null edgesOut，隔离npm11.16.0默认resolver完成（无force/legacy）。core传递依赖锁回R01核对的0.3.17，在react的^0.3.17合法范围内；assistant-cloud0.1.43为react原依赖，hoist后同时满足core optional peer，仅依赖解析，不启用Cloud服务。

安装后公开API编译/DOM smoke验证ExternalStoreAdapter要求非标准message显式convertMessage、useExternalStoreRuntime、AssistantRuntimeProvider、ThreadPrimitive.Messages、MessagePrimitive.Parts children、Composer Send/Cancel、MarkdownTextPrimitive。workspace audit为0；根其他workspace Vitest3.2.7/mocker仍2 moderate，未获准升级也未宣称root零风险。

## 7. 未解决项与 review 问题

**R09 实装补充（2026-09-18）**：上述原pins已安装，npm peer tree退出0，但不等于兼容/安全验收通过。当前assistant-ui传递core0.3.19/stream0.3.43要求nanoid6.0.1，不支持现场Node23；core0.3.17/stream0.3.41同样要求nanoid6。audit报告原pins及旧Vitest的风险，待用户批准最小版本修正及隔离Node22测试，详[PROGRESS第18节](./PROGRESS.md#18-r09-安装结果与新实质阻塞2026-09-18)。本表尚未改为未授权的新pins；Web/API实装验收仍待完成。

1. R09 安装后需要用实际 `node_modules` 的 TypeScript declarations 重新确认 assistant-ui `ExternalStoreAdapter`、`ThreadMessageLike`、`MessagePrimitive.Parts`、`ComposerPrimitive.Send/Cancel` 的版本形状；R01 的 tarball 检查不能代替安装后检查。
2. Pi event 到 ordered transcript parts 的准确字段和顺序仍需 R12 对真实 Pi 事件与 fixtures 取证；现有 flattened projection 不能可靠推断 tool ownership/placement。
3. `@assistant-ui/react-markdown` 的安全配置（尤其 URL transform、HTML policy、代码块渲染）要在 R10 根据实际 UI 需求和 CSP 决定，并测试恶意链接/HTML。
4. `@testing-library/*` 的最终 peer resolution 由 R09 真实安装确认；若 npm 报 peer conflict，必须回到 review，不得绕过 resolver。
5. `@assistant-ui/react@0.15.18` 及其核心/存储包使用的内部 API 不是本项目业务 contract；业务适配器只能依赖发布公开 exports。
6. Go 的完整 indirect dependency graph、构建标签和 Windows `go:embed` 产物行为等必须在 R03/R16 的实际 module/build 中验证。
7. 现有运行中的 Pi、Relay、Chrome、PID markers 和 `dist` 未由 R01 修改；清理/迁移需后续明确授权。

## 8. R01 结论

用户已明确要求落地功能，按连续执行授权完成 R01 遗留问题后进入 R02，不再等待例行审批。2026-09-18T05:45:39Z 开始补查以下 28 个精确版本的 registry metadata 并下载 tarball 至内存，逐个计算 SHA-512，与 `dist.integrity` 比较，全部一致（退出码 0）。没有安装、解压至项目或修改 lockfile。此校验是来源/字节一致性检查，不等于安全审计或实际安装兼容性验证；后续任务继续执行相应验收。

### 8.1 固定来源与 SRI 清单

查询日期统一为 2026-09-18 UTC。下表每行的 `name` 和 `version` 是精确值；来源 URL 按以下无歧义规则展开（不是 latest）：

- metadata：`https://registry.npmjs.org/{name}/{version}`，例如 `https://registry.npmjs.org/@assistant-ui/react/0.15.18`。
- tarball：`https://registry.npmjs.org/{name}/-/{basename}-{version}.tgz`；`basename` 是去掉 scope 后的包名，例如 `https://registry.npmjs.org/@assistant-ui/react/-/react-0.15.18.tgz`。28 行的实际 `dist.tarball` 均符合此规则。
- 复核：读取 metadata 的 `dist.tarball`，计算下载字节的 SHA-512 Base64，加 `sha512-` 前缀后同时对比 metadata 与本表；任何不一致都不能安装。

| name | version | 已匹配下载字节的 dist.integrity |
| --- | --- | --- |
| react | 19.2.4 | `sha512-9nfp2hYpCwOjAN+8TZFGhtWEwgvWHXqESH8qT89AT/lWklpLON22Lc8pEtnpsZz7VmawabSU0gCjnj8aC0euHQ==` |
| react-dom | 19.2.4 | `sha512-AXJdLo8kgMbimY95O2aKQqsz2iWi9jMgKJhRBAxECE4IFxfcazB2LmzloIoibJI3C12IlY20+KFaLv+71bUJeQ==` |
| @types/react | 19.2.14 | `sha512-ilcTH/UniCkMdtexkoCN0bI7pMcJDvmQFPvuPvmEaYA/NSfFTAgdUSLAoVjaRJm7+6PvcM+q1zYOwS4wTYMF9w==` |
| @types/react-dom | 19.2.3 | `sha512-jp2L/eY6fn+KgVVQAOqYItbF0VY/YApe5Mz2F0aykSO8gx31bYCZyvSeYxCHKvzHG5eZjc+zyaS5BrBWya2+kQ==` |
| @assistant-ui/react | 0.15.18 | `sha512-hjjz+9+pY54jCyaCAO+c3Q2M715MGzvlJw2yx+jSqOZGc0znJmSId+6NXH8TwO3JX8lESHqQcVB1dWpFdAlq6A==` |
| @assistant-ui/react-markdown | 0.14.14 | `sha512-hIydHkah5xUamtLBdWsezq/8b3xWvn1M3ixBXTUKfDihv3kBUPYH2AEgPlNrjSc9ZxYvoen9MzJDS+QTDaMOeg==` |
| vite | 6.4.1 | `sha512-+Oxm7q9hDoLMyJOYfUYBuHQo+dkAloi33apOPP56pzj+vsdJDzr+j1NISE5pyaAuKL4A3UD34qd0lx5+kfKp2g==` |
| @vitejs/plugin-react | 4.7.0 | `sha512-gUu9hwfWvvEDBBmgtAowQCojwZmJ5mcLn3aufeCsitijs3+f2NsrPtlAWIR6OPiqljl96GVCUbLe0HyqIpVaoA==` |
| sass | 1.97.3 | `sha512-fDz1zJpd5GycprAbu4Q2PV/RprsRtKC/0z82z0JLgdytmcq0+ujJbJ/09bPGDxCLkKY3Np5cRAOcWiVkLXJURg==` |
| axios | 1.13.6 | `sha512-ChTCHMouEe2kn713WHbQGcuYrr6fXTBiu460OTwWrWob16g1bXn4vtz07Ope7ewMozJAnEquLk5lWQWtBig9DQ==` |
| clsx | 2.1.1 | `sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==` |
| i18next | 25.8.13 | `sha512-E0vzjBY1yM+nsFrtgkjLhST2NBkirkvOVoQa0MSldhsuZ3jUge7ZNpuwG0Cfc74zwo5ZwRzg3uOgT+McBn32iA==` |
| react-i18next | 16.5.4 | `sha512-6yj+dcfMncEC21QPhOTsW8mOSO+pzFmT6uvU7XXdvM/Cp38zJkmTeMeKmTrmCMD5ToT79FmiE/mRWiYWcJYW4g==` |
| immer | 11.1.4 | `sha512-XREFCPo6ksxVzP4E0ekD5aMdf8WMwmdNaz6vuvxgI40UaEiu6q3p8X52aU6GdyvLY3XXX/8R7JOTXStz/nBbRw==` |
| use-immer | 0.11.0 | `sha512-RNAqi3GqsWJ4bcCd4LMBgdzvPmTABam24DUaFiKfX9s3MSorNRz9RDZYJkllJoMHUxVLMDetwAuCDeyWNrp1yA==` |
| lodash-es | 4.17.23 | `sha512-kVI48u3PZr38HdYz98UmfPnXl2DXrpdctLrFLCd3kOx1xUkOmpFPx7gCWWM5MPkL/fD8zb+Ph0QzjGFs4+hHWg==` |
| @types/lodash-es | 4.17.12 | `sha512-0NgftHUcV4v34VhXm8QBSftKVXtbkBG3ViCjs6+eJ5a6y6Mi/jiFGPc1sC7QK+9BFhWrURE3EOggmWaSxL9OzQ==` |
| modern-normalize | 3.0.1 | `sha512-VqlMdYi59Uch6fnUPxnpijWUQe+TW6zeWCvyr6Mb7JibheHzSuAAoJi2c71ZwIaWKpECpGpYHoaaBp6rBRr+/g==` |
| nanoid | 5.1.6 | `sha512-c7+7RQ+dMB5dPwwCp4ee1/iV/q2P6aK1mTZcfr1BTuVlyW9hJYiMPybJCcnBlQtuSmTIWNeazm/zqNoZSSElBg==` |
| react-router | 7.13.0 | `sha512-PZgus8ETambRT17BUm/LL8lX3Of+oiLaPuVTRH3l1eLvSPpKO3AvhAEb5N7ihAFZQrYDqkvvWfFh9p0z9VsjLw==` |
| jsdom | 26.1.0 | `sha512-Cvc9WUhxSMEo4McES3P7oK3QaXldCfNWp7pl2NNeiIFlCoLr3kfq9kb1fxftiwk1FLV7CvpvDfonxtzUDeSOPg==` |
| @testing-library/react | 16.3.2 | `sha512-XU5/SytQM+ykqMnAnvB2umaJNIOsLF3PVv//1Ew4CTcpz0/BRyy/af40qqrt7SjKpDdT1saBMc42CUok5gaw+g==` |
| @testing-library/dom | 10.4.1 | `sha512-o4PXJQidqJl82ckFaXUeoAW+XysPLauYI43Abki5hABd853iMhitooc6znOnczgbTYmEP6U6/y1ZyKAIsvMKGg==` |
| @testing-library/jest-dom | 6.9.1 | `sha512-zIcONa+hVtVSSep9UT3jZ5rizo2BsxgyDYU7WFD5eICBE7no3881HGeb/QkGfsJs6JTkY1aQhT7rIPC7e+0nnA==` |
| vitest | 3.2.4 | `sha512-LUCP5ev3GURDysTWiP47wRRUpLKMOfPh+yKTx3kVIEiu5KOMeqzpnYNsKyOoVrULivR8tLcks4+lga33Whn90A==` |
| typescript | 5.9.3 | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` |
| @types/node | 22.20.1 | `sha512-EANqOCF9QFyra+4pfxUcX9STKJpCLjMbObVzljIJomAWSnuSIEAvyzEU53GaajbXJEgdh0iEcPL+DGvpUd4k1Q==` |
| @assistant-ui/core | 0.3.17 | `sha512-qWiFVxFsnR4iBt6lZX8KFzf6gnL7uo5PQLgxZlbkUZn6dIzQByzmeFZfKp6vnVaPFN0B4qtc2hyCnDnWmtl7bw==` |

`@assistant-ui/core` 仅列为已核对 API 的传递依赖证据，不新增为业务直接依赖。
