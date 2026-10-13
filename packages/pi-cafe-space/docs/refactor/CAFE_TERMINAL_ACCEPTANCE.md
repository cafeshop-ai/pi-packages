# Café Space 终端入口与会话操作交付

2026-10-03。承接房间链接/二维码版，在未提交工作树上完成 `/cafe` 主入口，并修复远端新建会话与独立实例启动路径。本文件是当前修订；ROOM_ACCEPTANCE.md中的此前版本继续保留为历史证据。

## 当前连接修订

手机输入密码后持续connection lost的最新诊断和部署见[PHONE_CONNECTION_ACCEPTANCE.md](PHONE_CONNECTION_ACCEPTANCE.md)。当前运行`0.1.0-phone-connect-20261003`已修复多余ICE等待、首次失败无限重试和进行中连接被恢复事件重启，并显示安全阶段诊断；强制公网TURN/TCP已实际通过认证和welcome。物理手机结果仍待用户确认，未把二维码修复或HTTP200当作网络成功。

## 前序修复：真实Apple Terminal二维码有字体空隙，难以扫码

用户提供96×36 Apple Terminal截图。原截图的二维码定位框和黑色区域被字形留白切断；图像分析测得字符格约14×28像素，黑块有效字形只有约22像素高，行间出现约6像素白缝。原截图直接二维码识别失败，按字符格还原45×45模块后可解为同一有效房间链接；没有把用户链接/key写入此文档。说明编码内容不是根本错误，而是终端字形渲染破坏了可扫描图形。此前把终端字符还原为理想矩阵的测试没有覆盖真实字体空隙。

先尝试同色背景和Apple半块比例补偿，在截图近似栅格下仍有解码失败，因此没有将补偿实验当作稳定修复发布。最终Apple Terminal默认用每模块两空格加完整背景色的实心码，不依赖块字符字形。当前96×36窗口不足以完整显示时明确提示所需列/行数，不裁剪。其他终端保留背景填充的紧凑模式，S可切换；不保证任意字体紧凑码可扫描。

新增分享面板P与/cafe qr：主动操作后打开本机静态高清SVG预览，无需本机网页登录，无脚本/外部资源，不向二维码服务发送链接。预览编码仍是原房间URL，不含密码；临时目录0700、文件0600，15分钟或扩展停止时清理。启动不会自动开浏览器，SSH明确提示不能打开手边设备浏览器。C复制和B房间管理保持。

验证：真实ANSI前景/背景栅格及权限/布局共13项通过，含旧字体断裂复现和实心码在相同行距下可解码。实际Chrome生成的SVG区域PNG截图，在1100×900、390×844、320×568三个视口均经独立jsQR解为准确链接，外部请求0，报告`.refactor/reports/cafe-qr-preview-pixels-20261003/result.json`。这不是直接读取SVG路径或源矩阵，也不冒充物理手机相机验收。真实Pi0.99.1的Apple模式＋HTTP代理伪终端8组通过，报告`.refactor/reports/cafe-qr-native-final-20261003/result.json`。整个扩展537项、类型检查和三平台打包通过，模型请求0。

