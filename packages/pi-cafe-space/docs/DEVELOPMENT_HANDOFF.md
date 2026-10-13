# 换机器继续开发

## 公开交接与私有运维资料

本文件保留源码、验证范围和历史技术决策。个人用户名、实际部署根已泛化；`example-user`、`/srv/cafe-example` 是示例，不是当前主机信息。未脱敏部署日志与回退依据已保存于维护者的仓库外私有目录，公开 [部署指南](DEPLOYMENT_SPACE.md) 不再包含服务器连接清单。不得用本文件示例推断真实路径后执行操作。

按用户确认，本次修复当前公开文件和后续提交邮箱，不重写旧 Git 历史；旧提交或已克隆副本仍可能含早期信息。后续文档与提交审查见 [PRIVACY.md](PRIVACY.md)。本次文档脱敏不改变运行中的 Pi、网关或服务。

## 2026-10-11 必要修复与状态层：已提交、推送并部署

Space功能提交`b38ddf73a592ddeb2bfab3b089856c1c40b3ead5`已推送`cafecodework/pi-packages/main`。主站身份修复与镜像配置提交`273a97e8288949306d218d5cb58ce420e14eeeb9`已推送`Shirtiny/edel-garden/refactor/control-gateway`：主站当前使用该分支，远端main是另一套旧代码且没有identity目录。本次从原分支远端最新c78fa28建立独立工作树，仅提交8个身份相关文件，不合并重构到main，不切换或覆盖主站原工作区。

本机安装/网关、Space cloud及主站identity均已切换`0.1.0-practical-20261011`。cloud镜像ID`sha256:616fb79741b2891302897c9794b3fe481d9376cbba86aa4bbf1cfb0afd984f02`，identity镜像ID保持下方已测试候选。公网和本机已实际返回`index-BJ3inzfA.js`与`index-DV6MoyIo.css`。上线后5组公网浏览器检查全部通过，报告`.refactor/reports/practical-published-public-20261011/result.json`：真实登录入口/取消返回、独立密码与访客WebRTC、未登录声明拒绝，1次合成prompt、0模型请求，未代登真实账号。

Pi扩展登记已更新为新安装目录，其他包、模型配置、房间身份/密码和审批设置保持。现有Pi进程未结束，需用户空闲时`/reload`加载新扩展；新开Pi直接加载新版。全局Pi仍为1.0.2，没有隐式升级为1.1.0，较新SDK事件仅在支持版本完整提供，旧版保持兼容/未知语义。只重载本项目网关、cloud与identity，Caddy/TURN未改动或重启。

首轮identity切换遗漏原Compose项目名cafe-identity，命令失败、旧容器未被替换，Compose恢复后已核对健康；随后使用原项目名成功部署，没有重复构建或轮换密钥。今后命令须带`docker compose -p cafe-identity -f deploy/identity/compose.yaml`。部署回执在`/srv/cafe-example/pi-cafe-space/practical-deployment.json`，主站Git回执在`data/practical-fixes-20261011/publish-receipt.json`，本机回执在`.refactor/publish-practical-20261011/`。下面保留构建与测试过程。

### 实现与发布前验收

用户复审后要求只做必要修复，不增加权限体系或大重构。本轮在原Pi1.1.0未提交工作上实现：

- 文件共享补齐`.secrets`、`data/identity`、`.config/pi-cafe-space`与明确配置的运行凭据／SQLite旁路文件保护；读取、列表、@附件共用检查。普通项目源码、示例keys.json及普通数据库继续可读，不新增逐文件审批。这不是OS沙箱，也不宣称能识别任意文件里的所有秘密。
- 房间验密区分错误密码、验证忙碌、资源限流、房间已变化；网页对应显示。仍是原PBKDF与每连接一次验密，单次计算并发有界。原12次共享锁定改为120次/分钟计算额度，成功不是密码失败，忙碌不消耗计算额度。旧无code的room.denied仍兼容。
- 身份服务限流改为可信代理来源、已存在服务端会话、不同接口用途的独立额度，保留宽松全局资源上限；伪造转发头或Cookie不能任意换桶，限流带Retry-After。没有Redis、新服务、SSO期限调整或额外确认。
- 聊天活动只用Pi扩展有序快照，不与托管RPC独立runId合并。托管列表仍显示自己的RPC观察。取消/失败/未知、原生提示种类和压缩状态保留，不统一重写运行状态层。
- 默认build/start/relay与npm run pack已指向现有Go/React发行链，旧TS仅以legacy命令显式使用。npm run pack的prepack前置钩子允许继续；直接npm pack在源码目录会提示正确入口，避免归档布局错误。

