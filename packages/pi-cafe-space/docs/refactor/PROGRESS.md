# 重构执行进度

> 当前状态：**R00–R17、R18.1 已完成；R18 受控 provider 的真实 Pi/AgentSession、Chrome SxS、历史/文件及 Windows 候选安装验收也已通过。真实浏览器发现的抽屉焦点问题已修复、重新打包并全量复验。候选见 §33，[复验/产物说明](./CANDIDATE.md)。用户授权后的外部验收仅发送1次请求，收到HTTP 403即停止，R18.2现为blocked，见§34。用户随后选择亲自测试，本机试用版已安装，见§35；又按普通Pi启动自动注册的需求启用本机Cafe Space全局注册接线，见§36。房间URL、Café Workspace及Radix控件已部署到37983，见§38–42。用户后续指定的shadcn/ui + Tailwind已实现、验证并部署到37983，见§43–44；控件描边修复已验证并部署，见§45–46；截图反馈的Composer内外双框已修复并部署，见§47–48；会话工作区版见§49；原生会话管理版支持新建/重命名当前会话/继续历史，首次启用需在已有Pi空闲时执行一次/reload，见§50；精简导航/紧凑选择框见§51；当前37983已部署pack-Kmks1J斜杠命令/文件引用版，需刷新网页并在所选Pi空闲时执行一次/reload，见§52。仓库R19生产默认入口未切换。**
>
> 授权范围：原 R02–R17/R18.1 实施范围已完成；用户随后“开始”启动隔离 R18.2–4 专项，先使用明确标记的本地受控 provider（§32–33），不动全局配置、现有服务或生产默认。用户随后“按此执行”明确授权cafe/gpt-6-astra、最多2次调用/每次1024输出tokens/无自动重试/总60秒；该单次授权已因403封存，不自动续用。随后用户“真正的在本机安装启动 我自己来测试”授权独立持久安装/交互窗口启动，不授权助手自动发prompt；§35实例留给用户手动操作。随后用户要求Web看到普通Pi实例，并提出启动注册，已仅替换本机全局packages中的Cafe Space一项，未改provider设置，见§36。用户随后明确“开始重构ui页面”，授权按已安装的Cafe设计skill重做Web呈现及隔离验证，未授权重启现有服务。不能把受控流当成外部模型通过。R19 切换、切换后的清理确认及新一轮 commit/push 均不由本次验收自动授权。规则见 [执行入口](../REFACTOR_EXECUTION.md)。

## 1. 状态定义

- `todo`：未开始，不代表前置条件已满足。
- `doing`：已获授权并有进行中的修改，尚未通过全部验收。
- `blocked`：缺工具、基线失败、协议差异、未获授权等，不能自动绕过。
- `needs_review`：存在需要用户/外部决策的实质未决事项，不用于普通自检检查点。
- `done`：任务验收及内置检查通过并有证据；不要求逐项人工批准。

## 2. 任务表

| ID | 任务 | 状态 | 证据 / review |
| --- | --- | --- | --- |
| R00 | 现场与基线 | done | [BASELINE.md](./BASELINE.md)；三项现有检查退出码均为 0，65 tests passed |
| R01 | 版本/API 核对 | done | [VERSIONS.md](./VERSIONS.md) 第 8 节；28 个精确版本 tarball 字节与 registry SRI 全部一致 |
| R02 | v1 fixtures | done | 307 pure fixtures + 17 traces + coverage assertion；325 新测试通过；原 65 项不回退 |
| R03 | Go 配置/纯协议 | done | Go module/config/codec/reducer；307 shared fixtures、Go tests/vet 通过；fuzz 845418 次无失败 |
| R04 | Gin HTTP | done | HTTP/headers/assets/admission、44 个 TS 来源 Origin 用例、Go tests/vet 与 TS 回归通过 |
| R05 | WebSocket transport | done | 普通 tests/vet；Windows 全量 race 与 transport race 重复 30 次均退出 0 |
| R06 | room/host 投影 | done | 四条 frozen host traces；admission/expiry/compaction/queue tests；全量 race 与 hub race 10 次通过 |
| R07 | command/cache | done | 14 条共享 hub traces、命令预算/容量/竞态测试、全量及 hub 10 次 race 通过 |
| R08 | Go v1 验收 | done | TS synthetic peers 对真实 Go HTTP/WS 跑17 traces，普通/race均18 tests通过；全量race/fuzz/lifecycle通过 |
| R09 | Web 骨架 | done | Node22/Vitest4、workspace audit0、Web check/2 smoke/build、旧391 tests通过 |
| R10 | RelayClient | done | generation/认证/重连/HTTP/storage/StrictMode；Web6 files11 tests通过 |
| R11 | store/Gateway | done | Web9 files28 tests、原391+325 contracts、Node22/Vitest4真实Go race traces18 tests通过 |
| R12 | parts 契约审查 | done | PARTS_REVIEW；双版本实际agent-loop无provider实验；51codec/11reducer/ordered/native/15projection fixtures |
| R13 | parts 投影链 | done | TS476/Web29、Go tests/vet/race、原325契约+19真实Go traces；parts producer/历史/预算/重连已验收 |
| R14 | assistant-ui 对话 | done | pure converter8+component5 tests；实际ExternalStore/Parts/Markdown；Web42、TS476与19Go traces通过 |
| R15 | Composer/页面 | done | Web18 files56 tests；R18 发现并修复真实抽屉 Tab 循环问题；Chrome 几何/焦点/滚动通过，见§33 |
| R16 | embed/build/package | done | validator/plugin8 tests、candidate4 tests、隔离最终source-build/check/test1 test；tagged Go tests；standalone+pack通过，见§29 |
| R17 | 本地启动迁移 | done | TS3 tests、原生Windows2 tests（真实CIM/跨launcher竞争/ACL/stop/PowerShell/PiArgs shim）；重建pack通过 |
| R18.1 | 确定性全链路 | done | fresh embedded Go + 从其 HTTP 取得的实际 React bundle + synthetic peers；全量回归/fuzz/pack，见§31 |
| R18.2 | 真实 Pi/模型专项 | blocked | 受控原生部分通过；已授权的cafe/gpt-6-astra首个外部请求返回403，未重试；§35真实交互试用实例已就绪，等待用户手动测试结果 |
| R18.3 | 真实浏览器/历史/文件 | done | Chrome SxS 三种尺寸、CSP/焦点/滚动、custom sessionDir/大历史/真实 opened ID-cwd 拒绝通过 |
| R18.4 | 包与平台 | done | 25-file tarball 实际隔离安装、package manifest 加载、standalone 和源码回归通过；仅 windows-amd64 实测 |
| R19 | 显式生产切换 | todo | 未授权；旧实例不得自动停止 |

## 3. 已知条件与未决事项

1. 仓库的生产默认入口仍是原生 DOM Web + Node/TypeScript Relay + 原生 Pi TypeScript extension；本机试用Go/React已运行，且普通Pi的Cafe Space全局注册项已单独接入它（§36）。这不是仓库R19默认launcher切换或发布。
2. R03/R09已实际安装、锁定并验证Go/Web依赖；R09经用户批准调整了安全修复版本和隔离Node/npm工具链，历史R01候选证据仍保留但不是当前全部安装版本。
3. 有序 parts 已按R12实际双版本agent-loop证据及R13投影回归落地；R14/15消费该结构，未以工具名/时间猜测关联。
4. 旧工作已有测试和提交记录，但不能代替 R00 当前基线或 R18 新产物证据。
5. 用户此前单独授权的R00–R11提交/push已成功（395eb34）；当前R12–R18源码尚未提交/push，不把上次保存授权当作后续自动提交权限；§34仅在隔离Pi内使用获准的cafe凭据，不修改全局配置或记录密钥。
6. 历史 native Pi / 模拟 host 验收只代表当时产物；没有自动继承到 React/Go 版本。
7. 所有进程 PID/启动时间必须运行时重新核对。本表故意不提供可以直接拿来 kill 的历史 PID。

## 4. R01 原交接记录（历史）

以下保留当时状态与授权规则，不作为当前审批要求；后续 review 发现来源/integrity 记录未补齐。当前状态以任务表及第 7 节为准。

```text
任务/子步骤：R01 — 固定版本、API 和未决事项
授权来源：用户明确要求继续此前 R01；按执行入口只执行 R01
状态：needs_review
基线 HEAD/工作区情况：cf20beaf65097173b78a632a79df615b9576e5ce；main ahead of origin/main by 1；保留既有规划文档修改，未覆盖
修改文件：packages/pi-cafe-space/docs/refactor/VERSIONS.md；本文件
验证命令及退出码：文档结构/链接/敏感模式检查（0）；git diff --check -- packages/pi-cafe-space/docs/refactor/VERSIONS.md packages/pi-cafe-space/docs/refactor/PROGRESS.md（0）
实际测试数/失败数/skipped 数：无代码测试；R01 未安装依赖、未建 Go module、未 build、未启动服务
证据路径：packages/pi-cafe-space/docs/refactor/VERSIONS.md；R00 baseline 与临时 assistant-ui tarball/Go module cache（均为外部或既有证据，不提交）
未验证项：安装后的 npm peer resolution/lockfile；R09 本地 assistant-ui 类型；R03 实际 Go module/build；真实 Pi、浏览器、WS 故障矩阵；ordered parts 的真实 Pi 字段与顺序
进程/临时目录归属与清理：本轮未启动或停止进程；未修改 session、PID marker、dist、用户配置；assistant-ui tarball 与 Go module cache 位于仓库外
review：未完成；必须由 reviewer 确认版本/API 记录后才可授权 R02 或依赖安装任务
下一建议任务：等待 R01 review；review 通过后由用户单独授权 R02
```

## 5. 每轮更新模板

在本节追加脱敏记录，并同步任务表。不要复制完整聊天/工具输出或密钥：

```text
任务/子步骤：
授权来源：用户指定的单任务或连续范围；当前任务及剩余范围
状态：
基线 HEAD/工作区情况：
修改文件：
验证命令及退出码：
实际测试数/失败数/skipped 数：
证据路径：.refactor/reports/Rxx/...
未验证项：
进程/临时目录归属与清理：
检查点：自检/独立检查的实际方式、证据、结论及未决项（不冒称外部批准）
下一步：范围内继续的任务；或范围结束/需用户决定的阻塞
```

## 6. R00 交接记录（历史，当时采用单任务授权）

```text
任务/子步骤：R00
授权来源：用户消息“开始执行”；按入口解释为首个任务 R00
状态：done
基线 HEAD/工作区情况：cf20beaf65097173b78a632a79df615b9576e5ce；main ahead of origin/main by 1；R00 开始前已有规划文档未提交修改，未覆盖
修改文件：packages/pi-cafe-space/.gitignore（加入 .refactor/）；docs/refactor/BASELINE.md；本文件；.refactor/reports/R00/evidence.txt（ignored）
验证命令及退出码：npm.cmd run typecheck (0)；npm.cmd run pi-cafe-space:check (0)；npm.cmd run pi-cafe-space:test (0)
实际测试数/失败数/skipped 数：6 test files passed；65 passed；0 failed；0 skipped
证据路径：packages/pi-cafe-space/docs/refactor/BASELINE.md；packages/pi-cafe-space/.refactor/reports/R00/evidence.txt
未验证项：Go/Gin/Gorilla API parity；React/Vite/assistant-ui；真实 native Pi；新 Go/Web candidate；浏览器 E2E；远程/故障/发布矩阵
进程/临时目录归属与清理：本轮未启动或停止进程；未修改 session、PID marker、dist、用户配置；.refactor 报告为本轮生成并已被忽略
review：R00 无独立 review gate；R01 仍待用户授权
下一建议任务：R01（只建议，不自动执行）
```

## 7. 执行方式修订

- 授权来源：用户要求“改一下方案 不需要每次都中断去review”。本次仅调整规划文档，不实施 R01 证据修复、R02 或其他业务任务。
- 新规则：可一次授权连续范围，逐项实施、验证、完成内置检查并记录后继续；不因普通 review 检查点暂停。单任务授权仍只做一项。
- R01：此前 review 未通过，原因是 npm 来源/integrity 记录不完整；由 `needs_review` 改为 `doing` 表示仍有未完成工作，并非豁免问题或宣布通过。后续获准执行时先补证据、复验，再在授权范围内推进。
- 仍需停下：实质工具/测试阻塞、无法证明的 API 行为、协议/安全策略变化、越出授权范围。真实 Pi/Chrome/模型额度与 candidate 安装需专项授权；R19 切换/移除旧实现仍按两个明确授权检查点执行。
- 同步文档：执行入口、TASKS、CONTRACTS、PROGRESS、VERSIONS 的状态/交接措辞，以及 Web/Go 两份架构方案的执行说明；未调整技术选型、版本候选、协议、资源上限或测试验收项。
- 验证：Python 文档检查覆盖以上七份文件的严格 UTF-8、代码围栏、相对 Markdown 文件链接和尾随空白，退出码 0；`git diff --check` 退出码 0。旧审批措辞扫描仅在明确标为历史的 R01 交接中保留原要求，现行规则已改为内置检查。
- 无业务代码/manifest/lockfile 修改，无依赖安装、构建或代码测试，无服务/进程/配置操作，无 commit/push。

## 8. 执行方案 review 问题收尾

- 授权来源：用户在方案 review 后要求“你直接落地和完成吧”；本轮落实两处规则修正，不扩大到业务实施。
- 修改文件：`docs/REFACTOR_EXECUTION.md`、`docs/refactor/TASKS.md`、本文件。
- 差异处理：TS/Go 不一致先按冻结基线与 fixtures 修复、复验；只有语义未决、无法兼容或需要协议/安全策略变化才请求用户决策，不改 golden 迁就实现。
- 切换权限：R18 专项权限与 R19.1 接线权限可提前授予；R19.2 必须在接线和新版本验证后取得用户可用性确认及清理同意，提前授权不能代替。
- 检查方式：执行者直接核对入口与任务卡的一致性，不冒称独立 reviewer 批准；此前辅助子代理超时，不作为审查通过证据。
- 验证结果：Python 检查七份方案文档的严格 UTF-8、代码围栏、相对文件链接、尾随空白及两项规则一致性，退出码 0；`git diff --check` 退出码 0。两项 review 问题已修正，方案修订完成，不再等待例行审批。
- 本轮只做文档修正，R01 仍有来源/integrity 证据待补，R02 及以后未实施。未安装依赖、运行构建/代码测试、操作服务或 commit/push。

## 9. 连续实施：R01 收尾 → R02

- 授权来源：用户澄清“我的意思是落地功能 而不是停在方案上”；进入功能实施，不再为普通 review 中断。剩余授权范围见顶部。
- R01（2026-09-18 UTC）：补齐 VERSIONS 的固定来源 URL 展开规则、28 行 SRI 与实际下载字节核对结果；Python urllib/hashlib 查询校验退出码 0。无依赖安装/lockfile/Go module 修改。执行者内置检查通过，不冒称外部审批。
- R02：只增加协议说明、共享 fixtures、TS fixtures runner 和 package 的 contracts test 脚本；原 TS/Node/DOM 实现只读，当前 dist/服务不动。

## 10. R02 验收（2026-09-18）

- 修改：`protocol/v1/{README.md,compatibility.md,limits.json}`；`protocol/fixtures/v1/{values,codec,reducer,budgets}.json` 与 17 条 traces；`src/protocol/fixtures.test.ts`；package 新增 `refactor:contracts:test`；本进度。
- 验证：原生 PowerShell 执行根 `npm.cmd run typecheck`、`npm.cmd run pi-cafe-space:check`、`npm.cmd run pi-cafe-space:test`、`npm.cmd run refactor:contracts:test --workspace=@cafecodework/pi-cafe-space`，全部退出 0。7 files / 390 tests passed，contracts 325 passed，0 failed/skipped。`git diff --check` 与 6 份基线源 SHA-256 核对通过。
- 证据：`.refactor/reports/R02/final.txt`；先失败证据 `red.txt`（缺 fixtures）及 `fixtures-first.txt`（节点预算计数更正，详 compatibility）；受控验证脚本 `check.ps1`。生成 helper 不作为更新 golden 的机制。
- 内置核对：逐项 schema、已知 JSON 差异、路由/缓存/替换/seq/超时 traces 与 TS 源对照；不让未来 Go 决定预期。辅助 inventory 子代理超时未产生结论，不作为证据。
- 未验证：Go parity/race、真实 Pi/Chrome、发布产物；这些是后续任务。不声称原生 DOM 所有边界已有 portable fixtures，limits 中区分来源盘点与已测层。
- 资源：仅测试自己的 loopback port 0 listeners/synthetic WS，finally 关闭；未操作现有 Pi/Relay/Chrome/dist/session/marker。
- 下一步：按已有连续授权进入 R03，无需用户再次 review。

## 11. R03 验收与环境缺口（2026-09-18）

- 修改：`relay/go.mod`/`go.sum`，纯 `internal/{protocol,config}` 及测试，`cmd/pi-cafe-relay/main.go` 最小入口。入口明确不启动尚未接好的 transport，不冒充成品。Gin 1.11.0 / Gorilla 1.5.3 的直接 module sums 已固定。
- 协议：独立 JSON parser 保留 JS duplicate-key/IEEE-754/isolated-surrogate 语义；迭代解析未知深嵌套避免递归栈及额外拒绝条件。已实现 DecodeWire/EncodeWire/ApplyEvent/FitCommandResult；不依赖 Node、Gin、Pi。
- 验证：原生 Go 1.24.2；`go test -v ./...`、`go vet ./...` 退出 0；307 pure fixtures 全部等价。`go test ./internal/protocol -run '^$' -fuzz '^FuzzDecodeWire$' -fuzztime 30s -parallel 2` 退出 0，845418 executions，无失败。结果不代表证明无漏洞。
- 证据：`.refactor/reports/R03/{check.txt,fuzz.txt,modules.txt}`；受控原生 PowerShell 脚本同目录。R03 没有运行服务。
- 提前探测 race：默认 `go test -race ./...` 退出 2，提示 requires cgo。以已安装 clang 仅在子进程设置 CGO_ENABLED=1/CC=clang 重试退出 1：MSVC target 不支持 `-mthreads`；gcc 不在 PATH。日志 `stress.txt`、`race-clang.txt`。未安装编译器、未改全局配置或降低测试要求。
- R03 规定的 test/vet/fixtures 已通过；R04 HTTP 可继续。R05/R08 race 验收仍需用户提供/允许安装受支持的 Windows C 工具链，不能把这项记为 pass。

## 12. R04 验收（2026-09-18）

- 新增 `relay/internal/{httpserver,auth,webui}` 与测试：Gin 精确 HTTP routes/no redirect/no trusted proxies；GET/HEAD health/config；逐 URL 资产允许清单、4MiB/16MiB/256 限制；只读复制；header/body/time/512 connections admission；无资产明确 503，无磁盘 fallback。candidate main 接入 HTTP 和有界 shutdown，现有 launcher 不变。
- Origin：从未改动的 TS normalizeConfiguredOrigin 提取 44 个 synthetic 预期；Go 修复 IPv4 数字变体、IPv6 mapped、IDNA、转义 hostname 和 dot-segment normalization 后全部通过。配置层复用同一 pure normalizer，是范围内 R03 回归修复，不改 TS 行为。Go module 增加 Gin 的锁定传递依赖及 x/net 0.42.0（Gin 已要求）；Gin/Gorilla pin 未变。
- 验证：`go test -v ./...` / `go vet ./...` 均退出 0；原生 TS typecheck/check/test 和 contracts 均退出 0（7 files / 390 tests，contracts 325，0 failed/skipped）。`git diff --check` 通过，旧 runtime 与根 lockfile 无 diff。
- 证据：`.refactor/reports/R04/{check.txt,origins-red.txt,ts-regression.txt}`，来源提取 helper `origins.mjs`。测试仅创建/关闭自己的 loopback listener，不运行 candidate main 或现有服务。
- 新 HTTP 请求体拒绝/encoded asset path 拒绝/headers 超限为既定 Go 加固边界，不冒充旧 Node 每项行为；HTTP parser 层 431 由 net/http 发出，应用错误响应有完整安全头。
- 未验证：race（见 R03 工具链缺口）、WS/hub、生产 embed/React 页面。按授权继续 R05 实现与普通测试，race 未通过不得标 R05 done 或推进依赖任务。

