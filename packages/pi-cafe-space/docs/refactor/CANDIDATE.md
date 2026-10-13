# 已验证的迁移候选

当前完成 **R00–R17 + R18.1**，并通过了 **本地受控 provider 的真实 Pi/AgentSession、Chrome SxS、历史/文件与 Windows 隔离安装专项**。真实浏览器发现的抽屉焦点问题已修复、重新构建打包并全量复验。外部验收已按用户批准的预算尝试，首个请求返回HTTP 403并立即停止，**R18.2受阻**，候选仍未生产部署。产物与受控证据见 [PROGRESS §33](./PROGRESS.md)，外部失败记录见同文档§34。

## 当前本机试用候选：独立后台新会话

左侧“新建”现在真正启动独立原生Pi，不切换所选客户端；无需已有在线客户端，也不要求原客户端空闲。选择已配置项目和名称后创建，后台会话支持查看、确认关闭和重新打开。没有另写会话状态机或JSONL；进程/工具由Windows Job Object限定所有权，关闭/Relay重启不影响手动Pi，重启不自动重放任务。完整边界见[MANAGED_SESSIONS](../MANAGED_SESSIONS.md)。

- Archive：`.refactor/release/pack-GGb8q7/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`e8e446d6cf9d6342892d95f4ef62177f1ebcca43cb567bacc222d12b58b68597`
- Web：`74458dfd9935e09abc58c8e88c27c80f1cf8b0c7179372834ce5d7cdb831be8a`
- Windows binary：`a70aecc662c28c299eed3ce891dfa9167071cc138b2f3eaac8d25591f18f8ef1`
- TS：`743a28533b0527ef6d2c86bbd07862e4f1a2b3f14063e272ea622256bd84cec3`
- TS504/Web101、typecheck、Go全部/webembed与managed/config/service race、37项Node guards（0 skip）；Chrome14组/32布局，另16组改名+16组独立新建双语深浅/桌面手机短屏检查通过。原生Pi0.99.1五组生命周期验收通过，1次离线合成响应、0真实provider请求。

已部署37983，最终Relay PID7004，5 ready hosts的原进程/session/cwd保持。首轮六个包文件、试用launcher和新增受限配置备份在`managed-sessions-update-OCNPCl/`；最后房间校验一致性补丁只改exe/build metadata，备份`managed-room-update-d5rxmi/`。25文件/5HTTP/CSP/owner/旧资源/全局配置核验通过，项目白名单为Pi Packages工作区和Café Space。刷新网页即可，现有Pi无需reload或重启；没有替用户创建真实会话或调用provider。详见PROGRESS §57及`R18-managed-sessions/deploy-followup-*`。

## 上一版本机试用候选：左侧统一会话查询与管理

按用户纠正，操作不再分散到右上角：左侧“会话”标题行收纳铅笔改名和“+ 新建”，下面依次搜索、客户端实例、历史。右侧只显示当前会话/项目/状态；保留紧凑居中表单与`/new`、`/name`入口，手机在同一会话导航抽屉管理。

- Archive：`.refactor/release/pack-GcUAuC/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`59971bcdc135d7c2e040a14368efda8d00fed5e684bbc2bcd3a3a891d1ffb059`
- Web：`ce8ffab79c553f8564588e5d36f0896c5ce701eea4ef768d2c1f9b7832907cc0`
- Windows binary：`45d4309fe708ae2e3e80e498e528c09da35053f285ae6ac28659010cb10a94b6`
- Web96/typecheck、Go全部/webembed/build、18项guards；隔离Chrome14组/32布局和16组双语深浅弹窗/焦点检查通过，含手机嵌套弹窗取消后返回导航。

已部署37983，Relay PID32948→36068，仅README/exe/build metadata三项；25文件、5HTTP/CSP、5个host重连及进程/上下文核验通过。备份`.refactor/manual-trial/sidebar-management-update-GpU2lA/`。仅刷新网页，无需reload Pi。见PROGRESS §56。

## 上一版本机试用候选：客户端实例与会话操作精简

“进行中的会话”改为“客户端实例”。侧栏只保留导航与搜索，新建/重命名归属当前对话标题栏；新建保留文字按钮，重命名为有可访问名称的铅笔按钮。复用Base UI/Sheet焦点管理，操作表单改为紧凑居中弹窗，改名自动聚焦并选中名称，明确取消/保存或创建，保留切换提醒与所有状态门禁。移动端不再需要从实例抽屉嵌套打开操作。

