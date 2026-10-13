# 手机输入密码后 connection lost：诊断与修订

2026-10-03。用户确认手机能打开房间网页，但输入密码后持续connection lost。手机具体浏览器、网络类型和失败耗时尚未收到答复；不能据此断言是密码、手机、VPN或TURN服务器故障。此次未重置密码/房间key、未修改用户代理、未开放新的项目目录。

## 用户结果确认与后续范围

在dc-ready-fix办公端启用后，用户明确反馈“连上了”。后续关注点为控制权是否必要、手机布局、思考/工具diff显示和重连警告，已在[MOBILE_UX.md](../MOBILE_UX.md)记录并交付。新的手机公共界面和低噪声Pi扩展为mobile-ux版，办公端继续运行已连通的dc-ready-fix，没有再次重启或调整握手。用户确认实际连通，并不代表所有历史网络和所有设备条件都已独立验收；下面的失败记录与修复依据保留。

## 已启用实质修复：客户端open先于办公端ready的传输选择竞争

用户随后复制的完整报告显示：stage=transport、channelOpened=true、ICE/Peer connected，11.170秒data-error、DTLS/SCTP closed。channelOpened=true证明浏览器实际触发过通道open；不能再概括成“一直没建立SCTP”。此阶段尚未收到selected，排查收敛到数据通道打开之后的选择与关闭路径。

源码确认：当前pion/datachannel v1.6.3在Server中先writeDataChannelAck，再返回给pion/webrtc v4.2.22；后者先执行OnDataChannel回调，随后handleOpen才设置接收侧ReadyState=Open。因此浏览器已经open但办公端仍在接收回调/尚未注册通道是合法顺序。旧remoteSession.selectTransport把这个窗口的!rtc.ready()直接返回错误；readRoomLink随即Close整个会话，能造成客户端刚open即断开。该缺陷在应用代码，不需要修改TURN、DTLS或SCTP参数。

新增`relay/internal/remote/rtc_selection_race_test.go`使用真实Pion、真实本机信令与临时房间，在办公端接收回调的“登记前”和“本端open前”设置受控测试屏障。确认客户端已经ReadyStateOpen而office.ready=false，再沿真实WebSocket发送select。旧代码两组均复现主动关闭，原回执operation_k1mTEHhR0MkXJiYhNsDtJkh2退出1。测试屏障是人为稳定触发调度顺序，并非捕获了这部iPhone的原始时序；仍不能在实机确认前断言这是其唯一原因。

修复后有效select只保存pendingSelection意图，本机OnOpen再事件驱动完成选择。没有sleep补丁、没有堵塞共享信令读取，没有提前开放消息或加入Hub；仍只允许一次选择，重复请求/降级到relay被拒绝，30秒握手期限与5秒认证期限保持。通道已ready后才排队发送selected并启动写入，随后仍须验证原房间密码。

回归：上述两组顺序带race重复5轮通过；新增重复选择、禁止降级、原过期规则、禁止待选择时业务输入断言后，remote/service完整race测试通过（remote 71.262秒、service 3.242秒），go vet和git diff --check通过。测试还验证第二个访客在第一条连接等待本地ready时仍可完成认证，待屏障释放后原连接完成room.authenticated、welcome和两个Pi实例同步。打包时全部Go包测试通过。

真实公开网页＋新临时办公端也通过：`.refactor/reports/dc-ready-public-20261004/result.json`，正常auto模式，6.149秒DataChannel open并发select、6.633秒selected、6.725秒room.authenticated、6.727秒welcome，后续5秒仍connected。此浏览器与临时办公端在同一Mac，不能冒充手机或异网TURN验收；提供的是实际程序连接回归，竞争触发证据来自上面的受控Pion测试。provider请求0。原有生产认证诊断读取的安全阻断没有重试或绕过。

