# Pi Cafe Space Go / Gin Relay 重构方案

> 状态：规划，尚未实施。本文与 [Web 与 Relay 总体重构方案](./WEB_REFACTOR_PLAN.md) 配套。
>
> 目标是用 Go + Gin 替换当前 Node Relay，不是另外增加一个 Go 网关。当前 `src/relay`、启动脚本和已运行进程均不因这份文档而改变。
>
> 执行时先读 [执行入口](./REFACTOR_EXECUTION.md) 和 [R00–R19 任务卡](./refactor/TASKS.md)；具体初值/接口/隔离构建约定见 [CONTRACTS](./refactor/CONTRACTS.md)，不要让执行者临时重新选型。

## 1. 最终形态

```text
手机 / 桌面浏览器
React + Vite + assistant-ui
       │
       │ HTTPS 页面 / WSS 结构化消息
       ▼
Go + Gin Relay
       ├─ 内嵌 Web 页面
       ├─ host/client 认证、Origin 检查
       ├─ room 与多 host 连接管理
       ├─ snapshot / event / command / result 路由
       └─ 有界内存投影、请求关联与历史缓存
       ▲
       │ Pi 主动连接 Relay；电脑不开放入站端口
       │
原生 Pi + TypeScript Extension
       ├─ 唯一 AgentSession owner
       ├─ 模型与工具执行
       └─ SessionManager / 受限的本地文件访问
```

服务器部署成品只需一个对应平台的 `pi-cafe-relay` 二进制，默认内嵌同一版本的 Web 资源。运行 Relay 不需要 Node、npm、Go 编译器或 Pi 安装。

Pi 电脑仍运行原生 Pi 与 TypeScript 扩展。Go Relay 不创建 AgentSession、不调用 provider、不持有 provider API key、不读取/写入 Pi JSONL、不浏览用户项目磁盘，不镜像终端。

首版仍为单进程、内存型 Relay。没有 Redis、数据库、消息队列服务或多副本一致性承诺；断线重连能恢复投影，不等于 Relay 重启后能够恢复内存命令去重表。

## 2. 技术选择

| 组件 | 选择 | 用途 |
| --- | --- | --- |
| 服务语言 | Go | 编译为独立二进制、连接与内存状态管理 |
| HTTP 框架 | `github.com/gin-gonic/gin` | 显式路由、安全中间件、健康和配置接口 |
| WebSocket | `github.com/gorilla/websocket` | upgrade、读写与控制帧；不使用 Socket.IO，保持现有原生 WebSocket 协议 |
| HTTP server | 标准库 `net/http` | listener、超时、header 限额与关闭流程 |
| 静态资源 | `embed` + `io/fs` | 内嵌经过校验的 Vite 构建资源 |
| 配置 | 标准库显式解析 | 保留 `PI_COLLAB_*`，避免引入隐式配置搜索 |
| 日志 | `log/slog` | 有界结构化日志；不用默认请求 body dump |
| 安全原语 | `crypto/rand`、`crypto/subtle` 等 | 随机连接/请求 ID、认证值比较 |
| 测试 | `testing`、`httptest`、race detector、Go fuzz | 协议、并发、边界与生命周期验证 |

不引入 ORM、Gin 通用 JWT 登录模板、REST 模型接口或 Node 子进程。

实施时选定仍受支持、与 Gin/Gorilla 兼容的 Go 版本，在 `go.mod` 与 CI 中固定；提交 `go.sum`。不在规划阶段声称已安装这些依赖或已经验证所有目标平台。

## 3. 模块划分

```text
relay/
├─ go.mod
├─ go.sum
├─ cmd/pi-cafe-relay/main.go
└─ internal/
   ├─ config/       # 配置解析、默认值、限额和 token 配置校验
   ├─ protocol/     # codec、validators、canonicalization、snapshot reducer
   ├─ auth/         # token 与 Origin 策略
   ├─ hub/          # registry、room、host、pending、cache
   ├─ transport/    # WebSocket 连接、read/write pump、背压、close
   ├─ httpserver/   # Gin routes/middleware 与 net/http lifecycle
   └─ webui/        # 嵌入资产与精确 URL 允许清单
```

边界：

