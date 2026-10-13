# 多设备、多人协作与远程电脑

这套入口面向一台办公电脑运行多个 Pi 实例、用户从笔记本/手机/其他电脑访问，以及获授权同事共同查看和操作的场景。手机不是特殊客户端；各设备使用相同的 React 网页。原生 Pi 始终负责 AgentSession、模型、工具和 JSONL，云端不运行用户电脑上的任务。

## 当前本机安装与手机接入不是同一件事

`café space: connected` 表示此 Pi 与它配置的 Relay 已完成握手，不表示手机已经连接，也不表示公网网站已部署。`http://127.0.0.1:37891/` 仅供运行 Relay 的电脑使用；在手机输入同样地址指向手机本身。仅连接同一 Wi-Fi 也不会让 loopback 服务变成局域网服务。

跨 Wi-Fi／蜂窝访问需要完成下文的正式云端部署：服务器上的 HTTPS 网页和 cloud Relay、办公电脑到该服务器的出站 WSS 设备连接，以及手机自己的访问密钥。手机打开部署完成后的实际 HTTPS 域名，登录后选择电脑、房间与在线 Pi；仅查看不需要取得写控制权。云端模式优先可用中继，WebRTC 是可选传输，不会自动提供网页地址或替代云端身份/信令服务。

部署者必须明确提供服务器（SSH 别名或用户@主机）与域名，并完成 TLS/服务托管，不能照抄 example.com 当真实站点。本机首次设置的访问令牌不会自动变成云端用户账户；不要把本机包含 host 密钥的凭据文件上传云端。不要通过删除初始化安全检查、简单开放0.0.0.0或把令牌写进URL来凑手机接入。

## 首次本机使用：网页设置访问令牌

Pi 状态栏统一显示 `café space: connected`，连接中、重连和断开也使用 `café space:` 前缀。首次运行没有正式本机凭据时，状态为 `café space: setup required`，并提示打开本机网页。

启动的HTTP健康预检查不是连接状态判据，预检查未确认服务不再直接打印“local relay is unavailable”或静态“host connecting”。真实WebSocket故障连续3秒未恢复才通知重试中，同一故障窗口至多每60秒提醒一次；有效握手会取消待发提醒。已经提醒过的故障恢复时会明确显示“Café Space connected; the previous connection warning is resolved.”，停止/重载会取消旧定时器。底部状态始终独立更新，正常首次成功不会额外刷屏。

未配置远程/managed 模式且只使用默认本地令牌的 Go Relay，会自动进入初始化模式。默认网页为 `http://127.0.0.1:37891/`；用户自己填写“访问令牌”和“确认令牌”，也可点击“生成随机令牌”。只有点击“保存并进入 Café Space”才持久保存，不会在加载页面时自动生成正式令牌。新设置的自定义令牌为 6–20 位，不设复杂度要求，简单数字、重复字符和中文都可使用；不含首尾空白或控制字符。随机生成是可选操作，每次生成20位，不强制使用。已有版本保存的较长令牌保持可登录，不自动截断、轮换或重置；20位上限用于新初始化提交。简单令牌更容易被猜中，用户自行选择并妥善保存。这不是模型 API Key。

初始化表单沿用现有工作台的 Café 主题变量、字体和通用控件；标签左对齐，生成操作放在标签行，显示/隐藏放在输入框内。页面不使用咖啡背景图、玻璃效果或额外渐变。

初始化之前会话 WebSocket 返回 423，不允许使用开发令牌操作 Pi。保存成功后网页进入工作空间，已经等待的新版 Pi 会在下一次自动连接时读取本机 host 密钥，不需要重新发送任务。换一个浏览器进入时使用已设置的访问令牌登录；已完成初始化的服务不会再开放设置入口或覆盖令牌。

凭据保存于当前用户 `~/.config/pi-cafe-space/credentials-<端口>.json`，也可给 Go Relay 与 Pi 同时设置绝对路径 `PI_CAFE_CREDENTIALS_FILE`。POSIX 目录权限 0700、文件 0600。文件含用户选定的网页令牌及独立随机生成的 Pi host 密钥；它是本机私有文件，不是加密保险库，不要上传、分享或放入仓库。网页接口不返回已保存令牌或内部 host 密钥。文件损坏/权限不安全时拒绝启动，而不是恢复默认令牌。Windows 应放在当前用户专属目录并由管理员保障 ACL；本轮不宣称 Windows 凭据 ACL 实机验收。