## 13. R05 实施与实际阻塞（2026-09-18）

- 已新增 `relay/internal/transport/{session.go,session_test.go,failure_test.go}`：Gorilla upgrade、禁压缩、Origin gate、单 reader/data writer、128 个/1MiB 双限额（包括 in-flight）、入/出帧 256KiB 上限、分片累计检查、binary 1003/error、非法 UTF-8 1007、超帧 1009、5s hello gate、ping/pong、写 deadline、慢端 1013、关闭 watchdog 与队列额度回收。
- Gin 只通过显式注入 handler 接入 `/ws`；main 尚不注入协作 handler（room/hub/hello 业务仍属于后续任务），不能作为已完成的协作 Relay 使用。transport 不做房间/模型/工具操作，`MarkAuthenticated` 仅由 reader callback 在上层验证 hello 后调用。
- 真实 loopback Gorilla 测试覆盖空帧/刚好 256KiB、binary/非法 UTF-8/超帧、分片、hello deadline、并发 Send/Close 与资源结束。窄 connection 测试接口注入 blocked writer，验证写失败/重复 close/context cancel 均回收 reader/writer 和 pending bytes；生产仅创建 Gorilla connection。
- 原生 `go test -v ./...` 与 `go vet ./...` 退出 0，transport `go test ./internal/transport -count 30` 退出 0。后者只是重复性检查，**不是 race detector 的替代品**。日志 `.refactor/reports/R05/{final.txt,repeat.txt}`。
- 最终源码检查：50 个新增/相关文件 UTF-8、尾空白、JSON、Markdown links/fences 通过；六个旧 source SHA-256 与 R02 清单一致；28 个 SRI 值完整；`git diff --check` 通过。helper 为 `.refactor/reports/R05/verify.mjs`，不执行业务实现/更新 golden。
- **阻塞原因**：原生 Go `CGO_ENABLED=0`，无可用 GCC；只对测试子进程设置 CGO_ENABLED=1/CC=clang 后，现有 clang 的 Windows MSVC target 拒绝 `-mthreads`（R03 日志）。尚未安装编译器、改系统 PATH 或其他全局配置；R05 必需的 `go test -race` 没有通过，不标 done，不进入依赖它的 R06。
- **下一步所需外部操作**：用户允许在 `.refactor/toolchains/` 下载/解压兼容 Windows Go race 的便携式 MinGW-w64，并仅对测试子进程配置 CGO/CC；或者提供已安装且兼容的编译器路径。该问题是新增工具链操作授权，不是重新申请 R06–R17 的任务或 review 授权。
- 安全边界保持：没有启动真实 Pi/Chrome/candidate main，没有模型消耗，没有覆盖 dist/旧 launcher/进程标记，没有 candidate install、commit/push 或生产切换。React/room/hub/ordered-parts/embed 尚未实施，不能宣称范围内功能全完成。

## 14. R05 工具链解阻及验收（2026-09-18）

- 用户明确“允许”下载便携式 MinGW-w64 到 `.refactor/toolchains/`，仅供测试子进程，不授权全局配置变更。安装使用 WinLibs GCC 14.2.0 / MinGW-w64 UCRT 12.0.0 r3，来源 `https://github.com/brechtsanders/winlibs_mingw/releases/tag/14.2.0posix-12.0.0-ucrt-r3`，无 LLVM 的 x86_64 posix seh zip。
- 246962421 字节 zip 的 SHA-256 `88868d745b807f083a117ff69348d8bc021ad7389aa503379dbed1866efcaeb9` 及 SHA-512 均与同一官方 release 的 checksum 文件一致（来源一致性校验，不冒充独立签名/漏洞审计）；解压前逐项限制路径/符号链接/数量/总字节。
- 初次原始长目录下 GCC 无法查找其自带 header；只把本次解压目录改名到 `.refactor/toolchains/gcc14/` 后恢复。未修改系统长路径策略、PATH 或 go env 持久设置。旧失败日志保留 `race.txt`。
- 原生 PowerShell 子进程设置 `CGO_ENABLED=1`、CC 指向便携 gcc，局部 PATH 加其 bin 并在 finally 还原。`go test -race -count=1 ./...` 与 `go test -race -count=30 ./internal/transport` 均退出 0，无 race 报告、失败或 skip。
- 证据 `.refactor/reports/R05/{toolchain.py,toolchain.json,race.ps1,race-short-path.txt}`。编译器及 archive 均只在 ignored `.refactor/`，没有运行安装器或改当前服务。
- R05 验收缺口已关闭；按原连续授权直接进入 R06，不等待例行审批。后续 race 测试继续复用该隔离工具链。

## 15. R06 验收（2026-09-18）

- 新增 `relay/internal/hub/{hub,room,projection}.go` 及四份 tests：registry admission（512/128/32、rooms 256、hosts 64、clients 256）、每 room 单 writer、128 items/1MiB inbox、独立合并 close/control、128MiB 动态状态计账；Join/Handle/Leave/Close；注入 clock/ID；snapshot ready gate/replacement/旧连接隔离/seq fence/offline expiry/空 room 回收。
- 投影延续 Node 的 100 messages/24 tools/UTF-16 截断/261120 envelope budget、host 排序与 metadata 降级。为避免 Go UTF-8 字符串次序或 encoding/json 替换 isolated surrogate，protocol 只新增复用原算法的 ValueBytes/UTF16 工具，不改 codec 行为或 golden。压测发现反复全量序列化开销，改为同等 JSON 字节减计并复制保留 slices，避免保留已裁剪的 backing references。
- 同一四条纯 host traces（auth-and-role/duplicate-event-disconnect/snapshot-required-timeout/stale-snapshot）逐 FIFO/字段/绑定 ID/close 与 TS expected 对比；其余命令 traces 留 R07，binary/transport traces 留 R08 真实 WS 装配。不把 fake sender 当真实 Go WS 集成证据。
- 测试覆盖两个 room、多 host 同 session、replacement 旧 close、倒退 snapshot、context/seq 错误、snapshot timeout、offline TTL、room/host admission N+1、聚合状态预算、不可变投影、metadata 降级、并发 lifecycle、inbox count/bytes 饱和及 close/shutdown 配额释放。
- 原生 `go test -v ./...` / `go vet ./...` / `go test -race -count=1 ./...` / `go test -race -count=10 ./internal/hub` 均退出 0。首次未优化重复 race 外部 timeout 不是通过，确认没有遗留本次测试进程，优化后重新完整运行；最终证据 `.refactor/reports/R06/{final.txt,race-final.txt}`。
- TS typecheck/check/390 tests、325 contracts 回归退出 0（`ts-regression.txt`）。58 文件 UTF-8/JSON/Markdown/whitespace、六个 source digest、28 SRI 检查和 `git diff --check` 通过。sa-4 超时无可用结论，不作审查证据。
- R06 无真实服务/文件访问/模型操作；main 仍未接 hub。history 缓存失效/离线读取刷新和 pending 分支是 R07 工作；跨 room 全局缓存回收与实际 transport 计账在 R08 装配验收继续检查。
- 按连续授权进入 R07，不需新增任务授权。

## 16. R07 验收（2026-09-18）

- 新增 `relay/internal/hub/{command,cache}.go`、command tests；补 room snapshot/event/replacement/disconnect 的 cache/pending hooks。路由目标/legacy 选择/上下文 fences、tuple dedupe、client/host generation、15s pending、REQUEST_PENDING、128/32 pending 限额、路由后 bytes check、result fitting 均已实现。
- history 仅由 list/get 的匹配结果写入，按 projection revision 隔离；identity/branch/rename 变化清理，状态-only event 不误清；离线命中刷新两项 TTL，结果 replay 与 history cache 保留原顺序语义。results 1000/8MiB FIFO，history 20 项；缓存全局 64MiB 子预算，所有 pending/result/history 同时计入动态 128MiB，关闭释放有断言。
- 共享 fixtures：14 条 hub traces FIFO/严格字段/绑定 ID/close 全通过（其余3条仅 transport，由 R08 接入）。增加 per-host/per-client pending N+1、COMMAND_TOO_LARGE/RESULT_TOO_LARGE、history revision 与 client delivery fence、cache count/bytes/FIFO/清理、result/close/timeout 20 轮竞态只完成一次。
- 原生 `go test -v ./...`、`go vet ./...`、全量 `go test -race -count=1 ./...`、`go test -race -count=10 ./internal/hub` 退出 0，无 race 报告。证据 `.refactor/reports/R07/{red.txt,final.txt,race.txt}`。61 文件结构检查/六个旧 source digests/28 SRI/`git diff --check` 通过。
- 下一步 R08：装配真实 WS，检查 control/error 发出次序、聚合 queue 预算/全局回收与 shutdown，不能把 fake sender trace 通过说成完整 Relay 已验证。旧服务、dist、launchers 未动。

## 17. R08 装配、差异核对与验收（2026-09-18）

- 新增 `relay/internal/service/` 装配 HTTP/Origin/pre-upgrade admission/transport/hub，main 接入候选服务（仅测试调用 run 使用 owned port 0/冲突端口，未运行 main 或默认37891）。新增 service/main lifecycle tests、transport queue/error ordering tests、`src/protocol/go-relay.test.ts` 和 `scripts/refactor/test-go-traces.ps1`。
- 对齐发现：transport close 原先可能丢掉已排队协议 error；修复为在1s close deadline内 best-effort flush 已 admitted 数据再 close，1013过载不强行 drain。增加测试明确 error 在 close 前到达。queue bytes 现与 hub 的128MiB动态预算统一，独立64MiB cache子预算不重复分配。全局容量失败用合并epoch触发各 room 回收可淘汰 cache/offline projections，不跨actor锁内等待；失败 admission仍明确拒绝，不丢 pending。
- 每条 trace 都启动专用 Go test binary 的 ephemeral loopback服务；TS 使用真实 ws 接口，严格 FIFO/全部字段/ID binding/close reason，对比未修改 R02 JSON；stdin测试clock控制仅编译在 `_test.go`，没有生产 HTTP 管理接口。finally关闭本轮 sockets/test child；测试binary验证shutdown后connections/rooms/bytes全零。普通TS测试不隐式构建/启动Go，独立script显式开启17条。
- 行为核对：307 pure codec/reducer/budget fixtures通过；17/17 WS traces通过：auth/role、binary、bad UTF-8、hello/snapshot timeout、duplicate event、stale snapshot、multi-host/room isolation、target/cwd fence、client/host replacement、command timeout、history dedupe/offline TTL/revision/result binding、防写命令污染缓存。TS与Go golden无更改、无已知fixture差异。
- 额外计划边界（非旧Node逐字节等价承诺）：HTTP body/header/path严格拒绝；application队列128项、room inbox128项/1MiB、全局64MiB cache/128MiB动态预算及压力回收；有界Go shutdown。JSON对象key排列不是wire语义；UTF-16身份排序已使用专用比较。未承诺全域WHATWG/任意JSON fuzz等价，只声明已测基线。
- 生命周期/压力测试：预upgrade32地址限额、恶意Origin/精确路径/失败upgrade无quota泄漏；8个hijack sockets shutdown收到1001；owned listen冲突不影响原listener；取消run退出；inbox饱和close可达；跨room压力回收；result/close/timeout竞态；所有测试只操作自己资源。
- 验证：原生 `go test -v ./...`/`go vet ./...`/全量`go test -race -count=1 ./...`；hub/transport/service/main `-race -count=10` 全部退出0。普通及race Go test binary各运行18个TS集成测试（17 traces+入口校验），全部通过。
- Fuzz `go test ./internal/protocol -run '^$' -fuzz '^FuzzDecodeWire$' -fuzztime 30s -parallel 2` 退出0，1343816 executions（不等于无漏洞证明）。原TS回归8 files/391 tests和325 contracts、root typecheck/package check全通过，0失败/skip。
- 证据 `.refactor/reports/R08/{final.txt,race.txt,runner.txt,fuzz.txt,ts-regression.txt}`；受控持久runner为 `scripts/refactor/test-go-traces.ps1 [-Race -Compiler <portable-gcc>]`。无provider/Pi session/项目文件读取；无浏览器/模型/生产launchers操作。
- 内置检查完成，进入R09。React/ordered parts/embed/真实Pi仍未完成或未验证，不把当前候选当最终成品。

## 18. R09 安装结果与新实质阻塞（2026-09-18）

- 使用原R01精确pins，原生npm默认peer resolver + `--save-exact --ignore-scripts`，未使用force/legacy-peer-deps，未运行workspace lifecycle/prepack/build。两次安装退出0；`npm ls --workspace=@cafecodework/pi-cafe-space --all --json` 退出0，非peer conflict。
- 安装改变package manifest及根唯一lockfile。本次367个新lock entries（含平台optional条目）均有registry HTTPS来源/integrity及许可证（MIT/ISC/MIT-0/Apache-2.0/CC-BY-4.0/BSD-2-Clause/BSD-3-Clause/0BSD）。既有依赖无版本更新/删除；npm顺带同步pi-subagent lock版本一项已精确恢复原值，其他变动仅为必要dev/peer分类。未修改其他workspace业务文件。
- **engine阻塞**：`@assistant-ui/core@0.3.19` 和 `assistant-stream@0.3.43` 各要求 `nanoid ^6.0.1`，其engine为 `^22 || ^24 || >=26`，不含现场Node23.11.0。即使锁回R01 core0.3.17/stream0.3.41也要求nanoid6，不能假称锁传递版本即可解决。Node22满足原最低22.19.0要求；建议仅测试子进程用便携Node22.23.2，不改系统Node/PATH、项目最低版本或跨major强制override。
- **audit阻塞**：当前7条汇总（1 moderate/5 high/1 critical），不是7个已证明可利用漏洞。新直接依赖axios/lodash-es/nanoid/react-router/vite均有advisories；critical来自原有Vitest3.2.4（GHSA-5xrq-8626-4rwp，<3.2.6）。旧Vitest3及其mocker还报告moderate，完全修复需>=4.1.11。没有自动运行npm audit fix。
- 待授权最小版本建议（只查registry，尚未安装/宣称兼容通过）：axios1.13.6→1.18.0，lodash-es4.17.23→4.18.1，nanoid5.1.6→5.1.16，react-router7.13.0→7.18.2，vite6.4.1→6.4.3；均在当前audit所有对应direct受影响range之外，保留major/技术栈。Vitest3.2.4→3.2.7可修critical并保持major，但moderate须显式记录/限定run模式（不开放测试UI/API/dev mock服务）；若要求这项也修复，应另准该package升级4.1.11并重跑测试，不能顺手升级其他workspace。
- **根lockfile跟踪缺口**：既有根`.gitignore:7`忽略`package-lock.json`，当前lock未跟踪，故git status不显示它。R09只授权根lockfile、不含根.gitignore；建议额外允许只将这条改为`**/package-lock.json`并加`!/package-lock.json`，保留根唯一lockfile可提交（仍不执行git add/commit/push）。未擅改忽略策略。
- 回归仍通过：安装后root typecheck/package check/8 files391 tests及325 contracts退出0；31个当前dist/旧Web文件SHA-256不变，六个旧源digest不变，67相关文件结构检查及git diff --check通过。没有Web config/shell/build，没有启动真实Pi/Chrome/生产Relay。
- 证据 `.refactor/reports/R09/{install.txt,dependencies.txt,tree.json,audit.json,added-dependencies.json,protected-digests.json,ts-regression.txt}`。audit JSON仅作为来源证据，PowerShell stdout转码有个别非ASCII乱码，不修改它来伪造结果。现有安装状态保留供后续精确调整，不回滚用户文件或清空node_modules。
- 需要用户确认上面版本/隔离Node/根.gitignore额外范围后继续原R09–R17/R18.1授权；不是例行review审批。assistant-ui安装后API验证、Web smoke/build仍未执行。

## 19. R09 解阻与Web骨架验收（2026-09-18）

- 用户“允许”批准第18节建议，选择Vitest4.1.11；只改package manifest、根唯一lockfile、根.gitignore锁文件例外、web新目录及进度/版本说明。Node22.23.2放ignored `.refactor/toolchains/`，SHA256匹配官方SHASUMS，系统Node/PATH未改。
- npm10.9.8/10.9.2遇Arborist null edgesOut（不是peer拒绝），使用隔离npm11.16.0且校验registry SRI，默认peer resolver成功。一次prefer-dedupe尝试导致根Vite/esbuild重hoist，已恢复原根7.3.6/0.28.2，批准Vite6.4.3局限package；npm重同步pi-subagent lock版本已精确恢复旧值。被移除的旧lightningcss为不再需要的optional graph，不改其他workspace manifest/runtime。
- assistant-ui smoke发现最新core0.3.19的optional-cloud导入失败；锁回R01已核对core0.3.17（仍满足react^0.3.17），将原依赖assistant-cloud0.1.43共享hoist后普通npm再次安装/peer tree通过。未添加应用Cloud服务或私有API。实际类型+渲染证明公共runtime/parts等导出可用，不只读取声明。
- 新增web/index、Vite/Vitest/tsconfig、React StrictMode+HashRouter、SCSS Modules/normalize、zh-CN/en i18n、独立web/static；2个DOM smoke验证语言切换/样式/不连接WS及assistant-ui公共API。所有产物到`.refactor/web`，旧public不变。package test补`--exclude web/**`防Vitest substring src筛入DOM套件，Web有独立runner，未删/skip旧测试。
- 验证：隔离Node22原生`refactor:web:check/test/build`退出0（2 files/2 tests，hashed JS/CSS，无maps）；root typecheck/package check/8 files391 tests/325 contracts退出0。workspace npm ls退出0，audit0；根其他workspace保留2 moderate，不冒称全仓安全清零。
- 31个旧dist/public文件SHA256不变、六个旧源digest不变；bundle扫描无node:fs/PiSDK/服务端ws/host token，根lock可被git跟踪但未add/commit。证据`.refactor/reports/R09/{node-toolchain.json,npm-installer.json,integrity-approved.json,web-api-final2.txt,final-regression2.txt,audit-approved.json,audit-root.json,check-bundle.mjs}`。
- R09完成，连续进入R10。页面目前明确显示未连接，不冒充完整聊天；没有真实Pi/Chrome/现有服务或模型操作。

## 20. R10 验收（2026-09-18）

