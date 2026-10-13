# 重构执行入口：给逐步执行任务的 AI

> 本文件规定连续执行方式，不代表读到文档就获得实施授权。当前进度以 PROGRESS 为准。
>
> 用户可一次授权一个任务或连续范围；范围内按顺序执行、验证、自检，不因普通 review 检查点中断询问。仅要求修改方案不等于授权实施。

## 1. 怎么使用这些文档

两份架构文档说明“为什么这样设计”，但不是可以整篇一次性执行的任务。具体执行以本入口、任务卡和实现约定为准。

| 文档 | 用途 |
| --- | --- |
| [REFACTOR_EXECUTION.md](./REFACTOR_EXECUTION.md) | 执行规则、停止条件、验证命令与交接格式；每次开始先读 |
| [refactor/TASKS.md](./refactor/TASKS.md) | R00–R19 任务卡；在获准范围内逐项推进 |
| [refactor/CONTRACTS.md](./refactor/CONTRACTS.md) | 固定的接口、消息、构建目录和测试规则；不能自行改名换方案 |
| [refactor/PROGRESS.md](./refactor/PROGRESS.md) | 当前状态和证据索引；没有证据不能标 done |
| [WEB_REFACTOR_PLAN.md](./WEB_REFACTOR_PLAN.md) | 总体架构与前端设计 |
| [RELAY_GO_REFACTOR_PLAN.md](./RELAY_GO_REFACTOR_PLAN.md) | Go/Gin Relay 的边界与并发设计 |

阅读顺序：本入口 → PROGRESS → 当前任务卡 → 该卡引用的 CONTRACTS 章节 → 相关源文件。不要每次把所有任务重新解释一遍，也不要从下一任务挑喜欢的功能先做。

优先级：用户最新指令和安全约束 > 本执行手册的固定决策 > 两份架构文档的概述。发现相互矛盾时停止并提问，不把矛盾当作自由发挥的空间。

任务卡的“预期测试”是**要实现的测试**，不是现在已存在或已通过的测试。

## 2. 不可改动的方向

1. Web：React、Vite、TypeScript、axios、clsx、i18next、react-i18next、immer、use-immer、lodash-es、nanoid、react-router，以及 assistant-ui。2026-09-29用户明确授权shadcn/ui（Base UI）+ Tailwind v4：共享控件用Tailwind，现有页面SCSS Modules保留，Preflight替代入口normalize；见PROGRESS §43。
2. Relay：Go + Gin + Gorilla WebSocket，单进程内存状态；最终用 go:embed 内嵌 Web 资源。
3. Pi extension：继续 TypeScript，原生 Pi 是唯一 AgentSession owner。
4. React 接 `useExternalStoreRuntime`，不是 `useChatRuntime`、`useLocalRuntime`、`usePiRuntime` 或模型 API 示例。
5. Router 使用 HashRouter；不加入 Next.js、SSR、Redux、Zustand、Redis、数据库、Socket.IO 或 AI SDK 服务端。Tailwind仅按§43用户指定的UI接入授权，不改变聊天/runtime架构。
6. 工具在对话内容中按真实 ID 关联；不能做独立面板，也不能把全部工具挂到最后一条 assistant。
7. Web 不执行工具；Relay 不调用模型、不读写 Pi JSONL、不读电脑项目文件、不接触 provider API key。
8. 保留 `PI_COLLAB_*`、`/collab-*`、相关 CLI flags、storage keys、任意 PiArgs、现有 wire v1 的合法兼容用法。
9. 原有帧、JSON、路径、缓存、连接和时间限制不能删掉或放宽来让测试通过。
10. `private: true` 不变；没有用户指令不得发布 npm package、commit/amend/push 或改全局 Pi/provider 配置。

## 3. 范围授权，逐项连续执行

用户可以授权唯一 `Rxx` / `Rxx.n`，也可以授权连续范围（例如 R01–R17）。单任务授权仍只做该任务；范围授权不需要每项再次确认。已有范围授权下的“继续”表示从 PROGRESS 断点继续该范围；没有范围授权时不自行推定全部任务已获准。