初始化仅允许本机 loopback、字面 Host 校验、同源 JSON 和一次性随机挑战，不能作为无身份校验的公网部署向导。**同一操作系统账户和本机管理员仍属于信任边界**；多用户共享电脑应先由所有者完成初始化。既有显式自定义 host/client token、云端多用户配置或 managed 配置不会自动迁移或重置，仍使用下文原有配置方式。忘记令牌的恢复/轮换不通过未认证网页完成。

升级扩展后，已有 Pi 进程须使用原生 `/reload` 或重新启动 Pi 加载新代码；刷新网页不能替终端重载扩展。用户登录服务的 LaunchAgent 应使用稳定安装目录，明确保留 `HOME` 与凭据文件路径，不在其中写入固定开发令牌。

## 连接架构

```text
笔记本浏览器 / 手机浏览器 / 协作者浏览器
                 │ HTTPS 网页、账户认证、设备目录
                 ▼
       云端 Go Relay + 内嵌 React Web
                 │ 办公电脑主动建立 WSS；信令/权限续期
                 ▼
          办公电脑 Device Gateway
                 │ 原有本地 WebSocket Hub
        ┌────────┴────────┐
   Pi Extension A    Pi Extension B ...
       原生 Pi A        原生 Pi B
```

业务数据有两条互斥路径：

- **云端中继**：浏览器 ↔ 云端 WSS ↔ 办公电脑。无需开放办公电脑入站端口。
- **WebRTC**：浏览器 ↔ 办公电脑 DataChannel，ICE 优先直连，配置 TURN 时也可经 TURN 中继。云端信令连接保持在线，用于撤销与续期授权。

自动模式只在业务传输开始前选择路径。连接已经开始承载命令后，不静默切换、不重放写操作；恢复会重新认证和读取权威 snapshot。仅 WebRTC 模式失败时不会偷偷改走云端业务中继。

当前信任模型是**受信任的云端服务**：云端认证账户、设备并声明授权。本机再次限制房间、最高角色和操作能力，但这不是独立于云端的密码学设备配对。WSS 模式下云端能够看到业务消息；DataChannel 使用 DTLS，但信令与云端提供的网页仍属于信任边界。不要宣传“云端被攻破也无法冒充设备”。独立设备密钥签名/扫码验证不属于此版本。

## 构建与生成配置

从仓库根安装锁定依赖，进入 `packages/pi-cafe-space`：

```sh
npm ci --ignore-scripts
npm run remote:pack
```

在仓库根执行 npm ci；上述 pack 在包目录执行。`remote:pack` 与 `refactor:pack` 使用同一条新版本构建链。需要同时交付 Linux 服务器及 Windows 办公电脑时执行 `npm run remote:pack -- --platforms linux-amd64,windows-amd64`；本平台仍自动保留，额外目标通过 GOOS/GOARCH 交叉编译、文件格式和哈希检查，不会在本机执行外国平台二进制，也不等于目标平台运行验收。支持显式选择 `darwin-arm64`、`darwin-amd64`、`linux-amd64`、`linux-arm64`、`windows-amd64`。

候选位于 `.refactor/release/package/`，打包归档在 `.refactor/release/pack-*/`。旧 `npm run build` 仍是旧生产入口，不能代替新候选。生成源码与候选不会自动安装或切换用户全局 Pi。

在候选包目录或源码包目录创建**新的私有目录**：

```sh
node scripts/remote/setup.mjs \
  --output /absolute/private/cafe-access \
  --origin https://cafe.example.com \
  --device office --name "Office computer" --room main \
  --turn turn.example.com
```

`--turn` 可省略；另可传入管理员选择的 `--stun stun:host:3478`。工具不内置公共 STUN、不替用户选择外部服务。静态 `iceServers` 与动态 TURN 凭据合计最多 8 项；启用 `turn` 时，静态列表最多 7 项。没有 STUN/TURN 时仍可使用云端中继，同网直连也可能可用，但不承诺异网穿透。

工具拒绝覆盖已有目录，目录权限 0700、文件 0600（POSIX）。生成：

| 文件 | 放到哪里 | 说明 |
| --- | --- | --- |
| `cloud.json`、`cloud.launch.json`、`Caddyfile` | 云端服务器 | 用户/设备凭据只存 SHA-256；TURN shared secret 是私密配置 |
| `device.json`、`device.launch.json` | 办公电脑 | 该电脑独立设备凭据、本地 Host/Client token |
| `access-keys.json` | 管理员私密存储 | 给每个角色生成的独立访问密钥；只把对应那一项私下交给使用者 |
| `turnserver.conf`（可选） | TURN 服务器 | 必须私密保管，不发布为网页资源 |