已安装并启用Mac`~/.local/share/pi-cafe-space/0.1.0-dc-ready-fix-20261004`，实际LaunchAgent运行路径、安装二进制与健康接口已核对。安装前后原room identity、credentials、room-device文件摘要相同；未结束用户Pi，只重载网关。旧服务备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-dc-ready-fix.plist`，新plist SHA `414ab150bff4825ee7c45089f5bf93d8b9a6c98b6ce813e7142b33e043a30e7d`。当前网页/扩展业务代码未改，手机不需要重新安装、改密码或切换代理，使用原页面重新连接即可。

本轮没有部署cloud、Caddy或TURN。它们继续使用sctp-observe网页`assets/index-5Ug4D_9U.js`；Web摘要仍`faef90819343ecdb812ebdba810feeb598a7040353642a7d44ce8bdd1412ac3e`。最新41文件包`.refactor/release/pack-jGmxZH/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA `67e1e778546f96c94ee6289b08abd908b254d15b11ab9ccc243c209c96b91e9f`，Mac binary `2af0e0103d466dbb542dc7db66252eae7325d2751fc0500ee45a6501df931093`。未commit/push或发布远端release。该可复现缺陷已修复，物理手机最终成功仍待用户重连确认。

## 前序实机反馈与诊断复制（2026-10-04本地时间）

用户提供了实际手机两种模式的结果，均为ROOM_SCTP_FAILED：TURN/TCP在14.4秒data-error，自动在12.9秒data-error；两者ICE connected、DTLS closed、SCTP closed、DataChannel closing、RTC sctp-failure、双方relay true，均未给出SCTP cause code。因此已经知道兼容开关未解决这部手机的问题，不应再次让用户重复切换模式。DTLS在错误发生时已closed，不能仅因SCTP错误就宣称加密握手曾成功，更不能归因密码错误。

用户另明确要求手机一键复制日志。本轮已上线“复制诊断日志”，在连接信息区域无需逐行选择。只在用户点击时调用剪贴板；成功显示确认，浏览器拒绝则显示可长按复制的只读文本，不能虚报成功。报告为cafe-room-diagnostic-v1，白名单输出状态、阶段、策略、耗时、标准错误号；不含密码、房间URL/key、IP、会话内容、原始错误文本或完整浏览器UA。不序列化整个应用状态。

为查明办公端先关闭还是收到对端终止，新增仅办公端内存的握手记录：最多24次连接，每次32条枚举事件，5分钟过期并由原维护定时器清理。记录ICE/Peer/DTLS、SCTP error/close、DataChannel收到/打开/关闭、政策拒绝、选择传输以及应用首次Close的固定类别；Pion日志只映射限定类别，丢弃原始消息。通过现有/api/room/terminal的diagnostics操作读取，保持POST、loopback、无Origin、host密钥、main房间等原有保护，公共网页/访客不能读。未改DTLS/SCTP协议选项、未更新依赖、未降低身份/密码门禁。

本次验证：188项Web测试及类型检查通过，包含复制成功/失败反馈和敏感字段污染测试；4项新增Go诊断测试在race下通过，涵盖容量、清理、并发、访问权限以及真实临时房间握手仍成功。构建时全部Go包测试通过，三平台打包完成。公开网页资源已核对包含复制按钮；生产网关无认证健康接口正常、进程元数据仅一个网关且路径为观察版。没有宣称物理手机连接成功。

**当前阻塞**：尝试在Node进程中用已有host凭据调用生产本机diagnostics接口时，被OpenAI工具安全检查拦截，没有操作回执，未换文件/浏览器/代理等路径绕过。故没有取得这次手机故障对应的办公端握手记录，也没有确定关闭根因。已完成的是诊断能力和复制体验，不是SCTP连接修复。此前手机两份详情已收到，不需要再手抄相同字段。不得把隔离测试的诊断读取通过替代生产读取成功。