范围内每个任务严格遵循：

1. 确认当前任务在授权范围内，检查依赖任务的验收和检查点已完成。
2. 读取 `git status` 和当前 diff；记录已有用户修改，不 reset、不覆盖、不把它们混进本任务。
3. 列出本任务允许修改的文件与要新增的测试。
4. 先写失败测试或可运行验收脚本，再写实现。测试应证明缺陷或契约，不只是证明“文件存在”。
5. 只实现当前卡片，不顺便美化其他页面、更新其他 package 或更换技术选型。
6. 执行本卡规定的验证，保存精简证据，不保存 token 和真实聊天全文。
7. 自检 diff 是否越界、是否包含秘密/产物、是否减弱校验。
8. 更新 PROGRESS 并给出简短进度，在授权范围内继续下一任务，不为例行 review 等待用户回复。到范围末尾、用户要求暂停或第 7 节的实质阻塞时才停止。

任务卡中的“审查”是内置质量检查点，不是逐项人工审批。执行者依据类型/源码、测试和 diff 核对并记录结论；可使用只读独立检查辅助，但不以等待 subagent 作为例行中断理由。发现授权范围内可修复的问题，修复并复验后继续；不能把自检写成独立 reviewer 批准，也不能无证据放行。

如果一个任务在一个上下文窗口内做不完，按卡片内部步骤停在可说明的边界，记录 `doing` 或 `blocked` 及剩余授权范围，恢复时无需重复申请已获授权的任务。不能把未测试实现标为完成。

## 4. 修改范围与现有进程保护

仓库：`C:\Users\example-user\Documents\cafecodework-pi-packages`。

默认业务修改范围仅 `packages/pi-cafe-space/`。根 `package.json` / `package-lock.json` 只有任务卡显式允许时才可改；其他 Pi packages、用户 home 配置和外部旧副本不得动。

每轮执行前后：

```powershell
Set-Location -LiteralPath 'C:\Users\example-user\Documents\cafecodework-pi-packages'
git status --short --branch
git diff --check
```

**禁止：**

- 不得按端口冲突直接 kill 进程，不得用 `taskkill /IM node.exe`、批量停止 Chrome 等操作。
- 不得停止现有 Pi、37891 Relay、9222 Chrome，或删除它们的 PID marker。
- 不得把历史记录中的 PID 当作当前所有权证明；PID 会复用。
- 不得直接修改/清空用户 session JSONL，不得让测试连接真实 room 后发 prompt/abort。
- 不得未经确认执行 `pi remove`、`pi install`、`/reload` 或生产启动/停止脚本来“让改动生效”。
- 不得使用 tmux、ttyd、SSH、终端录制、截图或终端镜像做验收。
- 不得执行 `git reset --hard`、`git clean -fdx` 或粗暴删除全部 runtime/temp。

浏览器测试：只使用 Chrome SxS、新 profile、Relay 37983、CDP 9333。端口已占用就停止查明，不清理未知 owner。只可结束本轮明确创建并重新核对身份的进程。

## 5. 构建隔离

迁移期除 Go package 内必须存在的受控 embed 暂存区外，新产物都放到 package 的 `.refactor/`（须先加入 ignore）。Vite staging、Go binary、测试报告都不得覆盖当前 `dist/`。

- `web/public/app.js`、`index.html`、`styles.css` 在切换前是旧客户端，不能被新空壳覆盖。
- 最终 `web/public` 只留静态资源，但这是 **R19** 才允许做的事；此前 Vite 用独立的 `publicDir`，见 CONTRACTS。
- 不运行当前会 clean `dist` 的 package build/prepack 作为早期验证。
- `go:embed` 需要的暂存资源必须位于 Go package 内；不能写 `../../web/dist` 的 embed pattern。固定路径见 CONTRACTS。
- 不把空的 embed 测试资源当作完整 Web 发行产物。

只做文档时不需要重新构建项目，也不要报告“Go/React 测试通过”。

## 6. 验证命令规则

### 6.1 现有命令（R00 即可运行，无需构建）