- Archive：`.refactor/release/pack-LnumuT/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`ad8b4e3ddba5664b14795028ebf558b7a5bb8b56da2b7eb4475be045a08202c0`
- Web：`e1c691c8098e9faa2ca78662abcba84dcf797bf4efefd8416d41e34558a1cab8`
- Windows binary：`67931dd53ee31562cf89939498849f8a979f16d7492b6dd37f2be35e2cb559ae`
- Web96项/typecheck、Go全部/webembed/build、18项guards通过。隔离Chrome14组/32布局，额外16组中英文深浅主题桌面/手机/短屏弹窗几何与焦点检查通过。

已部署37983，Relay PID30672→32948；仅README/exe/build metadata三项变化，Pi扩展与全局注册入口不变。25安装文件、5HTTP资源、CSP、备份、5个ready host重连及进程/上下文核对通过。备份`.refactor/manual-trial/session-layout-update-2pbuxs/`。**本次仅刷新网页，不需要再reload Pi**。详见PROGRESS §55。

## 上一版本机试用候选：`/` 与 `@` 输入能力

已接入Pi命令发现/原生扩展命令、技能与模板执行；`/new`、`/name`、`/resume`、`/model`、`/thinking`复用既有Web操作。`@`按项目目录补全，普通消息附带经Pi校验的文本文件内容（8文件、64 KiB/文件、128 KiB总量）。未知/本地专属命令不降级为模型prompt，旧扩展明确要求reload。详见[WEB](../WEB.md)及PROGRESS §52。

- Archive：`.refactor/release/pack-Kmks1J/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`01d900800edb1c1504dcd6c1c228a0e24371b391247001a014b2191ebc0f4322`
- Web digest：`594a5fd1127d5d2872bf609b0d6d8eb07f5fbef4cf3977782a90dfaecbba03e8`
- Windows binary SHA-256：`fcc8c17ce99fadd9597508b2101e32dbb4a4968b04d138beb96e9b3ceabdfc10`
- TS digest：`c0eacbb20334cf0eb13b08a382bd5ef7bc5125a74b3c20af63d040b6f518a346`
- TS504/Web96、typecheck、Go全部/webembed/build、18项guards与Go+bundle集成通过。隔离Chrome13组/32布局，原生Pi0.99.1七组验收通过；三个离线合成响应用于确认文件上下文与Pi模板/技能展开，零外部模型请求。

已部署37983，Relay PID30672；部署后即时6个Pi host ready，25安装文件、5HTTP资源、严格CSP及进程/会话上下文保持复验通过。稍后重复核对发现先前1个Pi进程已不在清单中，未替用户停止或重启，原因未判定；当前Relay owner与安装/HTTP资源再次独立核对通过，见PROGRESS §52。首轮6项备份：`.refactor/manual-trial/input-assist-update-Fd1Hwr/`；原生命令同名优先级补测后的最终2项备份：`.refactor/manual-trial/input-assist-fix-update-EI0IDx/`。最终记录以`R15-input-assist/deploy-followup-*`为准。

**用户需刷新网页，在所选Pi空闲时执行一次`/reload`**。2026-09-30另修复全局注册adapter的ESM缓存：旧入口即使reload也可能继续加载旧扩展；已部署单文件修复，旧Pi需再reload一次。pack-Kmks1J与Relay不变，见PROGRESS §53及`R18-registration-reload`；真实同进程“旧reload失败→修复reload成功”回归通过。随后§54补齐旧打包版Pi的磁盘安装目录被升级移除的情况：入口改用Pi提供的嵌入SDK和保留workspace的jiti，已单文件部署，包/Relay仍不变；打包版原生验收通过，用户原离线Pi需再次reload，尚未冒称用户连接已恢复。未自动reload或重启用户Pi/Chrome，未发用户业务/模型请求；未改`#`或生产入口。

## 上一版本机试用候选：精简导航与紧凑选择框

移除侧栏无效重复的“当前对话”链接；历史页保留“返回当前对话”，活动实例仍可点击返回。思考等级/发送方式共用紧凑横排标签与按内容宽度的Select，取消Composer和模型面板强制拉伸，保留40px操作高度、键盘操作和焦点。