- Gin handler 只接收请求、执行入口校验并交给 transport/hub，不直接修改 host 缓存。
- protocol 是纯数据逻辑，不依赖 Gin、网络或 Pi SDK。
- hub 不执行网络阻塞写入，不访问 Pi session 文件。
- transport 不解释工具逻辑，只负责连接、编码后的消息与控制帧。
- webui 只服务自身构建产物，不提供通用文件服务。
- 每个模块允许注入 clock、ID source、transport 或 asset FS 以做确定性测试；生产随机 ID 必须来自安全随机源。

## 4. HTTP 与 Gin 设计

### 4.1 保留的接口

| 接口 | 行为 |
| --- | --- |
| `GET/HEAD /`、`/index.html` | 内嵌 Web 入口 |
| `GET/HEAD /assets/<构建文件名>` | 仅资源允许清单中的 hashed JS/CSS 等 |
| `GET/HEAD /icon.svg`、`/manifest.webmanifest` | 精确静态文件 |
| `GET/HEAD /healthz` | 保留 `{ ok: true, protocolVersion: 1 }` 语义；不包含凭据 |
| `GET/HEAD /api/config` | 保留协议版本、`wsPath: /ws`、默认 room 等公开配置 |
| `GET /ws` | WebSocket upgrade，随后使用 hello 认证 |

除 WebSocket upgrade 外，HTTP 接口只允许明确的 GET/HEAD；不新增 `/api/chat`、`/api/files`、`/api/sessions` 或公开 shutdown 接口。

历史/文件读取与控制指令仍是 WebSocket command。Gin 的 HTTP 路由不是 Pi API 的替代实现。

### 4.2 框架默认行为必须收紧

- 使用 `gin.New()` 配置经过选择的 middleware，不默认启用会记录敏感请求的全套模板。
- 不启用任意来源 CORS；WebSocket 的 Origin 校验在 upgrade 前单独执行。
- 默认不信任 forwarded headers，显式关闭 Gin 的默认代理信任；只有配置了受信代理 IP/CIDR 时才使用代理提供的客户端地址。
- Origin 规则继续按直接监听协议与 Host 校验；TLS 反向代理后的公开 HTTPS Origin 要显式加入允许列表，不能靠伪造 `X-Forwarded-Proto` 获准。
- 关闭自动 trailing-slash / fixed-path redirect，避免 `/ws/`、路径大小写或路径清理被重定向成另一条受保护入口。
- 不使用 `gin.Static`、目录列表或 `NoRoute → index.html` 作为任意资源回退。HashRouter 的 hash 不发给服务器，无需开放任意路径。
- 安全头对成功、404、405、异常和关闭响应同样生效：延续 CSP、no-store、nosniff、frame-ancestors、Referrer-Policy 等策略。
- 设定 header/body/time/连接上限。没有需要无限读取的 HTTP body；拒绝请求时关闭连接或有限 drain，不能无限读取被拒绝的 body。
- 不能通过 Gin recovery 认为所有 goroutine 的 panic 都已被捕获；WebSocket 后台任务需要自己的清理与失败隔离路径。

## 5. WebSocket 与并发模型

### 5.1 连接状态机

```text
TCP/HTTP admission
    ↓ 容量、路径、Origin 检查
WebSocket 已升级，未认证
    ↓ 5 秒内接收唯一 hello
认证后的 client 或 host
    ├─ client：welcome → host_status → 对应 snapshots
    └─ host：welcome → 5 秒内提交 snapshot → ready
    ↓
读写循环 / 心跳 / 转发
    ↓ 断开、超时、替换、服务关闭
只执行一次的清理 → 停止任务、释放配额、处理 pending
```

WebSocket `open` 不等于认证成功，host hello 通过也不等于 host ready。新 host 连接收到当前 snapshot 前，不得承接旧投影的写命令。

### 5.2 一个连接一个读任务、一个写任务

- 每个连接只有一个 read pump 和一个串行 write pump。
- 业务消息不从多个 goroutine 并发调用 socket write；ping、close 等控制帧与写锁/写任务的关系必须明确，不能依赖“偶尔没出错”。
- 消息从 hub 以已编码、不可变的有界数据进入发送队列；队列同时限制条目数和累计字节，满时关闭慢连接，而不是无限等待。
- 单个慢 browser 不阻塞其 room 的其他 host/client，单个故障 host 不阻塞其他 room。
- 不为每个消息、每次 broadcast、每条 command 启动一个无上限 goroutine。
- 上下文、timer、pending 和连接配额通过 `sync.Once` 或等价状态机清理，避免 error/close/timeout 三条路径重复释放。