当前本机网关/Pi登记`~/.local/share/pi-cafe-space/0.1.0-sctp-observe-20261004`，原identity/credentials/room-device摘要安装前后不变；仅重载网关，用户Pi未结束。旧LaunchAgent备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-sctp-observe.plist`，新SHA `2e35b01e8c2759ac85bb2524803e53c5116686f7c2e4e83cfc971d002f4ca814`。网关进程实测唯一且健康。

cloud镜像`pi-cafe-space-cloud:0.1.0-sctp-observe-20261004`，实际asset`assets/index-5Ug4D_9U.js`；仅重建cloud，Caddy/TURN字节及启动时间不变。Compose SHA `3c8bcb1f8f60a9df1d8be48737519ef0c3bf04445d5b65a4fa8b05e3bf4feaa4`，回执`sctp-observe-deployment.json`，回退`backups/before-sctp-observe-20261004`。没有把本机诊断上传到cloud。

交付包`.refactor/release/pack-mqy2jV/cafecodework-pi-cafe-space-0.1.0.tgz`，41文件，SHA `95dc1fc01cd590a440be645a41081f09793a758de49a8a61020443310bdf96eb`；Mac binary `990b9c3ebb20f6cb7c982835d2a0f3ccf9fc915c67f9a4fa42f6c46b9d4b1591`，Linux `42a4884a0df07b98de3b215f9a141d56b74b5a496fe33806378658ca4fc9ce47`，Web摘要`faef90819343ecdb812ebdba810feeb598a7040353642a7d44ce8bdd1412ac3e`。未commit/push或发布远端release。

## 前序修订：加密通道断开与兼容连接（2026-10-04本地时间）

最新iPhone截图显示ROOM_CONNECTION_LOST，最后阶段为建立加密连接，双方relay候选为true。按当时实现，此时身份签名已验证，尚未收到selected或发送房间密码；但仅有中继候选不证明ICE连通、DTLS完成或SCTP就绪。截图顶栏的“认证失败”来自RoomSocket把全部预验证失败都注入UNAUTHORIZED，这是已确认的错误归类，不是办公端判定密码错误。

本次前端改动：只有实际room.denied才触发认证失败。传输关闭/超时保存清理前的ICE、PeerConnection、DTLS、SCTP、DataChannel状态、触发事件及耗时；RTCErrors只保留标准errorDetail、有限数值SCTP cause/DTLS alert，不记录错误正文、地址、SDP或密码。监听器在清理前移除，避免close()自己覆盖故障快照。

新增明确的“兼容连接（强制中继）”复选框，默认关闭；用户选择时浏览器仅使用服务已提供的TURN/TCP地址和relay-only策略，没有自行新增代理服务器、没有静默降级到云端业务WSS、也没有降低签名或密码门禁。缺少TCP中继时明确失败。它是已验证的替代路径，不代表已查明用户手机断开的唯一原因。

### 本轮真实WebKit与回归

创建了非持久化系统WKWebView完整房间探测，而非仅测试WebSocket。第一轮未附着窗口的视图只到offer便停滞超时，记录transport-webkit-before-20261004；这是不充分测试夹具，未当作手机故障复现。附着独立非激活测试窗口后，当前旧生产版默认路径完成ICE/DTLS/SCTP、密码认证和welcome，约8.5秒；强制TURN/TCP路径offer为0host/1relay，约11秒完成。报告分别为`.refactor/reports/transport-webkit-window-before-20261004/result.json`与`transport-webkit-relay-before-20261004/result.json`。因此没有在该系统版本复现手机的准确失败，不能据此说手机已经修好。

新代码的182项完整Web回归及额外1项真实页面开关单元测试通过，Web类型检查和三平台打包通过。网络关闭不注入UNAUTHORIZED、真实密码拒绝仍拦截、标准诊断脱敏及只用已配TCP中继都有断言。本机真实Chrome原10组完整房间验收通过：报告`.refactor/reports/transport-recovery-local-20261004/result.json`。

部署后系统WebKit实际点击新兼容开关，offer确实0host/1relay、ICE connected，但首轮在DTLS connecting后事件停滞到测试deadline，报告`.refactor/reports/transport-compatible-public-20261004/result.json`退出1。没有删除或算作通过。已对独立测试运行器增加有界防App Nap活动和可见性诊断，第二次`transport-compatible-webkit-liveness-20261004/result.json`仍退出1：deadline时document.visibilityState为hidden，PC/DTLS closed，SCTP connecting。仅观察到页面hidden，不能直接宣称它导致全部失败，也不能当作用户手机前台故障的同一原因。没有继续反复打开测试窗口。

最后无窗口Chrome直接点击公开网页的“兼容连接”开关，测试注入不强制任何策略，实际应用生成relay-only，offer为0host/1relay；约10.1秒收到room.authenticated，10.9秒收到welcome，观察5秒后仍connected，getStats显示nominated=true的relay→relay候选对和双向字节。报告`.refactor/reports/transport-compatible-chromium-public-20261004/result.json`退出0。候选protocol为UDP并不表示浏览器到TURN的分配连接不是TCP：网页配置仅提供TURN/TCP URL，中继至peer这一段仍使用原WebRTC机制；未宣称端到端每一跳都是TCP。该结果证明新UI接线与中继路径在这个运行时有效，不能替代用户iPhone验证。所有测试provider请求0，临时资源已清理。

### 实际发布状态

本轮只更新公共站点cloud，镜像`pi-cafe-space-cloud:0.1.0-transport-recovery-20261004`，实际资源`assets/index-DzbJT9ym.js`。服务器版本目录`releases/transport-recovery-20261004`，回执`transport-recovery-deployment.json`；Compose SHA-256 `a6450a696c5a51a419804490fce1fd099d7edfc65cadfd85998b1482dddcc11c`，回退`backups/before-transport-recovery-20261004`。保留原cloud配置、精确本站WSS CSP、Caddy/TURN配置和启动时间。

办公端协议没改，不需要为了网页新选项重启网关或Pi；本机继续运行`0.1.0-signal-init-20261003`，LaunchAgent SHA仍`c79d72f288f30876fb7536505287a2535a08fb7b3defc580daf32ded7d461a0b`。已只读确认房间在线且一个Pi连接。原房间key、密码、代理、模型配置不变。本机localhost页面仍是上一版，手机公共页面才是本次更新入口。

可交付包`.refactor/release/pack-vXuAZf/cafecodework-pi-cafe-space-0.1.0.tgz`，41文件，SHA-256 `625d9cd00106a3df00603f1f9566069bf538772f619be3692fdc3db09970e3eb`；Linux binary SHA `4b96209e71c5162c8aaf21019a6e5482db18a8ced5e1ee96fe3d851c5fbb65bc`、Mac `69b4da7368e74d8ce6fb00daa5967633e2a1fef392f95b5ca33c49e4b3ac3749`，Web摘要`7721c11c5bdd02cf0ddb50908c5e7de5f8815b4a69ef456aef51924f4ffbe98a`。未commit/push或发布远端release，没有实际provider请求。

## 前序截图：ROOM_SIGNAL_START_FAILED，初始化尚未完成

用户随后提供iPhone截图，错误为ROOM_SIGNAL_START_FAILED、停在信令阶段，尚无双方relay候选。该版本会把随机数、Origin、WebSocket及其他构造异常统归此码，所以截图不能证明密码错误、TURN损坏或用户拦截网络。原界面“检查是否拦截WebSocket”归因过早，本轮已改成中性提示。

现场读取公开HTML响应，CSP仅有`connect-src 'self'`，没有显式`wss://space.cafecode.work`。MDN文档明确指出某些浏览器不把self映射到WebSocket scheme；WebKit历史issue201591/235873也记录过此差异。但本机当前系统WKWebView在旧策略下已能打开公开WSS，因此这是已确认的兼容隐患，不是已证实在这部手机上的唯一根因，不能以旧WebKit问题断言所有现代iOS均受影响。