- Archive：`.refactor/release/pack-KLqeoM/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`498093f71e0855e10644c2c9531bc5deaf8bb371b335e19e0e4e2d13466637d5`
- Web digest：`7ba676aa23b4b9cd70ea2e2442dd460e0c501c36295fa94fcb6d22ac8dfa9f4f`
- Windows binary SHA-256：`2debf42e8a9ed409cbadf2a0585bb736f7abc0222070d3a932cf22f9c4a72ac2`
- Web93测试、typecheck、Go webembed/build、Go+bundle集成及18项guards通过；隔离Chrome12组/24布局，额外10组中英文桌面/手机选择框尺寸断言通过。

已部署37983，Relay PID34844→9584。仅README、exe、build metadata三项改变，其余22项含Pi扩展保持；25安装文件、5HTTP资源、CSP、3个host重连与owner/上下文复核通过。备份/receipt：`.refactor/manual-trial/compact-choices-update-wVM9uB/`。本次只需刷新网页，无需再次reload Pi。见PROGRESS §51。

## 上一版本机试用候选：原生会话管理

已补齐 Web 新建会话、重命名当前会话、继续历史会话；仍由原生 Pi 拥有生命周期和持久化。忙碌/上下文/能力门禁、确认、Pi取消钩子和结果未知保护均保留。旧扩展按钮禁用并提示 `/reload`；部署不会自动 reload 用户 Pi。见[SESSION_WORKSPACE](./SESSION_WORKSPACE.md)、PROGRESS §50。

- Archive：`.refactor/release/pack-kvUZKf/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`f697b32c2bfabe24cc8576c8cecf299d56d083165a5128c8437265f859b4c7ef`
- Web digest：`7cf0054206e6e5a9ea006c61f63cae9893cb8dd31f6be70142cd2011e979b1f3`
- Windows binary SHA-256：`4109357df31e64a9bc1a1ef6c85b29f63c441b7ee598683266a9fcb4072cdc68`
- TS491、Web93、Go全部/webembed与实际编译bundle集成通过；隔离Chrome11组/24布局，隔离原生Pi0.85.1生命周期5组通过，0模型调用。

**已部署37983**，当前Relay PID34844。首轮5项部署记录在`.refactor/manual-trial/session-controls-update-PwI806/`（中间包pack-ssoBW3）；补测发现本地确认取消后缺失idle投影，修复共享UI结束回调并验证后，仅追加替换extension/index.js与build metadata。最终2项备份/receipt：`.refactor/manual-trial/session-controls-fix-update-wjOKeV/`。25安装文件、5HTTP资源、严格CSP、回退文件和3个Pi host ready重连均复核；Pi进程/session/cwd保持，未替用户执行reload。网页刷新后，在需要管理的Pi中空闲时执行一次 `/reload` 即可启用；不需要重启Pi。

## 上一版本机试用候选：会话工作区

参考OpenChamber的会话导航/主区交互，以Café主题实现，未引入Git等扩展。会话搜索/时间分组/自动历史读取、可折叠侧栏、默认关闭文件栏、上下文模型Sheet、消息复制和回到最新均已接入真实现有数据流。历史仍只读；没有Web会话创建/改名/恢复的假按钮。见[SESSION_WORKSPACE](./SESSION_WORKSPACE.md)和PROGRESS §49。

- Archive：`.refactor/release/pack-eJNDdn/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`205411f684245f8712e82241241938a41ac9a4d8e88d830aab811c14299c1a2d`
- Web digest：`0fb38107837e8cf3d0afe7c29191d9473eb4414df806bc6157b2ca1b9c149d08`
- Windows binary SHA-256：`1ec9aacb5034215cd40b471d198503433c0304184df1a86d28c4cd13fcd944c7`
- Web91 tests、正式25文件pack、Go webembed/build、实际Go+bundle集成、隔离Chrome10组检查/24组布局通过。

**已部署37983**，仅Relay PID30008→4120，3个Pi host ready重连。25安装文件、5个实际HTTP资源、原严格CSP、3份回退文件和会话/进程身份均核验通过。备份/receipt：`.refactor/manual-trial/session-workspace-update-rJls3U/`。

## 上一版本机试用候选：Composer完整外框焦点

针对截图中的内外双框，只将Composer文本输入焦点移到包含操作按钮的整个外框；保留其他控件及高对比度焦点提示，详见PROGRESS §47。

- Archive：`.refactor/release/pack-8liyMf/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`2819e77b1896bbf64248d8067521e0f9f7a9a1c59bff4b5415062468086d3a3d`
- Web digest：`b1b09d5855dd36c1a3f7b3b9bb8729a02bb28a5fd13d256a356005a47d9c94f8`
- Windows binary SHA-256：`9b9791af34bd65c734975e3e06996076362d3453a3e5142c54476eb2d4e061d0`
- Web88 tests、正式25文件pack、Go webembed tests/build、实际Go+bundle集成通过；Chrome11组检查/24组布局、4个深浅主题桌面/手机Composer截图及forced-colors验证通过。

**已部署到37983。** 只重启身份核对后的Relay（PID 8248→30008）；安装25文件、5个HTTP资源、原严格CSP及3个Pi host重连校验通过。未重启Pi/Chrome、改会话或调用模型。备份与receipt：`.refactor/manual-trial/composer-focus-update-tyeF2z/`。刷新或Ctrl+F5加载修复；见PROGRESS §48。

