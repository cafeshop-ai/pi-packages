# Pi Cafe Space 实施方案

## 1. 项目目标

Pi Cafe Space 的目标是让：

- 电脑上的原生 Pi CLI/TUI
- 手机或桌面浏览器中的 Web/PWA
- 将来部署在服务器后的远程浏览器

通过一个 HTTP/WebSocket relay 参与**同一个正在运行的 Pi 会话**。

用户体验应当是：

```text
Pi CLI 输入 ───────────────┐
                           ├─ 同一个 Pi 会话 / 同一个上下文
手机 Web 输入 ─ relay ─────┘
```

具体要求：

- 手机看到 Pi CLI 产生的 user、assistant、thinking、tool 和错误事件。
- 手机发送的 prompt 经 relay 转发给 Pi 扩展，再进入当前 CLI 所属的同一个 Pi runtime。
- relay 不创建 `AgentSession`，不调用模型，不读取或写入 Pi session JSONL。
- 同一个 room 可以同时连接多个独立 Pi host；每个 host 对应一个自己的 Pi runtime/session。
- 浏览器断线、刷新或重连不能启动第二个 Pi runtime，也不能把不同 host 的事件混在一起。
- relay 既能在本机运行，也能以后部署到服务器；Pi 主机通过出站 WebSocket 连接服务器，因此不要求服务器反向连接用户电脑。

这不是终端镜像，也不是两个 Pi 进程共同读写 session 文件。

## 2. 当前落地架构

### 2.1 本地 MVP

```text
浏览器/PWA
    │  HTTP 页面 + WebSocket /ws
    ▼
packages/pi-cafe-space
    ├─ src/relay       房间、认证、转发和每个 host 的独立状态
    ├─ src/extension   当前 Pi runtime 的 host connector
    ├─ src/protocol    snapshot/event/command 协议
    └─ web/public      静态 Web 客户端
```

一个 room 是连接命名空间，不是单一 session。它可以包含多个 Pi host；每个 host 由 `peerId` 标识，并拥有独立的 `streamId`、`sessionId`、snapshot、事件序号、命令队列和历史缓存。Web 客户端先收到 host 列表，再选择一个 host 查看和操作。

职责边界：

### relay server

- 提供 Web 页面静态文件。
- 接受 host 和 browser 两类 WebSocket 连接。
- 按 room ID 接受多个 host 和 client 连接。
- 以 `peerId` 为 key 管理每个 Pi host 的独立 snapshot、事件流、命令队列和历史缓存。
- 校验 host token、client token 和 Origin。
- 根据客户端的 `targetHostId`、`expectedStreamId`、可选的 `expectedSessionId` 和 `expectedCwd` 把 command 转成 `routed_command` 发给对应 host；session 或项目目录不匹配时拒绝旧命令。
- 把带有 `hostId` 的 snapshot/event 广播给 room 内浏览器，由客户端选择性消费。
- 保存短期内存状态、命令结果，以及各 host 已返回的历史会话列表/详情缓存；断开的 host 状态最多保留 30 分钟，避免长期污染实例列表；极端 pending race 在过期时以 `HOST_EXPIRED` 收束。
- 在某个 host 断开时只通知该 host 离线并拒绝它的未完成命令；其他 host 继续工作，已缓存的历史查询可以继续只读返回。

relay **不**：

- 创建 Pi `AgentSession`。
- 调用 provider 或接触 API Key。
- 打开 Pi session JSONL。
- 解释或修改模型上下文。
- 作为第二个 agent runtime。

### Pi extension

- 运行在原生 Pi CLI 进程内部。
- 是当前 Pi session 的唯一 host；同一个 room 中可以有其他独立 Pi host。
- 监听 Pi 扩展事件。
- 把 Pi 事件规范化为 protocol event。
- 通过出站 WebSocket 连接 relay。
- 接收 relay 转发的浏览器命令，再调用公开的 Extension API。

### Web client

- 只连接 relay，不直接连接 Pi。
- 不持有 Pi API Key。
- 以 snapshot 初始化状态，以 seq 顺序应用事件。
- 为每个 `hostId` 保存独立 snapshot 并按 host 应用 event，只渲染当前选择的 host；在发现某个 host 的序号缺口或 stream 变化时重新连接并获取 snapshot。

## 3. 两种运行模式的边界

### Extension-hosted（当前主线）

```text
Pi CLI = AgentSession owner
Pi extension = relay host connector
Web = remote client
```

这是本项目首版和核心目标。它能保证原生 Pi CLI 和 Web 同时看到同一活跃会话。