已核对：585项主包通过、1项原有跳过；277项网页与类型检查通过；Go remote/protocol/managed/service完整race和vet通过（103.781/3.175/4.956/3.901秒）。真实Pi1.1.0 SDK的完成、失败、自动重试、取消、结算前续轮5场景通过，报告`.refactor/reports/native-execution-practical-20261011/result.json`，外部模型/工具调用均0。主站身份16项协议/存储/限流/真实临时HTTP测试在固定Node LTS Docker构建中全部通过。本机Node24.0.2测试会有原有LTS/SQLite提示，不把它当作生产运行时覆盖；Docker构建补齐该覆盖。

主站七个源码文件已核对摘要后写回`/srv/cafe-example/edel-garden/services/identity`，候选镜像`edel-garden-identity:0.1.0-practical-20261011`，ID`sha256:1c242b5de3a976838b5ca3260826155639fa3b7736637fe02c02cbda9e0715cf`。源码原基线022ead2在操作间变为7cdcd07；确认新提交未改身份目录且七文件基线未变后再应用，未覆盖主站其他工作。清单、旧源码、镜像测试与写回回执在服务器`data/practical-fixes-20261011`，本机编辑副本在`.refactor/identity-practical-20261011`，没有复制运行密钥或真实会话数据库。

实际`npm run build`与`npm run pack -- --platforms linux-amd64,windows-amd64`均通过，默认启动器也已在随机本机端口验证Go/React资源并清理自有进程。47文件归档`.refactor/release/pack-iVHYXH/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA`ba5b0d5a5f933f5a6786c24b26bbb229ed64db3635c4205dc204f945e40ebf57`；Web摘要`a3b61574f80038aa0bde5d0c8b9f3a1f40f38db4b5dbba7596a45ef5a4ecfa51`，JS`index-BJ3inzfA.js`、CSS`index-DV6MoyIo.css`。Linux/Windows仅交叉编译，既有大JS分块提示保留，没有为了小修复再拆包。

最终真实浏览器21组全部通过，原操作退出0，报告`.refactor/reports/practical-fixes-browser-final-20261011/result.json`。包含本轮状态层、密码拒绝、原昵称刷新/房主审批、自定义模型选择、手机布局、旧链接离线、新链接接入，以及办公网关重启后身份/密码保持。4次合成prompt、外部模型请求0；实际Go/Chrome/WebRTC，非物理iPhone或公网蜂窝验收。之前Pi1.1.0因旧链接测试流程停住的尾部场景已补齐，不再是待完成项。

保留的检查边界：首轮默认构建因工具子进程PATH缺Node而未编译，随后只在测试shell使用既有Node/Go路径通过。网页旧room.denied兼容断言首次失败后恢复无code兼容，没有删除测试。首轮本次浏览器因旧正则“Incorrect password”不匹配新文案“Incorrect room password”超时，保留`.refactor/reports/practical-fixes-browser-20261011/result.json`；修正两处定位后同一应用包21组通过。一次有界等待调用被工具拒绝，没有调整权限或重跑任务，最终读原操作输出确认通过。

发布前曾核对旧identity容器与其他会话发布的cloud仍在运行；该状态已由顶部本次正式切换记录取代。本轮候选代码及归档字节未因Git提交改变，发布结果以顶部、实际镜像和公网报告为准。包内随构建封装的文档可能仍保留较早检查状态，不代表当前上线状态。

## 原实现与边界

- 开发包：`packages/pi-cafe-space`。当前远程版入口见 [REMOTE_ACCESS](REMOTE_ACCESS.md) 和 [本轮验收](refactor/REMOTE_ACCEPTANCE.md)；[PROGRESS §57](refactor/PROGRESS.md) 保留此前本地版本的历史记录。
- 当前方向是 **Go Relay + React / assistant-ui Web**，不是旧 `web/public` 客户端。Café 风格、严格 CSP、房间 Hash URL、原生消息/工具、`/` 命令、`@` 文件引用、左侧统一会话管理已经接入。
- 左侧新建会话启动独立原生 Pi RPC，不切换现有客户端；后台实例支持关闭/重开，Pi 负责模型、工具和 JSONL，Relay 仅管理其自行创建的进程及登记。
- 后台进程所有权已包含 Windows Job Object 与 macOS/Linux POSIX supervisor 实现。本轮在 macOS arm64 实测了两个原生 Pi 0.99.1 实例的独立创建、改名、关闭与重开；Linux/Windows 新远程版仍需在目标平台进行运行验收。交叉编译不等于运行验收。
- 本轮 Mac 远程版：主 TS 504、Web 121、Go 全部及 remote/managed/service race 通过；真实 Chrome 多客户端、WebRTC 直连、权限/控制接管/撤销通过。主包使用包内 Vitest 4.1.11，不使用根目录旧版本。此前 Windows 的 Web 101、37 项 Node guards 等是历史记录，不冒充本轮结果。
- 历史 PROGRESS 曾记录外部 provider 请求 HTTP 403 后停止。本轮未发送真实 provider 请求，也不将其他报告目录自动纳入本轮结论。生产切换 R19、真实 provider 调用、自动修改全局 Pi 配置均不属于拉取后的默认操作。

## 从干净仓库构建

本轮 Mac 工具链：Node **24.0.2**、Go **1.26.2**、TypeScript **5.9.3**、包内 Vitest **4.1.11**、Vite **6.4.3**。历史 Windows 工具链为 Node **22.23.2**、npm **11.16.0**、Go **1.24.2**。Windows 使用本机 Git/Node/Go，不把 WSL 工具链混入同一 Windows 工作树。新机器自行安装工具链；仓库不含原电脑 `.refactor/toolchains`。

```sh
# 仓库根目录：使用根 package-lock.json 安装整个 npm workspace
npm ci