## 上一版本机试用候选：控件描边层级修复

普通按钮使用淡底secondary，列表/辅助操作用ghost；表单保留细边框，焦点不再叠加outline与ring，保留原生元素及高对比度焦点提示。详见PROGRESS §45。

- Archive：`.refactor/release/pack-lVn7uC/cafecodework-pi-cafe-space-0.1.0.tgz`
- SHA-256：`b7ecdf6bbf746e7fbc5bca9d4dae6acb0159ca7fdea1e8b886d4f481ee2bd04f`
- Web digest：`0355b5bf57a220a8df455f6aec4eb012b00ae0b46a688aed7692e9ea9e6b8236`
- Windows binary SHA-256：`3f5226a895184f06c51a6b8905a64dfd18b15f5334d4ce92bc6f7a6ac1a2844d`
- Web88 tests、正式25文件pack、Go webembed tests/build、实际Go+bundle集成通过；隔离Chrome10组检查/24组布局、16个焦点样本和forced-colors通过。

**已按用户“部署和重启”授权更新37983。** 只替换README、Relay exe及build metadata，另外22项（含Pi extension）不变；Relay PID13236→8248，3个Pi host ready重连且session/cwd摘要不变。25文件、5个实际HTTP资源SHA、strict CSP、3份备份及owner/锁释放核验通过；未重启Pi/Chrome或调用模型。备份/receipt：`.refactor/manual-trial/quiet-controls-update-EArf0t/`，见PROGRESS §46。刷新网页或Ctrl+F5加载修复。

## 上一版本机试用候选：shadcn/ui + Tailwind（已由描边修复版替换）

用户在§42部署后明确改用shadcn/ui并接入Tailwind。官方Base Nova组件取代直接使用的Radix控件；thinking/delivery使用Base UI Select。已安装项目shadcn skill，保留Café主题与assistant-ui会话/runtime；见[SHADCN_UI](./SHADCN_UI.md)、PROGRESS §43。

- Archive：`.refactor/release/pack-ZzSXoX/cafecodework-pi-cafe-space-0.1.0.tgz`
- Archive SHA-256：`79dfe9bd1c047267afa2f209736ac8ffbcdb2be90dbb2b49fed472e64daf5581`
- Web digest：`6a58a35dc3e506910fb859b62652cf26d69a542f1156978217db49e56c7b0a2c`
- Windows binary SHA-256：`1745eaa8b13d535589dbbd97b9dc2a4fb087fcd265c1447e4b8596a0b36f5e8a`
- Web87 tests、三层typecheck、assets/plugin9、theme4、shadcn2、安全3、Go webembed tests/build、实际Go+bundle集成、隔离完整源码build/check/test、精确25文件pack通过。Chrome合成数据9组检查/24组布局采样，包括Select的真实键盘及嵌套Sheet操作，CSP未改。

**已部署到本机37983试用。** Relay重启前核验PID/creation/executable/instance marker/listener owner；部署后Relay PID 13236健康，3个Pi host ready重连且session/cwd哈希不变。未重启Pi/Chrome或reload、未改credentials/会话文件、未发模型请求。本机用户可刷新已打开页面加载新资源。逐项部署校验及receipt见PROGRESS §44。 本次未改Pi注册或会话，未调用真实模型。新包还更新了构建脚本与许可清单，不能直接套用§42四文件白名单；仅替换七项已核准文件（README、THIRD-PARTY-NOTICES、Relay exe/build metadata/package manifest及两份构建校验脚本）；逐项备份/receipt位于`.refactor/manual-trial/shadcn-update-nuduRI/`，未改其余18项（尤其Pi extension）。

## 上一版本机试用候选：Radix 基础控件（已被shadcn替换）

用户选择Radix UI Primitives后的接入已完成，详见[RADIX_UI](./RADIX_UI.md)、PROGRESS §41。采用Dialog、Tooltip、Label，共享Café样式的Button/Input/Textarea/NativeSelect；原生选择器保留以兼容严格CSP，不引入Radix Themes或Tailwind。

- Archive：`.refactor/release/pack-7Yb74q/cafecodework-pi-cafe-space-0.1.0.tgz`
- Archive SHA-256：`2accaf955fc3f48508c3c915d6c2f879ce22eb4419c0cafff3a3e2ebcd7010f8`
- Web digest：`8afc8a71a7c2176233941bbad76d13ec4622008055c6e61c4c0869a01070ec81`
- Windows binary SHA-256：`a1fee21b3d188e70cdee52ab7c379596cb130624125184179bdf9db30e5a1933`
- Web86 tests、三层typecheck、assets/plugin8、theme4、Go webembed tests/build、实际Go+bundle集成、精确25文件包通过；Chrome隔离合成数据8组检查、24组布局及2组Tooltip定位/主题采样通过，严格CSP未改。