### Daemon-hosted（后续可选）

```text
独立 daemon = AgentSession owner
Web/companion CLI = relay clients
```

daemon 是另一种运行模式，不是 extension-hosted 的透明升级。两种模式不能同时作为同一个 session 的 owner。当前不实现 daemon，也不把它作为首版验收条件。

如果未来要求 daemon 模式下仍能使用原生 Pi TUI，必须开发真正的 Pi TUI client/adapter；不能直接再启动一个 `InteractiveMode` 并打开同一 session 文件。

## 4. 协议模型

协议位于 `src/protocol/index.ts`，当前版本为 `1`。

### 4.1 身份

- `peerRole: "host"`：Pi 扩展。
- `peerRole: "client"`：浏览器或未来 companion CLI。
- role 由连接使用的 token 决定，不能靠客户端声称获得 admin 权限。
- `roomId` 标识一个协作房间，可以包含多个 Pi host。
- `hostId` 是 Pi extension 的 `peerId`，标识一个独立 Pi runtime；默认值包含进程内随机实例 ID，避免不同电脑或 PID 重用时误合并，亦可用 `PI_COLLAB_PEER_ID` 显式指定。
- `streamId` 标识一个 host 生命周期/事件流。
- `sessionId` 标识 Pi session。
- `seq` 在一个 stream 内单调递增。

### 4.2 Host -> relay -> client

- `snapshot`：完整当前投影，包括 transcript、模型、thinking level、运行状态和工具状态。
- `event`：带 `streamId`、`sessionId`、`seq` 的增量事件。
- `host_status`：room 内所有 host 的在线/离线状态、`ready` 同步状态和可选 session 元数据。替换连接在收到新 snapshot 前不会被当作可命令的旧 session。
- `snapshot` / `event` 带 `hostId`，用于在同一 room 内区分不同 Pi 实例。
- `host_command_result`：host 对 relay 命令的处理结果。

事件类型当前包括：

- session state
- message started/delta/finished
- tool started/updated/finished
- model changed
- thinking changed
- local UI waiting
- notice

### 4.3 Client -> relay -> host

浏览器发送：

- `targetHostId` 选择目标 Pi 实例；`expectedStreamId`、`expectedSessionId` 和可选的 `expectedCwd` 共同作为 host/session/project fence（旧客户端可省略后两者）。
- `prompt`，空闲时直接提交；运行时必须指定 `steer` 或 `followUp`。
- `abort`。
- `set_thinking`。
- `set_model`。
- `list_dir`：请求当前 Pi 项目根目录下的目录列表。
- `read_file`：读取当前 Pi 项目根目录下的文本文件片段。
- `list_sessions`：列出当前 Pi 项目的历史会话摘要。
- `get_session`：按 opaque session ID 读取当前项目的历史会话摘要和 transcript。

每条命令有：

- browser `requestId`
- `expectedStreamId`
- `expectedSessionId`（新客户端发送；旧客户端可省略）
- `expectedCwd`（新客户端发送；旧客户端可省略）
- relay 内部 `relayRequestId`
- source peer ID
- relay 返回结果中的 `hostId`（用于防止切换实例或页面重连后错显示结果）

relay 按 `hostId + sourcePeerId + requestId` 在目标 host 的内存状态中去重，避免浏览器因重试重复转发同一命令；没有明确目标且 room 中存在多个 host 时，relay 返回 `HOST_SELECTION_REQUIRED`。

当前命令结果状态：

- `dispatched`：host 已调用 Pi 的发送/控制入口；对于 `sendUserMessage()`，由于 Pi 0.84.4 扩展 API 返回 `void`，不能伪称 provider 已完成或持久化已完成。
- `applied`：同步控制操作已应用，例如 thinking level 设置成功。
- `rejected`：relay、stream 或 Pi 扩展拒绝。

**可靠性边界**：当前 relay 是单进程、内存状态设计，适合本地和单实例服务器。relay 自身重启后，命令去重表和房间状态消失；不能承诺跨 relay 重启的 exactly-once。当前已对同一 `peerId` 的替换连接执行内存级 fencing，并在新 snapshot 到达前暂停命令；未来仍需持久化 command journal 和跨进程 fencing。多实例部署还需要 sticky WebSocket routing 或 Redis/NATS 共享 room、host、snapshot 和命令状态，不能让同一个 host 的连接被多个实例分别接管。

