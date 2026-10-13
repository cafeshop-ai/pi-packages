# 房间链接、二维码与安装引导验收

2026-10-03，基于 main@3987e9c 的未提交工作树。本轮保留此前实现和用户改动，完成新的公共房间访问模型，不再以云端账号/设备目录作为访客入口。

## 当前修订：/cafe终端入口与会话操作

当前运行版本为`0.1.0-cafe-terminal-20261003`，Mac网关及Pi登记、云端cloud已更新。`/cafe`和`/cafe share`提供原生终端分享，`/cafe open`登录后直达网页分享。普通Pi新建会话与独立实例启动已分开。真实Pi终端6组、真实浏览器本机10组、独立实例真实Pi4组、安装集成4组、发行与隔离源码重建6项通过；最新Web156项和类型检查通过。详细证据、公开站点验收的实际范围及尚未授权的生产实例目录见[CAFE_TERMINAL_ACCEPTANCE.md](CAFE_TERMINAL_ACCEPTANCE.md)。

最新41文件归档`.refactor/release/pack-zsh7ue/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `335e2d73ed48e329e38dc36843579607cfd3af99e1db7b5eae63ebbf2db83a6f`。原身份与凭据未重置；当前房间实例创建能力仍默认关闭，不能把临时批准项目的验收当作生产目录授权。

## 历史修订：权限与体验复核

按用户追加要求完成定向架构/权限复核，详见 `../ROOM_REVIEW.md`。两项问题均先复现再修复：非WebSocket请求消耗全站房间连接预算；密码已发送后的信令异常仍显示“未发送密码”。新实现按已存在房间计数、无效HTTP不消耗预算、错误提示按连接阶段区分；分享入口增加首次密码来源和访客可以申请控制Pi的提示。

复核后网页156项通过，remote/service race及go vet通过，三平台构建和11个Go包通过。本轮原协议/扩展511项、安装工具6项、安装集成4组、发行/源码重建6项等前序验证保留；未为此次无关修改伪造重复运行结果。最新公开站点临时房间测试 `.refactor/reports/room-public-reviewed-20261003/result.json` 已全部8组通过，退出0：真实公共网页/信令、独立二维码解码、错误密码门禁、两访客/两合成Pi、一次受控合成任务、窄屏、密码修改、链接重置及重启。provider请求0；浏览器与临时办公端仍在同一Mac，不冒充手机蜂窝或异网强制TURN验收。

当前本机安装 `/Users/example-user/.local/share/pi-cafe-space/0.1.0-rooms-reviewed-20261003`，受管服务已重载且Pi包登记仅指向新版本。房间状态目录、本机登录令牌和Pi进程保持。当前云端镜像为 `pi-cafe-space-cloud:0.1.0-rooms-reviewed-20261003`，只重建cloud，原cloud配置与Caddy字节、TURN启动时间不变。

最新归档 `.refactor/release/pack-C3K5RL/cafecodework-pi-cafe-space-0.1.0.tgz`，43,412,799字节、37文件。SHA-256 `5d5359acfaa2cca4ba38c1b2c88517685bcfbe358ce1fc2f3fd9575ab302dba8`。Mac二进制 `1b41b92edcf3165ffc2940d2de10ccaa450c6bcba2fb78088e4518c1bbbd288f`；Linux `d6fdfd8f9e449127f337f8570dbc31e3f7f9ace44654511298521996204aee8b`；Web摘要 `66a8d49b52316416cbbf6366eafa609d7214848ee26d1ddb39cdde4988494a5c`。实际归档摘要、安装字节、运行路径与本机/公网 `index-SJV32FT8.js` 均已核对。

以下保留本轮前序房间功能和安装工具验收，旧归档路径不再是最新推荐交付物。

## 已交付行为

公共主页粘贴房间链接/key；本机工作台“分享房间”提供同一URL的复制和二维码。访客打开链接后输入6–20位密码，验证通过才进入房间并看到Pi实例/会话。二维码不含密码。房间对应一个办公网关，当前范围main，访客operator并保留按实例控制租约。

房主身份是稳定P-256密钥，公开roomKey用于URL。注册挑战以及会话、访客随机数、offer/answer摘要使用签名绑定。浏览器验证URL公钥后才通过WebRTC DataChannel发密码；密码正确之前不创建业务Hub连接。不静默回退到云端业务WSS。TURN仍可中继端点加密连接。网页JavaScript和本机OS账户仍是信任边界，未做独立密码协议安全审计。

房间密码使用随机盐与PBKDF2-HMAC-SHA256校验值私有落盘，限制每连接一次尝试、房间每分钟12次检查。修改密码不改URL；重置链接不改密码；两种操作均撤销现有访客但不停止Pi。首次迁移沿用已有本机登录令牌为房间密码，后续独立修改。

## 已执行验证

| 验证 | 实际结果 |
| --- | --- |
| 主包与Web TypeScript检查 | 退出0 |
| 主Pi扩展/协议Vitest | 15文件，511项通过 |
| 最终Web Vitest | 32文件，155项通过；含签名篡改、重放、密码不进信令、认证前拒绝数据及有限ICE收集 |
| Go完整构建测试 | 11包通过 |
| Go race | remote/service通过；新房间测试包含真实Pion直连与强制TURN并检查relay候选 |
| Go静态检查 | go vet通过（初版房间完整实现时）；后续ICE收集修复重新通过Go测试与race |
| 安装工具单元测试 | 6项通过；不启用系统服务 |
| 隔离真实Chrome房间流程 | 8组通过；真实WebCrypto/DataChannel，独立jsQR解码，两个合成Pi、两个访客，一次合成prompt，真实provider请求0 |
| 最终公共站点临时房间验收 | 8组通过，退出0；实际space.cafecode.work信令、Chrome与新临时办公房间，两访客/两合成Pi，1次合成prompt，provider请求0 |
| 隔离安装集成 | 4组通过；真实复制安装、用户首次设令牌后自动切入房间、版本化升级保留身份、两种自托管模板生成 |
| 自托管Compose模板 | 已在实际服务器Docker Compose中只校验schema，退出0；未启动该测试模板 |
| 最终发行回归/隔离源码重建 | 6项通过，0 skip，退出0；验证旧Go摘要拒绝、未知文件保留、自带静态资源和隔离源码build/check/test |

房间真实浏览器记录：`.refactor/reports/room-browser-installed-20261003/result.json`，同目录含桌面和320/390px分享截图。独立二维码解码值与复制URL完全一致；改密码、重置链接和重启场景均已验证。它们使用临时身份和合成Pi，不涉及用户真实聊天。

安装集成记录：`.refactor/reports/install-integration-20261003/result.json`。测试使用独立临时prefix/state，不登记全局Pi、不修改系统服务。实际最终Mac安装另经install-client --reuse-state --register-pi完成，并已单独切换受管LaunchAgent。

公网临时房间最终测试已经通过全部8组，原操作退出0。结果为 `.refactor/reports/room-public-final-20261003/result.json`：公共首页无账号/设备发现、真实二维码解码与复制URL一致、错误密码无实例泄漏、两访客通过签名WebRTC看到两Pi、一次受控合成任务、窄屏布局、改密码保留URL、重置链接失效及网关重启身份保持。此前无回应STUN导致的收集超时已修复为在有候选时继续签名握手，空候选仍失败。测试的信令确实经过公开站点，但浏览器和临时办公端位于同一Mac；不把它描述为跨运营商手机/异网强制TURN验收。

## 安装与部署

当前稳定Mac安装：`/Users/example-user/.local/share/pi-cafe-space/0.1.0-rooms-install-20261003`。当前房间配置：`~/.config/pi-cafe-space/rooms-space/room-device.json`；身份在同目录identity/room.json。本机登录文件仍为 `~/.config/pi-cafe-space/credentials-37891.json`，未重置或复制到云端。

已更新Pi包登记，旧安装目录保留。LaunchAgent `com.cafecodework.pi-cafe-relay` 已启用新room-run路径。没有终止Pi进程或更改provider/API key。最终doctor报告cloud.roomAccess=true、local.roomShare=true、配置匹配、身份文件私有存在；它显式标注health检查不能证明实际P2P。

服务器镜像 `pi-cafe-space-cloud:0.1.0-rooms-install-20261003` 已运行，目录 `/srv/cafe-example/pi-cafe-space/releases/rooms-install-20261003`。仅重建本项目cloud服务，Caddy与TURN的配置/启动时间保持。旧账号设备目录路径404，公共房间模式启用。旧云端login.txt密钥不再用于新的访客入口。

## 可交付归档

`.refactor/release/pack-w7Kcwf/cafecodework-pi-cafe-space-0.1.0.tgz`，43,412,367字节，37项文件，包含darwin-arm64/linux-amd64/windows-amd64。

SHA-256：`8f22ef021d8b61b1d0ca820af3e748851776bf416347f22c62ca5f4c11927d91`。

Mac二进制：`063cd23e956045cf123b163ab3e7623263dfbc14ec269a38478f2dd37ca68ddc`；Linux：`0af74b41afbf9410907a0f209e2012f4b332332d22f15363936e70d3f90d9b4b`；Web摘要：`da8ec94d2553df7decd736c1e211ab1ebd94b29f58bd2fed3560e4bfad43d7fd`。归档、安装二进制和运行版本均已核对。

归档根目录有INSTALL.md、AI_INSTALL.md；安装脚本包括install-client、configure-server、doctor、room-bootstrap、room-setup、room-run。可选择既有公共服务或自己的Docker服务。默认不全局安装Pi、不改模型、不启用服务；相应操作有明确开关和现有服务/目录保护。生成自托管配置不代表已部署。

## 未覆盖及不承诺

未做真实手机蜂窝/锁屏测试、独立密码协议审计、Linux用户systemd登录场景或Windows计划任务验收。Windows程序仅交叉编译，Windows安装器生成前台PowerShell脚本；不宣称后台服务已实现。TURN/TLS5349仍未配置，之前Mac公网UDP路径经过隧道且超时；不修改用户VPN或承诺任意网络直连。

本轮将直接HTTP依赖axios升级到1.20.0解决审计报告的对应问题，但工作区仍存在其它开发工具/依赖审计项，未执行全局强制升级，也不声明依赖零漏洞。

尚未commit、push或发布npm/GitHub release。请把实际归档和经过可信渠道确认的摘要一起交给其他用户的AI，不使用猜测的下载URL。