**2026-09-29已按用户“更新”授权部署到37983。** 只替换已安装25文件中的README、Relay executable、build.json和package.json，其他21个（含运行中的Pi extension）哈希不变。Trial本地包引用同步指向新archive，未执行npm install/lifecycle；Relay由PID51180切换至33604。5个实际HTTP资源SHA匹配，3个在线Pi自动重连、session/cwd摘要未变；旧37891/9222 owner不变。地址为 **http://127.0.0.1:37983/#/rooms/manual-trial**，已有页面请刷新或Ctrl+F5。证据见PROGRESS §42；此前pack-BjCbwa及更早archive保持原样。无Pi reload、会话文件变化、Chrome控制、真实模型调用或R19。

## 上一版试用候选：Café Workspace UI + 房间 URL

用户授权的Cafe风格重构已完成。采用`cafe-design@926e11c4`的Workspace tokens，保留React/assistant-ui及原生Pi所有权；设计和文件索引见[CAFE_UI.md](./CAFE_UI.md)，验证见PROGRESS §39。

- Archive：`.refactor/release/pack-BjCbwa/cafecodework-pi-cafe-space-0.1.0.tgz`
- Archive SHA-256：`2659122e6e6df19ff0b1566cf2334217312433009c468545082db56344b287d5`
- Web digest：`0f7de4d2f98d99f3746f568215af2ab85a5e0bb002cff3342395b17098d3a37f`
- Windows binary SHA-256：`1d44c2ca4aa278ec1060fdf2abfdee9d5910b96e2ae007af7b37f4256b38fa37`
- Web82 tests、theme/contrast4、assets/plugin8、Go webembed tests/build、实际Go+bundle集成及25-file pack通过。Chrome SxS以独立profile和合成数据完成深浅色/多尺寸/焦点/加载/CSP等6组检查、24组几何采样；没有真实Pi/model调用，不把它当原生模型验收。

**2026-09-28 已按用户“更新和重启”的授权更新37983。** 仅替换已安装包中与新archive不同的Relay executable、build.json及README；另外22个发行文件（含Pi扩展）不变。25个文件逐项哈希与新包一致；本机试用依赖记录同步指向新archive，安装路径、令牌与普通Pi注册配置不变。只重启身份核对后的Relay（18064 → 51180），5个嵌入HTTP资源逐项校验通过，原3个在线Pi自动重连且会话/工作目录摘要不变。入口为 **http://127.0.0.1:37983/#/rooms/manual-trial**；已有网页需自行刷新。不执行Stop.cmd、Pi reload或R19，未调用模型。原archive和3个被替换文件的备份保留；更新证据见PROGRESS §40，以下原生专项仍只代表其原版本验收。

## 房间 URL 中间候选（历史，未安装）

用户确认的房间路径功能已实现：`/#/rooms/manual-trial`，对应历史页为`/#/rooms/manual-trial/history/:sessionId`。带房间链接自动选房间、登录只填客户端令牌；令牌不放URL。切房间撤销旧pending并清理草稿/缓存，旧根入口与历史书签仍兼容。实现及证据见PROGRESS §38。

新隔离候选为`.refactor/release/pack-7qGHnu/cafecodework-pi-cafe-space-0.1.0.tgz`：

- Archive SHA-256：`1b164ddac0de9d339e00c0f579477a13dd7e5d4eea4b8ba6468d7583dbe442aa`
- Web digest：`680b97d900f209b0ddd28b3aa4513f8d0f616f1b18850df5f6b8f8d0b95028aa`
- Windows binary SHA-256：`e18283e68696a8a620a8fe84aa40f24a9ac5f1dd2b18b835a20dab6b5ef85a1f`
- Web78 tests、assets/plugin8、Go webembed tests/build、精确25-file包和实际bundle/Go临时端口集成通过；未对本包重跑native Pi/Chrome/外部模型专项。

该中间包未单独安装；房间URL最初随pack-BjCbwa部署，现已由上方兼容版pack-7Yb74q继续提供。原pack-30bbqJ、pack-7qGHnu及pack-BjCbwa archive均保持不变，下文的原生专项验收仅对应pack-30bbqJ，不能自动转授后续包。

## 产物位置

所有路径相对于 `packages/pi-cafe-space/`：