### 5.3 有界 room 状态机

Registry 只管理有上限的 room 索引及全局配额；每个 room 由一个串行事件循环拥有它的 hosts、clients、snapshots、pending 与 caches。共享 registry 的锁内不做网络或文件 I/O。

- 每个 room 的 inbox 是有界的；过载时按明确策略拒绝/关闭来源连接，不启动额外任务“排队”等待。
- 连接关闭、host 替换、command timeout 等控制操作也必须能够在过载时完成，不能被普通 event 队列永久饿死。为控制操作保留容量，或采用可合并的取消信号，并以压力测试证明清理可达。
- welcome、host_status、snapshot、event 在同一状态机中安排输出次序。
- 每次连接替换分配内部 generation；旧连接回调、旧 timeout 和旧 command result 都必须同时匹配 host 与 generation。
- timer 事件仅携带受限 ID/generation，不在闭包里永久持有整个历史投影。使用可注入时钟和集中 expiry 管理，避免每次事件新增一个长期 timer。
- 两个 host 即使 sessionId 相同，也不能共享命令、工具、缓存或 sequence。

## 6. 跨语言协议契约

### 6.1 不换协议，不套第三方传输格式

继续使用 v1 JSON text messages：

```text
hello / welcome / host_status
snapshot / event
command → routed_command → host_command_result → command_result
error
```

保留 `hostId`、`peerId`、`streamId`、`sessionId`、`seq`、`expectedCwd`、现有错误 code 和可选 legacy 字段。`roomId` 是路由命名空间；当前 token 是认证边界，不能把 room 名称描述成每租户独立 ACL。

### 6.2 契约与测试数据位置

```text
protocol/v1/          # 语言无关的消息结构、必填/可选、限额与状态转换说明
protocol/fixtures/    # 合法/非法输入、预期 canonical 输出、事件与命令轨迹
src/protocol/         # TS 实现：Pi extension 与 Web 复用
relay/internal/protocol/  # Go 实现
```

schema 用来描述形状，不替代应用层 byte/node/depth/sequence/context 校验。Go 不能直接导入 TS；也不通过运行 Node 来维持协议一致性。

实施顺序：先从现有 TS 实现和回归测试固定 v1 fixtures，再迁移 Go；等 Go v1 等价行为通过后，再同步增加有序 parts / 工具归属字段。新字段仍是可选的，不让前后端两个迁移同时改变基线。

### 6.3 特别需要对齐的语义

| 事项 | 要求 |
| --- | --- |
| 大小 | 原始消息按 UTF-8 bytes；字符串字段的旧上限按 JS UTF-16 code units 等价实现，不误用 Go `len(string)` 或 rune 数替换 |
| Unicode | 中文、emoji、截断边界、转义 surrogate 与非法 UTF-8 都有 fixtures；不允许 Go 解码器静默替换字符后改变 ID、token 或 cwd |
| 数字 | 用明确的数字解析与范围校验；seq、offset、limit 不接受越界/非整数值，不因 Go 整数范围更大而扩大 wire 可接受范围 |
| 必填 / 缺省 / null | 显式区分；不能用 Go 零值让缺失的 bool、seq、ID 自动变成有效输入 |
| 字段名 | 按 wire 中的精确字段名解析，不依赖 Go struct 解码的大小写宽容行为 |
| JSON 值 | 保留节点、深度、宽度、string bytes 与 finite-number 限制；JSON decoder 之后必须校验 |
| JSON 编码 | 按实际发出的字节测量大小，包括 envelope、转义和新增 metadata；不以估算的文本长度替代 |
| 未知字段 | 按已知字段重建 canonical 对象；保持 legacy/新增可选字段兼容，不依靠全面禁止未知字段解决问题 |
| 对象键 | `__proto__` 等只能作为数据；协议对象不能从任意 map merge 得到 |
| 重复 key / 异常转义 | 固定现有 JSON.parse 行为的测试；如安全收紧需 TS/Go 协同变更并记录差异，不能让两个服务默默解释成不同目标 |