修订：公共HTML现在输出`connect-src 'self' wss://space.cafecode.work`，只追加受验证的PublicOrigin对应精确源，保留script/object/frame等限制；不使用`*`、`ws:`或`wss:`全协议许可，不信任任意Host或X-Forwarded头。独立本机页面仅追加字面loopback的精确ws源。后端Origin鉴权、房间签名和密码门禁未放宽。

同时将初始化分为runtime/random/credentials/origin/websocket；只有WebSocket真正抛出SecurityError才显示ROOM_SIGNAL_POLICY_DENIED，随机数失败为ROOM_RANDOM_UNAVAILABLE，其他错误保留相应步骤。连接详情显示固定步骤和白名单标准异常名称；不记录原始异常消息、堆栈、URL、密码或私钥。已有停止初次无限重试逻辑保留。

验证：176项Web测试、前端类型检查、HTTP/service race和vet通过，三平台包构建通过。实际HTTP策略测试先失败（缺精确WSS）后通过；恶意源、凭据、路径、查询、通配符、代理头等拒绝/保持原策略。系统WebKit三组独立对照全部通过：禁止策略和只许可另一端口时同步SecurityError、连接没有到达服务器；精确本机地址策略时实际打开。记录`.refactor/reports/webkit-csp-controls-20261003/result.json`。这是当前系统WebKit的对照，不是用户iPhone版本复现。新包的本机真实Chrome10组房间流程全部通过，记录`.refactor/reports/signal-init-local-20261003/result.json`。公开部署后再用非持久化系统WKWebView确认WSS打开、无CSP违规。没有浏览用户历史或控制其现有浏览器，没有provider请求。