- 新增web services relay/RelayClient、storage、http/client及4个测试文件：显式start/stop/resync、不在import连接，token只发hello，固定同源/ws，5s握手deadline、500ms–30s退避、限频固定notice、auth失败停重试；generation/socket双门控清理旧回调，sendCommand只允许认证/current generation，无写重放队列。
- sessionStorage四个旧key保留，bounded值、get/set/remove异常回退内存，logout不复活旧token；axios固定/api/config和/healthz、XHR adapter/5s timeout/取消/受限响应，无任意URL或Authorization。
- 测试覆盖双start、open不等于authenticated、stop/start旧callback、room变更/resync、invalid token显式恢复、bad JSON/binary/超帧/错误类型、deadline、send fence/不重放、storage SecurityError/quota、HTTP取消/恶意wsPath、StrictMode真实mount-cleanup-remount只有1个活socket。
- 原生隔离Node22 `refactor:web:check/test/build`退出0：6 files/11 tests，0失败/skip；证据`.refactor/reports/R10/{first.txt,final.txt}`。bundle/31旧产物digest/root工具版本检查和git diff --check通过。
- 连接层尚未接UI owner（R15装配）；store投影/具体command能力gate属于R11。继续原授权，无真实服务操作。

## 21. R11 验收（2026-09-18）

- 新增`web/src/state/{CollabStore,selectors,useCollabStore,compactSnapshot}.ts`和store tests，以及`services/relay/CommandGateway.ts`/tests。同步Immer Map投影、稳定per-host引用、单microtask通知；host inventory/legacy、snapshot readiness、seq/context异常resync、100 messages/100 tools/261120-byte envelope compaction、100条notice、20份/4MiB全页面历史LRU。
- Gateway完整原值scope/fence、先登记waiter再send、精确request/host/generation/view/data kind绑定、文件新请求优先；256/每host32上限及abort预留、8MiB字节记账、20s原deadline、本地取消不暗发abort。只读HOST_NOT_READY后新权威snapshot最多重试一次，使用新requestId但不延长deadline。离线只允许缓存历史命令；写回执不改变phase，HOST_TIMEOUT/replacement/offline等不确定结果报告unknown、不重放。
- R10联动修复：原生socket listener显式清理、重入stop/state及旧retry timer代次门控；追加真正axios XHR abort测试（send被stub，无网络请求）、退避上限和emoji UTF-8超帧测试。
- 原生Node22.23.2完整验收：Web check/test/build退出0，9 files/28 tests；根typecheck、package check与8 files/391 tests、独立325 contracts均通过；使用现有便携GCC的真实Go race bridge17 traces+runner检查共18 tests通过。这也补齐Vitest4升级后的真实Go/TS runner复验。
- 证据`.refactor/reports/R11/{first.txt,check2.txt,verification.txt,verify.ps1}`；31个旧dist/public SHA256、root工具版本、bundle检查和git diff --check通过。只读sa-5超时未产生可用结论，不作为审查证据；本记录依据源码对照和实际测试。
- 未接真实服务/模型，UI app owner尚在R15；无Pi/Chrome操作，Go runner只创建并清理自己的ephemeral listener/子进程。未改旧Web、生产dist、默认启动或全局环境。下一步连续执行R12字段/事件证据，再进入R13；不跳过parts gate。

## 22. R12 当前断点（doing，未放行R13）

- 已重新核对CONTRACTS §6/7和R12任务卡。当前全局Pi包metadata为`0.85.1`（本会话developer指定的pnpm路径），仓库供类型检查使用的`node_modules/@earendil-works/pi-coding-agent`仍为`0.84.4`。没有升级/改动二者，也没有启动真实Pi。
- 下一步必须完整阅读相关Pi docs并核对两版event types/agent-loop/extension转发和session content；以受控、无provider调用的最小事件实验建立contentIndex/message_end/tool execution证据，再写`PARTS_REVIEW.md`及parts fixtures。版本差异不是已证实的兼容故障，不能以旧版研究替代新版本核对。
- 当前没有新parts生产逻辑或新协议字段；R12尚未验收，R13–R18.1授权继续有效，不需要例行重新审批。真实Pi/Chrome/模型/candidate安装和R19仍不在本轮权限内。

## 23. R12 验收（2026-09-18）

- 完整阅读当前Pi extensions/session-format/sessions及agent-core README，核对两版installed event types、agent loop、awaited extension转发、现有projection/history/callback源码；SHA256及映射清单见`PARTS_REVIEW.md`。0.84.4/0.85.1都支持真实contentIndex和assistant message_end先于工具执行；差异未影响既定parts草案。
- 实际调用两版已安装low-level loop，以显式synthetic stream+纯内存fake tools+Promise barrier跑同名t1/t2；断言indexed deltas、awaited message_end、t2先失败/t1空成功、最终toolResult按source order一致。没有AgentSession/CLI/provider调用/网络/配置或用户session读取。原生隔离Node22执行`.refactor/reports/R12/check.ps1`退出0，证据`{pi-events.mjs,pi-events.json,check.txt}`。
- 新增`protocol/v1/parts.md`、`protocol/fixtures/parts/{codec,reducer,ordered,native-events,projection-cases}.json`和`docs/refactor/PARTS_REVIEW.md`。51codec+11reducer先固定预期；另有ordered/native和15投影/关联场景。R13/14尚未实现，未把fixtures存在当功能通过。旧v1文件无变化，JSON/唯一ID/文档链接检查通过。
- 固定反序result是consumer压力用例，native真实结果仍source order；无协议必填变更/新command/推断父消息。普通内置检查已完成，sa-6超时无结论未用于放行。继续R13.1协议双端测试先红后绿，然后预算/producer；不启动生产服务。

## 24. R13.1 协议增强验收（2026-09-18）

- TS/Go新增可选parts/partsTruncated/toolIsError/parentMessageId/partIndex的role/index/长度校验、canonical保留和immutable reducer；type冲突拒绝、legacy/index缺失/part超限回退标记、formal输出字段保留。尚未启用extension producer。
- 先红：TS63项中61失败、Go同组失败；实现后63项TS和Go对应fixture/ordered/reconnect测试通过。首次绿前发现新fixture作者遗漏sticky historyTruncated的True参数，仅更正`authoritative-repairs-parts`一处期望以符合已冻结文字契约，并同步作者helper；原v1 goldens未改，未用Go输出迁就fixture。
- 完整原生验收`R13/verify-protocol.ps1`退出0：Go全部tests/vet/race通过；Web28 tests/check/build；TS454 tests（原391+新63），325原contracts，真实Go race bridge18 tests均通过。证据`.refactor/reports/R13/{protocol-red.txt,protocol-green.txt,protocol-regression-final.txt}`。初次typecheck发现重复narrowing条件，已删除冗余比较并复验。
- 31个旧产物digest不变、git diff --check通过；旧源码digest不再要求不变（进入已授权R13业务修改）。进入R13.2完善每层预算和history JSON converter，未将此子步骤当作完整R13完成。

## 25. R13.2–R13.4 完整投影链验收（2026-09-18）

- 预算：extension/Node/Go/Web compaction保留可选字段，整体parts不能保真时删除parts并标partsTruncated/historyTruncated；history JSON converter显式传递新字段；emoji大数组和result graph拒绝测试通过。`.refactor/reports/R13/budgets-check.txt`为R13.2通过证据，之后才启用producer。
- Producer：actual content array→indexed parts、空起始parts、跨object的assistant active lifecycle、原生contentIndex校验、执行前actual unique call parent索引（每次从≤100×500 retained evidence重建）、超长callId不做hash/prefix关联、原生toolResult.isError及空输出、历史assistant error保留。历史与live共用messageProjection。
- 新测试实际连隔离Node WS，证明两个同名call、反向完成/正式结果、parent、fresh client snapshot、fresh host历史重建、context reset及throwing getter/proxy恢复。使用合成SessionManager spy和本轮temp files验证get_session；发现既有list(ctx.cwd)遗漏custom sessionDir，按已安装签名补第二参数，未放宽路径/64MiB/opened cwd/ID校验。
- 自检发现R13.2 TS shared compactor在raw snapshot text裁剪时删除parts而Go canonical未同步。先加独立`budget-reducer.json`得到Go红，再补Go删除/标记逻辑；旧v1 fixture从未改动。sa-7超时，无可用审查报告，不据此放行。
- `R13/verify-protocol.ps1`最终退出0：Go tests/vet/全量race；Web10 files29 tests/check/build；TS12 files476 tests/root和package typecheck；原contracts325；真实Go race bridge19 tests（17 frozen + parts transport/reconnect + entry check）。新增transport trace完整比较ordered事件及fresh snapshot，不替代真实Pi gate。
- 旧dist/protocol实际decode已验证接受新字段并按legacy移除，空text保留；31 protected hashes不变。证据`R13/{lifecycle-first.txt,lifecycle-second.txt,lifecycle-green.txt,budget-parity-red.txt,history-status-red.txt,complete-final.txt}`。首轮测试harness自身command type和reset state错误已修复，不加timeout掩盖。
- 所有listeners/temp files/child binaries均仅测试所有并在finally清理；未连接旧服务、真实Pi、Chrome或模型。R13全部子步骤验收完成，进入R14。当前源码尚未commit/push，亦未生产启用。

## 26. R14 assistant-ui 对话验收（2026-09-18）

- 新增`web/src/features/chat/runtime/{convertMessages,usePiRelayRuntime}`及components/SCSS。真实`useExternalStoreRuntime`/Provider/ThreadPrimitive/MessagePrimitive/MarkdownTextPrimitive接入；直接convertMessage，不使用会合并相邻assistant的converter默认策略。
- 有序parts优先；唯一actual call ownership关联结果一次，缺父/歧义结果在原transcript位置，孤立execution在live edge；scope/message/index/callID键；formal空输出及错误/矛盾状态独立于assistant完成。非法/截断args走readonly data part而不是assistant-ui的partial-parse/空对象兜底，不启用任何tool executor或approval。
- 部分输出替换/正文更新测试保留同一tool DOM、展开和scrollTop；有界500个disclosure项；运行/错误默认展开、完成默认折叠，显式用户选择优先；卸载消息清理，随scope owner销毁（R15前重读§5补齐并经`R14/disclosure-final.txt`复验）。历史runtime只读isRunning=false；onNew只转唯一外部send，phase不从Promise推断，无乐观重复message，无edit/reload/branch/upload/Cloud。
- Markdown禁止raw HTML、只允许明确HTTP(S)无credentials的用户点击链接，noopener/noreferrer/no-referrer；图片只显示alt省略提示不发请求；纯文本code无eval/第三方style注入。DOM测试无script/img/iframe/inline-style，严格CSP未放宽；实际Chrome CSP验收仍留R18权限门。
- 最新assistant-ui llms.txt/external-store docs已咨询，实际安装types和源码是API依据。证据`.refactor/reports/R14/`：converter/components先红后绿；`verification.txt`完整退出0，Web12 files42 tests/check/build、TS476/root/package check、原325契约、Go tests/vet/race及19真实bridge tests通过，旧31产物未改。尚未接App的功能组件将在R15统一接线。

## 27. R15 页面落地与确定性验收（2026-09-18）

- R15.1：单一`Composer` use-immer草稿、65536字符界限、Enter/Shift+Enter/IME、同步send latch、running/waiting显式steer/followUp、独立abort；scope/view/generation变化清草稿；旧ack不清新草稿；未知结果保留原文并警示且不重发。`R15/composer-final.txt`记录47 Web tests/check/build通过，之后才接页面。
- R15.2：`AppOwner`统一拥有RelayClient/Store/Gateway，effect内创建/清理，store同步ingest先于Gateway，HMR沿用root.unmount；token只留Login表单/专有storage/hello，认证失败或logout清token和host。多host且无选择不自动选第一项；有host但无权威snapshot不能发送。App已从断开空壳接为真实登录/主机/对话/Composer页面。`R15/app-second.txt`验证通过。
- R15.3：目录/纯文本分段预览、当前自定义历史入口、只读详情与bounded validators全部经Gateway；路径只在内存/payload，history sessionId仅用于display scope，不替换当前命令fence。慢file A不能覆盖B；离线host禁文件/写命令但可向Relay读缓存历史。React Router实际测试发现useParams将字面`%2F`额外转成slash；改为从location.pathname提取原segment并decode一次，`saved/%2F:id`精确回传，未改协议ID语义。`R15/data-second.txt`通过。
- R15.4：桌面240/minmax(0,1fr)/300，右栏可收起；tablet/mobile使用关闭可恢复焦点的dialog抽屉，Escape/Tab/focus guard；当前对话80px跟随阈值，用户上滚不抢scrollTop。模型/provider/thinking表单同样走Gateway，历史视图禁写；zh-CN/en标签、状态和错误提示。`R15/layout-first.txt`记录55 Web tests/check/build通过。
- **最终原生验收**：`.refactor/reports/R15/verification.txt`退出0（复用`R13/verify-protocol.ps1`）：Web18 files55 tests/check/build；TS12 files476 tests/root/package check；原325契约；Go全量tests/vet/race与19真实Go bridge tests。31 protected文件digest未变；原v1 fixtures无diff，git diff --check通过。Vite主chunk约768KB，有默认500KB size warning，未提高阈值掩盖；小于资产4MiB上限。
- **验收边界**：App测试使用真实RelayClient/Store/Gateway与受控fake socket，不是实际Pi/model测试；breakpoint 1440/1024/900/390、焦点和scroll行为在jsdom按明确尺寸/测量stub验证。jsdom不能提供真实布局几何，因此没有把零scrollWidth当成“无横向溢出”证据；真实1440×900/1024×768/390×844 DOM几何及Chrome CSP仍需R18专项权限。当前只完成获准的确定性功能/组件验收。
- 生产入口/dist/web/public、旧进程/PID/配置均未改，未安装candidate，未启动真实Pi/Chrome或花费模型额度。本轮仅迁移build产物在.refactor/web；源码尚未commit/push。
- R15验收后已进入R16.1，当前断点见下一节；随后R16发行候选、R17隔离launcher和R18.1仍在已有授权内，不需要逐项审批。R18真实操作及R19仍未授权。

## 28. R16.1历史断点：资产校验已写，实际bundle未接受（已由§29解决）

- 新增`scripts/refactor/assets.mjs`、`assets.test.mjs`及`refactor:assets:test`。基于普通canonical目录/文件读取、link/junction/hardlink拒绝、读取前后identity/size校验、4MiB/16MiB/256固定上限，检查hashed静态名、HTML/JS AST/CSS/manifest引用和reachable资产集；生成带SHA-256和字节数的内部`asset-manifest.json`。staging只替换已校验的自身输出，未知文件或外部修改保留并拒绝，失败不能复用原完整staging。
- red：`R16/assets-red.txt`为尚未实现模块时的失败。`R16/assets-unit.txt`原生Node22 **7 tests通过**，含真正创建并清理的Windows directory junction、外部文件保留、缺失/外部/孤立引用、预算/计数、拒绝未知owner和staging失效。加入ignore的只有固定embed目录和同父目录的临时builder目录；没有改生产dist或旧public。
- **尚未通过实际资产验收**：`R16/assets-current.txt`先通过7 tests，随后在当前Vite bundle检查中退出1：`unverifiable dynamic import reference`。AST定位`R16/imports.txt`显示React Router framework route-module loader保留`import(t.module)`。这不是已有静态chunk缺文件；目前仍未擅自放宽检查或把它当通过。
- 为排除盲目改Link，`R16/router-probe.mjs`用Vite在内存中打包仅导出HashRouter/Routes/Route/useLocation/useNavigate的入口；首次仅probe返回值处理错误，修正后`router-probe.txt`仍显示1处`import(route.module)`。删除Link不能解决。没有改Web源码、node_modules或手补dist来绕过。
- **下一个实际动作**：核对该上游loader与纯HashRouter的可达性/构建引用边界，再选择有证据的构建处理；不要简单全局接受任意动态import。随后验证实际Vite输出并落地`embedded.go`/`embedded_stub.go`、校验manifest/私有资产/服务接线及tagged tests。当前Go embed与R16.2/16.3尚未实现，不能标R16通过，也不能声称新binary已可用。

## 29. R16 验收与 R17 入口

- React Router实际源码`lib/dom/ssr/routeModules.ts` loader只供FrameworkContext/manifest路径；当前HashRouter没有该context。使用受审函数SHA-256（两种ESM构建相同）的Vite pre-transform将整个loader替换为明确reject，既不允许运行时任意import，也不修改node_modules或生成后的JS。未知函数变更/匹配数量不为1会失败；仍执行原严格引用检查。sa-8超时，未使用其作为证据。
- 已实现Go webembed/stub、manifest逐文件SHA/字节数/白名单/额外文件验证、私有manifest不提供HTTP；main装配与`--version`（version/platform/webDigest）；source build始终重建Web/TS，记录binary checksum和TS digest，不复用失效staging。平台collector支持五种标签并验证PE/ELF/Mach-O header；本机只产出/验收windows-amd64，完整矩阵模式缺平台明确失败。
- `R16/build-fifth.txt`退出0：asset/plugin8 tests；普通Go tests/vet；带tag全量tests；candidate3 tests，含移走assets后普通tests仍通过而tagged build失败、真实owned native binary在无Node/Go PATH、只读executable、无磁盘assets目录中提供HTTP/HEAD/MIME/CSP/no-store与私有URL404。
- `R16/package-first.txt`退出0：最终build-source脚本在临时完整源码副本实际完成source/Web/Go/TS构建并验证成品，未触碰当前dist；isolated npm11 pack --ignore-scripts只在此前已显式构建的candidate执行，无安装。tarball文件允许清单检查无env/runtime/map/tests/refactor helper。candidate标准scripts与future接线在candidate-overrides记录；R17将替换当前显式拒绝运行的启动/停止占位脚本，不影响源树旧脚本。
- THIRD-PARTY-NOTICES包含实际bundle module/Go dependency许可证；react-remove-scroll-bar2.3.8、use-composed-ref1.4.0的npm及固定gitHead没有独立license文件，单独固定其MIT声明/原README/元数据归属及标准MIT条款，明确不伪造版权声明。未发布npm或声称法律审查完成。
- 初次失败依次为nested package.json无name/version、Vite虚拟module ID和两项上游缺license文件；均保留R16/build-first至fourth日志，修复后才验收。没有扩大资产/帧预算。进入R17；真实Pi/Chrome/candidate安装和生产切换未执行。

## 30. R17 验收

- `local-relay-go.ts`选择package内匹配平台/hash的binary、复用原bounded health/环境allowlist，仅Windows启用已实测的自动owner管理；其他平台可显式运行成品，auto-start安全返回unavailable。URL/query/fragment/credential/port0/原始token长度先门控，没有PATH搜索、下载或隐式build。原local-relay仅导出原helper并给环境helper增加默认不变的parent参数。
- candidate overlay把extension import切到Go；生产源码import/旧PS默认均未切换。新增Go PS start/stop/process-owner，独立.runtime-go和CreateNew锁/marker，不覆盖或回收未知锁。启动仅回收保有本次spawn/Process handle的失败子进程；持久PID stop先保有Windows process HANDLE，再两次CIM复核canonical exe、creation ticks、instance命令行，避免PID复用竞态。旧Node marker不转换、不删除、不据此停Go。
- 原生`R17/first.txt`通过TS check、3个纯门控测试与candidate重建，随后ACL测试在拒写状态下的scandir本身也被拒绝（test harness预期不当）；把“目录未新增文件”检查移到恢复该测试目录ACL后，未更改生产降级策略。`native-complete.txt`2个native tests通过：Node/PowerShell并发启动同一owned ephemeral端口；真实CIM正确stop、错path/nonce/creation及unavailable identity拒停；真实icacls仅作用本轮临时runtime并finally撤销；readonly未知lock保留；旧marker保留；PowerShell5.1 parse、任意PiArgs/function shim、异常/exit37下env恢复，无真实Pi。
- `R17/package-final.txt`退出0：最终source-build在完整隔离源码副本应用同一extension import overlay后构建，明确断言成品import local-relay-go；standalone验证和pack allowlist通过。当前tarball已含实际Go启动脚本，不再是R16占位脚本。临时服务、目录和ACL均由测试finally清理，没有操作现有37891/9222或旧marker。
- 后续直接执行R18.1；Windows以外auto-start/平台成品未实测，真实Pi/Chrome/安装仍未进行。普通内置核对依据实现与测试完成，不冒称sa-8审批。