示例提供 Owner/admin、Collaborator/operator、Viewer/viewer 三个独立账户。真实多人使用时，为每个人新增独立用户和随机密钥，不共用 operator 账户；云端 `users[].grants` 可给同一账户多个精确的 deviceId/room 授权。`devices` 可加入多台电脑，每台电脑必须使用自己的 key。可选 `expiresAt` 使用 RFC3339；`disabled:true` 或换 key 可以撤销访问。云端约每 5 秒重新读取配置并关闭不再授权的连接；配置损坏时拒绝继续使用旧授权。建议通过同目录临时文件原子替换配置，避免编辑过程短暂失效。

目录、账户、项目名都不是凭据。所有 key 应由安全随机源产生，至少 32 随机字节；不要把 provider API key 当作连接 key，也不要放在 URL 查询参数中。

## 启动云端和办公电脑

云端安装匹配平台的候选及其生产运行依赖 `ws` 后：

```sh
node scripts/remote/run.mjs --profile /private/cafe/cloud.launch.json
```

办公电脑：

```sh
node scripts/remote/run.mjs --profile /private/cafe/device.launch.json
```

启动器验证所选二进制的平台和 SHA-256，读取 launch profile 中显式端口/本地 token，前台运行。可以用 `--binary /absolute/path/pi-cafe-relay` 指定一个自己已核验的二进制；这个显式覆盖由管理员负责其来源。启动器不会编辑全局 Pi、继承任意 provider 环境变量、杀掉占用端口的未知进程或后台自动开机启动。生产托管可以把同一条命令交给管理员配置的 systemd/launchd/Windows 服务。

云端默认只监听 127.0.0.1:37892，使用生成的 Caddyfile 在 HTTPS 域名上反向代理；域名、证书、防火墙与 Caddy 服务需由部署者配置。办公电脑默认监听 127.0.0.1:37891；设备模式拒绝非 loopback 监听。更换端口可编辑私有 launch profile。云端不得配置本机 managed manager；用户项目目录和 provider 凭据属于办公电脑，不应复制上云。

### 连接已经运行/手动启动的 Pi

新启动某个 Pi 时显式加载候选扩展及该办公电脑的本地连接设置：

```sh
node scripts/remote/run.mjs \
  --profile /private/cafe/device.launch.json \
  --pi-cli /absolute/path/to/pi/dist/bundle/cli.js \
  --room main -- <其他 Pi 参数>
```

在目标项目目录运行。Pi CLI 参数仍传给原生 Pi；启动器不会修改全局设置。已运行的 Pi 只有在原本已连接到这个网关，或用户按原生扩展方式配置/reload 后才会出现；本工具不会接管或强制重启旧进程。多个实例保留独立 host/stream/session，网页必须明确选择实例。用户在本地终端的操作仍有效；远程控制租约不锁住原生终端，最终 session/cwd/空闲状态检查仍由原生扩展执行。

## 手机、笔记本与多人权限

访问同一个 HTTPS 网页，输入自己的访问密钥，点击“查找我的电脑”，选择被授权的电脑和工作空间，再选择连接方式。网页显示实际传输状态：云端中继、WebRTC、已观察到的直连或 TURN；未获取到 ICE 路径统计时只显示 WebRTC，不猜测。

- **viewer**：看会话、工具状态和本来获准的项目文件/历史；不能发任务、取得控制权或创建/关闭后台 Pi。
- **operator**：可以查看，并在取得某个 Pi 实例控制权后发送任务、取消、改名、继续历史或执行已有受限命令；不能管理后台进程生命周期。
- **admin**：拥有操作能力以及后台新建/打开/关闭；可以经明确确认接管另一远程设备的控制权。

每个 Pi 实例在同一时刻只有一个远程连接持有 30 秒控制租约；前台页面每 10 秒续期。不同实例可由不同人同时操作。同一个人的手机与笔记本也是两个独立连接，不互相覆盖。失联、撤销或到期会释放控制权；接管不自动取消正在运行的任务。不同房间不共享在线成员或控制权。

手机锁屏、切后台、换网都按可断线处理，回到前台重新认证并获取 snapshot，不自动重发最后一条 prompt。断线时已发出的操作可能返回“结果未知”，应先检查当前会话/后台列表，而不是点重试来掩盖不确定性。

## 远程新建/打开/关闭后台会话

办公电脑网关需要额外的**本机** managed JSON。先创建项目、专用 agent/state 目录并配置原生 Pi provider。配置格式延续 `MANAGED_SESSIONS.md`：