cd packages/pi-cafe-space
npm run check
npm test -- --maxWorkers=2
npm run refactor:web:check
npm run refactor:web:test -- --maxWorkers=2

cd relay
go test ./...
cd ..

# 正确的 Go + React 候选构建/打包入口
npm run build
npm run pack
```

`build` 生成React、嵌入资源、运行webembed Go测试、构建当前平台Relay并编译扩展，安装布局在`.refactor/release/package/`。`npm run pack`在同一链路上再校验精确发行文件与归档，生成`.refactor/release/pack-*/`；只打本机及`-- --platforms linux-amd64,windows-amd64`明确选择的平台，不受未选平台旧缓存影响。旧`refactor:pack`与`remote:pack`仍为兼容别名，不是另一条构建链。

`npm start`／`npm run relay`启动已构建的Go包；旧TS参考入口是`legacy:build`／`legacy:relay`。源码checkout不是发行布局，直接`npm pack`会提示用`npm run pack`，不静默打旧dist。不要单独用`vite build`代替发行构建，所需HashRouter-only检查仍由统一构建注入。生成文件不提交，本机构建不自动部署。

Windows 的额外确定性检查（先完成 pack）：

```sh
node --test --test-concurrency=1 scripts/refactor/*.test.mjs scripts/refactor/local-registration/*.test.mjs
```

其中 launcher 测试会启动并清理自有测试进程，source-build 测试会执行隔离源码构建。Go `-race` 需要配置本机兼容 C 编译器；可参考 `scripts/refactor/verify.ps1` 的 `-Compiler`/`-NodeDirectory` 参数。真实 Pi loader 回归可显式设置 `PI_CAFE_TEST_PI_ROOT`，未设置则该项 skip。

## 启动与后台配置

- 普通 UI/Relay 调试可直接启动刚构建的 `.refactor/release/package/dist/relay/bin/windows-amd64/pi-cafe-relay.exe`。入口配置为 `PI_COLLAB_HOST/PORT/HOST_TOKEN/CLIENT_TOKEN/ALLOWED_ORIGINS`；不要复用公开开发 token 做后台管理。
- 独立新建需要另设 **`PI_COLLAB_MANAGED_CONFIG`**，按 [配置文档](MANAGED_SESSIONS.md) 填写新机器的 Node、Pi CLI、候选扩展、agent/state 目录和项目白名单。原生 Pi **0.99.1** 已验证；workspace 锁定的 SDK 版本不代表后台 CLI 支持相同参数。
- 在新机器原生 Pi 中自行配置 provider/凭据。设置文件、密钥、会话、后台登记不是源码，也不会随 Git 迁移。不要把它们放入已跟踪文件。
- 如需真实原生后台专项测试：完成 pack 后，在 Windows 显式执行 `node scripts/refactor/managed-native.mjs --allow-native --pi-root <本机Pi包目录>`。它使用临时项目/agent/state、随机 token/端口和离线合成 provider。
- `cafe-ui-browser.mjs` 是原电脑的显式浏览器验收脚本，依赖 Chrome SxS、独立调试端口和本机试用 HTTP/CSP；不是通用的一键新机器安装器。运行前检查路径、端口和独立 context 约束，不附着用户浏览器。

## 哪些内容不会随 Git 迁移

被忽略的 `.refactor/`、`.runtime*/`、`dist/`、`relay/internal/webui/assets/`、依赖目录和本机 `.env` 均不提交。因此：

- PROGRESS/CANDIDATE 内的 `pack-*`、部署 receipt、截图、日志和 PID 是原电脑历史证据，不会在新 clone 中出现；新机器重新构建会生成自己的候选包和摘要。
- `scripts/refactor/` 中的构建、测试、fixture 和接线源码已提交，但实际试用目录、provider 密钥、client/host token、Chrome profile、Pi 历史与全局 `.pi/agent` 不提交。
- **不要直接运行 `manual-install.mjs` 或 `local-registration/setup.mjs prepare/activate` 来迁移。** 它们保留了原电脑的一次性安装路径/旧包哈希和 owner 前置条件，不是可重复的通用安装命令；`local-registration/smoke.mjs` 也需先检查本机路径。
- 项目级 `.pi/skills/shadcn`、`.pi/skills/migrate-radix-to-base` 与 `skills-lock.json` 是已安装的开发参考，随源码保留；原电脑全局 Café/assistant-ui 等 skills 不在本仓库。

## Windows 凭据兼容性与首次使用回归（2026-10-09）

- 本机 Node 23.11.0 的 Windows 路径 `lstat` 返回 `dev=0`，同一文件的 `fstat` 返回真实卷 ID；BigInt 本身不能修复此差异。`private-json.ts` 从父目录句柄取得卷 ID，与文件句柄比较；保留 BigInt 文件编号、普通文件/权限检查、16 KiB 有界读取、读取期间变更检测和失败关闭。host、owner、room launcher 共用此实现，不忽略 dev，也不降级到默认 token。
- `cafe-render` 仍打包二维码依赖，但 Pi TUI 使用宿主 SDK，不再把另一版 TUI 打进扩展；未跳过依赖许可证检查。
- Windows Node 22.23.2 / 23.11.0 的凭据与 owner 专项各 14 通过、1 个 POSIX 权限检查跳过；TypeScript check、正式 Go/React pack、安装工具 4 项通过。主 TS 全量本次为 563 通过、1 跳过、1 失败（`cafe-render.test.ts` 的 12×24 终端二维码解码，未修改或隐瞒该失败）。
- 持久化回归入口 `scripts/remote/onboarding-test.mjs` 已修正 Windows PATH，额外验证发行包 room launcher 的私有配置读取。必须用**日常 Pi 实际使用的 Node**执行，而不只验证 installer 的 Node。真实 Pi 0.99.1 + Chrome + Node 23.11.0 对新发行包及正式安装路径均通过：初始化前拒绝接入、网页初始化、原 Pi 自动接入、第二浏览器登录、网关重启后重连；0 provider 请求。临时凭据只用于隔离服务。
- 本机经用户授权重置：正常入口 `http://127.0.0.1:37891/`，新安装 `AppData/Local/CafeSpace/versions/0.1.0-69f2af2d`。旧程序、状态、旧试用和 adapter 已移入用户私有备份 `CafeSpaceBackups/before-fresh-KfvhE4`，不复用旧令牌/房间身份；其他 Pi 配置及历史保留。新安装不需要 `Pi.cmd`，用普通 `pi` 即可。
- 正式端口已验证初始化页面，实际全局 Pi 登记（非 `-e` 覆盖）可达到 `setup required`；未替用户初始化。用户设置新令牌后才可完成这个新房间的真实接入/公网第二设备验收。未设置开机自启、未 commit/push 本轮修改。构建资产检查在 Node 23 下的类似兼容性尚未修复，发行构建仍使用已验证的 Node 22 工具链；不等同于预构建包需要用户换 Node。

