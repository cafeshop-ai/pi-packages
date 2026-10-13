# Café Space · @cafecodework/pi-cafe-space

在手机、笔记本和协作者的浏览器中使用办公电脑上的原生 Pi。一台办公电脑的网关对应一个房间，房间里可以连接多个 Pi 实例；分享链接或二维码后，访客输入房间密码进入。

**当前实现是 Go Relay + React 网页 + Pi 扩展，不是终端画面转播。** 模型、工具和真实会话由办公端 Pi 负责，网页呈现结构化消息与状态。

[安装与自托管](docs/INSTALL.md) · [房间与二维码](docs/ROOMS.md) · [部署与维护](docs/DEPLOYMENT_SPACE.md) · [Café 账号与 SSO](docs/CAFE_SSO.md) · [开发交接](docs/DEVELOPMENT_HANDOFF.md) · [文档隐私](docs/PRIVACY.md)

## 使用方式

办公电脑安装 Pi、Café Space 扩展和房间网关，并保持网关在线。Pi 内执行 `/cafe` 或 `/cafe share` 分享房间，`/cafe open` 打开本机分享和设置。默认本机网页地址 `http://127.0.0.1:37891/` 只适用于这台电脑，不是手机的远程入口。

手机或笔记本打开房间链接。公共产品入口支持 Café 账号或访客身份；自托管实例也可仅提供访客。账号登录复用主站，不需要第二套 Space 注册／密码系统；登录或取消后返回原房间。

**身份、房间密码、操作审批彼此独立。** 账号不免除房间密码，也不自动成为房主。审批默认关闭，通过房间密码后可直接操作；房主开启审批后，在本机页面或 `/cafe approvals` 处理申请。批准不自动发送访客草稿。详细规则见[房间指南](docs/ROOMS.md)。

网页更新后刷新页面；扩展更新后，已有 Pi 在空闲时 `/reload`。安装扩展不会自动升级全局 Pi，生命周期事件能力取决于实际运行的版本。

## 架构与职责

```text
手机／笔记本浏览器
  ├─ HTTPS ─► 反向代理
  │              ├─ 网页、房间登记和信令 ─► Go cloud
  │              └─ 登录、OIDC、应用会话 ─► identity
  │
  └─ WebRTC（直连或经 TURN） ─► 办公端 Go 网关
                                   ├─ WebSocket ─► Pi 扩展 A ─► 原生会话 A
                                   └─ WebSocket ─► Pi 扩展 B ─► 原生会话 B
```

| 组件 | 职责 | 边界 |
|---|---|---|
| React 网页 | 会话、文件、模型设置和操作意图 | 不直接持有模型 API Key 或调用模型 |
| cloud | 嵌入的网页资源、房间登记和 WebRTC 信令 | 不代替办公 Pi 执行任务，不保存房间密码 |
| identity | 主站账号接入、OIDC、Space 登录会话与声明 | 不代替房间验密和房主审批 |
| TURN | 直连受限时转发加密的 WebRTC 流量 | 不执行任务，不决定房间权限 |
| 办公网关 | 验密、身份检查、审批与命令准入，连接本机 Pi | 不自行改写 Pi 会话历史 |
| 原生 Pi 与扩展 | 执行模型与工具，上报真实消息和生命周期 | 不通过屏幕或 OSC 文本推测任务结果 |

当前 cloud 使用单实例内存登记；信令与授权生命周期变化可能让已有房间连接重建。P2P 不表示云端任意重启都不影响使用。可选的[托管实例](docs/MANAGED_SESSIONS.md)由办公网关拥有，重启网关可能影响这些进程；手动 Pi 另有生命周期。

## 构建与安装

源码构建需要 Node.js `>=22.19.0`、npm，以及满足 [`relay/go.mod`](relay/go.mod) 的 Go 工具链。Go 二进制无需 Node／Go 运行时；办公端 Pi 扩展与 Node 启动脚本仍需要 Node，Pi CLI 单独安装。

从仓库根目录执行：

```sh
npm ci --ignore-scripts
cd packages/pi-cafe-space
npm run build
```

构建得到当前平台的可安装目录 `.refactor/release/package`。需要交付归档及服务器平台时：

```sh
npm run pack -- --platforms linux-amd64,windows-amd64
```