当前已安装并启用`~/.local/share/pi-cafe-space/0.1.0-signal-init-20261003`，cloud镜像`pi-cafe-space-cloud:0.1.0-signal-init-20261003`，实际本机/公网asset均为`assets/index-x9XpvC15.js`。原房间identity/凭据/配置安装前后摘要不变，未结束用户Pi；仅重载受管网关/cloud，Caddy和TURN配置/启动时间不变。服务器回执`signal-init-deployment.json`，Compose SHA-256 `0180712abc16b41676b0e6a6c11cc726ae3bbb15cf0abc06391313ce5672f6bc`；备份`backups/before-signal-init-20261003`，Mac旧plist备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-signal-init.plist`。当前plist SHA `c79d72f288f30876fb7536505287a2535a08fb7b3defc580daf32ded7d461a0b`。

最新41文件包`.refactor/release/pack-HgtE3m/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA-256 `a23567a6aac2ff4bfe1b60c7ff12629ebef5095e64713b886af146c59b4b62e3`。Mac二进制`9d3ff0a4f5cf752e04395850f112112af2d587f117c558249c6d7857d9f03889`、Linux`d201e5e76ba699bd9e5525ae810b85904d41633116b905ea9bf2722d05178968`、Web摘要`3ca4e99f978bb7f27a8b2b6cae98de5818a29d8453a3e7a0fafb8ddf3be514c3`。未commit/push或发布远端release。

下一步是手机完整刷新原链接，保持原密码；仍失败时查看新增初始化步骤与异常类型，不要求关闭浏览器安全保护。没有物理手机最终成功证据，也没有重跑或宣称解决历史默认模式页面导航超时。参考：MDN connect-src https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src；WebKit历史记录 https://bugs.webkit.org/show_bug.cgi?id=201591 。

## 前序已定位并修复的代码问题

1. 已收集到可用TURN候选时，浏览器和办公端仍可能分别等满8秒，形成不必要的串行等待。公开探测中浏览器约4.5秒拿到relay候选，11.1秒才发offer，19.6秒收到answer。现在拿到relay后保留250毫秒合并窗口便继续；只有host候选时继续等其他路径，原8秒上限与取消仍保留。签名仍绑定实际发送的完整offer/answer摘要，没有降低身份验证。
2. 页面恢复/online事件之前会销毁正在connecting的房间连接。现在不再对进行中的协商执行resync；已认证或待重连状态仍可恢复。
3. WebRTC/加密能力缺失或socket构造异常以前会被上层吞成CONNECTION_LOST并不断重试。现在记录明确错误，首次失败停止自动循环，回到可手动重试的密码页。正常连接建立后的恢复逻辑没有被整体删除，也不自动重放任务。
4. maxMessageSize=0不再被误判小于最小消息尺寸；协商异常与房间验签失败分开，不能把已验证身份后的协商错误都叫作身份失败。
5. 密码页显示信令、地址收集、等待办公端、验签、加密通道、密码验证及实例同步的阶段和耗时。失败显示安全错误码与可展开详情：阶段、有无本端/办公端relay、ICE错误号和WebSocket关闭号。无密码、SDP、IP、会话正文、私钥或房间key。

这些是已证实的缺陷/等待行为与回归修复，不等于已经确定用户手机的唯一根因。用户需刷新手机原房间页，若仍失败提供新错误码和连接详情，不需要反复改密码。

## 实际网络证据

只读检查：云端与TURN运行无重启，云端确实发送STUN、TURN/UDP与TURN/TCP，短期凭据配置存在。没有因容器运行而宣称手机连通，也没有把no-tcp-relay误解成不支持客户端TURN/TCP。

新增scripts/remote/room-connection-probe.mjs使用临时办公网关、随机房间身份和合成密码，访问真实公开网站。记录信令类型、候选类型计数、阶段耗时及安全错误号，不记录SDP或用户凭据。强制relay-tcp时浏览器只允许relay候选，且只保留TURN/TCP URL，排除浏览器同机直接连接的捷径。