## 手机同步阶段断线修正（2026-10-09）

- 用户手机显示 `synchronizing / ROOM_CONNECTION_LOST / sctp-failure`；本机受限诊断接口显示该次连接在 transport selected 后 5149ms 被 `AUTH_EXPIRED` 主动关闭，随后才关闭 DTLS/DataChannel。不能据此把手机网络或 SCTP 实现认定为根因。
- 确认并修正 `remoteSession.expired()` 的阶段计时：房间密码验证和 client hello 之前共用 selectedAt 起算的 5 秒预算；现在验证成功记录 roomVerifiedAt，给 hello 独立 5 秒。保留未认证超时、一次密码尝试、账号过期和信令授权过期。新增安全日志阶段 ROOM_VERIFIED / HELLO_RECEIVED / HELLO_ACCEPTED，不记录凭据。
- 新回归先红后绿；Go 全量 tests/vet、正式 pack 通过。用户明确同意重启后，正式安装更新至 `AppData/Local/CafeSpace/versions/0.1.0-28800cd4`，候选 `pack-Fl2YYl`；此前版本保留。凭据、房间身份/链接、其他 Pi settings/models 字节检查通过，没有结束普通 Pi。
- 正式公网入口的独立桌面 Chrome 只读接入成功，收到真实会话快照；另将两个握手发送分别人为延迟 2600ms，仍成功接入。网关诊断记录三个握手阶段后正常 VISITOR_LEFT。0 provider 请求；**真实手机仍待用户重试，不能以桌面延迟测试冒充手机验收**。本轮未再次执行 race、未 commit/push。