| 路径 | 用途 |
| --- | --- |
| `.refactor/web/` | 本次 Vite 输出，不替换旧 `web/public` |
| `relay/internal/webui/assets/` | 经过引用/容量/哈希校验的 embed staging，已忽略 |
| `.refactor/bin/windows-amd64/pi-cafe-relay.exe` | 当前实测的 Go 独立 executable，已内嵌 Web |
| `.refactor/ts/` | 应用候选源码 overlay 后独立编译的 TS |
| `.refactor/release/package/` | 独立候选包 staging，含最终 extension/launcher 接线 |
| `.refactor/release/pack-*/` | 每次 fresh pack 独占目录，包含 tarball 与 `pack-report.json` |

独立 Go Relay 运行不需要 Node、Go 工具链或磁盘 Web 文件。Pi extension 仍是 TypeScript 编译的 JavaScript，仍由原生 Pi/AgentSession 持有会话与工具。包 runtime dependency 只有 `ws`，Pi 保留 peer dependency；Web 与构建工具是开发依赖，前端代码已经编入 executable。

目前仅 **windows-amd64** 有 native 运行证据。其余四个平台只有明确映射、文件头/元数据/checksum 校验及缺失失败路径，不代表已产生或验证对应 binary。非 Windows 自动进程 owner 管理安全返回 unavailable，不冒充已支持自动启动。

## 确定性复验

在原生 PowerShell 中使用已批准的 Node 22.23.2/npm 11.16.0 和 Go 1.24.2；只设置当前子进程环境，不改系统 PATH、Go 全局配置或 Pi 配置。完整验收另需已核对的 native GCC race compiler。

```powershell
# 当前目录：packages/pi-cafe-space
.\scripts\refactor\verify.ps1 `
  -NodeDirectory "$PWD\.refactor\toolchains\node-v22.23.2-win-x64" `
  -Compiler "$PWD\.refactor\toolchains\gcc14\mingw64\bin\gcc.exe"
```

该脚本执行 TS/Web/contracts、Go tests/vet/race、真实 Go bridge、fresh embed build、候选/隔离源码聚合 check/test/build、Windows owner/PiArgs shim、实际 bundle 集成和 fuzz。测试使用自有临时目录与 ephemeral ports，不启动真实 Pi/Chrome，不调用模型。

已配置正确子进程工具链后，可以单独执行：

```powershell
npm.cmd run refactor:relay:build
npm.cmd run refactor:build:test
npm.cmd run refactor:launcher:test
npm.cmd run refactor:integration:test
npm.cmd run refactor:pack
```

`refactor:integration:test` 和 `refactor:pack` 各自先 fresh build。pack 随后校验独立 staging，才在该目录运行 `npm pack --ignore-scripts`，输出精确文件表、Web digest、平台和 archive SHA-256。不存在借 ignore-scripts 省略构建的路径；失败不会覆盖旧 archive 或产生成功报告。文本敏感模式扫描是辅助检查，不是普遍秘密审计。

**不要在当前生产源码包运行旧 `build`、`prepack` 或直接 `npm pack` 来做迁移。** 它们的旧默认仍会清理生产 `dist`；连 `npm pack --dry-run` 都可能触发 prepack。

## 最终入口如何复用

- `scripts/refactor/candidate-overrides/package-fields.json`：候选 scripts、依赖分层和发布文件边界。
- `scripts/refactor/candidate-overrides/extension-import.json`：在源码副本中选择 `local-relay-go`，不是修改编译后 JS。
- `scripts/refactor/candidate-overrides/scripts/`：经过测试的最终 build/check/test/relay/PowerShell 实现。
- `build-source.mjs` 仅在完整源码 checkout 中显式构建；已安装成品缺源码时明确失败，不在启动时自动 build 或下载。
- `source-verify.mjs` 在源码 checkout 检查 TS/Web/Go，并运行包含 frozen contracts 的 TS tests、Web tests 与 Go tests。在成品中只做 artifact 验证，明确输出该区别，不假称执行过 source tests。
- 源码副本验收复用了已安装依赖和只读根 TS 配置；没有建立第二份 lockfile，也不是 candidate 安装测试。

R19 获准并满足其前置验收后，应采用这些已测源码 overlays，而不是另写一套未测默认入口。当前原 `src/extension/index.ts` launcher import、生产启动脚本、`dist` 和旧 Web 均未切换。

## 真实专项复验（需要专项授权）

此前完成原生专项的候选（当前UI试用已更新，见上节）：

```text
.refactor/release/pack-30bbqJ/cafecodework-pi-cafe-space-0.1.0.tgz
archive SHA-256: 32ee907b902174495ed3e1ea9307a8f339cd8df79ede3e7f23e50eeccc94bfd2
Web digest: ccd8e0767e578c9adb38f2783549e21f8a90353999ad02ab78c9fd8d24572c15
windows-amd64 binary SHA-256: a0f1bb438d108403c77c6d471a9a5dc086149d8681aefdc76a51216eed7a8e23
```