以下在原生 Windows PowerShell 运行；每条外部命令后检查 `$LASTEXITCODE`，非零则停止：

```powershell
Set-Location -LiteralPath 'C:\Users\example-user\Documents\cafecodework-pi-packages'
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm.cmd run pi-cafe-space:check
if ($LASTEXITCODE -ne 0) { throw 'package check failed' }
npm.cmd run pi-cafe-space:test
if ($LASTEXITCODE -ne 0) { throw 'package tests failed' }
```

不要硬编码“65 项通过”；读取当前 runner 输出并记录实际文件/测试数。不要把 skipped、timeout 或命令未找到记作 pass。

### 6.2 待任务创建的命令

这些命令是目标名称，不保证现在存在。只有对应任务创建后才能运行并记录结果：

| 命令（在 package 根） | 首次建立 | 作用 |
| --- | --- | --- |
| `npm.cmd run refactor:contracts:test` | R02 | TS fixtures runner / 契约验证 |
| `npm.cmd run refactor:web:check` | R09 | 新前端 TypeScript 检查 |
| `npm.cmd run refactor:web:test` | R09 | 新前端 Vitest，不漏 `web/src` |
| `npm.cmd run refactor:web:build` | R09 | 新 Vite 产物 → `.refactor/web` |
| `npm.cmd run refactor:relay:build` | R16 | 校验 Web、准备 embed、构建本平台 Go binary |
| `npm.cmd run refactor:integration:test` | R18 | 明确使用测试 binary 的隔离集成验收 |

Go module 建立后，在 `packages/pi-cafe-space/relay` 运行 `go test ./...`、`go vet ./...`；`go test -race ./...` 需有对应平台支持的工具链。没有 Go 或 race 工具链时标 blocked，请用户提供/允许安装，不能改为“不需要测试”。

Fuzz 每个目标用精确名称单独执行，例如 `go test ./internal/protocol -run '^$' -fuzz '^FuzzDecodeWire$' -fuzztime 30s`；必须先有 seed corpus。不要声称 30 秒 fuzz 证明不存在漏洞。

WS/CDP 等异步验收必须先注册 waiter 再触发操作。CDP 的 browser socket 只作目标管理，页面操作连接 `/json/list` 中的真实 page target。测试有超时和 finally 清理。

WSL 没有可用 Linux Node 时，不绕过原生 Windows 验证。不把复杂 PowerShell/Node 源码塞进多层 Bash/cmd `-e` 引号；使用受控脚本文件。

## 7. 必须停止询问的情况

| 情况 | 不允许的替代行为 | 正确动作 |
| --- | --- | --- |
| Go 未安装、依赖 registry/网络不可达 | 假装安装成功、换语言/库、改用户 PATH | 记录版本/错误，不含秘密，标 blocked |
| peer dependency 不兼容 | `--force`、`--legacy-peer-deps`、更新全部 package | 提交最小兼容版本建议等待确认 |
| TS/Go 差异涉及未决语义或无法保持兼容 | 改 golden output 迁就 Go、丢弃字段 | 先按冻结的 TS 基线与 fixtures 修复实现并复验；仅基线语义不明确、无法保持兼容或需改变协议/安全策略时，提交最小输入及差异等待用户决策 |
| 不知道 Pi 字段/事件顺序 | 依工具名/时间猜归属 | 读已安装 API 文档及类型，建最小实验；仍不确定则停 |
| snapshot/事件超限 | 提高 MAX_FRAME_BYTES 或关校验 | 修复裁剪与预算；无法无损则保留截断标记 |
| token/Origin/CSP 阻止 demo | 默认 allow-all、去掉认证、加 unsafe-eval | 修正同源/资源/组件；确需政策变化先询问 |
| 需要动未授权文件或现有服务 | 顺手重构/停止进程 | 报告所需范围及理由等待授权 |
| 旧测试失败 | 删断言、skip、扩大 timeout 掩盖 | 先定位；属于基线问题则阻塞，不混合修复 |
| 需要修改 wire 必填字段或新增 command | 单方改浏览器/Go | 停止，更新契约并经过 reviewer |
| 只通过模拟 host 或构建 | 写“真实 Pi 已验证” | 明确标未验证，保留 R18/R19 gate |