已安装登记`~/.local/share/pi-cafe-space/0.1.0-cafe-qr-fix-20261003`，旧proxy-fix目录保留。当前Pi应Esc返回、空闲时/reload，随后/cafe qr，或/cafe share按P。安装前后逐字节摘要核对房间身份、凭据、代理shell配置和LaunchAgent不变；后端二进制一致，网关/云端未重启、没有修改房间key或密码。最新41文件归档`.refactor/release/pack-9gIjlg/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `a8a26eb4eb93dc24d4d009b8effd8585795d798998378e6a8fa63ae7bd6c5a9b`。

### 扫码之后的connection lost不是二维码识别问题

用户本轮另补充手机扫码后持续connection lost。询问失败阶段、浏览器和Wi-Fi/蜂窝后问题超时，未取得答案；没有据此猜测。只读检查云端/TURN容器运行，近15分钟无TURN日志；这不能证明手机P2P成功或确定故障原因。也核对上层已有30秒远端握手预算，不能套用“仍是5秒本机超时”解释。没有改变网络、TURN、认证或重试逻辑，手机连接丢失仍未定位，本次二维码修复不宣称解决它。

## 历史修复：Pi全局代理导致/cafe误报网关不可读

用户在真实Pi中看到“暂时无法读取本机网关”。现场只读检查：网关运行，/api/config与认证后的/api/room/terminal均200，房间在线，最初检查时已有一个Pi连接。用户shell配置了http_proxy/https_proxy，已安装Pi启动代码会设置全局代理dispatcher并替换fetch；扩展此前直接使用全局fetch，因此本机状态查询受到代理影响。没有读取或输出用户代理凭据、模型密钥或会话正文。

`cafe-terminal-test.py --proxy-regression`在全新临时房间和真实Pi0.99.1中复现完全相同提示，旧版退出1，代理接到请求。修复后/cafe这两项本机HTTP查询使用独立node:http Agent，只连接数值loopback（localhost固定到127.0.0.1），不使用全局fetch、不改全局代理、不跟随重定向；保留认证、3.5秒期限、8KiB响应与头部限制、取消和严格JSON。界面分别显示连接拒绝、超时、响应异常和鉴权失败，而非一律提示网关未启动。

最终7组真实带代理Pi检查全部通过，报告`.refactor/reports/cafe-proxy-scoped-20261003/result.json`；包括在线菜单、二维码、SSH复制说明、reload和原生新会话。/cafe菜单、分享、复制/返回阶段代理请求0。测试同时记录Pi其他启动/reload/新会话阶段仍有4次旧健康探测经过代理；没有把它们隐藏，也没有声称所有Pi网络都被改写。首次修复后测试的全局计数断言因此过宽，后改为按阶段归因，所有原UI/会话断言保留。

新增真实HTTP回归13项（全局fetch替换、localhost、拒绝重定向转发凭据、内容类型/大小/截断、401/403、拒绝连接、超时、取消、非本机地址）；完整主包17文件531项通过，类型检查与打包通过。此前无代理终端测试确实漏掉此场景。本次不改变Go网关、网页或云端配置，不宣称修复此前公网浏览器导航超时。

新扩展安装并登记在`~/.local/share/pi-cafe-space/0.1.0-cafe-proxy-fix-20261003`。旧目录保留供已运行网关继续使用，LaunchAgent未变、网关未重启、用户Pi未被强制重载。安装前后比较房间身份、本机凭据、房间配置、服务文件、.zshrc/.zshenv摘要均不变。后端二进制与前一版完全相同。当前用户需Esc退出面板，空闲时/reload，再/cafe share。

最新41文件归档`.refactor/release/pack-psy2VK/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `5bdd7899ea91925cc42e21fe80fcf7aea41a49d4b3c476e0e1e843dd5180fe3f`。下文旧发布路径和测试为历史记录。

## 当前使用方式

新启动Pi后输入 `/cafe`；已有Pi可在空闲时 `/reload` 再使用。`/cafe share`直接打开终端分享，C复制链接、B网页管理、R刷新、Q二维码、Esc返回。初次显示完整非阻塞引导，之后简短提示；不会在启动/重连时自动打开浏览器。多Pi共用同一网关的引导标记和房间身份。状态明确本机连接、房间登记与当前Pi成员情况。

终端二维码按实际URL生成并保留静区，空间不足不裁剪，显示放大/网页替代方式。分享链接仅在主动分享时获取，不含密码。SSH不冒充已经复制到手边设备剪贴板，也不自动打开远端图形浏览器。网页直达 `/#/rooms/main?panel=share` 保留登录意图，登录后自动打开分享抽屉。`/cafe`不出现在远端可调用命令列表。