## 扫码后先检查房间在线状态（2026-10-09，待公网部署）

- 旧行为在提交密码后才打开信令连接，离线提示过晚。新增云端 `POST /api/room/status`：只接收 roomKey，返回单个 online 布尔值；同源 JSON、小请求限制、连接准入和 no-store；不接收密码/账号令牌，不创建访客、WebRTC 或消耗房间加入次数。
- 公网 RoomLogin 在身份选择和密码表单之前先查询状态。离线显示“房间已离线”及重新检查按钮；查询失败显示“暂时无法确认”，不当作离线/密码错误。取消旧房间请求，忽略导航后的迟到结果。检查通过仍须完成原来的签名、密码和业务握手，不能作为授权或连接成功证明。
- 云端只保存在线登记，不能区分有效但离线、未登记或已失效的 key；界面明确提示“房主未连接或链接已失效”，不捏造“房间不存在”。在线检查是进入页面时的快照，随后掉线仍由原连接流程报告。
- 专项 14 项、Web 全量 247 项、Web TypeScript 检查、Go 全量 tests/vet 通过。新增云端测试覆盖真实注册/离线、未知 key、同源/方法/body 校验、服务不可用与不分配访客资源。
- **尚未更新公网服务器及它提供的网页**；只重启用户电脑网关不会生效。本轮未重启任何现有服务、未 commit/push，未把本机单测当成手机在线验收。

## codemode 内部工具与重复缺失提示（2026-10-09，本机已部署／公网待部署）

- 对用户 `deepctrls-sight` 会话做只读快照统计，确认内部 read/ls 的参数、结果、状态保留，但没有独立 assistant tool-call/tool-result 消息。核实原生 Pi `core/nested-tool-calls.js` 的 ID 规则为 `<callerId>/<positive integer>`；不是工具名/时间推测。
- Web 转换器将规范 ID 的内部执行归入当前 scope 中唯一的 codemode 调用卡片，保留 ENOENT/错误、输出、参数、作用域 key 和折叠状态；已有直接调用归属优先，重复 ID、歧义或冲突 hint 不强行归并。不修改原生 JSONL，不重新执行工具，不扩展 wire schema。
- 已知边界：当前 wire 不包含 parentToolCallId，因此这个兼容处理只识别 codemode 父调用；其他嵌套工具及已裁掉父调用的记录继续独立显示。不按任意 ID 前缀或工具名称猜测关系。
- 独立执行不再自动标 incomplete；删去重复“关联信息缺失”标题。真正的 historyTruncated/partsTruncated 在会话顶部提示一次，未找到调用消息的记录只保留一条准确说明。参数校验保护保留，说明移至参数详情内。
- 转换/UI 专项 27 项，Web 全量 260 项及 Web TypeScript 检查通过。再次用用户当前只读快照验算：4 条 `.trellis` 内部执行成功归组，0 条仍被当成孤立记录；当时原 3 条 ENOENT 已不在当前快照，错误保留由回归 fixture 验证，不声称重放了原始会话。
- 正式 pack 通过：Windows 候选 `pack-W1Eicg`，归档 SHA256 `6a800197d989460a3bbd8b8082c280566713cb458f3d8c71f6622db02545f5cb`，Web digest `6ad8d76753414ed06794170bd557caded40b147b01f43f2e770f12fa1cdcedf5`。包含上述离线预检改动。用户授权后本机升级至 `AppData/Local/CafeSpace/versions/0.1.0-6a800197`；旧版本及升级备份 `CafeSpaceBackups/before-nested-tools-kFfMFA` 保留。owner/监听核验后仅停止自有网关进程，凭据、身份、链接及其他 Pi 配置保留。真实 Chrome 登录并选择用户项目会话通过：65 个工具卡片、14 个内部卡片，旧警告 0，分享面板正常，pageerror 0、provider 请求 0。未部署公网或 commit/push；公网需在目标平台构建并更新所提供的 Web，Windows 归档不能直接当 Linux 发布包。

