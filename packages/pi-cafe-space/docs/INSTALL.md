# Café Space 安装与配置

本指南适用于**Go Relay + React 房间版的预构建包**。用户可以选择连接已有 `https://space.cafecode.work`，或在自己的 Linux 服务器部署服务。一台办公电脑一个房间，复制链接／扫码后输入房间密码进入。公共 Space 支持 Café 账号或访客，账号登录不替代房间密码；自托管未配置身份服务时仍可使用访客。

当前架构和运维入口见 [README](../README.md)；具体上线版本、提交和回退记录见 [DEPLOYMENT_SPACE.md](DEPLOYMENT_SPACE.md)。下文描述安装步骤，不代表生成包或配置文件后已经部署。

## 先区分三种安装位置

- **办公电脑**：安装 Pi、Café Space 扩展和本机网关；Pi 执行任务、保存会话。
- **公共服务**：提供网页、房间发现与信令；TURN 为无法直接连接的客户端中继加密传输。
- **手机/笔记本访客**：只需浏览器、房间链接和密码，不安装网关，不设置服务器访问密钥。

配置文件和身份必须保存在办公电脑的私有状态目录，不能放在程序安装目录。程序版本可以替换，状态目录不能随更新删除。

## 取得可信安装包

先取得发布者交付的 `.tgz` 预构建包及通过独立可信渠道提供的 SHA-256，校验后解压。不能只信归档里自己携带的哈希。不要从猜测的 GitHub Releases 地址下载，也不要运行未经查看的远程 `curl | sh`。

Git 中的源码提交、可安装归档和运行中的部署是不同产物，不能仅凭 commit/push 假定 GitHub Releases 或 npm 已经发布了安装包。将包交给另一台电脑或 AI 时，同时提供实际归档与摘要。源码开发者在仓库根安装锁定依赖后，在包目录执行 `npm run build` 生成 `.refactor/release/package`，或执行 `npm run pack -- --platforms linux-amd64,windows-amd64` 构建并归档。直接 `npm pack` 会提示正确入口；`remote:pack`／`refactor:pack` 为兼容别名，旧 TS 流程只通过显式 `legacy:*` 命令使用。

解压后的预构建包应有 `dist/relay/build.json`、目标平台的 Go 二进制以及 `scripts/remote/install-client.mjs`。Node **22.19+** 为最低声明要求；本轮实测 Node24.0.2。Go 编译器只在从源码构建时需要。Pi是单独安装的CLI，安装器不会擅自全局安装/升级它或配置模型供应商。

## A. 办公电脑连接公共服务

### 1. 检查现有环境

读取 `node --version`、`pi --version`、`pi list`，检查本机37891端口和已有Café Space启动服务。没有Pi时，先经用户确认再安装原生Pi CLI；不要自动替换当前Node版本或修改provider/API key。NVM用户应使用当前Node对应的绝对CLI路径，服务不依赖交互式shell的PATH。

### 2. 安装程序与配置

在已验证、解压的预构建包目录执行。下面路径是示例，`NODE`、`NPM_CLI`、`PI_CLI`由该机器实际检查取得，不能照抄另一台电脑的路径。

```sh
# 设置这些变量为当前机器实际路径。
NODE="/absolute/path/to/node"
NPM_CLI="/absolute/path/to/npm/bin/npm-cli.js"
PI_CLI="/absolute/path/to/pi/dist/bundle/cli.js"

"$NODE" scripts/remote/install-client.mjs \
  --prefix "$HOME/.local/share/pi-cafe-space/rooms-v1" \
  --state "$HOME/.config/pi-cafe-space/my-room" \
  --server https://space.cafecode.work \
  --credentials "$HOME/.config/pi-cafe-space/credentials-37891.json" \
  --install-dependencies --npm-cli "$NPM_CLI" \
  --register-pi --pi-cli "$PI_CLI"
```

此命令新建独立安装目录，校验二进制并安装锁定的最小生产依赖，生成房间配置和启动脚本。`--register-pi`明确授权通过Pi原生安装机制登记此扩展；没有该开关就不会改Pi配置。`--install-dependencies`明确允许npm联网安装依赖；不运行安装脚本，不安装开发依赖或自动安装peer Pi。