无法与现有行为直接对齐的边界输入必须列入兼容差异清单，并在切换前解决。语义相同不要求 JSON 属性输出顺序相同，但字段含义、错误类别、截断标记和实际帧上限必须一致。

## 7. 路由、状态与缓存

必须迁移的是整个状态机，不只是 `read → broadcast`：

- host/client 使用不同 token 认证；role 一旦确认不能通过后续消息改写。
- 多 host 命令必须明确选择目标，旧字段不足以唯一定位时返回选择/过期错误，不猜测目标。
- 路由前核对 `targetHostId + expectedStreamId + expectedSessionId + expectedCwd`，pending 记录捕获同一上下文。
- 新 host 替换旧连接后，旧 pending 以 `HOST_REPLACED` 等既定语义结束；新连接等待新 snapshot。
- 按正确 sequence 应用 snapshot/event；seq 缺口或倒退使 host 不再 ready，重新同步之前不得继续路由。
- `tool_started/updated/finished` 只更新有界投影，不执行工具；增加 parts 后仍按同一协议规则处理。
- pending、结果缓存按 host/sourcePeer/requestId 和连接代次关联，旧结果不能完成新 host 的请求。
- 历史缓存区分 `list_sessions` 和 `get_session`，并包含上下文与 projection revision；不得将一种请求结果复用于另一种请求。
- 离线 host 可以返回已缓存的历史查询结果；未缓存的数据返回离线/未命中，不扫描电脑文件补齐。
- 断线和过期及时释放连接与缓存；host 重连清理旧历史缓存并等待新 snapshot。
- `RESULT_TOO_LARGE` / `COMMAND_TOO_LARGE` 是明确拒绝，不在丢弃 data 后仍返回 applied。
- 不承诺跨 Relay 重启 exactly-once；Web 对结果未知的写操作不盲目重发。Go 迁移不能用“支持并发”掩盖重复执行风险。

## 8. 容量、安全与超时基线

以下延续当前实现的关键上限；完整常量表应在阶段 A 写入协议/服务 limits 文档并由 fixtures 检查。Go 迁移不能因为编译型语言而放宽限制。

| 对象 | 基线 |
| --- | --- |
| 单个完整 WebSocket 数据消息 / 出站 envelope | `256 KiB`，含所有 fragments 组合后的内容 |
| seq | `0..1,000,000,000`，event 连续递增 |
| JSON nodes | 最多 `20,000`，并保留现有 depth/width/string 聚合预算 |
| 单资源 | `4 MiB` |
| room 数量 | 最多 `256` |
| 每 room host / browser client | `64` / `256` |
| WebSocket 总连接 | 最多 `512` |
| 未认证连接 / 同来源未认证连接 | `128` / `32` |
| 单连接待发送数据 | 延续 `1 MiB` 字节预算，另设有限队列项数 |
| 单 host pending / 单 client 对一个 host pending | `128` / `32` |
| 单 host 缓存结果 | 最多 `1,000` 条并不超过 `8 MiB` |
| 单 host 历史详情缓存 | 最多 `20` 份，并受字节/TTL/上下文限制 |
| Relay snapshot 展示投影 | 最多 `100` 条消息、`24` 个工具，并继续按 envelope bytes 裁剪 |
| hello / 首个 host snapshot 等待 | 各 `5 秒` |
| command acknowledgement timeout | `15 秒` |
| heartbeat interval | `30 秒`；配套读写 deadline 和失联清理 |
| 离线 host / 历史缓存 | 默认 `30 分钟` 无活动期限，保留现有刷新/失效语义 |