普通Pi“新建会话”和`/new`使用原生会话上下文，要求空闲、实例控制权与确认。侧栏“新实例”另起Pi进程；固定会话的受管Pi使用“新实例”，不再显示注定失败的当前会话切换。取消不会发送任务或创建进程。

## 独立实例的明确权限边界

代码已支持房主在房间配置中明确开启 `roomManagement:true`，并向room-run传入私有 `--managed-config`。管理器必须有明确项目列表与真实Pi/Node/扩展路径。密码认证后的operator可在批准项目中创建/打开，不得到关闭他人实例、强抢控制、修改房间密码/key的权限。

**当前生产房间仍为roomManagement=false。** 真实项目目录选择尚未得到用户答复；此前问题超时不构成授权。隔离测试的批准目录只属于测试夹具，不能据此开放用户HOME或dev。工作目录白名单不是OS沙箱，Pi工具仍按本机账户和原工具策略执行。

真实验收发现旧管理器要求强随机client密钥，与6–20位用户自选本机令牌冲突。先用测试复现，再将兼容条件限定为loopback、独立强随机host密钥、合法本机令牌和绝对房间配置；服务创建Hub/Manager之前再次核验真实device房间身份以及roomManagement已开启。仅填一个远程配置路径或旧设备模式不能绕过。无关管理模式原强密钥规则保持。

## 执行证据

| 检查 | 结果和范围 |
| --- | --- |
| 主包测试 | 本轮实现阶段16文件518项通过，含7项终端渲染/独立二维码解码；远端/cafe禁用另经现有生命周期7项回归通过 |
| 最终Web与类型检查 | 主包/Web TypeScript noEmit、32文件156项Web测试、go vet及git diff --check退出0 |
| Go测试与并发 | 原房间相关Hub/remote/service race通过；管理能力边界race通过；本次新增配置/服务准入回归由失败转通过；最终生产标签构建11包通过 |
| 原生Pi终端 | `.refactor/reports/cafe-native-full-20261003/result.json` 6组通过：提示、状态面板、二维码、SSH复制提示、reload及两个原生Pi中的目标新建会话/另一实例不变；无回执操作重启后找回退出0，没有重放 |
| 本机真实浏览器 | `.refactor/reports/cafe-room-browser-resumed-20261003/result.json` 10组通过：登录直达、复制/QR、密码门禁、2访客2合成Pi、单次合成任务、确认新会话、320/390布局、密码变更、重置、重启 |
| 房间创建真实Pi | `.refactor/reports/cafe-managed-browser-runtime-20261003/result.json` 4组通过，浏览器经WebRTC创建2个实际Pi0.99.1；第一实例不变，权限未扩大，取消无副作用；全部在临时批准项目 |
| 最终安装工具单元检查 | 6项通过，包含命令help、Origin/IPv4输入、服务参数边界、拒绝覆盖已有安装以及房间配置保护 |
| 安装集成 | `.refactor/reports/cafe-install-final-20261003/result.json` 4组通过，实际安装/首启/升级保存身份/自托管模板；未激活测试系统服务 |
| 发行与源码重建 | candidate/source-build共6项通过，0skip：精确清单、平台/摘要、未知文件保留、独立二进制、生产标签拒绝stub、隔离完整源码构建 |

以上原生和浏览器测试provider请求均为0；合成prompt不冒充真实模型推理。

### 公开站点验收

已安装版本的 `.refactor/reports/cafe-public-installed-20261003/result.json` 完成前8组，但在“重置链接”阶段访问公开页面触发35秒导航超时，故该整轮退出1，不能写成全通过。已通过项目包括公开首页、登录直达、独立二维码解码、错误密码门禁、多人WebRTC、当前Pi新会话、窄屏及密码变更。没有页面脚本异常记录。