```json
{
  "node": "/absolute/path/to/node",
  "cli": "/absolute/path/to/pi/dist/bundle/cli.js",
  "extension": "/absolute/path/to/candidate/dist/extension/index.js",
  "agentDir": "/private/native-pi-agent",
  "stateDir": "/private/cafe-managed-state",
  "env": { "HOME": "/Users/me", "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "projects": [ { "id": "work", "name": "Work", "room": "main", "cwd": "/Users/me/dev/work" } ]
}
```

Windows 环境使用实际绝对路径与必要 OS 环境变量；不得照抄 Mac 示例。然后：

```sh
node scripts/remote/run.mjs \
  --profile /private/cafe/device.launch.json \
  --managed /private/cafe/managed.json
```

浏览器只能传白名单 projectId 和固定操作，不能指定可执行程序、文件路径、CLI 参数或环境变量。原生 Pi RPC 0.99.1 是此功能的目标验收版本；workspace SDK 版本不是后台 CLI 的版本保证。后台进程独立 UUID；相同创建 ID 先登记再启动，重复请求不会生成第二个实例。最多 16 项目、8 运行实例、100 保存登记，不自动淘汰会话；本版未增加永久删除/归档功能。

后台实例拒绝切换自己的原生 session 身份。手动 Pi 的历史继续能力不变。Relay 不生成或重写 JSONL。

### 进程存活语义

手机退出、浏览器断开或云端不可达，**不会停止办公电脑上的 Pi**。办公电脑本地网关退出/崩溃时，它自行创建的 managed Pi 会被回收；手动启动的 Pi 不会被停止。需要本地网关升级期间任务继续存活的独立守护服务，仍属于不同的生命周期设计，不应误认为本版实现了热迁移。

Windows 保留 Job Object 所有权；Mac/Linux 使用一个独立监督进程及父进程存活管道，回收自己创建的 POSIX 进程组，不扫描历史 PID。POSIX 进程组不是安全沙箱：刻意 setsid/脱离进程组的程序不在同一回收保证内。关闭管道写入使用有界单写队列，避免全局管理锁被阻塞的 stdin 卡住；调用方关闭截止时间得到传递，真实清理结束前不提前释放 registry 锁。

## TURN 与服务器运维

生成的 coturn 配置默认提供 UDP/TCP 3478 和限定的中继端口范围。云端签发短期 REST 凭据，不把长期共享密钥交给网页。需要 UDP/TCP 对应防火墙放行；服务器自身在 NAT 后面时必须明确配置 external-ip。

受限网络可另配 TURN/TLS：设置 coturn 证书和 key、移除 `no-tls`，在云端 `turn.urls` 增加 `turns:turn.example.com:5349?transport=tcp`。不要把纯 UDP/TCP 配置宣传为已具备 TLS 兜底。TURN 仍消耗中继流量，不承诺“任意网络都纯 P2P”。

保护云端与 TURN 的升级、密钥、监控和配额；云端普通业务转发不是手机到电脑的应用层端到端加密。日志不要记录 Authorization、hello token、SDP、ICE 细节或用户消息全文。协议状态主要在内存；不会承诺云端重启后的 exactly-once，浏览器不会自动重试未知写结果。

## 验证与边界

```sh
# 包目录，Node >=22.19.0，仓库锁定依赖已安装
npm run check
npm test -- --maxWorkers=2
npm run refactor:web:check
npm run refactor:web:test -- --maxWorkers=2
node --test scripts/remote/setup.test.mjs
cd relay
go test ./...
go test -race ./internal/remote ./internal/managed ./internal/service
go vet ./...
```

实际浏览器验收只启动自己的新浏览器，不附着用户实例：

```sh
node scripts/remote/browser-test.mjs \
  --binary /absolute/path/to/candidate/dist/relay/bin/darwin-arm64/pi-cafe-relay \
  --browser "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
  --report /absolute/isolated/report-directory
```

路径依平台替换。脚本使用临时随机 token/端口、两个真实 Go 服务、三个独立浏览器 context 和合成 Pi peers；不调用真实 provider。该脚本的本地云端入口是 loopback HTTP/WS，验证中继业务而非公网 TLS/证书配置；生产域名必须使用 HTTPS/WSS。Go 专项另有实际 DataChannel 直连与强制本地 TURN，断言真实选中的 ICE 类型。

当前版本的验收记录见 `docs/refactor/REMOTE_ACCEPTANCE.md`。桌面浏览器的 390px 视口不是 iOS/Android 实机；本地强制 TURN 不是所有公网/NAT/企业网络通过；交叉编译也不是目标系统运行验收。公网部署、域名证书和真实网络矩阵需在目标环境验证，不随构建自动完成。