文件浏览是只读的：文件和历史命令由 relay 转发给 Pi extension，relay 本身不访问电脑磁盘；文件浏览会隐藏常见敏感路径（`.git`、`.pi`、`.runtime`、`.env*`、密钥扩展名等），拒绝 symlink/reparse indirection，并且不会把文件系统根、用户主目录或其祖先作为远程浏览根。历史会话由当前 Pi host 通过 `SessionManager` 提供，详情最多返回最近 100 条消息并受帧预算限制。Pi 完全退出后，Web 只能查看 relay 已缓存 30 分钟的历史查询结果，relay 重启或缓存过期后需要再次启动 Pi 刷新。

## 5. Pi API 现实边界

当前 Pi 0.84.4 扩展 API 已验证可用：

- `pi.sendUserMessage()`
- `pi.setModel()`
- `pi.setThinkingLevel()`
- `ctx.abort()`
- `ctx.sessionManager` 只读 session 状态
- `session_start` / `session_shutdown`
- `agent_start` / `agent_settled`
- `message_start` / `message_update` / `message_end`
- `tool_execution_*`
- `model_select` / `thinking_level_select`
- `ui_prompt_start` / `ui_prompt_end`

已知限制：

1. `pi.sendUserMessage()` 在 Extension API 类型中返回 `void`，底层异步错误由 Pi runtime 自己处理。因此 MVP 的 prompt ack 是 `dispatched`，不是完成确认。
2. 扩展 API 没有公开完整的 pending queue 内容，也没有公开 `queue_update` 事件。当前只同步 `hasPendingMessages` 布尔值。
3. `ui_prompt_start/end` 只能告诉扩展 Pi 在等待本地 UI；不能让远程 Web 直接回答其他扩展创建的任意 TUI 对话框。
4. 当前 Web 能显示“等待本机 UI”，手机审批任意 Pi 工具需要未来的统一 approval hook。
5. Pi 的内部 `AgentSession.subscribe()/prompt()` 属于 SDK/daemon 路径；MVP 扩展禁止自行调用 `createAgentSession()`，否则会破坏单一 owner 不变量。

## 6. 当前已实现

- 父仓库 `packages/*` 下的自包含 TypeScript Pi package。
- 共享协议类型、运行时入站校验和 snapshot event projection。
- relay HTTP server：
  - `/`
  - `/api/config`
  - `/healthz`
  - `/ws`
- host/client token 认证。
- 同一 room 支持多个独立 host；同一 `peerId` 的重连替换旧连接，不同 Pi 实例互不冲突。
- Origin 检查、帧大小限制、心跳和慢客户端断开。
- snapshot 和历史 transcript 会同时按消息数与 256 KiB 帧预算裁剪，工具状态也有独立上限；snapshot 尚未建立时 host 不发送增量 event。转发前 relay 会重建 snapshot/event/command/result envelope，未知字段不能把新增 metadata 挤出帧预算。
- relay 在缺少 snapshot 时只向同一 host 报告一次 `SNAPSHOT_REQUIRED`，避免错误通知风暴。
- Pi extension：
  - 自动连接或 `/collab-connect`
  - 普通 `pi` 启动时自动检查并拉起 loopback relay
  - `/collab-disconnect`
  - `/collab-status`
  - Pi transcript、流式文本/思考、工具和模型状态转发
  - Web prompt、abort、thinking、model 命令转发到当前 Pi
  - 断线指数退避重连
- 最小移动端 Web 页面：
  - token 登录
  - transcript
  - thinking 展开
  - 工具状态
  - prompt、steer/follow-up、abort
  - thinking level
  - 项目目录浏览和文本文件查看
  - 历史会话列表和历史 transcript 查看
  - 断线重连
- 协议单元测试和 relay WebSocket 集成测试。

## 7. 本地运行方式

### 7.1 首次安装和普通 `pi` 自动模式

在父仓库根目录构建并安装 `packages/pi-cafe-space`：

```powershell
cd C:\Users\example-user\Documents\cafecodework-pi-packages
npm install
npm run pi-cafe-space:build
pi install C:\Users\example-user\Documents\cafecodework-pi-packages\packages\pi-cafe-space
```

之后在任意项目目录直接运行：

```powershell
pi
```

扩展默认检查并自动启动 `127.0.0.1:37891` 的 detached relay，然后把当前 Pi runtime 注册为 host。可以用 `PI_COLLAB_ENABLED=0` 为单次进程关闭自动连接。

### 7.2 手动 relay 或显式参数

需要时仍可先手动启动 relay：

```powershell
.\scripts\start-relay.ps1
```