## 工具详情展开箭头对齐（2026-10-09，本机已部署）

- rawData summary 的 `display:list-item` / outside marker 使箭头越出内容区域；完整输出、参数、diff 原始输出统一使用已有 SVG chevron + flex 行内排列，open 状态旋转 90°，保留原生 details 键盘/点击行为。不修改外层工具标题或全局 summary 样式。
- Conversation 8 项及 TypeScript 检查通过；Chrome 隔离样式验收覆盖 1440×900、1280×720、390×844、320×844、嵌套行和 Enter/Space toggle。正式 pack 通过，候选 `pack-me1YZP`，SHA256 `b6af2d782e1e5c791a48ecd5e9735bf0220cec30fa53ad87248bf5deacf231ec`。
- 本机升级为 `AppData/Local/CafeSpace/versions/0.1.0-b6af2d78`，备份 `CafeSpaceBackups/before-disclosure-VlsKJa`。实际本地页面 107 个工具详情行 SVG 均在内容区域内且垂直居中；登录、当前项目会话、分享面板通过，无 pageerror、无 provider 请求。令牌、房间链接/身份、普通 Pi 保留。未更新公网、未执行 Firefox/Safari 视觉验收、未 commit/push。

## 待调研：Pi 1.1.0 程序状态（OSC 7501）

- [ ] 核验 Pi 1.1.0 与当前扩展、managed RPC 的兼容性，以及 `agent_settled.aborted` 对取消/完成/最终失败展示的价值。
- [ ] 核验公开 SDK 对等待确认、输入、登录和上下文压缩的状态覆盖，尤其重试结束、断线重连和会话切换时的语义。
- [ ] OSC 7501 暂仅作为终端集成候选：优先保留 Pi 原生自动探测，不全局强制 `PI_PROGRAM_STATUS=1`；Web 继续使用结构化事件，不为此新增 stdout 拦截或 PTY，不向 RPC JSON 流混入控制序列。
- [ ] 若未来托管终端，再评估 OSC 消费、安全过滤与消息隐私。状态提示不作为授权依据或任务成功验收。

状态：仅待调研，未实施、未承诺完整状态覆盖。参考 Pi 1.1.0 `docs/terminal-setup.md#program-status`、`docs/environment-variables.md` 和 `dist/modes/interactive/program-status-reporter.js`。

## 接下来从哪里看

| 范围 | 入口 |
| --- | --- |
| 后台进程、锁、配置/API 边界 | `relay/internal/managed/` |
| HTTP/WS 服务组装 | `relay/internal/service/service.go`、`relay/internal/httpserver/server.go` |
| 左侧新建/关闭/重开及结果过期保护 | `web/src/features/history/ManagedSessions.tsx`、`web/src/services/http/workspace.ts` |
| 原生会话/命令/文件能力 | `src/extension/index.ts`、`src/extension/file-commands.ts` |
| 协议与测试向量 | `src/protocol/`、`relay/internal/protocol/`、`protocol/fixtures/` |
| 候选发行与精确文件清单 | `scripts/refactor/build.mjs`、`release.mjs`、`pack.mjs` |

尚未实现：会话删除、未加载历史直接改名、跨会话草稿保留、`#` 输入能力。远程版跨平台进程所有权已有实现，实际验收范围以 REMOTE_ACCEPTANCE 为准。后台上限为 8 个运行实例 / 100 项登记，不自动淘汰；修改上限或删除语义前要保留幂等创建、原生持久化和进程所有权边界。