## 31. R18.1 完成及最终确定性验收（2026-09-21）

- `scripts/refactor/integration.mjs` 每次先 fresh build，再执行真实 embedded binary。Node `ws` synthetic hosts/clients 经真实 HTTP/WS；JSDOM 执行从该 binary HTTP 实际取回并核对 SHA 的生产 bundle，而不是 source component 或 transport mock。JSDOM 缺少的 WHATWG streams 使用 Node 实际实现补齐，未改应用传输层。
- 覆盖两个 host、明确选择、有序正文/tool parts、并行反序结果和空/error 输出；真实 Composer → Gateway → Go → 指定 host 的 prompt fences/ack；浏览器重连且不重放写入；opaque history ID `saved/%2F:id`、离线 Relay 缓存和 readonly；重复/错 scope 的事件断开；262145-byte 超限；暂停读取的客户端面对900条16KiB notices被断开，健康客户端继续收取及最终snapshot正确。
- 保留失败证据：`R18/first.txt` 是 JSDOM 缺 TransformStream；`second/third/input-diagnostic` 发现 harness 错把重复 seq 当作可继续发送，实际冻结契约要求 EVENT_SEQUENCE/1011，UI正确禁用了 offline host。测试改为断言断开并以真实 snapshot 重连，**没有改变 v1 golden**。
- **退回R05修复实际缺陷**：`R18/fourth.txt` 的真实 Node peer 对超帧收到1006而不是1009；Gorilla按header拒绝body后立即TCP关闭，未读数据可能触发reset。writer仅在1009时使用原有close grace留出control交付时间，原watchdog仍执行原截止时间，不读取/分配超限body、不增加帧/队列/时间上限。新增Go regression；fresh binary的相同原测试随后通过。`fifth.txt`及后续全量/重复race/closeout均通过。
- **全量证据**：`R18/verification.txt`，执行已入源码的`scripts/refactor/verify.ps1`，退出0：TS13 files/**479 tests**；Web18 files/**55 tests**；原**325 contracts**；**19真实Go bridge tests**；asset/plugin8、candidate/source-build4、native launcher2、实际bundle集成1；Go普通tests/vet、全量race、webembed race、transport/service各5次race；fuzz **1,319,762 executions**。没有把skipped当pass。
- 回到R16/R17作发行收口：`candidate-overrides/package-fields.json`固定最终scripts/dependency接线；runtime只需`ws`，Web依赖转为源码构建devDependencies，保留已批准core/cloud兼容pin。`source-verify.mjs`在完整源码检查TS/Web/Go并执行TS（含contracts）/Web/Go tests；成品只验证artifact并明确说明不是source tests。隔离源码副本复用已安装依赖及只读根TS配置，不是tarball安装试验。`R18/package-final.txt`、`closeout.txt`及最终`closeout-final.txt`记录source build/check/test、candidate标准check/test、native launcher和fresh集成再次退出0。最终收口为candidate4/source-build1/native2共7 tests，再加实际bundle集成1，均pass。
- `refactor:pack` **先fresh build**，再stage/check，然后仅对独立candidate执行`npm pack --ignore-scripts`。每次拥有新的pack目录，失败清理该目录，不覆盖未知archive；restaging先核对已拥有目录的精确文件/目录边界，未知文件保留并拒绝（新增regression）。打包文件集合必须与精确release allowlist相等，源码helper不遍历复制未知脚本或license目录内容。最终25个allowlisted文件；无source maps/test helpers/runtime/PID/credential文件；文本私钥/常见token模式扫描无命中（非普遍秘密审计），licenses/notices齐备。没有发布或安装。
- `R18/archive-audit.txt`独立核对真实tar内容：25项均为普通文件、名字集合与报告相等，解包后逐文件与staging SHA一致；解出的Go executable在空PATH下`--version`匹配。同样没有安装或执行npm lifecycle，临时解包目录finally清理。
- R18及回归修复文件索引：`scripts/refactor/{integration.mjs,integration.test.mjs,verify.ps1,pack.mjs}`为复验/打包；`relay/internal/transport/{session.go,oversize_close_test.go}`修复超帧close，`relay/internal/protocol/fixtures_test.go`补parts fuzz seeds；`scripts/refactor/{build.mjs,release.mjs,candidate.test.mjs,source-build.test.mjs}`及上述overlays完成发行收口；`src/extension/local-relay-go.ts`对CIM结果做明确类型/字段校验；package新增refactor脚本，文档仅记录验收与使用边界。
- 当前产物：`.refactor/release/pack-ZvSIQF/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `1f0fe7d58e2d4c9f9dcc45a5dacf0e0f1d7a9d40a3c386125fd59e56ba0cfa62`；同目录`pack-report.json`记录完整清单。native **windows-amd64** executable SHA-256 `cc0e02747ebd50b5e66cb1a0cf004d5e4ace95247108927d7f28fd4dc9f01ba5`；Web digest `5db439111cc056fc7fec506b3959b9c333f6e3e2861db4f2f9441213886a2d21`。其他平台没有成品或实测，不宣称完整矩阵通过。
- `closeout-final.txt`末尾复验：31 protected文件digest不变、旧codec接受增强v1并保留legacy/empty输出；没有本轮临时测试目录或迁移目录中的Go候选进程残留。原v1 fixtures、根lock/package、生产dist/旧Web无diff；现有37891/9222、旧marker、默认import/launcher未改。R12以后未commit/push。
- **明确未验收**：真实Pi/AgentSession/provider/model、真实Chrome的CSP与布局几何、candidate安装、非Windows运行；未进入R19。当前授权范围已完成，不是为例行review暂停，也不把synthetic/JSDOM证据扩大成真实用户环境通过。

## 32. 开始 R18 真实专项

- 用户在获知尚缺真实Pi/Chrome、安装和切换后回复“开始”。本轮先推进R18.2–4：独立测试项目/session/config、Chrome SxS独立profile、37983/9333，以及候选tarball隔离安装；不改全局Pi/provider配置，不停止现有服务，不提交/push。R19仍须R18通过；旧实现删除还须切换后的可用性确认。
- 先测试真实原生Pi进程/AgentSession和Chrome，但使用明确标注的本地受控provider覆盖流、并发工具、队列和错误，避免在浏览器/安装问题排查时消耗外部模型额度；这不能冒充外部真实模型验收。
- `.refactor/reports/R18-native/preflight.json`：37983/9333空闲，Chrome SxS存在；37891/9222当前有监听，未操作。进程PID仅作为该次检查记录，不作为后续停止依据。
- 本节记录启动时状态；后续真实结果见§33，不再代表尚未启动。

## 33. R18 受控原生专项通过与候选替换（2026-09-22）

- **证据范围**：真实 Pi **0.85.1 CLI/RPC / AgentSession**，不是模拟 host 或直接 agent-loop；provider 是测试专用 `r18-local` 的确定性 stream，不访问外部模型。Chrome **SxS 155.0.8047.0 headless** 使用独立 profile 和真实 page target；不是 JSDOM、截图或终端录制。未宣称 TUI 自定义组件、外部 provider 或其他平台通过。sa-9/sa-10 均超时，没有把它们当作独立审查结论。
- **可复验源码**：`scripts/refactor/native-{acceptance,browser,data,support}.mjs`、`native-process.ps1` 和 `native-fixture.ts`。主脚本必须显式带 `--allow-native`，不挂到普通 tests；参数指定已打包 archive、已安装 Pi、Node/npm 和 Chrome 路径，完整命令见 CANDIDATE。fixture 单独针对实际安装的 Pi types 做 strict typecheck，无 any cast。没有把 fixture/helper 装进发行包。
- **安装与隔离**：先复核 tarball SHA、精确 allowlist 和25项普通 tar entries，再用 npm11 在新 prefix 实际安装。Pi peer 指向已安装0.85.1，本地单独安装 `ws@8.21.3`；不是重新下载/安装整个 Pi。正常 peer resolution、offline cache、ignore-scripts，无 force/legacy-peer-deps 或第二 lockfile；npm user/global config、日志与 Pi home/config/temp/session/project 全部隔离。通过 `-e <安装后的 package 目录>` 加载 manifest 指向的 candidate extension，而非源码入口。成品 check/test 在空 PATH 下成功，并明确只做 artifact verification。
- **原生链路**：Chrome Composer → Gateway → Go → candidate extension → 实际 Pi 工具执行，正文/thinking/tool parts 和 call ID 正确；执行完成顺序 `t2→t1`，正式结果顺序 `t1→t2`；空最终输出替代 partial、错误结果可见。Web steer/followUp 各入队一次且按原生顺序消费；独立 abort 真正中止 stream；Web 模型切换与 high thinking 到达 Pi；原生 RPC confirm 等待投影正确，Web 无远程批准按钮。实际 new_session 更新 scope/清草稿，旧 fence 写入被拒绝；页面重连恢复 parts，不重放 prompt。
- **浏览器与数据**：1440×900、1024×768、390×844 的真实 DOM 均无横向溢出；底部自动跟随、用户上滚保留；移动抽屉 label/inert/Tab/Escape/焦点恢复通过。实际 Markdown 禁止远程图片与可执行 markup；CSP/security/runtime exceptions 均为空，页面无外部 HTTP 请求；console.error、失败网络请求及 HTTP 错误响应也均为空。读取专用 UTF-8 文件；敏感路径、越界、ADS、非法 UTF-8、Windows junction 均拒绝。原生 SessionManager 创建 **1,696,241-byte** 合法历史，custom sessionDir 枚举/有界截断/只读浏览不切换当前会话；原生 host 离线后只允许 context-bound cached history。
- **opened identity 专项**：仅在自有 sessionDir 构造 CR/LF 歧义损坏文件：原生 list 的 readline 索引与 open 的 LF JSONL 解析得到不同 ID/cwd。真实 `get_session` 返回 `SESSION_INVALID`，文件未改写；没有 monkeypatch SessionManager，也没有和用户 JSONL 竞速。真实持久化会话的 ordered parts 历史回放另外通过。
- **R15 缺陷与替代包**：`third.txt` 首先暴露 harness 试图 focus 隐藏控件；改为真实可见 tab stops 后，`fourth.txt` 确认最后可见 `summary` 没有被焦点循环包含，且关闭的 details 内控件仍被计算。`WorkspaceLayout.test.tsx` 新 regression 先红（`layout-red-node22.txt`），再在 `WorkspaceLayout.tsx` 过滤 hidden/CSS/closed-details/disabled/负 tabindex 并包含 summary。`layout-green.txt`、全 Web56 tests、重新打包后的原 Chrome 断言均通过。没有放宽 CSP、协议或业务预算。
- **失败不掩盖**：`first.txt` 的启动期 get_state timeout 未计通过；加入原生 session_start readiness 等待及诊断后复验，未声称已证明首次 timeout 的唯一原因。`fifth.txt` 是 page reload 重置内存语言后的 harness 预期错误；`sixth.txt` 是 CDP expression 换行转义错误；`eighth.txt` 是 fixture typecheck 用 require 解析 import-only export，改为读取实际 types entry。以上都保留，不修改应用行为迁就 harness。`seventh.txt`、`ninth.txt`、`final.txt` 与最终 **`final-audited.txt` 均退出0**；最后一次共23项明确检查，`latest.json`及同目录独立 run JSON 保存 identities/清理摘要，不保存聊天全文。
- **全量复验**：`R18-native/verification.txt` 退出0，Node22.23.2/npm11.16.0、Go1.24.2/native GCC；TS **479**、Web **56**、frozen contracts **325**、real Go bridge **19**；assets/plugin8、candidate/source-build5、native launcher2、fresh actual-bundle integration1；Go普通/vet/full race/webembed race、transport/service各5次；fuzz **653,558 executions**，无失败。31 protected文件不变；旧codec兼容仍通过。Vite约767.62kB chunk warning保留，未隐藏。
- **当前候选**：`.refactor/release/pack-30bbqJ/cafecodework-pi-cafe-space-0.1.0.tgz`；SHA-256 **`32ee907b902174495ed3e1ea9307a8f339cd8df79ede3e7f23e50eeccc94bfd2`**。Web digest **`ccd8e0767e578c9adb38f2783549e21f8a90353999ad02ab78c9fd8d24572c15`**；windows-amd64 binary SHA-256 **`a0f1bb438d108403c77c6d471a9a5dc086149d8681aefdc76a51216eed7a8e23`**。§31 的 pack-ZvSIQF 是历史候选，已被本次修复替代；TS digest 不变。
- **进程与清理**：启动前再次拒绝占用37983/9333，并校验 listener 属于刚创建的进程；按 executable/creation/唯一命令标记登记。停止前保有 process HANDLE、两次复核完整身份；错creation/exe/command line的拒停测试通过。finally 只处理本轮 Pi/Chrome/Go；结束审计无该 run 命令路径的进程、37983/9333无监听、自有 install/session/profile/temp已移除。37891/9222前后仍是同一组监听 owner；没有停止旧服务、改默认入口或全局配置、删除旧实现、commit/push。`R18-native/closeout.txt` 退出0，另核对 fresh source build 与实际安装候选的 Web/binary/archive identity、精确25-file包不含harness、23项原生检查、无临时目录残留、31 protected hashes、旧codec、文档/JS语法/PowerShell5.1与diff检查。
- **剩余边界**：外部模型/provider调用、额度和所需凭据来源未在本轮验收，需明确 provider/model 与调用上限后单列；当前不能宣称 R18 全部模型能力或生产环境通过。其他四个平台无本轮可执行产物/实测。R19仍未开始，不能因受控专项通过就自动切换或清理旧实现。

## 34. 外部验收受阻：首个请求 HTTP 403（2026-09-22）

- **授权与结果**：用户“按此执行”批准仅使用既有cafe配置/凭据，在隔离Pi测试`cafe / gpt-6-astra`，最多2次调用、每次最多1024输出tokens、无自动重试、模型阶段总60秒。实际只发出**1次880-byte请求**，线上body的`max_output_tokens`确为**1024**；服务端返回**HTTP 403**，**1085ms**后预算已关闭。无第二次请求、模型completion或工具执行；没有usage，不能推断实际计费为零。403不能单独证明密钥失效，也不能据此确定模型权限、网关或其他策略的具体原因。
- **状态**：R18.2从doing转blocked。受控原生23项和候选安装/浏览器结果继续有效，但外部模型→工具→UI链路没有通过，不建议或执行R19。一次性授权账本已保留并封存；不得因上限还剩一次就自动重试、切模型或修改凭据。后续外部诊断/复验须明确新的范围与预算。
- **新增专项源码**：`scripts/refactor/external-acceptance.mjs`、`external-fixture.ts`、`external-budget.ts`、`external-budget.test.mjs`。不接普通build/test，不进入发行allowlist；候选的应用源码和archive/Web/binary身份未变化。真实Pi仍独占AgentSession与工具；第一轮强制一个无文件/网络/shell能力的固定测试工具，第二轮禁用工具；本次403发生于第一轮，因此该外部工具流程未实际执行。
- **发送前限制**：发送函数核对精确HTTPS endpoint、POST、Authorization、模型、body字段/16KiB上限、`stream:true`、`store:false`与1024输出上限；禁止redirect。每个原生stream调用仅有一次fetch票据，最多2张；OpenAI SDK与pi-ai重试均为0，隔离Pi retry/compaction关闭。60秒共用AbortController，另有父进程abort watchdog；不会给工具续轮重新计时。创建`authorized-once.jsonl`时使用wx，发送前fsync记录；失败不重置账本。服务端输出上限依赖Responses API执行，不能将请求参数或403当成服务端成功生成/计费证据。
- **隔离与保密**：只读取授权的cafe/model记录，凭据仅用于隔离Pi进程里的provider请求，不经Relay/Web、命令行或报告。使用固定非秘密system/user文本、单一受控工具、空白自有project/session；禁用其他资源和内置工具。报告只保存状态/计数/身份，丢弃服务端错误body，不保留外部聊天全文或私密诊断。未修改全局Pi/provider配置、生产入口、旧服务或原项目文件。
- **预演与失败保留**：`R18-external/guard-red.txt`为未实现时的红测；`guard-final.txt`为**5 tests passed，0 failed/skipped**，包含真实60秒timer中止假的pending fetch，不访问网络。`dry-first.txt`发生readiness timeout，原因未定，不计通过；`dry-second/third.txt`暴露SDK要求整数timeout，修正毫秒取整并加断言。`dry-fourth.txt`的off预演通过，但`external-first.txt`实际启动时被配置检查拒绝，**没有arm或外部模型请求**：全局模型明确`off:null/minimal:null`，最初只读检查中的`?? 'default'`误把null显示为默认，已纠正，实际支持的低档为`low`。`dry-fifth.txt`按相同null/low配置再预演通过，仍仅是假HTTP响应经过真实Responses SDK/Pi/Chrome，不是外部证据。
- **真实证据**：`R18-external/external-second.txt`退出1；`external-latest.json`、`external-WRDKaf.json`与`authorized-once.jsonl`分别记录失败阶段、1次请求/403/1085ms/0工具、持久化发送计数。旧首次启动报告的`externalModel:true`当时仅表示所选运行模式，不能当作已发送；后续已拆成`externalModeRequested`和按请求计数计算的`externalModel`。本轮已安装原pack-30bbqJ并通过实际Pi types的strict检查，Chrome已就绪；未完成的浏览器模型输出断言不算pass。
- **收尾复验**：`R18-external/closeout-final.txt`退出0；根typecheck、package check、TS **13 files/479 tests**通过。另核对403报告与单次账本一致、预演不当外部证据、原candidate/archive/Web/binary身份未变、精确25-file包不含新增harness、31 protected文件不变、旧codec兼容、文档/JS语法与`git diff --check`。本轮未改应用代码，不冒充重新执行了§33整套Web/Go/race/fuzz；本轮也没有重建/覆盖候选。
- **清理**：复用原生owner helper，最终无自有Pi/Chrome/Go进程、37983/9333监听或external/budget临时目录；37891/9222监听owner前后一致。仅报告与一次性账本保留。没有commit/push、发布、切换或旧代码清理。

## 35. 本机持久安装与用户手动试用（2026-09-22）

- **授权**：用户明确要求“真正的在本机安装启动 我自己来测试”。因此安装并保留独立试用实例，不再由助手发送模型请求，不用假模型/受控响应。不是R19生产入口替换，也不停止旧服务。§34的外部自动验收及封存账本不改为通过；用户手动模型操作使用自己的正常配置/额度，不套用原自动验收的2×1024上限。
- **实际安装**：`.refactor/manual-trial/`是保留目录，使用npm11正常offline cache安装原pack-30bbqJ、已安装Pi0.85.1的本地peer和独立ws8.21.3；先核对archive SHA、25项普通文件与精确allowlist。包的check/test在空PATH下做artifact验证通过，不冒充source tests。安装目录ACL限制当前用户和SYSTEM；独立home/agent/temp/project/session/Chrome profile，随机host/client token仅存于该目录，不把provider key复制到磁盘。
- **真实运行**：Go/React提供`http://127.0.0.1:37983/`；Chrome SxS为**可见窗口**而非headless，并已通过真实page target自动填写登录和连接。另开**原生Pi交互控制台**，实际`stdin.isTTY/stdout.isTTY`均为true；包通过`-e <安装目录>`加载。专用loader只把既有cafe/gpt-6-astra配置注册到内存，沿用原生API transport、模型参数/成本/思考映射与原生工具，**无stream override、测试工具或预设回复**；不改全局配置。Pi的retry/自动compaction在独立设置中关闭，启动网络和资源自动发现关闭；用户需要的本地交互仍在Pi窗口完成。
- **启动证据**：`R18-manual/install-first.txt`退出0；`.refactor/manual-trial/manual-ready-report.json`记录实际native snapshot与TTY证明：cafe/gpt-6-astra、low、idle、0 messages、0 Agent tools，cwd为`.refactor/manual-trial/project`，独立sessionId一致。验证客户端只发送hello、不发送command/prompt；网页仅登录/连接，没有发送模型请求。`verify-red.txt`保留未安装时的失败，实际安装后相同snapshot/identity断言通过。
- **用户入口**：浏览器可直接开始测试；安装目录中`Start.cmd`用于停止后重启，`Stop.cmd`用于停止本试用，`README.txt`说明project/session/本地令牌位置。停止会结束试用Pi，用户应先完成或取消正在运行的任务；不批量杀用户自行启动的工具子进程。会话和安装不删除，原37891/9222服务仍保留。
- **所有权与检查**：`manual-runtime.mjs`在首次启动拒绝占用端口/既有owner文件，先校验package binary；持久登记Go/Chrome/console/Pi的exe、creation与完整命令。停止前先验证所有record的角色路径/marker，Chrome的Browser.close同样在身份与listener匹配后才允许；强制终止复用已测native-process helper的保留HANDLE/两次复核。`manual-stop.test.mjs`只对新建无网络dummy进程做错误marker拒绝与正确owner终止，**没有停止当前试用实例**；测试通过，前后四个监听owner一致。检查中的顺序加固已同步到自有试用helper，不改安装包dist或业务代码。sa-11只读任务超时，未作为审查结论。
- **本轮源码**：`scripts/refactor/manual-{install,runtime,verify}.mjs`、`manual-stop.test.mjs`及`manual-trial/{provider.mjs,pi-console.ps1,launch-console.ps1}`；不加入发行包/普通模型测试。候选仍是§33同一archive/Web/binary；没有build/prepack/默认入口切换、全局install、旧代码清理或commit/push。
- **收尾结果**：`R18-manual/check-first.txt`退出0（真实dummy的stop regression **1 passed**、31 protected文件、文档/JS语法、diff）；`closeout.txt`退出0（根/package check、TS **13 files/479 tests**、安装helper与源码一致、原候选25项/SHA未变、用户试用listener保留且旧owner不变）。`current.json`记录保留状态，不记录聊天/终端画面。未重新跑Web/Go/race/fuzz，也未将模型403标为已修复。
- **有意保留**：37983 Go、9333独立Chrome以及本轮交互Pi/console继续运行，供用户测试；这不是忘记清理。后续自动native/external验收遇到这两个端口必须拒绝，不得自行关闭用户正在用的试用实例。仅stop测试的dummy进程/目录已清理。外部模型生成与完整TUI行为仍待用户反馈，不能把空闲就绪当作模型请求成功。

## 36. 普通 Pi 启动自动注册到本机试用 Web（2026-09-22）

- **需求与原因**：用户希望Web看到正在运行的会话/实例，并提出“本机pi启动的时候注册一下不行吗”。现有extension已经默认在`session_start`注册；缺失不是历史目录问题，而是全局Pi仍加载旧源包、默认连37891/main，新Web却连37983/manual-trial。没有扫描所有进程或合并全局JSONL。
- **实际接线**：仅将`C:\Users\example-user\.pi\agent\settings.json`的Cafe Space package字符串替换为`C:\Users\example-user\.pi\agent\cafe-space-local\extension.ts`，其余JSON设置严格相等，并保留原ACL。`registration-backup.json`只记录被替换项与哈希，不复制全局设置/凭据。原始配置仍在其他已运行Pi的内存中；不主动重载/终止它们，用户在各窗口执行`/reload`或以后正常启动时生效。
- **实现**：`scripts/refactor/local-registration/`的adapter直接加载已安装的原SHA候选extension，不创建第二个AgentSession、不注册provider、不发送prompt。只有默认/精确的本机37983目标获得试用Relay令牌；显式其他endpoint绝不继承这些令牌。保留CLI/env优先级、不同room、`PI_COLLAB_ENABLED=0`及显式peer ID；普通实例沿用candidate的每进程唯一ID。`session_shutdown`仅撤销自己仍持有的环境默认值，便于reload。
- **上下文与保密**：普通Pi保留原cwd、原会话、原provider/model/思考设置和原生工具。当前会话由所属Pi投影；历史仍由所选host按其cwd/sessionDir查询，不为接线移动或复制用户会话。试用Relay配置从`trial.json`原位重命名为`credentials.json`，并同步自有启动/停止helpers，利用已冻结的敏感basename拒读；未改变文件策略、candidate dist、archive、Web或binary。provider key不进入adapter配置或Relay/Web。
- **测试证据**：3项默认值/覆盖/非目标令牌隔离tests以及真实dummy stop regression共**4 passed**。`R18-registration/smoke-final.txt`和`smoke.json`通过：针对实际Pi0.85.1 types做strict检查；在独立测试room启动两台真实native CLI/RPC，仅将这一个全局注册入口镜像到独立agent settings中自动发现（没有`-e`/`--collab`/显式relay/token），收到不同ID/cwd的snapshot；第三台用`PI_COLLAB_ENABLED=0`保持离线；实际`read_file credentials.json`被拒绝为`SENSITIVE_PATH`。这是注册测试，不是全套其他全局插件/TUI兼容或外部模型验收；测试模型是不会发请求的占位配置，未生成任何假回复。
- **失败与范围**：首次通知型readiness等待超时保留在`smoke-first.txt`，未计通过，也未断言唯一原因；后续以Relay实际snapshot为就绪门槛复验通过。激活曾因路径末尾分隔符导致严格匹配拒绝，规范化后仅替换目标一项；`activation.json`记录落盘结果。所有测试**0模型请求**、无agent_start/聊天消息，不重开封存外部账本。自有测试Pi全部按owner复核停止、目录移除；既有37891/9222/37983监听owner不变，用户服务未停。
- **收尾复验**：`R18-registration/check-final.txt`退出0：根typecheck、package check、TS **13 files/479 tests**、31 protected文件、原25-file候选/archive/binary身份、全局单项设置与adapter哈希、helpers一致性、文档/语法及diff检查通过。没有重跑Web/Go/race/fuzz，也不把注册检查当作模型能力通过。
- **用户操作/保留**：新Web仍为`http://127.0.0.1:37983/`、room `manual-trial`。已有普通Pi需用户`/reload`，不是声称它们已被自动注入；带显式旧relay/禁用设置的进程仍尊重原设置。`.refactor/manual-trial/`现在也是普通Pi注册的依赖，不得当成临时测试目录删除。`Stop.cmd`会停止共享试用Relay，让已接入普通Pi的Web连接中断，但不会终止那些普通Pi。全局provider设置、仓库生产launcher和旧实现均未改；R19发布/旧实现清理、commit/push仍未执行或获批。

## 37. 补齐本地 Web 登录操作（2026-09-22）

- 用户反馈停留在“客户端令牌/房间”登录页。当前Web按契约使用sessionStorage保存认证，新的浏览器/标签页可能没有登录状态；此前仅提供URL和Pi注册说明不足以完成登录。
- 只读检查使用现有clientToken、与网页一致的Origin向37983发送hello，在独立空房间获得welcome；`R18-registration/login-check.json`记录鉴权有效、0 commands/模型请求，未读取真实会话。没有关闭认证、修改Origin/CSP、暴露host/provider令牌或将token放进URL/报告。
- 新增`manual-trial/copy-login.ps1`源helper，并在持久试用目录提供`Copy-Login.cmd`及该helper副本。校验私有配置格式/大小/普通文件和客户端令牌后，复制到Windows剪贴板并在本机比较确认成功，只输出操作说明、不输出令牌。用户粘贴到客户端令牌框、填写`manual-trial`后显式连接；当前用户页面尚未由助手操作，不能冒称已经登录。
- 此次已执行复制并核对成功；同步本机README。未启动/停止Pi、Relay、Chrome，不改全局设置或任何candidate产物；这是登录操作补齐，不是模型能力验收。

## 38. 房间放入 Hash URL：实现通过，试用服务待更新（2026-09-28）

- **授权/范围**：用户确认将房间放入URL。仅实现Web房间导航及相关测试/契约/记录；不改协议、认证、Pi配置、会话、模型、存储key或生产默认入口。不将此前试用许可扩大为自动停止正在使用的37983/9333。
- **行为**：新增`/#/rooms/:roomId`及其`/history/:sessionId`路径；显式房间在首次socket前优先于sessionStorage/服务端默认。该登录页只填token、纯文本显示URL房间；旧根入口仍能手填房间，提交后生成房间书签。历史链接、host选择回实时对话、logout均保留房间。返回按钮切房间时撤销pending、清理旧host选择/草稿/panels/cache并拒绝旧generation回调。令牌、cwd、文件路径不写URL。
- **校验/兼容**：room单次decode后沿用ASCII1–64上限；超长、空段、非法百分号、二次编码、斜杠/非ASCII拒绝，不静默退回旧房间。历史opaque ID不被room parser解码，继续由原解析器单次decode；只读历史不变为当前会话，也不携带历史sessionId发送prompt。原根路径/未带房间历史书签保留。
- **源码/测试**：`web/src/app/{roomRoute.ts,roomRoute.test.ts,roomRoutes.test.tsx,App.tsx,owner.ts}`、`features/auth/LoginForm.tsx`、`features/history/History.tsx`；`scripts/refactor/integration.test.mjs`增加实际bundle的房间深链登录、旧cached room覆盖、历史URL、房间切换清视图与logout断言。`roomRoute.test.ts`16项、`roomRoutes.test.tsx`6项，涵盖StrictMode、back、非法路径无连接、刷新历史页等待inventory、鉴权失败重新登录。
- **失败保留/修复**：先红测证实原实现仍要求手填room、错误连接旧room；最初误用根Vitest3的`red.txt`不作批准工具链证据，已以包内Vitest4.1.11重跑`red-approved.txt`。`first.txt`暴露测试fixture用空日期而被既有codec拒绝，改合法fixture；首次typecheck发现测试误写不存在的seq字段，改`lastEventSeq`。`check-first.txt`实际back测试发现host选择在同一路径重复push导致多余历史项，修复为只有离开当前页时导航，未删断言。
- **通过证据**：`R15-room-url/check-second.txt`退出0：Node22.23.2/npm11.16.0、Go1.24.2；Web typecheck及**20 files / 75 tests**、package check、assets/plugin **8 tests**、fresh Vite+Go webembed全包tests/build、25-file fresh pack、真实嵌入bundle+临时Go Relay集成、31 protected文件/文档/语法/diff通过。新增房间bundle断言另在`bundle-room.txt`通过：来自新binary HTTP的真实React JS在JSDOM中运行，使用自有synthetic hosts/临时端口，无真实Pi/Chrome/provider。最终补齐URL尾部编码CR/LF/空白拒绝测试后，`final.txt`退出0，Web为**20 files / 78 tests**；closeout核对旧archive/已安装包不变、37983健康且仍为记录的Relay PID、新旧Pi extension/protocol逐文件哈希一致、无integration目录残留。未重新跑native Chrome、外部模型或Go race/fuzz；Vite约769.02kB chunk warning保留。
- **新待安装候选**：`.refactor/release/pack-7qGHnu/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `1b164ddac0de9d339e00c0f579477a13dd7e5d4eea4b8ba6468d7583dbe442aa`；Web digest `680b97d900f209b0ddd28b3aa4513f8d0f616f1b18850df5f6b8f8d0b95028aa`；windows-amd64 binary `e18283e68696a8a620a8fe84aa40f24a9ac5f1dd2b18b835a20dab6b5ef85a1f`。仅新增隔离候选/覆盖自有构建staging，不替换§33/§35已安装的pack-30bbqJ，不把旧native验收自动授予新包。
- **未生效边界**：当前37983仍服务旧候选。新链接`http://127.0.0.1:37983/#/rooms/manual-trial`尚不能当成已部署入口；需要用户确认仅更新/重启试用Relay后才能使用，不能说刷新已可用。不终止原生Pi/Chrome/旧37891，不执行Stop.cmd、全局install/reload、R19、commit/push。sa-12只读搜索超时，没有采用其审查结论。

## 39. Café Workspace UI 重构完成，试用服务待更新（2026-09-28）

- **授权/设计**：用户先指定安装并阅读`cafecodework/cafe-design-skill`，再明确“好 开始重构ui页面”。按skill `926e11c4`的Workspace方案实现，不以assistant-ui官方默认皮肤替代Cafe规范。详细设计/文件清单/复验边界见[CAFE_UI.md](./CAFE_UI.md)。保留React/assistant-ui/SCSS及原状态所有权，不新增UI依赖、provider调用或生产切换。
- **呈现**：集中`tokens.scss`深浅主题、字体/间距/圆角/控件/状态颜色；重排品牌/房间/连接工具区、实例/历史导航、对话与代码/表格、工具卡片、Composer、文件预览及登录。静态装饰SVG与共享蒸汽busy indicator；加载不跳按钮尺寸，图标不污染accessible name。保留Pi Cafe Space身份，不复制Cafe Shop字标/商城/营销或伪造数据。主题为页面内存状态，切换不连接或发送command、不新增storage key。
- **范围保护**：开始保存`before/`Web源快照、git状态/diff；与该快照逐文件核对，client/Gateway/Store/runtime/converter/CollapseState/owner/roomRoute/data解析器未改。已存在的大量R12–R18/room URL dirty工作保留。仅展示组件/SCSS、i18n、静态外壳颜色、对应测试/验收脚本及文档变化，旧web/public与dist不动。
- **先红后绿/缺陷**：`red.txt`四项新UI红测，之后Web全部通过；`App.test.tsx`只将旧登录标题换成新标题并增加明确Disconnected断言，不删除不建socket检查。`browser-first.txt`是旧Chrome已不监听9333导致安全预检拒绝，未触碰未知owner；确认端口空闲后改为fresh自有Chrome SxS/profile。`browser-second.txt`是harness返回DOM节点导致CDP序列化失败，改void返回后通过。加严短屏可读区域断言后`browser-short-red.txt`暴露640×360消息区只剩padding，修复短屏header/textarea布局；`browser-short-green.txt`和最终复验通过，没有降低阈值。
- **最终验证**：`verify-final.txt`退出0，Node22.23.2/npm11.16.0/Go1.24.2：Web **21 files / 82 tests**、Web/package typecheck、**4项**tokens/contrast/无散落颜色测试、**8项**assets/plugin、fresh Vite+Go webembed全包tests/build、精确25-file pack、真实Go+实际嵌入React bundle集成**1项**、31 protected文件检查全部通过。Vite约778.35kB主chunk警告保留，未提高阈值。未重跑Go race/fuzz或native Pi/provider链路。
- **Chrome证据**：`browser.json`为Chrome SxS真实DOM **6组检查/24组几何采样**；深浅主题各1440×900/1280×720/1024×768/900×700/720×450/390×844/320×640/640×360，另有登录/长room/历史/空态/running/local UI wait。无横向溢出，主要控件在视口内，send可见，非空对话净滚动空间≥48px；真实Tab/Escape/焦点恢复、读取历史只读、draft/tool DOM/用户上滚位置保持、busy尺寸/reduced motion、auth失败清token通过。specimen也已在隔离context打开深浅两主题。不是截图、JSDOM几何或真实200%缩放证据。
- **浏览器隔离**：9333开始空闲，仅启动/清理本轮owner核对的headless SxS及新profile；不复用用户page、不操作9222。只在新context内Fetch拦截并提供fresh编译assets，沿用当前Go HTTP的严格CSP；synthetic WS fixture不持有native WebSocket，因此0真实Relay命令/0真实Pi/provider请求。无CSP/runtime/console错误/外部资产请求；合成内容明确不当模型生成。上下文/浏览器子进程/profile清理，原37891/9222/37983监听owner不变。
- **收尾核对**：`closeout.txt`退出0；根typecheck、最终browser脚本复跑、与before快照的改动白名单、浏览器实际asset SHA与最终staging逐文件一致、旧两个archive/已安装包/TS digest未变、37983健康且仍为记录的PID、无自有browser/integration残留、文档/脚本语法及diff检查通过。`closeout.json`记录Chrome155.0.8047.0与最终候选身份，不保存真实聊天或令牌。
- **最终待安装包**：`.refactor/release/pack-BjCbwa/cafecodework-pi-cafe-space-0.1.0.tgz`，archive SHA-256 **`2659122e6e6df19ff0b1566cf2334217312433009c468545082db56344b287d5`**；Web digest **`0f7de4d2f98d99f3746f568215af2ab85a5e0bb002cff3342395b17098d3a37f`**；windows-amd64 binary **`1d44c2ca4aa278ec1060fdf2abfdee9d5910b96e2ae007af7b37f4256b38fa37`**；TS digest与原已安装候选一致。中间pack-g35CQb只作迭代记录，不作最终短屏验收包。
- **未生效/下一步**：37983仍为原已安装pack-30bbqJ；本次无替换、重启、Pi reload、全局配置更改、外部模型重试、R19、旧代码清理、commit/push。新包包含§38房间URL；需明确允许更新/短暂重启试用Relay后用户才会看到新UI。sa-13只读搜索超时未产出结论，所有检查由执行者完成，不冒称独立审查。

## 40. 本机试用 Relay 更新并重启完成（2026-09-28）

- **授权/范围**：用户在UI完成报告后明确“更新和重启”，随后“继续”。仅更新`.refactor/manual-trial/`现有安装中的Relay并重启37983；不执行Stop.cmd，不停止/重启Pi或Chrome，不做R19、生产默认切换、全局注册修改、reload、模型重试或commit/push。
- **安装方式**：固定§39的pack-BjCbwa archive SHA，tar精确25个普通文件白名单，解包并逐文件比较；差异恰好为`README.md`、`dist/relay/build.json`、`dist/relay/bin/windows-amd64/pi-cafe-relay.exe`。只原位替换这3项，另外22项（含extension/protocol/scripts/package manifest）未改；最终25项与新archive逐文件哈希一致。同步trial自身package.json的本地archive依赖记录，保持安装路径、credentials.json、普通Pi注册入口和运行中Pi所加载的JS不变；没有npm install/lifecycle或依赖解析。
- **进程安全**：先校验exe、完整命令、creation、PID和37983 listener归属；持有`.runtime-go/relay.127.0.0.1-37983.lock`避免自动launcher并发启动，仅通过已测的owner helper终止旧Relay。原PID18064变为51180；18:17:03.781Z停止核对完成，18:17:06.654Z新实例健康/资源/owner确认完成。其他service owner记录逐字保持，37891/9222仍分别由8324/35904监听，9333前后均未监听且未启动浏览器。
- **验证结果**：`.refactor/reports/R18-ui-deploy/`保存`check.txt`、`apply.txt`、`result.json`及`final-check.txt/json`，命令均退出0。同源client仅发送hello，验证3个原在线Pi全部自动重连ready，host ID及session/cwd摘要与更新前相同；不发command、不保存聊天正文。健康通过，实际HTTP返回的**5个嵌入资源**SHA与最终Web digest对应资源逐项一致；安装binary的`--version`/platform/checksum验证通过。识别到的native Pi CLI进程PID/creation未变；没有写入会话文件。
- **安全回归**：新增`scripts/refactor/relay-update-safety.mjs`及`.test.mjs`。先红（实现不存在，`red.txt`），后**3 tests / 3 pass**（`safety.txt`），覆盖非Relay/错误身份/额外命令拒绝、仅3文件差异白名单、并发内容更改拒绝及原子替换/还原。部署器位于报告目录`update.mjs`，有停止前全部重核、独占锁、已知哈希备份和新实例失败时的owner核对回退；此次没有触发服务回退。
- **保留/清理**：pack-30bbqJ、pack-7qGHnu、pack-BjCbwa三个archive哈希未变。旧3文件及非秘密安装记录备份保存在`.refactor/manual-trial/relay-update-AKLcP4/`，`receipt.json`记录成功更新；check预演的`relay-update-U9YQhL/`也保留。自有launcher锁已释放；只保留用户要使用的新Relay，没有新增Pi/Chrome或其他监听服务。回退不得直接覆盖运行中的exe或运行Stop.cmd，仍需先核对且只停止对应Relay。
- **当前入口**：**http://127.0.0.1:37983/#/rooms/manual-trial**。用户刷新既有网页即可看到新UI；令牌不变，带房间链接只填令牌。本次未替用户导航/刷新浏览器。更新了`WEB.md`、`CANDIDATE.md`、`CAFE_UI.md`及本机README，§38/§39“待更新”属于当时的历史状态。
- **验收边界**：本次为已验证成品部署及只读重连核对，没有重跑Web82项/浏览器布局专项或发送模型请求；沿用§39对应同一SHA产物的验证证据。外部provider HTTP403封存和非Windows未验证状态不变，不能把本次健康/重连通过写成外部模型验收成功。

## 41. Radix 基础控件接入完成，候选待部署（2026-09-29）

- **授权/范围**：用户明确“采用Radix UI Primitives”。仅统一Web基础控件和弹层，沿用Café Workspace tokens/SCSS、React及assistant-ui，不改聊天/通信/路由/会话所有权，不把§40的单次重启授权延伸到本轮。设计、API与失败记录见[RADIX_UI.md](./RADIX_UI.md)。
- **依赖**：将已有依赖图中的`@radix-ui/react-dialog@1.1.23`、`react-tooltip@1.2.16`、`react-label@2.1.15`声明为该workspace直接依赖。批准工具链npm11离线、ignore-scripts安装；没有新增包版本或其他workspace升级。npm顺带重写的无关pi-subagent lock版本已恢复；closeout结构比较证明根lock只有3个声明变化。未增加Radix Themes、Tailwind或新主题系统。
- **组件**：新增`components/ui/{Controls.tsx,Controls.module.scss,Controls.test.tsx,UiProvider.tsx,Tooltip.tsx,Drawer.tsx,Drawer.module.scss}`。共享Button/IconButton/Input/Textarea/NativeSelect/Label，业务页面不再直接散布基础控件；统一primary/quiet/disabled/loading及ref/原生表单语义。App、登录、Composer、模型设置、文件、历史、WorkspaceLayout使用统一入口。复杂Dialog/Tooltip交互由Radix承担；loading保留蒸汽占位、不增加重复发送路径。
- **CSP/可访问性**：实际核对官方文档与已安装source/types；Radix Select及默认Dialog Overlay会注入style，本轮不采用这两个部分，也不改服务器CSP或依赖源码。思考级别/delivery保留NativeSelect；Dialog使用外部SCSS遮罩，Radix负责modal、背景ARIA隔离、Escape和焦点，原闭合details/hidden/inert/disabled的Tab边界检查迁入共享Drawer保留。portal在带主题/语言的main内、inert grid外；退出/resize/unmount恢复交互和焦点。
- **边界核对**：before保存Web源、package manifest及根lock；与快照逐文件比较，允许范围外的owner/RelayClient/Gateway/Store/runtime/converter/CollapseState/路由/data解析器未改。编译TS digest仍为`9483b8bee30b8054980ee497cec0f57cf631e65dea623db6fdbb1344a3cdfee8`。原dist、web/public及31 protected文件未变。
- **失败保留**：`red.txt`为新组件实现不存在的红测；`test-first.txt`暴露Radix焦点恢复异步时序与Tooltip JSDOM超时。焦点断言改waitFor而非删除；Tooltip定位/focus/hover/Escape/portal完整断言移到实际Chrome，不提高timeout、不用mock冒充通过。`browser-first.txt`等背景target focus失败通过只激活本轮自有target修复；`verify-first.txt`的hover leave停在grace polygon，补充实际越界移动后通过。误用根Vite7的初次手工构建不作核准证据，后续包内Vite6重建；所有最终断言保留。
- **最终验证**：`.refactor/reports/R15-radix/verify-final.txt`退出0：Node22.23.2/npm11.16.0/Vite6.4.3/Go1.24.2；Web **22 files / 86 tests**，Web/package/root typecheck、assets/plugin **8**、theme **4**、已有update safety **3**、fresh Go webembed tests/build、精确25-file pack及实际Go+嵌入React bundle集成 **1** 全通过。主chunk约836.06kB警告保留，不放宽限额。没有重跑Go race/fuzz或原生Pi/provider专项。
- **Chrome证据**：`browser.json` Chrome155.0.8047.0为 **8组检查 / 24组布局采样 / 2组Tooltip主题与位置采样**，包含两主题、多尺寸、focus/hover/Escape/Tab、modal背景隐藏、外部点击/断点变化清理、原closed details焦点、busy尺寸、draft/tool DOM/滚动保持、只读历史及auth清token。strict CSP无违规，console/runtime错误0、native WebSocket 0；所有5条command/1条prompt仅流向明确的合成fixture，不触达真实Relay/Pi/model。
- **最终待安装候选**：`.refactor/release/pack-7Yb74q/cafecodework-pi-cafe-space-0.1.0.tgz`；archive SHA-256 **`2accaf955fc3f48508c3c915d6c2f879ce22eb4419c0cafff3a3e2ebcd7010f8`**，Web digest **`8afc8a71a7c2176233941bbad76d13ec4622008055c6e61c4c0869a01070ec81`**，windows-amd64 binary **`a1fee21b3d188e70cdee52ab7c379596cb130624125184179bdf9db30e5a1933`**。pack-hcYHwR仅为前次完整验证中的中间包，不替代最终记录。
- **收尾/部署边界**：`closeout.txt/json`退出0，源码/lock白名单、新包SHA、实际browser asset与最终staging逐项一致，旧archive、当前安装25文件和37983 PID51180均未变；37891/9222原owner不变，9333自有Chrome及profile/context清理，integration资源无残留。本轮没有重启现有服务、改全局注册、Pi reload、模型请求、R19、commit/push。需后续授权才更新37983；新candidate package.json还增加开发依赖声明，不能直接复用仅允许3文件差异的§40更新器。sa-14只读任务超时，未使用独立审查结论。

## 42. Radix 候选部署到本机试用（2026-09-29）

- **授权/边界**：用户在§41候选报告后明确“更新”。只将已验证的pack-7Yb74q部署到现有37983试用Relay并重启该Relay。没有停止/重启Pi或Chrome、reload、运行Stop.cmd、改全局注册/provider、读写会话、发prompt/model请求、生产切换/R19或commit/push。
- **产物**：`.refactor/release/pack-7Yb74q/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `2accaf955fc3f48508c3c915d6c2f879ce22eb4419c0cafff3a3e2ebcd7010f8`；Web digest `8afc8a71a7c2176233941bbad76d13ec4622008055c6e61c4c0869a01070ec81`；windows-amd64 binary `a1fee21b3d188e70cdee52ab7c379596cb130624125184179bdf9db30e5a1933`。沿用§41同SHA构建/test/browser验收，不把模拟UI内容说成真实模型验收。
- **精确差异**：tar普通文件清单及发行25文件表匹配、binary平台/checksum校验成功；已安装目录逐项比较确认唯一不同是`README.md`、`dist/relay/bin/windows-amd64/pi-cafe-relay.exe`、`dist/relay/build.json`、`package.json`。另外21项全部哈希保持；尤其Pi extension、protocol和launcher未动。新package manifest保留runtime dependency仅`ws@8.21.3`、Pi peer，三个Radix精确版本只在devDependencies。同步trial本地archive引用；没有npm install/lifecycle。四个旧版本文件字节备份和receipt位于`.refactor/manual-trial/radix-update-kMfFL8/`。
- **进程/隔离**：先用PowerShell核实37983的PID51180、creation、exe、完整`--instance`命令及listener owner；核实3个Pi host ready/上下文哈希和Pi CLI PID/creation，并获取只发送hello的只读inventory。不保存snapshot/chat/tool结果。独占lock后，owner helper仅停目标Relay并启动binary；PID **51180→33604**。停止记录05:21:07Z，新Relay健康与资源核验05:21:09Z，随后3个Pi host全部ready重连且host/session/cwd摘要一致；native Pi进程creation不变。Pi继续连接原Relay配置，无需reload。令牌/credentials未改。
- **验证/证据**：`.refactor/reports/R15-radix/deploy-safety.txt`：Relay更新安全测试**3/3 pass**，增加并验证4-file Radix manifest差异集合；`deploy-check.txt`：应用前预检通过，`deploy-apply.txt`：部署成功，`deploy-final.txt/json`：末态核对通过。最终核实25安装文件、4旧文件备份、3个历史archive SHA、installed candidate `--version`及platform/checksum、实际HTTP **5/5嵌入资源**哈希、健康、Relay owner marker、无launcher lock残留。`37891`仍为PID8324，`9222`仍为PID35904，其他service owner记录不变；未操作9333页面。不会把health/reconnect误称为Radix真实用户页面的视觉再验收。
- **失败保留**：首次预检在停止进程前因少带报告目录的`pi-audit.ps1`读取失败；修复为本地只读helper后重跑通过，未更改运行包或任何监听。`.refactor/manual-trial/radix-update-BdnWae/`与`radix-update-izOpxW/`是该失败/成功只读预检创建的临时staging，含新候选副本与owner标记，无运行进程；为保留执行证据不删除。有效备份/receipt仅在`radix-update-kMfFL8/`。
- **当前试用入口**：**http://127.0.0.1:37983/#/rooms/manual-trial**。房间在Hash URL，用户刷新或Ctrl+F5即可加载Radix版本；令牌不变，只需令牌登录。本次不自动导航/刷新用户Chrome。
- **文档/状态**：更新`WEB.md`、`refactor/CANDIDATE.md`、`RADIX_UI.md`和试用README。部署仅针对用户控制的本机试用，不改变R18外部模型HTTP403受阻结论、非Windows验证状态或生产候选门禁。

## 43. shadcn/ui + Tailwind实现及候选完成，未部署（2026-09-29）

- **授权**：用户明确“换成shadcn/ui方案，并接入Tailwind，pnpm dlx skills add shadcn/ui”。这取代此前不加入Tailwind的UI限制，不改变assistant-ui/原生Pi所有权或部署门禁。已执行`pnpm dlx skills add shadcn/ui --agent pi --yes`并阅读安装的shadcn及迁移skill；保留项目npm lock，不执行技能中的自动commit/清理工作树建议。两个只读子代理超时，无代理结论被当作验收。
- **实现**：官方Base Nova registry生成9个组件，配置在package根`components.json`；Base UI1.8.0、Tailwind/Vite插件4.3.3。Sheet/Tooltip/Select取代本项目直接Radix，thinking/delivery均为真实Select；表单采用Field/FieldGroup/FieldLabel，保留原生Input/Textarea校验和refs。Tailwind语义变量映射既有Café深浅tokens，页面SCSS Modules与消息/runtime/Store/Gateway不变。移除废弃控件SCSS及直接Radix和多余cn依赖。
- **CSP/资产**：使用Base公开支持的`CSPProvider disableStyleElements`，滚动条规则进入外部CSS，不放宽原`style-src 'self'`。旧资产validator拒绝合法Tailwind转义类名，先补red case，再用既有PostCSS精确解析：仅选择器允许转义，声明/at-rule混淆、import、外部/缺失URL及无效语法仍拒绝。共享构建/发行入口保留路径、预算和hash限制。补齐本地shadcn源码、Tailwind、tw-animate-css许可清单。
- **确定性验收**：`.refactor/reports/R15-shadcn/verify-final.txt`通过Web **23 files/87 tests**、Web/package/root typecheck、assets/plugin **9**、theme **4**、shadcn **2**、更新安全 **3**、Go webembed全量tests/build、实际Go+React bundle集成及精确25文件pack。`source-build.txt`中候选和隔离源码构建检查**5/5通过**，含最终build/check/test实现，未覆盖当前dist。
- **浏览器验收**：`browser-final.txt`/`browser.json`为Chrome155独立owned profile/context，**9组检查、24组布局采样**、2种主题Tooltip。覆盖真实Tab/hover/Escape、Sheet背景隔离/焦点恢复/闭合details、320px Select碰撞边界、嵌套Sheet先关闭Select、delivery选择不发送以及thinking/prompt精确payload；style标签与CSP violation均0。使用合成fixture，无真实Pi/provider命令，也不导航/刷新用户Chrome。
- **失败/测试边界**：JSDOM打开Base Select的布局等待曾超时；保留日志，业务测试用显式选择控件替身，真实Select→Gateway互动在Chrome验收，不以JSDOM零布局冒充浏览器通过。先前browser焦点/隐藏listbox保留DOM/嵌套列表异步聚焦断言已改为真实输入与可见性检查；一次owned Chrome停止超时后确认该PID已退出，最终复验清理成功。Vite约985KB主JS的500KB提示仍保留。
- **候选**：`.refactor/release/pack-ZzSXoX/cafecodework-pi-cafe-space-0.1.0.tgz`；SHA-256 `79dfe9bd1c047267afa2f209736ac8ffbcdb2be90dbb2b49fed472e64daf5581`；Web digest `6a58a35dc3e506910fb859b62652cf26d69a542f1156978217db49e56c7b0a2c`；windows-amd64 binary `1745eaa8b13d535589dbbd97b9dc2a4fb087fcd265c1447e4b8596a0b36f5e8a`。许可/构建脚本也是合法包差异，未来部署不能直接照搬§42四文件白名单。
- **范围/末态**：`closeout.json`核对相对本轮baseline的源码及lock边界、旧31文件、已安装25文件、历史archives、Relay owner/health/已部署Web、候选与浏览器资源digest。npm顺带改动的pi-subagent lock版本已恢复；其他workspace记录未变。
- **状态**：新源码/候选完成但**未部署**，37983仍为§42Radix；未改普通Pi注册、provider、会话、生产入口或启动脚本，未重启既有服务、未执行R19/commit/push。外部HTTP403仍封存，非Windows不宣称验收。实现/维护细节见[SHADCN_UI](./SHADCN_UI.md)。

## 44. shadcn/ui 候选部署到本机试用（2026-09-29）

- **授权/范围**：用户明确“部署”。按精确发行包更新37983当前安装，并重启经过owner核对的目标Relay；不操作普通Pi/Chrome进程或reload、不更改全局注册、provider、credentials或session文件、不发真实命令/model请求、不切换生产默认入口/R19、不commit/push。
- **预检**：`.refactor/reports/R15-shadcn/deploy.mjs --check`确认archive SHA与25文件清单，trial当前引用指向pack-7Yb74q，唯一监听37983的owner为已登记Relay；新旧二进制、PID creation/executable/commandline/instance marker/listener匹配。差异按七文件精确白名单核对，不复用§42 Radix的4-file scope。只读测试清单：README、`THIRD-PARTY-NOTICES.txt`、Relay exe、build.json、package.json、`scripts/build-tools/{assets,build}.mjs`。在停止前有上述差异保护哈希、逐文件备份及trial package/owner记录。
- **应用**：取得排他Relay更新锁，owner-check stop PID **33604**，只原子替换该七文件并启动已验证新Relay；更新trial archive引用与owner记录。Relay **PID 13236** 于08:13:23Z健康；资产SHA核对通过后，3个已ready Pi host重连。Pi CLI进程PID/creation及每个host的session/cwd哈希前后不变；其他owner/listeners（37891、9222）不变。Chrome未打开/控制。
- **末态校验**：`.refactor/reports/R15-shadcn/deploy-final.txt/json`通过；安装目录25项逐项与候选比对、先前未变18项保持原hash、7项旧文件备份在`.refactor/manual-trial/shadcn-update-nuduRI/backup/`，receipt在同目录。archive SHA `79dfe9bd1c047267afa2f209736ac8ffbcdb2be90dbb2b49fed472e64daf5581`；Web digest `6a58a35dc3e506910fb859b62652cf26d69a542f1156978217db49e56c7b0a2c`；binary SHA `1745eaa8b13d535589dbbd97b9dc2a4fb087fcd265c1447e4b8596a0b36f5e8a`。5/5嵌入HTTP资源SHA及原`style-src 'self'`CSP匹配，旧Radix hashed JS/CSS不再由Relay服务，artifact verifier通过，更新锁已释放。
- **现在状态**：`http://127.0.0.1:37983/#/rooms/manual-trial`运行shadcn/ui + Tailwind候选。用户自行刷新已开的页面/Ctrl+F5加载新资源。刷新不是验收用户页面，本次未触碰其Chrome或登录态。未调用真实模型或发送Pi命令；外部403仍封存，非Windows不宣称验证。

## 45. 控件描边层级修复（2026-09-29，未部署）

- 用户反馈控件outline过多并要求修复。共享Button默认从outline改为secondary淡底；host/文件列表显式用quiet/ghost，主操作仍为primary。输入框/Select保留1px可识别边界，不通过统一border:0抹掉表单提示。
- 根因是未分层的全局`:focus-visible`覆盖Tailwind的outline-none，导致outline与ring叠加。将原生焦点fallback放入base层，让shadcn控件只显示2px、不透明的语义ring；链接/summary仍有2px outline。去掉Composer额外focus-within边框强调，forced-colors下单独保留系统色outline，因为高对比度会移除box-shadow。
- 新增按钮层级单测先red后green。Web **23 files/88 tests**、typecheck/build、theme4/shadcn2/assets8通过。`cafe-ui-browser.mjs --allow-browser-context --quiet-controls`使用独立合成fixture和报告目录：**10组检查、24组布局、16个深浅主题控件焦点样本**及forced-colors检查通过，CSP不变。浏览器断言修正了实际英文标签、CSS颜色序列化及过渡采样；delivery键盘用与嵌套Select一致的真实初始焦点/End等待，未延长timeout掩盖。
- 普通Web构建未带发行链的HashRouter-only插件，不作为可嵌入候选；最终通过正式pack链重新构建，再运行上述浏览器检查和实际Go+bundle集成。Windows候选：`.refactor/release/pack-lVn7uC/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA `b7ecdf6bbf746e7fbc5bca9d4dae6acb0159ca7fdea1e8b886d4f481ee2bd04f`，Web digest `0355b5bf57a220a8df455f6aec4eb012b00ae0b46a688aed7692e9ea9e6b8236`；25文件pack、Go webembed tests/build通过。证据集中`.refactor/reports/R15-quiet-controls/`。
- **未部署**：末态核对已安装25文件、pack-ZzSXoX archive、5个已部署HTTP资源及原监听owner不变；37983仍为§44的PID13236。未重启现有服务、未碰Pi/session/provider或用户Chrome、未发真实模型请求、未commit/push。旧候选浏览器证据保留在R15-shadcn，不覆盖为本次结果。

## 46. 描边修复版部署并重启Relay（2026-09-29）

- 用户明确“部署和重启”。复用owner校验、更新锁、逐文件备份/原子替换及回退路径，只操作37983的试用Relay；不运行Stop.cmd、不重启Pi/Chrome或reload、不修改session/provider/全局注册、不发Pi命令/模型请求、不执行R19或commit/push。
- 精确候选为§45的`pack-lVn7uC`（archive SHA `b7ecdf6bbf746e7fbc5bca9d4dae6acb0159ca7fdea1e8b886d4f481ee2bd04f`）。先核实旧25个安装文件仍匹配§44 receipt；新archive清单/hash、binary身份、Web digest及当前Relay PID/creation/executable/完整instance命令/listener全部通过后才停止服务。
- 唯一三个发行差异：README、Relay exe、build metadata；其余22项含extension/protocol/launchers/manifest/许可文件保持。trial archive引用同步更新，无npm install/lifecycle。Relay PID **13236→8248**，5个实际HTTP资源逐项SHA匹配，原3个ready Pi host自动重连且session/cwd哈希不变，Pi进程creation保持。其他37891/9222 owner未变。
- `.refactor/reports/R15-quiet-controls/{deploy-safety.txt,deploy-check.txt,deploy-apply.txt,deploy-final.txt,deploy-final.json}`通过：安全3 tests、25安装文件、3备份、上版archive保留、artifact verifier、Relay身份/health、strict CSP、旧hashed资源不再服务、更新锁释放。备份及receipt在`.refactor/manual-trial/quiet-controls-update-EArf0t/`。
- 当前入口 **http://127.0.0.1:37983/#/rooms/manual-trial**。用户自行刷新或Ctrl+F5加载修复；未导航/刷新用户Chrome。原§45隔离浏览器验证对应同一digest，此次HTTP/hash/重连校验不冒充新一轮真实模型或用户页面验收。

## 47. Composer焦点改为完整外框（2026-09-29，未部署）

- 用户截图显示textarea的焦点ring只包住输入区上半部，与含发送按钮的外框叠成两个框。这是复合输入组件的焦点边界问题，不是全站按钮outline回归。生产源码只改`Composer.module.scss`：输入文本时完整inputShell以`:has(textarea:focus-visible)`获得2px外轮廓（offset -1px贴合原边框），Composer textarea不再画内层shadow/outline；其他Textarea不受影响。焦点转到按钮或Select后外框提示消失，各控件保留自身焦点。高对比度使用Highlight系统色外框。
- 浏览器回归先在已部署同款staging重现红测（inner box-shadow不是none），再验证修复。`cafe-ui-browser.mjs --allow-browser-context --composer-focus`通过**11组检查/24组布局**，深浅主题各1440/390px共4个Composer外框/包含按钮/边界样本，高对比度也仅一个外框；截图在`.refactor/reports/R15-composer-focus/composer-{dark,light}-{1440,390}.png`。检查期间响应式sidebar重挂载会关闭details，测试恢复它再检查Select焦点，未改业务逻辑。
- Web typecheck、**23 files/88 tests**、theme4/shadcn2/assets8、正式25文件pack、Go webembed tests/build及实际Go+bundle集成通过。新候选`pack-8liyMf`，archive SHA `2819e77b1896bbf64248d8067521e0f9f7a9a1c59bff4b5415062468086d3a3d`；Web digest `b1b09d5855dd36c1a3f7b3b9bb8729a02bb28a5fd13d256a356005a47d9c94f8`；binary SHA `9b9791af34bd65c734975e3e06996076362d3453a3e5142c54476eb2d4e061d0`。
- 证据`.refactor/reports/R15-composer-focus/{red.txt,tests.txt,pack.txt,browser-final.txt,browser.json,guards-integration.txt,closeout.json}`。末态确认已安装25文件、5个实际HTTP资源、pack-lVn7uC archive、37983/37891/9222监听owner未变。**未部署或重启现有服务**，无真实Pi命令、模型请求或用户Chrome控制；当前37983仍为§46。

## 48. Composer焦点修复默认部署（2026-09-29）

- 用户明确“默认直接部署，不用问”，本轮据此安装§47已验证的`pack-8liyMf`到本机37983并只重启Relay。该授权仅针对后续同类已验证的本机试用UI修复；不含生产/R19、普通Pi/Chrome重启、provider/model调用或commit/push。仍须每次核对运行进程owner、archive/hash、安装差异并验收，不因默认授权跳过安全门禁。
- `deploy.mjs --check`先核验archive SHA `2819e77b1896bbf64248d8067521e0f9f7a9a1c59bff4b5415062468086d3a3d`、25文件及windows-amd64元数据、全部旧安装文件与§46 receipt逐项相符、已部署trial引用与目标Relay PID/creation/instance/exe/listener身份；唯一3项差异为README、Relay exe、build.json。先备份，再以独占锁owner-check停止Relay **8248**、原子替换、启动新Relay **30008**，同步trial archive/owner记录，无npm lifecycle。
- `deploy-final.mjs`复核25项文件与新候选一致、3旧文件备份及§46 archive保留、5/5实际HTTP资源哈希与Web digest `b1b09d5855dd36c1a3f7b3b9bb8729a02bb28a5fd13d256a356005a47d9c94f8`、严格CSP、artifact verifier、health、旧hashed资产不再服务、更新锁释放。3个Pi host ready自动重连，session/cwd摘要及Pi进程creation不变，37891/9222 owner不变。未操作用户Chrome或发命令/模型请求。
- 证据`.refactor/reports/R15-composer-focus/{deploy-check.txt,deploy-apply.txt,deploy-result.json,deploy-final.txt,deploy-final.json}`；备份/receipt在`.refactor/manual-trial/composer-focus-update-tyeF2z/`。现在试用入口`http://127.0.0.1:37983/#/rooms/manual-trial`，用户自行刷新或Ctrl+F5加载修复。浏览器合成测试仍是§47的同digest，不冒称已自动操控用户页面或真实模型验证。

## 49. 会话工作区：参考OpenChamber布局与交互（2026-09-29，已部署）

- 用户要求从原型式控制台转向成熟工作区，只关注会话管理、主区交互与展示，保留Café UI，不引入Git等扩展。实际查看官网桌面/手机截图，读取公开仓库commit `566ba61852526ab30800c3a0cb82e51825d8bc60`的ChatContainer与SidebarHeader参考；未运行其应用或复制其源码/商标。详情见[SESSION_WORKSPACE](./SESSION_WORKSPACE.md)。两次quick_explorer均超时，无子代理审查结论被采用；源码流转和末态由主代理核验。
- UI合并顶栏/工具栏，会话侧栏可折叠，文件默认关闭、按需打开。活动实例显示真实标题/项目/状态；搜索本地过滤活动实例和所选实例历史；历史自动读取、按修改时间排序和本地今天/昨天/更早分组、消息数/日期/选中态。历史页独立只读标题/返回入口。复用有界history缓存的完整scope+host revision key以保持同上下文列表连续展示，后台刷新不削弱原view/connection/authority fence。
- 对话保留assistant-ui外部Store runtime及有序parts。输入区入口打开模型/思考Sheet；显示真实就绪/运行/本地等待状态、仅运行中提供中止；消息文本点击复制、有失败反馈；手动上翻显示回到最新，点击恢复跟随。保留IME、Shift+Enter、delivery确认、单次发送、scope/view草稿清理。主题、面板和断点改变不替换当前输入及工具节点。深浅Café语义色、原严格CSP和单一Composer焦点边界保留。
- **范围边界**：现有协议没有Web新建、改名、删除、恢复历史会话。本轮只提供已支持的活动实例切换与历史整理/搜索/只读浏览，没有伪生命周期按钮，不直接写会话文件或创建Web-owned AgentSession。跨历史/实例/房间的草稿仍按既有安全边界清理，不冒称已支持跨会话草稿。
- 验证：typecheck，Web **23 files/91 tests**，theme4/shadcn2/assets8、真实Go+编译bundle集成、正式Go webembed测试/build、25文件pack通过。原integration测试以按钮可见文案匹配，历史刷新改为图标后旧断言超时；改为可访问名称且等待可用状态，重跑通过，未放宽缓存或协议断言。更新测试区分自动list_sessions读与写请求，继续精确验证一次prompt及全部scope/opaque-ID/重连边界。
- 隔离Chrome **10组检查/24组布局**通过，包括桌面/短屏/平板/手机320–1440、深浅主题、Sheet/Tooltip/Select真实键盘、嵌套Escape、搜索/清除/无结果、主区节点保留、回到最新、只读历史选中态、forced-colors Composer外框、CSP无注入。人工读取截图发现历史行min-content造成侧栏内部横向溢出，修复grid列为minmax(0,1fr)并增加断言后重跑。截图与业务模拟都是合成数据，未连真实Pi或provider，复制只用隔离单元mock，不改用户剪贴板。
- 候选`pack-eJNDdn`，archive SHA `205411f684245f8712e82241241938a41ac9a4d8e88d830aab811c14299c1a2d`；Web digest `0fb38107837e8cf3d0afe7c29191d9473eb4414df806bc6157b2ca1b9c149d08`；binary SHA `1ec9aacb5034215cd40b471d198503433c0304184df1a86d28c4cd13fcd944c7`。仅Windows amd64发行验证；未作生产/R19、commit/push或外部provider重试。
- 依据§48默认部署授权：先check，精确验证当前§48的25安装文件、archive引用、目标Relay identity/instance/exe/listener；只备份/替换README、exe及build metadata。**37983 Relay PID30008→4120**，3个Pi host自动ready重连，session/cwd摘要及Pi进程creation保留，37891/9222 owner不变。末态25文件、5实际HTTP资源哈希、strict CSP、artifact verifier、3份备份/前archive、旧hashed资源不再服务和锁释放全部通过。未重启Pi/Chrome或写会话/凭据；部署命令与模型请求为0。
- 证据`.refactor/reports/R15-session-workspace/`：`check-final.txt`、`tests-final.txt`、`pack-final.txt`、`guards-final.txt`、`browser-final.txt`/`browser.json`、5张合成截图、`deploy-{check,apply,final}.txt`、`deploy-result.json`/`deploy-final.json`。备份/receipt：`.refactor/manual-trial/session-workspace-update-rJls3U/`。用户自行刷新`http://127.0.0.1:37983/#/rooms/manual-trial`查看。

## 50. Web原生会话管理：新建、改名、继续历史（2026-09-29）

- 用户要求补齐会话支持；本轮范围为新建、重命名当前会话、继续历史，未扩展删除/Git/多owner机制。保留Café主题、assistant-ui外部Store、严格CSP和scope/view草稿边界。
- TS/Go协议新增`new_session`、`rename_session`、`resume_session`与可选`sessionControl`能力；9个共享fixture验证规范化、标题长度/控制字符/空白、opaque ID和旧host兼容。Relay/Gateway/extension均保留门禁，生命周期写要求显式stream/session/cwd、online/ready、空闲且无排队消息。历史解析复用既有目录/路径/ID/CWD校验，异步后再次验证原生上下文，不接受客户端文件路径。
- Pi是唯一owner：`pi.setSessionName`及原`session_info_changed`负责改名投影；单次nonce内部桥取得`ExtensionCommandContext`调用`newSession/switchSession`。保留原生before-switch取消；shutdown确认交接后从旧连接发送dispatched，再由新扩展重连投影，绝不在旧ctx失效后调用旧Pi API。dispatched不是切换完成；超时/断线结果未知，不自动重试。桥接文本有input-hook兜底，不能降级成模型prompt。
- 侧栏新建/改名、历史页继续使用既有Sheet/Field/Button，明确目标实例、确认、草稿清空及本地Pi确认。取消与改名不清空草稿；新scope按原规则清空。旧扩展缺能力时禁用按钮并提示`/reload`，不假装已能操作。
- 验证：主TS **13 files/491 tests**、Web **23 files/93 tests**、主/Web/原生fixture typecheck、Go全部/webembed/build、实际Go+编译Web集成及theme/shadcn/assets/update安全共18组通过。首次检查捕获extension与旧TS Relay快照压缩器遗漏能力字段，补齐共享投影路径后通过；Go共享fixture数量按新增9项明确更新，原golden不变。首轮工具诊断发现默认PATH为Node23/npm10，正式验收改用便携Node22.23.2/npm11.16.0，Go1.24.2。
- 隔离Chrome：**11组检查/24布局**，含320–1440、短屏、深浅、原有键盘/CSP/Composer回归，以及桌面/手机嵌套会话确认Escape、改名保留草稿、Pi取消反馈、新scope清空、opaque历史继续进入live。合成WebSocket，不连接用户Pi或provider。
- 额外全新隔离原生Pi：先用0.84.4验证桥接，再用实际全局安装的**Pi0.85.1**跑最终候选Go/extension，5组检查覆盖真实历史恢复、原生持久化改名、before-switch取消、新建空会话、旧scope写拒绝、原历史再恢复。独立临时project/agent/home/sessionDir、随机token和临时端口；**0 agent turn、0 provider call**。SDK测试不操作任何用户会话；身份核验后仅清理自有进程/目录，原监听owner保持。quick_explorer只用于盘点既有隔离启动helper，未委托设计/修改或声称其做代码审查。
- 最终候选`pack-kvUZKf`，archive SHA `f697b32c2bfabe24cc8576c8cecf299d56d083165a5128c8437265f859b4c7ef`；Web `7cf0054206e6e5a9ea006c61f63cae9893cb8dd31f6be70142cd2011e979b1f3`；binary `4109357df31e64a9bc1a1ef6c85b29f63c441b7ee598683266a9fcb4072cdc68`。25文件，Windows amd64限定，未引入依赖。
- 按默认部署授权完成check/apply/末态验证：**37983 Relay PID4120→72148**。精确替换5项：README、extension/index.js、protocol/index.js、exe和build metadata；其余20项不变。25安装哈希、5HTTP资源、strict CSP、5份备份/前archive、artifact verifier、旧hashed资源失效与锁释放通过；3个Pi host ready重连、Pi process creation/session/cwd摘要与其他listener/owner记录保持。未restart/reload用户Pi/Chrome、发业务/模型命令、改用户会话/凭据。
- 首轮部署为中间包`pack-ssoBW3`。随后将原生取消测试升级为实际RPC本地确认框，红测发现`ui_wait(false)`按旧协议回到running，但命令级对话没有agent_settled事件；取消后会话控件因此保持busy。已在共享`onUiWait`回调结束时依据`ctx.isIdle()`补发原生session_state，而非放宽按钮/协议门禁；新增idle/running单元回归，Pi0.85.1真实确认取消/再次新建与恢复均通过。最终`pack-kvUZKf`只比首轮多改extension/index.js和build metadata（Relay/Web字节不变），沿用owner校验部署流程复验并更新，**Relay PID72148→34844**。2份追加备份/receipt：`.refactor/manual-trial/session-controls-fix-update-wjOKeV/`；25安装文件、5HTTP资源、CSP、3个host及全部owner/上下文再核验通过，未reload用户Pi。红测保留`native-local-ui-red.txt`，末态以`native-final.txt/native.json`与`deploy-followup-*.{txt,json}`为准。
- **启用步骤**：刷新`http://127.0.0.1:37983/#/rooms/manual-trial`；在需要管理的既有Pi空闲时执行一次`/reload`。扩展文件已部署，但运行中的旧扩展不会被强行替换；新启动Pi自动加载新版。未实现删除会话、直接改名未加载历史或跨会话草稿保存；生产/R19、外部provider重试、commit/push仍未执行。
- 证据：`.refactor/reports/R15-session-controls/{check-final,tests-final,web-tests,pack-final,guards-final,native-final,browser-first,deploy-check,deploy-apply,deploy-final}.txt`及`native.json`、`browser.json`、`deploy-result.json`、`deploy-final.json`。备份/receipt：`.refactor/manual-trial/session-controls-update-PwI806/`。

## 51. 去掉重复导航、收紧选择框（2026-09-30）

- 用户反馈侧栏“当前对话”指向当前页面、作用不明，Field选择框过大。移除重复Link及死样式/文案；保留历史页“返回当前对话”与点击活动实例的真实返回路径。既有房间书签/opaque历史ID/草稿上下文规则不变。
- 追踪ChoiceSelect的两个调用点（思考等级、运行时发送方式）：共用横排Field、紧凑标签与按内容宽度的Select；去掉Composer的flex-grow与模型面板对所有button的width:100%，后者仅作用于提交表单按钮。选择器宽度上限192px，40px操作高度保留；未缩小文本输入、损坏语义标签或改官方primitive。
- 验证：Web typecheck、23 files/93 tests；正式25文件pack执行全部Go/webembed测试与Windows amd64构建；Go+编译Web集成、theme/shadcn/assets/update安全共18项通过。隔离Chrome12组/24布局、额外10组中英文思考/发送方式在1440/390/320宽度的尺寸断言通过；组高度≤44px、控件≤192px、无溢出，键盘/Select/Sheet/CSP/会话操作回归通过。截图为合成数据，无用户Chrome/Pi/provider操作。
- 候选`pack-KLqeoM`，archive SHA `498093f71e0855e10644c2c9531bc5deaf8bb371b335e19e0e4e2d13466637d5`；Web `7ba676aa23b4b9cd70ea2e2442dd460e0c501c36295fa94fcb6d22ac8dfa9f4f`；binary `2debf42e8a9ed409cbadf2a0585bb736f7abc0222070d3a932cf22f9c4a72ac2`。TS digest与§50相同，未改协议/原生扩展或增加依赖。
- 默认部署完成：owner检查后Relay PID34844→9584，仅README、exe及build metadata三项不同；另外22项含Pi扩展保持。25安装文件、5HTTP资源、严格CSP、3份备份/前archive、旧hashed资源不再服务及更新锁释放复验通过；3个Pi host ready重连，Pi进程creation/session/cwd摘要与其他监听/owner不变。未重启/reload Pi、控制用户Chrome、发业务/模型命令、commit/push或切换R19。
- 证据：`.refactor/reports/R15-compact-choices/`中的check/tests/pack/guards/browser与deploy记录。备份/receipt：`.refactor/manual-trial/compact-choices-update-wVM9uB/`。本次用户只需刷新网页，不需再次reload Pi。

## 52. `/` 命令与 `@` 文件引用（2026-09-30）

- 用户明确本轮先补`/`和`@`，不做`#`。输入开头的`/`提供所选Pi的命令发现、过滤与键盘补全；扩展/技能/模板命令由原生Pi dispatch和expand处理，不新建AgentSession。`/new`、`/name`、`/resume`、`/model`、`/thinking`复用既有确认/历史/设置组件。Pi忙碌时拒绝斜杠命令；未知、本地TUI专属及私有collab命令拒绝，不降级为模型请求。命令dispatched仅表示交给Pi，本地UI仍在终端处理。
- `@`按项目目录补全，支持中文、空格、光标中间替换、目录继续输入；普通消息携带显式`files`数组，Pi复用既有文件安全读取后附带JSON文本数据。最多8文件、每个64 KiB、总计128 KiB；超限/二进制/敏感路径/越界整体拒绝，不发送部分prompt；异步读取后重验原生scope与delivery。命令参数中的`@`仅完成路径，不改命令参数语义。不是全项目递归索引。
- 协议v1增加可选`inputAssist`能力、`list_commands`/`run_command`及`prompt.files`；12个共享fixture（Go总数328），原golden不变。Go/TS Relay、扩展和Web均保留完整session/cwd/stream门禁，旧扩展明确要求reload。Gateway增加临时读取slot，不污染文件面板，保留取消、读结果校验、旧响应隔离及写操作不重试。列表最多200项，UI最多30项并提示缩小输入；没有新增依赖或无界缓存。
- 测试：主TS13 files/504、Web24 files/96；主/Web/原生fixture typecheck，全部Go/webembed及Windows amd64构建；Go+编译Web集成、theme/shadcn/assets/update安全18项通过。隔离Chrome13组/32布局，含深浅1440/390/320/640短屏弹层、Tab/Enter/Escape、真实鼠标选择带空格中文路径、旧capability/未知命令错误、原生命令及files payload、既有Sheet/Select/IME/上下文回归。Web测试为合成WebSocket，未控制用户页面。
- 原生验收使用独立临时project/agent/home/sessionDir、随机token/端口与自有进程。验收时全局安装已更新为Pi0.99.1，按其实际路径验证；七组通过，含真实命令发现/参数/同名扩展优先于模板、真实文件内容进入上下文、Pi自身展开模板/技能，以及原有会话恢复/持久化改名/真实本地确认取消/新建/fence回归。三个**离线合成provider响应**，无网络和真实模型请求；不能写成零agent turn或外部provider成功验收。原生脚本的消息类型guard/旧snapshot匹配与浏览器脚本的Escape后重新输入/selector字符串红测保留，均为验收脚本修正。
- 收尾核对发现Pi命令清单可能包含扩展与模板同名，已在共享发现方法按原生顺序去重，并用真实同名fixture确认扩展优先，不把阴影模板误列成第二个菜单项。最终`pack-Kmks1J`，archive SHA `01d900800edb1c1504dcd6c1c228a0e24371b391247001a014b2191ebc0f4322`；Web `594a5fd1127d5d2872bf609b0d6d8eb07f5fbef4cf3977782a90dfaecbba03e8`；binary `fcc8c17ce99fadd9597508b2101e32dbb4a4968b04d138beb96e9b3ceabdfc10`；TS `c0eacbb20334cf0eb13b08a382bd5ef7bc5125a74b3c20af63d040b6f518a346`。最后补丁Web/Relay字节未变，最终候选重新执行原生验收。
- 默认部署完成：首轮6项（README、extension/index.js、extension/file-commands.js、protocol/index.js、Relay exe、build metadata），Relay PID9584→2584，备份`.refactor/manual-trial/input-assist-update-Fd1Hwr/`；最终仅extension/index.js和build metadata两项，PID2584→30672，备份`.refactor/manual-trial/input-assist-fix-update-EI0IDx/`。每轮owner/hash/diff检查后再停止Relay；25安装文件、5HTTP资源、strict CSP、备份/前archive、旧hashed资源失效与更新锁释放复验通过。6个Pi host ready重连，Pi进程creation与session/cwd摘要、其他监听/owner保持；未重启/reload用户Pi/Chrome、写用户会话或凭据、commit/push或切换R19。
- 证据：`.refactor/reports/R15-input-assist/`。最终以`pack-followup.txt`、`tests-followup.txt`、`web-tests-final.txt`、`guards-final.txt`、`native-followup.txt`/`native.json`、`browser-final.txt`/`browser.json`、`deploy-followup-*`为准；首轮pack-3EDlLz是中间候选。用户刷新后，在所选Pi空闲时执行一次`/reload`；新Pi自动加载新版。sa-1只读探索超时，未采用其审查结论。
- 部署后的即时完整复核通过；数分钟后的重复检查在Pi进程保留断言处停止，发现原清单中1个Pi进程已不再出现（`deploy-final-repeat.txt`、`late-pi-observation.json`）。没有执行Pi停止/重启，不能据此推定退出原因。另行仅核对当前Relay owner、25安装文件、5HTTP资源、CSP、备份、其他监听及更新锁，通过`deploy-current-assets.*`记录；其scope明确为当前Relay/资产，不把先前6个ready host或原Pi进程全保持冒充更晚末态。

## 53. 修复普通Pi在 `/reload` 后仍缺输入能力（2026-09-30）

- 用户反馈reload后仍提示启用`/`和`@`。只读WebSocket能力清单确认多个host保留sessionControl但缺inputAssist；未读出会话内容或发送业务命令。真实Pi loader同进程红测复现：候选入口/依赖覆盖后再次加载仍返回旧命令。
- 根因在本机注册adapter，不在Web门禁或快照投影：原生动态import的ESM缓存跨Pi reload保留。仅入口加query不能刷新协议/file-commands依赖。修复仅在`local-registration/extension.ts`复用当前Pi已安装的jiti同步转换本包（moduleCache:false、transformModules），保持SDK/ws原生引用；异步jiti.import依然可能选择native缓存，已红测，不采用。不增加依赖、不改全局环境或清理其他扩展缓存。
- loader回归覆盖旧ESM缓存预热、入口和依赖同时更新、重复reload、仅依赖更新；Pi0.84.4及0.99.1通过。defaults/update安全合计7项通过，注册入口/原生fixture typecheck通过。原生验收增加`--registration-reload`，从旧候选及旧adapter开始，在**同一个自有Pi进程**实际reload重现缺能力；只更换adapter后连续两次reload恢复inputAssist且sessionId/cwd/空会话保持；继续跑命令发现/执行、文件、模板、技能和会话管理，共8组通过。三个离线合成provider响应，零真实provider/网络调用，自有进程已清理。
- 已部署**仅一项**：`C:/Users/example-user/.pi/agent/cafe-space-local/extension.ts`。旧hash与原注册smoke一致，新hash`16d3609cec0b47a8b2525bcbe0eec445be6fc527293f5839d0301b938fb06dee`；备份`.refactor/manual-trial/registration-reload-update-HDa4kg/extension.ts.before`及receipt。25个候选文件保持pack-Kmks1J；Relay PID30672/owner/health保持，settings、credentials、connection/defaults与owner记录哈希不变。未重启Relay、Pi、Chrome或替用户reload，未commit/push。已有用户Pi需在空闲时再reload一次。
- 证据：`.refactor/reports/R18-registration-reload/`中的`red.txt`、`loader-debug.txt`、`tests.txt`、`compat-loader.txt`、`typecheck.txt`、`native-first.txt`/`native.json`、`deploy-check.*`、`deploy-apply.txt`/`deploy-result.json`。本轮子代理spawn失败，未把其作为调查证据；没有为adapter修复重新打包不变的Web/Relay。

## 54. 补齐旧打包版Pi安装目录被移除后的加载兼容（2026-09-30）

- 用户报告§53后reload变离线。只读确认Relay37983健康，其余4个host在线；原PID29724 host离线但Pi进程仍存活。其命令行为旧pnpm hash目录下的`dist/bundle/cli.js --resume`，该目录确实已不存在。未读取终端错误/用户会话，因此不把推断当作已采集的终端日志。
- §53入口调用`import.meta.resolve(Pi SDK)`并从该路径找jiti，对内存中的嵌入SDK仍强制要求旧磁盘安装，兼容不足。用已部署入口加“嵌入SDK+不存在的磁盘SDK路径”回归复现MODULE_NOT_FOUND，保留`deployed-red.txt`。修复为静态导入Pi提供的SDK namespace并传入jiti virtualModules；jiti从候选所在保留workspace解析（已有依赖），不再访问运行中Pi已被移除的安装目录，也不引入第二份SDK或新增npm依赖。
- 新回归确认嵌入SDK对象身份、旧ESM缓存预热、入口/相对依赖/仅依赖更新；defaults与两类loader共5项通过，注册入口/原生fixture typecheck通过。`--bundled-pi`改为真实`dist/bundle/cli.js`隔离验收：8组通过，重复原生reload、inputAssist、命令、文件、模板/技能及会话生命周期通过；三个离线合成provider响应，零真实模型/网络调用，自有进程清理。磁盘目录缺失是loader级合成场景，不冒充用户旧Pi已经恢复或直接在用户Pi验收。
- 已再次仅更新拥有标记的全局`cafe-space-local/extension.ts`，hash `16d3609c…`→`8800294df881637484cc7db325a042fa524311c0291ae4e72e4ec001f94f2d3e`，备份`.refactor/manual-trial/registration-offline-update-zDKZgi/`。安装的25个pack-Kmks1J文件、settings/defaults/connection/credentials/owner哈希不变，Relay PID30672/owner/health保持。未重启任何用户进程、未代发reload/业务请求。用户原离线Pi仍需在空闲时手动reload来加载修复；不建议用重启掩盖问题。
- 证据：`.refactor/reports/R18-registration-offline/`：`deployed-red.txt`、`tests.txt`、`typecheck.txt`、`native-first.txt`/`native.json`、`deploy-check.*`、`deploy-apply.txt`/`deploy-result.json`。此前§53的未打包新进程验收没有覆盖该老进程/移除目录条件，本节明确补充而非改写旧验收结论。

## 55. 客户端实例与会话操作精简（2026-09-30）

- 按用户要求把“进行中的会话”改为“客户端实例”（英文Client instances）。侧栏只做客户端/历史导航、搜索；移除顶部新建/改名按钮组，在当前对话标题旁放轻量“+ 新建会话”和带可访问名称/title的铅笔按钮。状态随项目路径显示，手机直接可达，不再从客户端抽屉嵌套操作。
- 复用现有Base UI Sheet/Drawer焦点与Portal，为会话操作增加compact居中样式，无新依赖/设计系统。表单保留会话/项目对象、必要切换提醒；改名自动聚焦并选中当前名称，明确取消/保存，新建用取消/创建。Escape/取消恢复触发按钮，不清空草稿；恢复历史仍只读进入后明确确认。`/new`/`/name`复用同一个控制实例。能力/busy/latch/scope/unknown门禁不变。
- 扩展浏览器回归发现Workspace位于覆写location的Routes内，用其useLocation计算roomBase会丢失房间前缀；将Shell已验证的base显式传入Workspace，修复新建/斜杠会话动作误导航到根路径。增加确认成功后仍保留room hash的测试。改名按钮使用普通quiet Button+原生title而非额外Tooltip层，避免对话关闭恢复焦点触发Tooltip造成测试持续更新。
- Web24 files/96项、typecheck通过；Go全部/webembed/build与25文件pack、Go+Web集成/theme/shadcn/assets/update安全18项通过。隔离Chrome14组/32布局（包括原有输入辅助），另16组中英文×深浅×1440/390/320/640短屏，检查居中/尺寸/无横向溢出、改名聚焦、取消焦点恢复；新增截图已人工查看390深色标题栏与浅色改名弹窗。UI测试仅合成WS，零用户业务/模型请求。首次全并发测试超时，限定2 workers完成；浏览器首轮捕获roomBase真实缺陷，次轮为中文主题label脚本错误，均保留红测且最终通过。
- 最终pack-LnumuT：archive `ad8b4e3ddba5664b14795028ebf558b7a5bb8b56da2b7eb4475be045a08202c0`；Web `e1c691c8098e9faa2ca78662abcba84dcf797bf4efefd8416d41e34558a1cab8`；binary `67931dd53ee31562cf89939498849f8a979f16d7492b6dd37f2be35e2cb559ae`；TS digest保持`c0eacbb20334cf0eb13b08a382bd5ef7bc5125a74b3c20af63d040b6f518a346`。中间pack-qXfab9未部署。
- 默认安全部署37983完成：精确README/exe/build metadata三项，Relay PID30672→32948；备份/receipt `.refactor/manual-trial/session-layout-update-2pbuxs/`。25文件、5HTTP资源、严格CSP、旧hashed资源失效、备份/旧archive和更新锁释放核验通过；5个ready host重连及Pi进程/session/cwd摘要保持，其他owner/监听保持。未动全局注册adapter、Pi/Chrome、凭据、会话、生产或commit/push。**此次只刷新网页，不再要求reload Pi**。
- 证据：`.refactor/reports/R15-session-layout/`中的`check-final.txt`、`tests-final.txt`、`guards.txt`、`pack-final.txt`、`browser-final.txt`/`browser.json`及`rename-*`/`header-*`截图、`deploy-*`。该项是UI/导航修正，不另报原生模型验收。

## 56. 按反馈统一到左侧会话查询与管理（2026-09-30）

- 用户明确不接受§55把操作放到右侧。新建/改名收回左侧“会话”标题行，短文案“+ 新建”保留完整aria-label，铅笔保留名称/title；下方仍是统一搜索、客户端实例、历史。删除右侧操作和专用布局限制，右侧只显示当前会话/项目/状态。保留已验收的紧凑表单、确认/取消、草稿与安全门禁。`/new`/`/name`用request-only渲染表单，不产生第二组右侧按钮。
- 单测改为断言左侧具备两个操作、右侧均不存在；Web24 files/96、typecheck通过。Go全部/webembed/build与25文件pack、18项集成/安全guards通过。隔离Chrome14组/32布局+16组双语/深浅/桌面/手机/短屏检查通过；手机打开同一导航抽屉，再操作新建/改名，取消后恢复导航内触发点；斜杠命令与旧会话/文件回归通过。已查看1440深色侧栏和390浅色导航截图。无用户业务/模型请求。
- pack-GcUAuC archive `59971bcdc135d7c2e040a14368efda8d00fed5e684bbc2bcd3a3a891d1ffb059`；Web `ce8ffab79c553f8564588e5d36f0896c5ce701eea4ef768d2c1f9b7832907cc0`；binary `45d4309fe708ae2e3e80e498e528c09da35053f285ae6ac28659010cb10a94b6`；TS不变。默认安全部署37983，Relay PID32948→36068；精确README/exe/build metadata三项，备份/receipt `.refactor/manual-trial/sidebar-management-update-GpU2lA/`。25文件、5HTTP/CSP、旧hashed资源失效、备份与更新锁释放通过；5个ready host重连、Pi进程/session/cwd摘要与其他监听保持。未改扩展/全局adapter、凭据、用户会话或生产；仅需刷新网页，不用reload Pi。
- 证据：`.refactor/reports/R15-sidebar-management/`的`check.txt`、`tests.txt`、`pack.txt`、`guards.txt`、`browser.txt`/`browser.json`、`sidebar-*`/`rename-*`及`deploy-*`。§55保留为历史过程，不再代表当前布局。

## 57. 真正独立的新会话与后台 Pi 所有权（2026-09-30）

- 用户确认需要补齐独立新建语义。左侧“新建”和`/new`不再向所选客户端发`new_session`，而是在本机配置的项目中启动新原生Pi RPC；即使没有客户端、原客户端忙碌，也能从左侧创建。原客户端的进程/session/cwd不切换。保留左侧统一查询、客户端实例标题、紧凑表单与取消焦点；增加后台会话的查看/打开/明确确认关闭。只有原发起网页仍在相同房间/连接/视图且没有改选其他客户端时，才在新进程和Relay snapshot就绪后进入新会话。
- Go `internal/managed`是有界进程所有者，不是第二套AgentSession或JSONL实现。配置只允许本机显式路径、项目ID/room/cwd绑定和受限环境；loopback加显式不同强token。固定同源`POST /api/workspace`做Origin+client bearer校验、4 KiB body/未知字段/UUID/房间边界校验，支持list/create/open/close；不接受浏览器路径/命令/环境，不公开provider配置。最多16项目、8运行实例、100登记；创建UUID先原子落登记，重复创建不重复启动，写入不自动重试。
- Windows文件锁保证单manager owner；Job Object只拥有直接创建的Pi及工具子进程，Relay崩溃也回收它们。不按旧PID猜测接管，不附着手动Pi。进程使用原生`--mode rpc --session-id`、独立session-dir、offline启动、拒绝自动项目批准，仅显式加载协作扩展；native工具/持久化仍由Pi负责。关闭先读原生名称并关闭stdin，8秒后仅回收本manager Job；重新打开使用相同UUID，Relay重启不自动恢复执行或重放任务。后台实例拒绝切换自身session，手动Pi原生继续历史能力不变。
- 原生红测发现Go的EvalSymlinks不能解析本机某些pnpm junction（Windows/Node可正常打开），改为Windows文件句柄规范化；另发现Pi在首个用户/助手消息前不写JSONL，不能把“改名已应用”当成已落盘。现在仅保留空会话名称元数据，正常关闭/重开恢复；不伪造JSONL或模型消息。崩溃前无对话的临时改名仍遵循原生未保存setup语义，文档明确边界。RPC大图/工具事件按有界流跳过，不因大于2 MiB而杀掉正常Pi。
- 浏览器补测发现Select的隐藏input会被共享Drawer初始焦点选中，导致Escape/焦点恢复不稳定；复用已有可见tabstop筛选，补单测并验证16组独立新建表单的真实输入焦点、几何和返回点。TS13 files/504，Web25 files/101，主/Web typecheck、Go全部/webembed及managed/config/service race通过；全部37项Node guards通过、0 skip（含真实Pi loader）。Chrome14组/32布局、10项紧凑选择框、16组改名+16组独立新建的双语深浅桌面/手机/短屏检查通过，已查看新建1440深色/390浅色截图。
- 原生Pi0.99.1隔离验收5组：无已有host启动、两个并行独立会话、手动Pi身份不变、空会话改名正常关闭/重开、真实原生历史持久化/恢复、Relay崩溃Job回收/登记恢复。**1次离线合成provider响应，0真实provider请求**；不冒称0 agent turn。临时project/agent/home/state、随机token/端口与所有测试资源清理通过。子代理因`spawn pi ENOENT`未启动，没有采用子代理结论。
- 最终`pack-GGb8q7`：archive `e8e446d6cf9d6342892d95f4ef62177f1ebcca43cb567bacc222d12b58b68597`；Web `74458dfd9935e09abc58c8e88c27c80f1cf8b0c7179372834ce5d7cdb831be8a`；binary `a70aecc662c28c299eed3ce891dfa9167071cc138b2f3eaac8d25591f18f8ef1`；TS `743a28533b0527ef6d2c86bbd07862e4f1a2b3f14063e272ea622256bd84cec3`。首轮`pack-dVQ5CJ`六文件包更新（README、extension/index、exe、build metadata、run/start-relay）及备份过的试用launcher更新，新增managed-config/state；备份`.refactor/manual-trial/managed-sessions-update-OCNPCl/`。随后补齐manager与Relay房间首字符规则一致，最终仅更新exe/build metadata，备份`managed-room-update-d5rxmi/`，Web/TS/配置保持；补测Go与完整原生5组再次通过。
- 已默认安全部署37983，Relay PID36068→44320→7004。25文件、5HTTP资源/严格CSP、旧hashed资源失效、owner/更新锁/备份、5 ready Pi hosts与原进程/session/cwd、其他监听、全局settings/models/adapter/defaults/connection摘要保持核验通过。追加更新前两次确认没有正在运行的后台用户任务；部署未新建用户会话或调用provider。项目白名单为`Pi Packages 工作区`与`Café Space`，原生agent配置取已有`.pi/agent`，不复制provider密钥。全局adapter仍为`8800294d…`。**刷新网页即可，现有Pi不需要为这次独立新建执行reload或重启。** 未改生产入口/commit/push。
- 说明：[MANAGED_SESSIONS](../MANAGED_SESSIONS.md)。证据`.refactor/reports/R18-managed-sessions/`：`tests-final.txt`、`web-focus-final.txt`、`guards-focus-final.txt`、`pack-room-final.txt`、`native-room-final.txt`/`native.json`、`browser-focus-final.txt`/`browser.json`、`new-independent-*`、首轮`deploy-*`与最终`deploy-followup-*`；各次红测和中间候选保留，不用早期失败结果冒充最终通过。

文档编码、链接或空白检查不等于实现测试通过。