默认不启动服务。安装结果JSON给出 `startCommand`，也可执行安装目录里的 `start-room.sh`（Windows为`start-room.ps1`）。进程持续运行时，打开结果中的本机网页地址。

确认希望登录后自动运行时，可在**首次安装同一条命令**追加 `--enable-service`。macOS创建用户LaunchAgent，Linux创建用户systemd服务；它拒绝覆盖现有同名服务或抢占已占用端口。Windows目前生成前台PowerShell启动脚本，不宣称已配置或验收计划任务。不要为通过检查杀掉未知进程；旧安装升级应按后面的显式迁移流程操作。

### 3. 首次使用与分享

第一次没有本机令牌时，bootstrap先提供本机初始化网页。用户亲自在浏览器选择6–20位令牌；安装器和AI不生成、记录或索取密码。保存后bootstrap自动转成房间网关。重新登录本机网页，点击顶部**分享房间**即可复制链接、展示二维码。

第一次房间密码沿用刚设置的本机令牌；之后可在分享抽屉中独立修改房间密码。本机登录令牌不随房间密码修改。已有6–20位本机令牌的升级用户也按同样方式首次迁移；若原本机令牌较长，不要截断它，应先明确选择迁移策略。

手机用系统相机扫码，或笔记本打开链接；公共 Space 首次先选择 Café 账号或访客，再输入房间密码。密码不在 URL／二维码中，不需要旧云端 `login.txt` 的访问密钥。办公电脑必须保持网关运行并联网。控制权审批默认关闭，通过房间密码即可操作；房主开启审批后，访客明确申请，由房主本机网页或 `/cafe approvals` 批准后才能操作。多人可同时查看，批准不自动发送草稿。

### 从 Pi 直接分享（推荐）

启动 Pi 后输入 `/cafe`，默认选中“分享房间”；也可直接 `/cafe share`。终端会显示二维码和完整链接，C复制、B打开网页管理、R刷新、Esc返回。终端太小会明确提示放大或按Q展示二维码，不裁剪二维码；SSH下不能操作手边设备的剪贴板时如实提示手动复制。启动不自动开浏览器、不打印链接或密码，完整引导按本机网关只显示一次。`/cafe open`需要登录时，登录后直接回分享面板。已运行的旧Pi先在空闲时 `/reload`；不必结束其进程。

新建会话与新实例是不同动作：普通Pi聊天区域“新建会话”或`/new`在当前Pi中启动新会话，需要空闲、当前操作权限和确认；侧栏“新实例”创建独立Pi进程。受管实例固定到自己的会话，提供“新实例”而不显示无效的会话切换按钮。

独立实例需房主明确批准项目配置。房间配置设置`roomManagement:true`，并在`room-run`明确传入`--managed-config /absolute/private/manager.json`；其中node/cli/extension/agentDir/stateDir及projects均为本机真实绝对路径，最多16个批准项目。此开关允许有密码的operator在列表项目中创建/打开实例，不允许关闭他人实例、强抢控制或管理房间密码/key。未批准时默认关闭。令牌保持用户自选，内部host密钥独立随机，服务必须验证真实房间模式才能使用此组合；不要为启动管理器重置用户令牌。项目工作目录白名单不是OS沙箱，Pi工具仍按本机账户和工具策略运行。

### 4. 诊断

```sh
"$NODE" scripts/remote/doctor.mjs \
  --server https://space.cafecode.work \
  --port 37891 \
  --config "$HOME/.config/pi-cafe-space/my-room/room-device.json"
```

doctor只读取公开配置和房间身份文件元数据，不读取/传送密码或私钥。它报告网页可用和配置匹配，**不会把healthz当作P2P成功**。完整验收还要在本机分享抽屉确认在线、用第二个设备打开链接并输入密码，查看实例和实际连接状态是WebRTC direct还是WebRTC TURN。

## B. 部署自己的公共服务

需要用户明确指定：服务器及正常授权访问方式、域名、公网IPv4、目标CPU架构、是否已有Caddy/其他反向代理。网页、信令、TURN都可以自行托管；办公电脑只需把 `--server` 改为自己的HTTPS域名。

在有对应Linux二进制的预构建包目录运行配置生成器。它可以在Mac生成文件再上传，不会自行登录服务器或改变DNS/防火墙。