随后以相同已安装程序、新临时房间复验，`.refactor/reports/cafe-public-final-recheck-20261003/result.json`已确认退出1：前9组通过，包括重置链接后旧链接不可用、新链接仍可认证；最后“重启”阶段再次在公开页面导航触发35秒超时，整轮没有通过。该轮所有临时资源已结束，无运行中的测试操作。没有继续无界重试或为了凑通过而改大超时。

最后只读检查本机及公开站点的`/healthz`、`/api/config`和`/`均返回HTTP200，公开响应约254–1028毫秒。因此不能据此说服务一直离线，也不能据此排除浏览器导航问题；超时的网络/浏览器具体原因仍未定位。公开重启后重连仍列为未验收通过，不能把本机10组通过替代它。公开信令测试中浏览器和临时办公端仍在同一Mac，不是手机蜂窝、异网强制TURN或长时间锁屏测试。TURN/TLS5349、Windows原生服务和独立安全审计不在已验收范围内。

## 实际安装与部署

Mac版本 `/Users/example-user/.local/share/pi-cafe-space/0.1.0-cafe-terminal-20261003` 已安装并登记，旧扩展登记移除但旧文件保留。LaunchAgent `com.cafecodework.pi-cafe-relay` 已重载到新room-run；不是只改源码。没有结束用户Pi或强制其reload。安装前后对原本机凭据、room-device配置和身份文件逐字节摘要比较一致。

LaunchAgent SHA-256 `73a93e643987dd2762a4a144af7ba8e140ce1e83d47d827a2e711e1ae2050fb5`；旧服务文件备份在 `~/.local/share/pi-cafe-space/deploy-space-20261003/before-cafe-terminal.plist`。原状态路径 `~/.config/pi-cafe-space/rooms-space` 和 `credentials-37891.json`保持。

服务器镜像 `pi-cafe-space-cloud:0.1.0-cafe-terminal-20261003` 已运行，版本目录 `/srv/cafe-example/pi-cafe-space/releases/cafe-terminal-20261003`。先比较旧配置摘要、新二进制和临时端口冒烟，再仅重建cloud；Caddy配置/启动时间及TURN启动时间保持。cloud配置SHA-256仍为 `a4e2f01142a3451608b15961dee65055718890715e59717ddfa4f64673d07fb9`，Compose新SHA-256 `54697565ee0f344588f41004f01e6c92684158f9a6ae7c8a33fac6f4bdb78954`。服务器回执 `cafe-terminal-deployment.json`、备份 `backups/before-cafe-terminal-20261003`。

安装后实际只读检查确认：受管网关运行、终端接口可认证访问、房间已登记在线、本机和公开页均返回 `assets/index-CnILNDwY.js`。检查时0个生产Pi连接不代表P2P失败，应启动Pi或在已有Pi空闲时reload再分享。

## 最终可交付包

`.refactor/release/pack-zsh7ue/cafecodework-pi-cafe-space-0.1.0.tgz`：41文件、43,526,173字节，含darwin-arm64/linux-amd64/windows-amd64。SHA-256：`335e2d73ed48e329e38dc36843579607cfd3af99e1db7b5eae63ebbf2db83a6f`。

Mac二进制 `a44aa9743de8a0cf8a0f53d47793ecfef1003cc420d0cf49a42d5ade9b622dc7`，Linux `1661c6a96f09eaf2bea92c5db73228765fa435341d49c686adaf17e6b5f141be`，Web摘要 `9833b89cdb5bf2be9bab5ab7d7625bd36467d34f6cd6378549d34e32f13f7c41`。归档完整SHA、所有交付业务文件/脚本与已安装版本字节一致；build.json仅构建时间戳不同，平台二进制摘要与版本一致。终端二维码依赖内联且包含许可证，不额外要求全局安装。

INSTALL.md、AI_INSTALL.md及安装器next提示都以/cafe为主入口，不再只给本地端口，也不让升级用户重设密码。代码和文档尚未commit/push，未发布npm/GitHub远端release。未修订用户模型/provider配置，也未扩大操作系统权限。