不能预分配“所有 room × 所有 host × 每个最大缓存”。除上述局部上限外，需要统一的全局缓存字节预算；初始规划为 `64 MiB`，压测后锁定默认值及允许范围。超限先回收过期、离线和旧缓存，不静默丢弃已转发的 pending；无法回收时明确拒绝新增负载。该聚合上限属于计划中的额外保护，要记录与旧容量行为的差异。更外层的投影/缓存/application queue 合计预算初值为 128 MiB（包含此 64 MiB 子预算，不是 RSS 硬上限）；队列条目/bytes、close deadline、资产数量/总量等初值统一见 [实现约定第 3 节](./refactor/CONTRACTS.md#3-go-服务接口与状态所有权)。

### 8.1 解析前限制

- 配置 WebSocket read limit，保证限制作用于完整消息，而不是单个 fragment。
- 只接受 JSON text；binary 用明确协议错误关闭。
- 读取器、拼接和缓冲池均有上限；不先 `io.ReadAll` 再检查，也不能把超大 buffer 放回无限池长期占用。
- 压缩首版关闭，避免解压后大小绕过与额外 CPU 风险。
- 解码前检查 UTF-8，JSON 只接受一个顶层值；解析中/解析后限制嵌套与结构复杂度。
- WebSocket 升级前也要受连接和 header 限制。Go goroutine 便宜不等于可以无限创建。

### 8.2 配置和认证

- 默认 `127.0.0.1:37891`；生产端口保持 `1..65535`，仅测试 listener 可用 0 分配临时端口。
- room ID 保持 `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`，不接受前后空白。
- 非 loopback 绑定要求显式、不同、非默认、非 placeholder 的两个 token，每个 16–4,096 字符；保留至少 8 种字符、单字符最多 25%、Shannon entropy 至少 3.0、估算总熵至少 64 bit 的复杂度门槛。
- 熵检查只是复杂度启发式，不证明 token 来源；生产 token 使用密码学安全随机生成器。
- 配置文本在 trim/split 前检查原始上限；Origin 最多 64 项，每项最多 2,048 字符，并保留原始列表总上限。
- 配置缺失与显式空值、大小写、IPv6、URL 凭据/query/fragment 的处理通过跨语言 fixtures 固定。
- 不记录 hello token、命令文本、工具全文或 provider 配置；远程部署使用最小必要的环境变量，本地 spawn 继续使用环境允许列表。
- 默认开发 token 的启动提醒可以保留；重复连接/协议错误日志需要限频，不能把 UI warning 风暴搬到服务器日志。

## 9. 关闭与故障恢复

Go `http.Server.Shutdown` 不会替应用关闭已 hijack 的 WebSocket，因此需要显式管理它们：

1. 原子进入 closing，停止接收新连接和新 command。
2. 使 room 不再 ready，按协议尽力结束 pending，不返回虚假的成功。
3. 在有界时间内发送 WebSocket close；无法完成握手的连接强制关闭。
4. 取消 read/write pumps、room loops、heartbeat 与 expiry timer，并等待有界退出。
5. 关闭 HTTP listener，确认 admission 配额归零，不留 goroutine 或失效 room。
6. 只有本实例创建且仍属于自己的 runtime marker 才能清理。

listener 启动失败必须释放已分配资源并返回非零退出码。单连接解码或写入失败不得引发整个 Pi 客户端组崩溃；对不可恢复的共享状态错误应关闭相应 scope，而不是带损坏状态继续转发。

Linux/macOS 处理 SIGINT/SIGTERM。Windows 普通进程的停止能力与 Unix signal 不同，脚本不能假设 `Stop-Process` 会触发优雅退出；手动控制台关闭、可用的服务管理停止与强制终止路径需分别测试，不通过新增公开 HTTP shutdown 端点解决。

## 10. Web embed 与交付

### 10.1 构建链

```text
Web source → Vite build → 验证资源 / 精确清单
                               ↓
                       Go embed 暂存区
                               ↓
                    go build / 目标平台构建
                               ↓
          pi-cafe-relay[.exe] + 版本/平台/校验和清单
```

- Web 产物必须先于 Go 构建完成；二进制记录公开的构建版本和 Web 资源摘要，便于检查是否混入旧页面。
- 只复制 canonical 普通文件，禁止 symlink/junction、路径穿越、隐藏凭据与 source map；构建资源总数量/字节也设硬上限。
- 精确清单控制可访问 URL；嵌入不意味着整个 embed FS 都能被 HTTP 下载。
- 所有 `VITE_*` 都按公开值处理，host/client token 绝不能进入 bundle 或二进制。
- `dist/relay/public` 可作为最终构建中间目录保留，但生产默认从二进制读取资源；不要求服务器磁盘存在外部 Web 目录。
- 迁移期新构建使用隔离暂存目录；未验收前不能覆盖正在使用的旧静态文件。

默认不提供磁盘 webRoot 覆盖。若未来增加，必须走独立安全审查：保留 canonical/regular-file/单文件上限、POSIX `O_NOFOLLOW` 和 Windows reparse/ADS/device 检查；不能用 `gin.Static` 替代。

### 10.2 分发目标

规划的首批构建目标：Windows amd64、Linux amd64/arm64、macOS amd64/arm64。只有完成对应平台编译、启动和必要验收后才列为受支持平台；交叉编译成功不等于运行测试通过。

- 默认以不依赖 CGO 的生产构建为目标，若依赖导致不能这样构建必须先说明，不隐式要求服务器安装 C 运行库。
- race detector 在支持的平台用所需工具链执行，与生产 `CGO_ENABLED=0` 的构建策略分开，不把二者混为一条构建命令。
- 源码工作流的 build/prepack 需要 Node + Go；已打包安装不在用户机器上编译 Go，不用 postinstall 静默下载可执行文件。
- Pi package 在 `dist/relay/bin/<os>-<arch>/` 中携带声明支持平台的产物；完整发行包由构建流程收集并校验这些文件。
- 单独服务器发布可以只发一个平台的 Relay 二进制与校验和，Pi package 仍保持自包含，不依赖另外一个 Node 项目。
- 发布来源、版本和校验和要固定；本地可写攻击者能同时替换二进制和校验文件时，checksum 不能替代 OS 权限或可信签名。
- Go binary / embed 暂存目录 / dist 不入 Git；提交 Go 源码、go.mod/go.sum、构建脚本与文档。npm package 的 `private: true` 不变。

## 11. 本地启动与脚本迁移

当前 extension 用 `spawn(process.execPath, [dist/relay/index.js])` 启动 Node，PowerShell 停止脚本也按 Node+脚本精确匹配。Go 替换时必须一起迁移，不能只改服务端入口。

### 11.1 保留的用户入口

- `/collab-connect`、`/collab-disconnect`、`/collab-status`。
- `--collab`、`--collab-relay`、`--collab-room`。
- 已有 `PI_COLLAB_*` 配置、Web sessionStorage keys、默认端口、room 与 token 规则。
- `relay:start`、`relay:stop`、`pi:start` 等 npm/PowerShell 命令名。
- `start-pi.ps1` 任意 PiArgs、child exit code 和调用方环境变量恢复。

### 11.2 新启动路径

```text
Pi extension 解析 Relay URL
    ├─ 远程 wss / 不适合自动启动 → 只连接，不启动本机服务
    └─ 安全 loopback ws URL
         ├─ 兼容 Relay 已健康 → 使用现有服务
         └─ 未健康
              → 选择 package 内 OS/arch 二进制
              → 校验路径/文件/版本
              → 启动锁 + 再检查健康
              → 直接 spawn Go binary（不经过 shell）
              → 验证健康与本次启动身份
              → 记录可选 PID / instance 信息
```

- URL 只允许既有安全的 loopback `ws://.../ws` 自动启动。credentials、query、fragment、错误路径或端口 0 不触发 fallback。
- 二进制缺失、平台不支持或无法启动：给出有界提示并维持安全失败/重连行为，不自动下载或调用 `go build`，不退回任意 PATH 可执行文件。
- 安装目录可能只读；锁和 PID marker 是便利信息，不是运行前提。并发启动失败的子进程必须退出/被拥有它的启动器回收。
- spawn 只传 OS 必需变量与 Relay 配置，不继承整个 Pi/provider 环境。
- 不假设健康响应意味着当前 PID 归启动器所有；可新增非秘密的启动实例 ID 辅助核对，但 HTTP 字段不能作为停止进程的唯一授权。

### 11.3 停止与所有权

Go 进程匹配 canonical executable path，而不是只匹配 `pi-cafe-relay.exe` 名称。停止前再次核对 PID、实际执行文件与 creation time/instance 记录；有权限获取不了必要证据时拒绝停止。

- PID marker 本身不证明所有权；拒绝 symlink/reparse、超大、锁定或正在并发写入的 marker。
- 保留不同 bind/port 的锁与 marker 区分，避免多本地 Relay 互相清理。
- 迁移期间识别旧 Node marker 时，必须使用原有严格的 Node+入口匹配路径，不能把旧 PID 自动当作 Go 进程处理。
- 自动连接/升级不得停止当前旧 Relay 来抢占端口。切换旧 Node 实例是用户明确操作，不是发现版本不同就 kill。
- 不停止用户正在运行的 Pi 或 Chrome；遗留 runtime 文件在归属不明时不删除。
- PowerShell 保持 5.1；健康读取仍要有界、拒绝重定向、使用严格 UTF-8，并按现有策略禁用意外代理。

## 12. 迁移顺序与验证

本方案的阶段对应总体方案 A–G；这是概览，实际按 [R00–R19 任务卡](./refactor/TASKS.md) 在授权范围内顺序连续执行，普通审查点由执行流程内据证据完成，不逐项等待人工确认；实质阻塞和生产切换仍按执行入口处理：

1. **A：建立协议基线**。从当前 TS tests 提取 fixtures，覆盖正常消息、错误、缓存与 replacement 轨迹；建立 Go module 与 Gin 空壳。
2. **B：先完成 Go v1 等价 Relay**。暂不加新 parts，先证明现有 TS host/旧 Web 能与 Go 正确交互。
3. **C–E：接入新 Web 并增强有序内容投影**。TS/Go 同步处理可选字段，在明确兼容路径上使用 assistant-ui。
4. **F：内嵌页面、二进制分发与本地启动迁移**。验证只读安装、平台选择、锁、进程归属与参数环境兼容。
5. **G：完整验收后切换**。新旧服务只在隔离端口比较；生产切换前保留源码与成品回退点，回退不尝试合并两套 Relay 内存状态。

### 验证矩阵

- TS 与 Go codec：同一 fixtures 的 accept/reject、canonical output、UTF-8 size、null/可选字段及所有错误语义。
- Go Relay + 现有 TS extension/client：握手、多个 host、重复 requestId、replacement、readiness、seq、离线历史、超大消息。
- Go 并发：race detector、并发 broadcast、慢 writer、inbox 饱和、close/result/timeout 竞态、room 淘汰与 timer/goroutine 泄漏。
- Go fuzz：frames/JSON、Origin/Host、room/token 配置、字符串/数字边界、资产路径、状态转换输入。
- 浏览器：使用刚构建的 Go binary 内嵌页面，在桌面与移动尺寸验证工具顺序、折叠、滚动、发送和多 host 切换。
- 原生 Pi：明确归属的新 Pi 进程验证真实文本/思考/工具、prompt/abort、session/project 变化和 reconnect；模拟 host 不算执行证明。
- 静态资源：hash chunks 可访问；source map/清单/源码不可访问；HEAD/404/CSP/no-store 一致；没有磁盘目录暴露。
- 打包：对应平台二进制齐全，Web 资源版本一致，不包含 token/provider 配置，安装成品无需 Go。
- 生命周期：启动失败、只读目录、并发竞争、正常/强制停止、环境恢复、退出码、旧实例不被误停。

继续使用原生 Windows Node/PowerShell/Pi 做本机验证；其他 OS 的 Go 构建/race/runtime 验证在对应可用环境或 CI 完成。不能把本机没有的 Linux 工具链当作已验证。

浏览器检查使用独立 Chrome SxS profile、Relay 37983、CDP 9333；现有 37891 Relay、9222 Chrome 和原 Pi 进程不在自动清理范围内。

## 13. 参考与实施前检查

- [总体 Web 与 Relay 重构方案](./WEB_REFACTOR_PLAN.md)
- [当前 Node Relay 行为说明](./RELAY.md)
- 当前实现：`src/relay/server.ts`、`src/protocol/index.ts`、`src/extension/local-relay.ts`、`scripts/start-relay.ps1`、`scripts/stop-relay.ps1`
- [Gin 官方文档](https://gin-gonic.com/en/docs/)
- [Gorilla WebSocket API](https://pkg.go.dev/github.com/gorilla/websocket)
- [Go embed](https://pkg.go.dev/embed)
- [net/http Server.Shutdown](https://pkg.go.dev/net/http#Server.Shutdown)
- [Go race detector](https://go.dev/doc/articles/race_detector)

代码实施前应完整核对所选 Gin/Gorilla/Go 版本的默认代理、upgrade、read limit、并发写和 shutdown 行为。本文规定目标与验收要求，不是依赖安装报告或安全测试通过证明。