以命令输出的归档路径与摘要为准。交叉编译不等于目标系统已运行验收。安装使用生成的分发目录或 `.tgz`，不把源码 checkout 中旧的 `dist` 当作发行包。直接 `npm pack` 会提示使用 `npm run pack`；`remote:pack` 和 `refactor:pack` 是兼容别名。

在包目录查看房间安装器参数，再按[安装指南](docs/INSTALL.md)选择实际路径：

```sh
node .refactor/release/package/scripts/remote/install-client.mjs --help
```

程序与房间状态目录分开，更新不得删除身份、密码或模型配置。`npm start`／`npm run relay` 启动已构建的 Go Relay，不替代房间配置或服务注册；已有网关运行时不要再占用同一端口。仓库根提供 `pi-cafe-space:build`、`pi-cafe-space:pack`、`pi-cafe-space:start`。

```text
packages/pi-cafe-space/
├── src/extension/                 Pi 扩展
├── src/protocol/                  TypeScript 协议与归约
├── relay/                         正式 Go 网关、云端与管理模块
├── web/src/                       React 网页
├── scripts/                       构建、安装、诊断及发行
├── docs/                          公开指南
└── .refactor/release/package/      生成的分发目录，不入 Git
    ├── dist/extension/index.js
    ├── dist/protocol/
    ├── dist/relay/build.json
    ├── dist/relay/bin/<platform>/pi-cafe-relay[.exe]
    └── scripts/remote/
```

旧 TS 中继和静态 Web 流程见[历史参考](docs/LEGACY_TS_RELAY.md)，不作为当前生产安装步骤。

## 服务器部署概览

cloud、identity 和 TURN 可以分别以 Docker Compose 服务运行，复用现有 HTTPS 反向代理。**这里不公布某台服务器的源站地址、SSH 账户、内部端口映射或实际运维目录。** 下面是通用分工；具体配置由维护者私下管理。

Space 的 `/api/identity/*` 转发到身份服务，其余页面和信令转发到 cloud。主站 OIDC、SSO 与退出接口接入同一身份系统，其他主站业务保留原路由。公网入口、回调、issuer 与可信代理设置必须来自当前实例配置。

React 资源嵌入 Go 程序，cloud 无需单独的 Vite／Node 前端容器。身份服务采用独立 Node 构建和测试，使用主站原有账号系统。TURN 使用自身协议端口，不经过普通 HTTP 反代；网络可用性需要现场验证。

持久数据与镜像分离：身份签名密钥、登录会话数据库、内部运行配置使用独立受限目录或卷。办公房间身份和 Pi 会话仍在办公电脑。公开仓库不是运行凭据或真实运维回执的备份。

### 运维命令模板

在服务器上从私有运维记录设置变量后执行，不把示例复制成未经核对的实际部署：

```sh
: "${SPACE_PROJECT:?请设置实际 Compose 项目名}"
: "${SPACE_COMPOSE:?请设置实际 Compose 文件绝对路径}"
docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" ps
docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" logs --tail=80 cloud
```

只有新镜像已准备、Compose 已指向该版本且回退依据已保留，才切换目标服务：

```sh
docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" up -d --no-build --no-deps cloud
```

身份服务使用其自身项目名与 Compose 文件，不能推断或复用错误的项目名。完整流程、身份命令和回退原则见[部署与维护](docs/DEPLOYMENT_SPACE.md)。

**Git push 不等于部署成功。** 服务更新后要核对实际资源、身份接口、房间密码、审批与第二设备 WebRTC 连接。`/healthz` 只证明 HTTP 可用，不证明端到端成功。文档更新不需要重启业务服务。

## 状态、权限与隐私

连接、活动和本轮结果分开显示。“本轮结束”不是业务目标验收，断线不会当成成功，`dispatched` 只表示命令已派发。缺少原生事件证据时保留未知，不编造运行状态。

共享文件受项目边界和已知敏感路径保护，但程序不能识别任意文件里所有秘密。获得 Pi 操作权后仍使用办公端原生工具权限，项目白名单不是操作系统沙箱。

公开文档保留产品域名、协议、默认开发端口和明确示例；实际实例信息、个人路径和未脱敏回执放在仓库外。后续提交应使用本人核对后的隐私邮箱。更改当前文件不会删除已公开的旧历史，本轮不重写历史。详见[文档隐私](docs/PRIVACY.md)。