```sh
"$NODE" scripts/remote/configure-server.mjs \
  --out "$HOME/cafe-server-new" \
  --origin https://space.your-domain.example \
  --public-ip YOUR_SERVER_PUBLIC_IPV4 \
  --arch amd64 \
  --proxy existing
```

`YOUR_SERVER_PUBLIC_IPV4`和示例域名必须换成用户的实际信息；不能用文档示例地址部署。输出目录必须不存在。私网地址、带密码/查询参数的URL或不支持架构会被拒绝。

**已有反向代理**选择 `--proxy existing`。生成器不覆盖原代理，只输出`caddy-site.snippet`。这份snippet假定Caddy运行在宿主机或host网络；桥接网络的Caddy不能把自己的127.0.0.1当宿主机，需要先检查实际Docker网络，再通过共享受控网络连接cloud容器。备份、比较正在生效的配置、校验、reload，保留所有原站点。

**全新服务器且80/443空闲**才选择 `--proxy caddy`，生成独立Caddy服务及持久证书卷。它使用明确版本，不会升级机器上已有Caddy。该模式需要正确DNS和可达的80/443；现有Caddy冲突时不要强行启动第二个。

上传整个新目录到服务器的新路径，例如`/srv/cafe-example/cafe-room`，校验`MANIFEST.sha256`。该目录包含TURN shared secret和独立内部运行密钥，必须私有保存，不上传Git或作为公共下载文件。

经用户授权的服务器管理员在目录内执行：

```sh
sh ./start-server.sh
```

脚本明确要求管理员身份，不自动sudo。先校验摘要、设置容器所需文件权限和Compose配置，再启动这套独立服务。它不修改防火墙，**不得把生成目录当成已部署或端到端验收成功**。使用前必须检查同名Compose项目和端口占用。

网络规则：cloud只发布`127.0.0.1:37892`；网页通过HTTPS443。TURN直接使用公网IP的3478TCP/UDP以及49160–49259UDP，不能走Cloudflare普通HTTP代理。模板假定公网IPv4实际配置在服务器网卡上；NAT后的服务器需单独映射设置，不能照搬。模板未提供TURN/TLS5349；受限网络是否可用必须实际测试，房间模式不会静默把业务改为普通WSS明文中继。

服务端只路由房间信令，不需要为每台办公电脑创建User/Device条目。TURN限时凭据、配额和私网目标拒绝已生成。日志不能记录密码/设备密钥；密钥备份不应放进Caddy站点目录。

## 升级与回退

程序安装目录版本化；房间状态、原本机凭据和模型配置独立保存。再次安装使用新的 `--prefix`，相同 `--state` 并明确 `--reuse-state`。只有域名、房间路径和模式一致才复用；换服务域名或发现不匹配时停止，不能偷偷重置roomKey。

旧服务存在时不要再次使用`--enable-service`。AI应读出旧服务实际参数、备份及哈希，验证新版本后，在明确授权下只切换该网关服务的执行路径。已有Pi可以`/reload`扩展或下次启动加载，不能自动结束正在执行任务的Pi。失败恢复原服务文件/原程序路径，不删除身份或密码文件。

自托管升级先备份cloud/Compose/TURN配置和Caddy，再单独替换cloud镜像与资源。单文件bind mount的配置采用原子替换后需要重建对应容器才能挂载新inode；不要重启整台Docker或执行`docker system prune`。保留原镜像和配置直到新版本验收通过。

## 验收清单与当前边界

最低验收：程序哈希/平台正确；本机可初始化；房间重启后URL不变；二维码解码与复制链接一致；错误密码无实例信息；正确密码进入WebRTC；两个Pi与两个访客不串会话；修改密码不改URL；重置链接使旧链接无效；原模型和会话文件未被改变。

本轮已在macOS arm64实测房间功能和Linux amd64 Docker服务；Windows二进制只交叉编译，安装服务模板尚无Windows真机验收。Linux用户systemd模板不等于每种发行版桌面会话均验收。公网UDP受VPN/路由/防火墙影响，不能承诺所有网络直连。公开网页代码仍是信任边界，不宣传“恶意网页也看不到输入的密码”。

参考：Caddy官方命令与部署文档、Docker Compose service/network文档、coturn官方4.18.0发布。使用当前已验证版本并对网络环境做现场核验，不以文档替代运行证据。