同目录 `pack-report.json` 给出精确25项文件表。它替代先前 pack-ZvSIQF；不要把先前构建的确定性结果当成该旧包通过了全部真实浏览器检查。

以下会**实际安装包并启动独立 Pi、Go 和 Chrome**，不属于普通 `test`。只有取得专项授权后运行；37983/9333占用时拒绝，不终止未知进程。

```powershell
# 当前目录：packages/pi-cafe-space
$Node = "$PWD\.refactor\toolchains\node-v22.23.2-win-x64\node.exe"
$PiRoot = 'C:\Users\example-user\AppData\Local\pnpm\global\5\.pnpm\@earendil-works+pi-coding-a_92f687cfe951df750bec0864ffeea219\node_modules\@earendil-works\pi-coding-agent'
& $Node scripts/refactor/native-acceptance.mjs --allow-native `
  --pi-root $PiRoot `
  --archive .refactor/release/pack-30bbqJ/cafecodework-pi-cafe-space-0.1.0.tgz `
  --npm-cli .refactor/toolchains/npm11/package/bin/npm-cli.js `
  --chrome "$env:LOCALAPPDATA\Google\Chrome SxS\Application\chrome.exe"
if ($LASTEXITCODE -ne 0) { throw 'Native acceptance failed' }
```

- 使用已安装 Pi0.85.1 作为本地 peer；npm11 从已有 cache 正常解析并安装候选和 `ws@8.21.3` 到新 prefix，不安装第二套完整 Pi。无 force/legacy-peer-deps、全局 install 或第二 lockfile；`--ignore-scripts` 不冒充执行过 lifecycle。实际通过 `-e <已安装 package 目录>` 加载包 manifest。
- Pi 使用独立 home/config/temp/project/custom sessionDir；禁用自动资源发现、外部工具、启动网络和 telemetry。`native-fixture.ts` 只提供受控 stream/tool，不访问外部模型；原生 Pi 自己执行工具、排队、取消和持久化。该 fixture 针对实际安装的 Pi 类型检查，并有20次 stream调用上限。
- Chrome SxS headless 使用独立 profile；浏览器 socket 只管理 target，DOM/CSP/键盘断言使用 `/json/list` 对应 page socket。实际验证三个 viewport、工具顺序、抽屉、滚动、Markdown、重连、历史和文件，不录制或截取终端。
- 先核对本轮 listener/进程身份；finally只关闭本轮资源，终止前重新核对 exe/creation/完整命令并保有 process handle。身份不确定则保留目录并失败。报告写入 `.refactor/reports/R18-native/`，成功退出前检查测试端口释放、无本轮进程残留、旧服务监听 owner 不变并移除自有目录。

`final-audited.txt` 为最新23项真实专项检查；`verification.txt` 为修复后的全量确定性回归。两者证据独立列出；受控 provider 通过不证明任意外部模型能输出相同内容或事件。

## 有界外部验收：403后停止

用户授权`cafe/gpt-6-astra`最多2次调用、每次1024输出tokens、无自动重试、总60秒后，已在同一SHA候选的隔离Pi/Chrome环境尝试。实际使用配置支持的`low`（`off`和`minimal`明确不支持），**仅1次请求，HTTP 403，1085ms后关闭预算，0工具执行、无模型completion**。未自动重试，不能据403确定凭据失效或其他具体原因；没有usage，不宣称零计费。

专项实现为`external-acceptance.mjs`、`external-fixture.ts`和`external-budget.ts`。凭据只在隔离Pi内从授权配置读取，不传Relay/Web；只发送固定测试文本和受控工具结果，不读取真实项目或旧聊天。SDK/Pi重试关闭，fetch票据限制次数、校验线上1024参数、禁止redirect，使用共享60秒取消信号。`authorized-once.jsonl`以wx创建并在发送前fsync；HTTP失败后永久保留本次记录，不重置剩余额度。

```powershell
# 无外部请求的预算测试，包含实际等待60秒的取消测试
& $Node --test scripts/refactor/external-budget.test.mjs
# 以下预演仍会安装隔离包并启动真实Pi/Go/Chrome，须有原生专项权限
& $Node scripts/refactor/external-acceptance.mjs --dry-run `
  --pi-root $PiRoot `
  --archive .refactor/release/pack-30bbqJ/cafecodework-pi-cafe-space-0.1.0.tgz `
  --npm-cli .refactor/toolchains/npm11/package/bin/npm-cli.js `
  --chrome "$env:LOCALAPPDATA\Google\Chrome SxS\Application\chrome.exe"
```