协议边界、并发、Pi 事件映射和进程终止仍必须有可复核检查与测试证据；普通检查点由执行流程内完成，不要求每项人工确认。既定契约内的实现缺陷可自行修复；需要改变协议或安全策略、证据仍不足、越出授权范围时才请求用户决策。R18 真实 Pi/Chrome、模型额度和 candidate 安装的专项权限，以及 R19.1 接线权限，可以由用户提前明确授予，但不省略各自验收前置条件。R19.2 必须在 R19.1 接线及新版本验证后，由用户确认新版本可用并明确同意清理；提前授予的清理权限不能代替这项事后确认。

## 8. 每个任务的结束输出

每项在 PROGRESS 保存以下记录；连续执行期间仅输出简短进度，不因此停止。范围结束或实质阻塞时给出汇总：

```text
任务：Rxx — 标题
状态：done / needs_review / blocked / doing
修改：逐个列出文件及目的
验证：完整命令、退出码、实际测试结果
未验证：平台、真实 Pi、浏览器或故障路径
与契约差异：无；或逐项列出
进程/资源：创建过哪些；哪些已确认清理；无权清理哪些
下一步：授权范围内的下一任务 ID；或需用户决定的阻塞/额外授权
```

证据保存在 `.refactor/reports/Rxx/`（不提交），PROGRESS 只存脱敏摘要、路径、命令和时间。稳定 fixtures/测试要提交源码目录，不能只留在临时报告里。

`done` 需要本卡验收证据（文档任务使用文档/API 核对证据），且内置检查点已完成。普通检查点通过后可直接标 `done`，不必先进入 `needs_review`。仅对确需外部决策的未决事项使用 `needs_review`；测试/工具实质阻塞使用 `blocked`。空输出/超时 subagent 不算已完成检查，可由执行者据实完成检查，但不可冒称独立审查。

## 9. 可直接交给执行 AI 的提示词

下面是**用户决定开始实施后**使用的提示词。此处文本本身不是实施授权：

```text
仓库：C:\Users\example-user\Documents\cafecodework-pi-packages。
只执行 packages/pi-cafe-space/docs/refactor/TASKS.md 的 R00。
先完整阅读 packages/pi-cafe-space/docs/REFACTOR_EXECUTION.md
和 packages/pi-cafe-space/docs/refactor/PROGRESS.md。
不要执行 R01 或后续任务。
不要安装依赖、改业务代码、运行会覆盖 dist 的 build/prepack、停止现有进程或改全局配置。
遵守任务卡允许文件范围。验证失败标 blocked，不得删测试或猜测成功。
完成后按执行入口的交接格式输出结果并停止。
```

上面这段是单任务授权示例，不能只替换编号后继续沿用其中的限制。连续执行使用下面的模板，由用户填写范围：

```text
仓库：C:\Users\example-user\Documents\cafecodework-pi-packages。
本轮授权范围：【填写连续范围，例如 R01–R17；也可填写单个 Rxx / Rxx.n】。
先读 packages/pi-cafe-space/docs/REFACTOR_EXECUTION.md、
同目录 refactor/PROGRESS.md，以及 refactor/TASKS.md 的对应任务卡。
按顺序逐项实施、验证并更新 PROGRESS；普通 review 检查点在流程内完成，不停下来等待逐项确认。
范围内问题自行修复并复验；实质阻塞、未知 API 无法验证、协议/安全策略变更或白名单外修改时才询问。
到范围末尾停止；不要越出授权范围、切换现有服务、改全局配置或 commit/push。
按执行入口规定格式给出真实验证证据及未验证项。
```

R18 的真实 Pi/Chrome/模型额度/candidate 安装和 R19 的两个切换/清理检查点仍需明确授权；普通范围授权不隐含这些操作。R18 专项权限及 R19.1 接线权限可提前授予；R19.2 仍需在接线与验证后取得用户可用性确认及清理同意，不能用提前授权替代。连续执行不等于一次性重写或跳过中间验收。