`start-pi.ps1` 现在调用普通 `pi`，只负责设置 relay URL、room 和 token，不会重复加载 extension；Pi 退出后会恢复调用方原有的 `PI_COLLAB_*` 环境变量。也可以进入 Pi 后执行：

```text
/collab-connect
```

本地开发默认凭据只适用于 loopback。不要把默认 token 用于 LAN 或公网。

### 7.3 打开 Web

浏览器打开：

```text
http://127.0.0.1:37891/
```

本机 loopback 页面在当前 tab 没有已保存 client token 时会自动使用开发 client token 和 `main` room；已有自定义 token 会被保留，非 loopback 访问仍显示 token 登录。

手机访问需要让 relay 绑定局域网地址：

```powershell
.\scripts\start-relay.ps1 `
  -Bind "0.0.0.0" `
  -HostToken "随机高熵 host token" `
  -ClientToken "随机高熵 client token"
```

然后手机访问电脑的局域网 IP，例如：

```text
http://192.168.1.20:37891/
```

普通 LAN HTTP 只适合可信家庭网络测试；远程使用应放在 HTTPS/WSS 反向代理或 Cloudflare Tunnel 后面。

远程或自定义 token 时，Pi 端使用同一个 host token，并把 relay URL 改成 `wss://.../ws`。

## 8. 后续阶段

### Phase 1：本地可用性

- [x] relay + Web + host connector 最小闭环
- [x] snapshot/event/command 协议
- [x] 本地认证和基础测试
- [x] 实际加载 Pi extension 的 host 连接 smoke test
- [x] 实际 Pi extension 的双向控制命令和受限文件命令 smoke test
- [x] 普通 `pi` 启动时自动拉起/连接本地 relay
- [x] 当前项目历史会话列表和 transcript 只读查看
- [ ] 同一 Pi 会话中 CLI prompt 与 Web prompt 的人工验收
- [ ] 处理 relay 重启时的 Web/host 状态恢复提示

### Phase 2：可靠性

- [ ] 独立 `session-core` 包
- [ ] 明确 command queue 和 host 内部串行执行
- [ ] command result 持久化或 lease/fencing
- [ ] snapshot 版本和 branch revision
- [ ] 更完整的 event replay，而不是只依赖最新 snapshot
- [ ] 每客户端发送队列和精确背压指标
- [ ] 工具参数/结果更严格的脱敏和截断

### Phase 3：远程部署

- [ ] HTTPS/WSS 部署文档
- [ ] Cloudflare Tunnel 配置示例
- [ ] token 轮换、撤销和设备管理
- [ ] 多 room 管理
- [ ] systemd/Windows service 启动方式
- [ ] 服务器日志和监控

### Phase 4：完整远程交互

- [ ] Pi Cafe Space 自己控制的工具 approval protocol
- [ ] 移动端图片输入
- [ ] 只读/可写权限角色
- [ ] 可选 daemon 和 companion CLI

## 9. 验收标准

首版不以“页面能打开”为完成，而以以下测试为准：

1. 一个 Pi CLI + 一个 Web：CLI prompt 的 user/assistant 流在 Web 出现。
2. 一个 Pi CLI + 一个 Web：Web prompt 出现在所选 Pi transcript，不启动第二个 runtime。
3. 两个 Pi CLI + 一个 Web：两个 host 可以同时加入同一 room，Web 可以切换实例且 command 不串台。
4. relay 日志和测试能证明 command 只会路由到选定的 host。
5. Web 发送重复 request ID 时，选定的 Pi host 只收到一次转发。
6. Pi 运行期间 Web 使用 `steer`/`followUp`，不会触发未指定 delivery 的错误。
7. Web 断线重连后，以 snapshot 恢复当前状态，不重复渲染旧事件。
8. `/new`、`/resume`、`/fork` 或 `/reload` 后 stream 变化，旧命令被拒绝并要求重新同步。
9. host 断开时 Web 显示离线，未完成命令得到明确失败结果。
10. 错误 token、非法 room、错误 Origin、超大帧被拒绝。
11. relay 不包含 Pi SDK runtime，不读取 session JSONL，不暴露 API Key。

## 10. 当前决策

当前只推进这条路径：

```text
本机 Pi CLI
  + Pi extension host connector
  + 本地 relay HTTP/WebSocket server
  + 手机 Web client
```

先把这条路径做成真实可用，再考虑服务器部署和 daemon。不要为了提前支持 daemon 而引入第二个 `AgentSession`，也不要把 relay 变成 session owner。
