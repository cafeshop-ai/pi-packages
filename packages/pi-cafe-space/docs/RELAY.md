# Relay server

> 本页描述当前 Node.js/TypeScript 实现。目标迁移为 Go + Gin，详见 [Go Relay 重构方案](./RELAY_GO_REFACTOR_PLAN.md) 和 [总体重构方案](./WEB_REFACTOR_PLAN.md)；当前运行方式尚未切换。

`src/relay/` 是 Pi extension 与浏览器客户端之间的传输边界。它不拥有 `AgentSession`，也不读取或写入 Pi session JSONL。一个 room 可以同时容纳多个 Pi host；每个 host 按 `peerId` 保存独立的 snapshot、事件流、命令去重状态和历史查询结果。单个 room 默认最多保留 64 个 host state 和 256 个 browser client；单个 relay 进程最多保留 256 个 room、512 个 WebSocket 连接，未完成 hello 的连接最多 128 个且同一来源地址最多 32 个。达到 host 上限时会优先淘汰已离线且没有 pending command 的缓存 state。历史缓存和离线 host 状态默认在 30 分钟无活动后过期；新的历史查询以及离线缓存命中会刷新相应的非活动计时器，而 host 重连会清理旧历史缓存并重新建立当前连接的 snapshot 生命周期。若极端 close/result race 留下 pending command，过期时会以 `HOST_EXPIRED` 拒绝后再释放 host state。现代客户端通过 `hostId` 选择目标实例；只理解旧 aggregate 字段的客户端只能看到确定性 primary host，在多 host room 中不应依赖无 target command 的自动选择。host 重连或替换时，在收到新 snapshot 前标记为 `ready: false`，避免把旧 session 的命令路由到新连接；新连接需要在 5 秒内发送 snapshot，否则 relay 会关闭它并保留离线缓存。

## Local start

从父仓库根目录执行：

```powershell
cd C:\Users\example-user\Documents\cafecodework-pi-packages
npm install
npm run pi-cafe-space:build
npm run pi-cafe-space:relay:start
```

relay 默认监听 `127.0.0.1:37891`，端口必须是 `1..65535`（仅测试用的 `createRelayServer()` 可以使用 `0` 请求临时端口），并从 `dist/relay/public/` 提供 Web 客户端。所有静态资源（包括 HTML、JavaScript、CSS、manifest 和图标）以及健康检查、配置端点都使用 `Cache-Control: no-store`，避免旧客户端缓存过期的协议或安全修复。package 安装到 Pi 后，普通 `pi` 也会检查该地址，并在需要时启动 relay。自动启动只对没有凭据、query 或 fragment 的 loopback `ws://.../ws` 生效（`127.0.0.1`、`localhost`、`::1`）；远程 `wss://`、其他路径以及端口 `0` 都不会触发本地 fallback。不同 bind/port 使用独立的启动锁和 PID convenience file；默认端口兼容 `.runtime/relay.pid`，其他端口使用带 bind/port 的文件名。PowerShell 启动脚本在只读安装目录会尝试用户临时 runtime；extension 自动启动最差情况下无锁、无 PID 也不阻止 relay 启动。

Pi extension 使用 `PI_COLLAB_RELAY_URL`、`PI_COLLAB_ROOM` 和 `PI_COLLAB_HOST_TOKEN`；room ID 必须是 1–64 个字母、数字、下划线或连字符，且不能带前后空白。浏览器使用登录表单中的 client token。客户端命令应带 `targetHostId`、`expectedStreamId`、`expectedSessionId` 和 `expectedCwd`；relay 会在结果中回传 `hostId`，防止页面切换实例、项目目录变化或重连后错显示结果。LAN 或公网部署必须设置两个彼此不同、非默认、非 placeholder 的 token（每个至少 16 个字符且不超过 4,096 个字符），并显式配置 `PI_COLLAB_HOST`。当前的“高熵”检查只是启发式最低门槛：至少 8 个不同字符、任何单字符不超过总长度 25%，Shannon entropy 至少 `3.0`，估算总熵至少 64 bit；它不能证明 token 的来源或不可预测性。生产环境应使用密码学安全随机源生成 token，例如 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`。可配置 `PI_COLLAB_ALLOWED_ORIGINS` 额外允许指定的跨源浏览器 Origin；列表最多 64 项、每项最多 2,048 个字符，原始环境变量文本也有总长度上限。当前实现允许与 relay 直接监听协议和 Host 完全匹配的同源 Origin，并为兼容 extension/非浏览器客户端允许无 Origin 连接；经 TLS 反向代理时应把公开的 HTTPS Origin 显式加入 allowlist。allowlist 项必须是没有凭据、路径、查询或 fragment 的 `http(s)` origin，列表不是对同源页面或无 Origin 客户端的硬隔离，token 认证仍是必要边界。

单个 browser peer 对一个 host 最多保留 32 个 pending command，单 host 总计最多 128 个；超过时返回 `COMMAND_QUEUE_FULL`。command result 会为 relay 添加的 envelope 预留空间；无法放入 256 KiB frame 的结果显式返回 `RESULT_TOO_LARGE`，不会被静默丢弃。客户端命令在加入 relay 路由 envelope 后若超出帧预算，会返回 `COMMAND_TOO_LARGE`，不会把 host socket 撑爆；当前已知 command variant 本身有字段上限，未知 future fields 会在转发前剥离，因此该分支也作为未来协议扩展的纵深防御保留。

文件命令始终在 extension 侧执行。路径会经过 lexical/canonical 两次检查；POSIX 文件读取使用 `O_NOFOLLOW`，Windows 使用 bigint 文件索引比较打开前后的对象，并在打开后再次检查 canonical path。目录通过已打开的目录句柄枚举，不会由 relay 直接访问磁盘。这是应用层的路径隔离和竞态防护，不替代操作系统权限或恶意本地进程隔离。