最初两个探测（phone-connect-baseline、phone-connect-turn-tcp）因没有Pi实例、页面不显示WebRTC状态面板，而使用标签的成功判据错误地退出1；其底层trace显示真实通道已经打开并收到数据。随后修正为直接检查认证通道中的room.authenticated、welcome类型和持续连接，不删除原失败记录。

最终已部署强制TURN/TCP验证：`.refactor/reports/phone-connect-turn-tcp-final-20261003/result.json`，退出0。浏览器实际iceTransportPolicy=relay，offer为0 host/1 relay；约7.6秒收到办公端签名answer、10.0秒打开DataChannel、11.8秒收到room.authenticated、12.3秒收到welcome，之后观察5秒仍connected，provider请求0。getStats的候选对列表为空，因此没有编造候选对统计；强制策略、唯一relay offer及实际认证数据是此次中继证据。办公端answer包含relay候选，但未宣称双方全程都是TCP或手机蜂窝已验收。

默认模式最后一次公开复验`.refactor/reports/phone-connect-default-final-20261003/result.json`在page.goto等待DOM阶段25秒超时，尚未进入密码/信令阶段，退出1。这个既有公开浏览器导航间歇问题仍未定位，没有无界重试或用TURN测试替代它。两项探测均已清理临时资源。实际手机没有由本来源控制或捕获，所以其最终结果仍待用户确认。

## 回归

- Web TypeScript检查、34文件166项Web测试通过，含新增ICE定时、取消、构造失败停止重试、浏览器能力检测、移动页面恢复不重启协商及SCTP零值测试。
- Go remote/service的race测试与go vet通过；构建时所有Go包测试通过。
- 本机新网页/新办公端真实Chrome的原10组房间流程全部通过：二维码、分享登录直达、错误密码、两访客/两Pi、控制权/单次合成prompt、新会话确认、窄屏、改密码、重置链接、重启身份保持。报告`.refactor/reports/phone-connect-local-regression-20261003/result.json`。
- 没有真实provider请求，没有在用户生产会话中发送测试命令。终端二维码及本机代理兼容修复源码未回退；本轮不重复声称其所有历史测试都重新执行。

## 当前部署与回退

Mac安装与Pi登记：`~/.local/share/pi-cafe-space/0.1.0-phone-connect-20261003`。受管LaunchAgent已指向新room-run并重新加载；没有结束用户Pi。原房间identity、credentials及room-device文件安装前后摘要完全相同。旧qr-fix登记已移除，旧文件保留。原服务文件备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-phone-connect.plist`；新plist SHA-256 `43592abc60baece3ff7fc6049b0f4594c38f19af77d09ee26f0f3d2faa788f43`。

云端镜像`pi-cafe-space-cloud:0.1.0-phone-connect-20261003`、版本目录`/srv/cafe-example/pi-cafe-space/releases/phone-connect-20261003`。比较旧摘要、备份、临时端口冒烟后只重建cloud；Caddy字节和启动时间、TURN启动时间、原cloud配置保持。回执`phone-connect-deployment.json`，备份`backups/before-phone-connect-20261003`；Compose SHA-256 `36e8b4dad13da84cab035f50c36b06bbf04ebd0c1d34bc80acc575cad08d853a`。cloud配置SHA仍为`a4e2f01142a3451608b15961dee65055718890715e59717ddfa4f64673d07fb9`。

安装后只读确认网关运行、原房间登记在线、一个Pi连接，本机/公开首页均为`assets/index-C4-pbOfB.js`。手机必须刷新页面加载这个新版本；单在Pi执行/reload不会更新手机已打开的网页。

交付包`.refactor/release/pack-MrcsgG/cafecodework-pi-cafe-space-0.1.0.tgz`，41文件，SHA-256 `f327ce00560839dd778cd0c4a81b9d2e163fffa816b38561cb2c8e499d51cb21`。Mac二进制`4413e909fec661aa19b2a1a036f310552d4e9922da2ce3e2c17743445805e7b2`、Linux`3fb307861b7c56ba99954d52a34b483a5e49709c34b31092ecadd84f7ae1eaa1`，Web摘要`910bc64bec958b7ecd0327b511260a4dbfdeaa20e1c9cbe6df6aa4ee4f9768a4`。尚未commit/push或发布远端release。