`--dry-run`使用非秘密假配置及假HTTP响应，经过真实Responses SDK和AgentSession；不能当成外部模型成功。`guard-final.txt`的5 tests与`dry-fifth.txt`通过；真实`external-second.txt`退出1、`external-latest.json`为failed，账本记录唯一的403请求。首次真实模式仅因配置不匹配在arm前拒绝，未发出模型请求；完整失败经过见PROGRESS §34。

本次授权已封存，脚本拒绝使用现存账本再次启动外部测试。**不要删除账本绕过；新的外部诊断/复验需要另行明确授权和预算。** 已核对仅清理本轮进程/目录，测试端口释放、旧监听owner不变。报告未保存密钥、endpoint或服务端错误body。没有产品代码修改或候选重打包。

## 已启动的本机手动试用

用户选择亲自测试后，已实际安装本机试用；最初安装为pack-30bbqJ，现按§40仅将Relay更新到pack-BjCbwa，不是仅提供打包文件或模拟host：

- 网页：**http://127.0.0.1:37983/#/rooms/manual-trial**。首次安装曾打开并登录独立Chrome SxS；本次更新不操作或重开浏览器，用户自行刷新。
- 本地Pi：独立真实交互控制台，`cafe/gpt-6-astra`、`low`；原生provider transport与工具，无假stream/预设回复。
- 持久安装目录：`packages/pi-cafe-space/.refactor/manual-trial/`；项目为其`project/`，会话为`sessions/`。
- `Start.cmd`：停止后重启；`Stop.cmd`：结束本试用，保留会话和安装。停止前请先完成或取消运行中的任务，不批量清理用户工具子进程。
- `README.txt`包含使用说明；如需重新登录，房间为`manual-trial`，本地客户端令牌在该目录`credentials.json`的`clientToken`。这不是provider密钥。

安装目录仅当前用户/SYSTEM可访问；首次独立试用使用独立agent/home/temp/profile，只在Pi进程内存中读取现有cafe配置，没有修改全局配置或复制provider key。之后的普通Pi注册接线单独见下节。首次启动的TTY、真实snapshot/上下文和listener owner验证通过；助手没有发送prompt。之后用户手动模型调用按其正常服务配置计费，不受先前自动测试2×1024预算包装。

**试用进程刻意保留给用户。不要为了跑自动测试而停止37983/9333上的这套实例。** 原37891/9222未动。它不是生产默认切换；详细证据及范围见PROGRESS §35。外部验收403仍保留，空闲就绪不等于模型请求成功。

## 普通 Pi 自动注册：本机接线已启用

按用户希望看到普通Pi实例的需求，已仅替换全局`~/.pi/agent/settings.json`的Cafe Space package项，入口为`~/.pi/agent/cafe-space-local/extension.ts`。它加载同一已安装候选，默认连接**37983 / manual-trial**，不新建AgentSession、不改模型/工具/原工作目录或会话目录。其他扩展和provider配置不变；旧37891服务仍运行。

- 以后正常启动`pi`会自动注册；已经运行的Pi由用户在各窗口执行`/reload`后接入。显式指定其他relay/room或关闭协作的设置仍优先，不强行覆盖。
- 在新Web的`manual-trial`房间选择实例，即查看该Pi的当前会话。历史按所选Pi的原上下文查询，不复制全局历史。
- 实际native测试已验证两个自动加载实例、不同ID/cwd、第三个实例opt-out和敏感配置拒读；0模型请求。验证入口、证据与权限边界见PROGRESS §36。
- `~/.pi/agent/cafe-space-local/registration-backup.json`保留旧注册项，未保存完整全局设置。恢复旧接线需只还原该项，再由用户reload。
- **保留`.refactor/manual-trial/`安装。** 普通Pi现在引用它；不能在后续清理时直接删除。`Stop.cmd`会停止共享Relay，使普通Pi暂时失去Web连接，但不终止它们。若只想关闭最初的专用Pi，退出那个Pi窗口即可。

这是用户本机试用注册的实际变更，不是R19仓库默认launcher切换、发布或外部验收通过。

## 尚未验收 / 未授权操作

- 外部provider成功生成、真实外部工具续轮与UI投影：本次403阻塞，仍未通过；不能从当前会话模型标记推断隔离请求必然可用。
- 非 Windows 实机或另外四个平台的发行 binary；原生 Pi TUI 自定义组件也未由 RPC 验收覆盖。
- 全局provider配置或无关Pi配置修改、R19仓库默认切换、停止旧实例和删除旧实现；仅上节所述本机Cafe Space注册项已按用户需求修改。

本机试用及其Pi注册已启用；受控专项通过不能被扩大为生产环境可用，也不自动开启R19。切换后的旧实现清理仍需用户先确认新版本可用并明确同意清理。
