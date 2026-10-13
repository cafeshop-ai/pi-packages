# 房间控制权配置与本机审批

2026-10-04。用户要求控制权功能默认关闭，按房间配置；开启后必须在房主机器的页面同意。已实现后端授权策略、本机设置/审批页面和远程申请状态，安装并启用room-control版本。此前mobile-ux的自动取得空闲控制权只作为历史实现保留，不再适用于新版公共房间。

## 当前版本：原生思考反馈与Pi内房主审批已安装

用户指出原生select在电脑上也不能切换Gemini思考。实际本机Pi版本为1.0.2，`~/.pi/agent/models.json`的cafeshop/gemini-3.8-flash写为reasoning:false、API为openai-responses。已仅将该条reasoning改为true；逆向恢复该单字段的摘要与原文件完全一致，未改密钥、地址、其他模型或默认等级。实际Pi ModelRuntime在禁止网络的进程内读取修改后的定义，返回reasoning:true。Google官方thinking文档列明Gemini3.8Flash支持思考，但用户的兼容上游是否正确转发参数尚未实测，不能把本地声明等同于模型服务已生效。

此前Café Space直接调用pi.setThinkingLevel后不读回就返回applied；原生Pi在reasoning:false时把high静默保持为off且不发事件。现按原生reasoning/thinkingLevelMap上报白名单能力，网页仅展示支持档位，禁用时解释配置原因。调用后读回真实等级，不匹配返回THINKING_NOT_APPLIED，不再假成功；未上报能力的旧客户端也保留实际值校验。实际安装AgentSession方法（非无条件成功替身）的false/true及静默钳制回归已通过，记录`.refactor/reports/native-thinking-20261004/result.json`，模型请求0。

已有Pi需空闲时/reload加载新扩展，然后执行/cafe models：明确只重新读取本机模型配置、不联网发现，重新装入同一个模型并保持原思考等级。不因/reload假设旧模型对象已刷新；同ID模型不会触发原生model_select，因此本地命令会把真实能力主动同步给网页。忙碌或中途上下文变化不替换模型、不取消任务。

Pi审批采用与先前受阻的host令牌增权不同的认证方案：原`/api/room/terminal`仍只读，新增本机owner入口必须同时具备真实房主clientToken与Pi hostToken、回环连接且无浏览器Origin、当前在线Pi、准确申请ID及房间版本。只允许本Pi待办读取、批准/拒绝，不能开关审批、改密码、接管其他实例或强抢。凭据由程序从私有本机文件读取，不进入模型上下文或云端。

交互式Pi对当前实例的新申请仅提示一次昵称与/cafe approvals。/cafe主面板的审批项或/cafe approvals打开申请列表，选择批准/拒绝后有人工确认；提交前重新核对同一申请和版本。取消、过期、变更、断线均不会提交旧决定，写入未知结果不自动重试。通知轮询和UI取消随扩展关闭清理；RPC不支持审批，远程命令也不能调用/cafe。网页房主仍可撤销从Pi批准的授权，默认关闭控制权和身份刷新逻辑保持。

验证已通过：557项主包、230项Web及类型检查；新本机客户端/人工确认/模型读回专项；完整Go remote/protocol/service race和vet（78.977/3.665/3.193秒）。真实Pion验证双凭据审批前后命令门禁、跨Pi/旧版本拒绝、网页撤销、旧host只读接口仍不能批准。首轮主包随机半块二维码在12px模拟字形上出现一次解码失败，后续完整557项通过；没有改二维码绘制掩盖该随机用例问题，既有实心/高清二维码路径保留。本机20组真实浏览器与Node审批联动已通过，报告`.refactor/reports/pi-owner-local-ready-20261004/result.json`。浏览器真实申请、实际本机双凭据客户端与Pi控制器提示/确认/授予、网页同步和原批准刷新均实际执行；人工选择与确认采用测试替身，没有代替真实房主审批生产访客。首轮该流程在网页2.5秒状态轮询前检查待办数失败，保留pi-owner-local报告；改为等待原页面自然同步，不调整授权算法或删除断言。原生Pi Responses适配器另已验证生成`reasoning.effort=high`，在发送前停止，网络请求0；这不证明cafeshop上游转换实际生效。

本机安装、Pi登记和运行网关及cloud均为`0.1.0-pi-owner-20261004`，新资源`assets/index-lZRNhiZP.js`、CSS仍`assets/index-gezFmgl6.css`。已有Pi需用户空闲时依次执行/reload和/cafe models；安装不是当前Pi已重新加载的证据。除前述单字段reasoning修正外，身份/凭据/room-device/可选审批配置及models.json安装前后摘要不变，未改房间密码、审批选择或独立实例管理。仅重载受管网关与cloud，未结束手动Pi任务；Caddy/TURN字节和启动时间不变。

最终44文件包`.refactor/release/pack-uU6K0H/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA`8392ec23e4e02957a0aeecba4ada54aafc460481494858270176478012a16ceb`，Mac程序`64318008d9126d38227a500c1f837f95683ccac466bd391ecdffbc9686bad277`，Linux程序`e9c78f3a70a9b5af2a10a32a8d1af4e27ffb9428aa63c478551b09d8f2655f93`，Web摘要`820e1399f6250a26da9b04cce93ca2a71482a6630ba380c0f2f4248dd904dbb6`。首轮打包因三个新增运行模块未列在精确清单失败；显式加入cafe-approvals、cafe-owner-client、thinking-capability后通过，没有放宽文件集合校验。Windows仅交叉编译，既有大JS分块提示仍存在。

本机旧启动文件`~/.local/share/pi-cafe-space/deploy-space-20261003/before-pi-owner.plist`，新LaunchAgent SHA`52beaca23f92202b7e300afe346ffc3480305ad467f1d4346dd626992e522ed8`。服务器回执`/srv/cafe-example/pi-cafe-space/pi-owner-deployment.json`，回退`backups/before-pi-owner-20261004`，Compose SHA`e564aeaaaa08ecf6cdf6152e6188b5a8abc88b75b14f6e9ae926ed0aaedb3081`，原cloud配置保持。最终公网联动报告`.refactor/reports/pi-owner-public-20261004/result.json`已完成，20组全部通过、退出0、4次合成prompt、真实模型调用0；与本机20组均核对报告文件。最后再次核对本机/公网精确JS/CSS、健康状态、运行版本和本机专属terminalOwnerControl能力正常，Gemini配置reasoning仍为true。没有在用户实际Pi里执行/reload或替用户批准真实访客；现有Pi由用户闲时加载新扩展并/cafe models更新同名模型。未commit/push或发布远端release。

## 前序访客体验：弹窗、昵称身份与刷新恢复


用户要求发送受审批阻止时弹窗申请、Pi内通知和/cafe审批、刷新保留身份并可自定义昵称、修复手机思考强度选择闪退、缩小活动图标并对齐。当前已完成网页弹窗、签名身份与短时授权恢复、昵称输入、原生思考选择和20px活动图标的源码，并通过228项Web/类型检查与完整Go remote/service race、vet。申请弹窗只调用原访客申请接口，不携带待执行消息，批准后不会自动发送。

**Pi内审批通知和/cafe内直接批准尚未交付。** 先前新增终端审批接口的写入受工具安全检查阻止，本轮没有换路径重试，也没有扩张现有接口权限；用户仍在房主本机网页处理审批。此项必须保留为未完成，不得把网页改进说成终端能力已完成。

访客使用每个浏览器/房间的不可导出P-256密钥，通过绑定房间、当前连接、随机数和昵称摘要的签名证明身份；昵称只是显示偏好，呈现为昵称#8位ID。网页存储不可用时临时身份明确提示，旧记录不可用时不静默覆盖。只保存身份密钥和昵称，不保存房间密码；整页刷新仍需密码认证。原批准仅在同一身份验证成功后恢复，断线保留窗口5分钟；撤销、释放、到期、改密码、重置链接、策略切换或网关重启不恢复旧批准。已批准的同浏览器新连接可接续控制，旧连接不能同时写；不同浏览器即使昵称相同也不能取得原授权。

手机思考强度使用原生select避免嵌套浮动弹层，选中值仍以办公端快照为准，拒绝/未知结果在模型面板显示。活动图标固定20px，文字和计时统一20px行高居中，保留咖啡杯蒸汽与减少动态效果规则。

本轮同时回答了独立实例管理配置位置：目前没有网页编辑表单；当前room-device.json没有roomManagement，LaunchAgent没有--managed-config，确实未启用。详细路径/字段见ROOMS.md和MANAGED_SESSIONS.md。没有替用户配置项目目录或启用后台实例，手动Pi不改变。

新增Go签名/刷新测试涵盖同昵称伪装、不同房间/连接/随机数/昵称重放拒绝、撤销/策略清空/过期、真实Pion刷新后使用原批准。专项race通过11.379秒；完整remote/service race通过109.334秒与2.924秒。首个浏览器流程已走通昵称和弹窗申请，刷新后因界面默认中文而英文定位器超时；保留visitor-ux-local报告，测试已显式切换语言继续，不把该失败当成身份验证失败。修正定位器后的本机19组浏览器流程已全部通过，报告`.refactor/reports/visitor-ux-final-20261004/result.json`，包括真实IndexedDB跨页面刷新保持同一昵称#ID、原批准恢复且没有新增申请或重放消息、手机原生思考选择向合成Pi提交low/high并取得快照确认、图标宽高20px且文字中心偏差0。4次合成prompt、0模型调用。窗口视觉复核因设备锁定返回DEVICE_LOCKED，未改用其他屏幕读取途径；不声称已人工检查这轮图片或远程操作了物理iPhone键盘。

本机安装和运行网关、Pi登记及cloud均已更新为`0.1.0-visitor-ux-20261004`。原身份、凭据、room-device及可选审批配置安装前后摘要不变，用户现有审批选择保留，没有启用独立实例管理。只重载受管网关和cloud，没有结束手动Pi任务，Caddy/TURN配置及启动时间不变。第一次升级旧无签名访客需要重新登录并在审批开启时申请一次；后续同浏览器刷新遵守上述恢复窗口。

最终资源`assets/index-b_rbHzxo.js`、CSS`assets/index-gezFmgl6.css`。归档`.refactor/release/pack-rYFXQA/cafecodework-pi-cafe-space-0.1.0.tgz`，41文件，SHA`73266e706ff43e272c919ea49346a749e37ece7815ca05e8782d5a0ba80dc7c6`；Mac程序`2fc8a7c64d675867e9e230922179423f19926f56aa4dba8603f3819f70a73b7d`，Linux程序`dce186f9b1503649c3f7a0bdf1c04add91fb8b316eebfa375ad73cd8a0047310`，Web摘要`482c54d2de5a1ee812abfa5c5d7fb48e9890516df7c39f701ddd9b43fd4ac74b`。构建仍有既有JS大分块警告，Windows只交叉编译。未commit/push或发布远端release。

旧LaunchAgent备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-visitor-ux.plist`，新SHA`dbd86ae28dc6f9579105f9589b7a44685a1b7333d6966256046e9694487a3a68`。服务器回执`/srv/cafe-example/pi-cafe-space/visitor-ux-deployment.json`，回退`backups/before-visitor-ux-20261004`，新Compose SHA`9aa330fce49460fd81a8299be8c15df17e95291d74c871d393717831faed52f7`。首轮实际上线测试报告`.refactor/reports/visitor-ux-public-20261004/result.json`已完成：16个阶段通过，包含本轮全部新增交互和身份刷新；后续旧密码轮换回归在等待办公端应答时超时，退出1。该失败保留，不能把整套说成一次全通过。测试侧已将密码/链接轮换和重启后的前置条件改成明确读取临时网关完成房间注册，不再仅靠HTTP健康或600ms延迟；没有为此改动生产程序，也不能把这个测试改进断言为超时唯一根因。复核报告`.refactor/reports/visitor-ux-public-ready-20261004/result.json`已完成：同一生产版本19组全部通过，退出0并清理临时实例，4次合成prompt、0模型调用。签名身份刷新、申请弹窗、手机思考选择与密码/链接/重启流程均实际执行；这不删除首轮超时记录，也不证明物理iPhone或所有网络条件。一次operation.get等待参数被运行时拒绝，没有改变权限或重跑测试，后续只读取原操作保留输出。

## 使用方式

**关闭控制权审批时，所有通过房间密码验证的访客都可以直接操作Pi**，不创建控制权租约、不要求申请，也不再额外划分“有操作权限的访客”和“只读访客”。公共房间入口为每位访客统一设置可操作身份；此前文案中的“viewer仍只读”混入了旧非房间访问模式的角色概念，不适用于当前公共房间。

**开启审批时，所有访客在获批前只能查看，房主在本机页面批准后才能操作指定Pi；撤销或授权失效后恢复只能查看。** 这是审批状态，不是另一种需要单独分配的访客角色。拥有Pi操作权限不等于房主管理权限：更改房间密码、开关审批及批准其他人仍由房主本机页面完成。房间密码、当前会话及命令校验保持不变；关闭审批不保证多人操作不会互相影响，是否启用协调由房主决定。

房主在办公电脑打开本机工作台（当前`http://127.0.0.1:37891`），使用原本机令牌登录，进入「分享房间 → 房间设置 → 启用控制权审批」。coffee-ui版已将分享和设置整合到同一面板，直接访问本机根路径也能找到入口；待审批提示会直接打开设置页。切换开关后有确认说明，默认不会帮房主开启。公共站点和远程访客不获得这个入口或审批权限。

启用后的流程是：访客明确申请指定Pi实例，本机页面显示申请者、编号、实例和待办数量，房主点击批准或拒绝。看到申请、忽略申请、关闭页面均不会自动批准。批准授予已验证访客身份对指定Pi的操作权，当前连接通过短期租约使用；访客仍需自行点击发送，不执行此前未发送或被拒绝的草稿。

房主可以撤销已授予的控制权，访客可以撤回未处理申请或释放自己的授权。一个实例已有持有者时，批准另一个申请会提示先撤销旧授权，不会暗中抢占。远程管理员也不能在此房间模式下force接管或自行发送approve帧取得权限。

申请90秒未处理会失效。批准后的在线租约30秒，由活跃页面每10秒续期。使用签名身份的同一浏览器断线时，原批准保留最多5分钟供刷新重连；新连接须再次通过房间密码和新连接签名验证，不依据昵称恢复。旧无签名身份仍断线即清空，过期或撤销后都须重新申请。配置切换清空旧请求与授权，但不自动取消已经开始的任务。开启时远程创建/打开独立Pi实例暂不支持，请在房主本机页面完成，再让访客对已有实例申请。默认关闭时仍遵守原项目白名单和管理角色规则。

## 持久化与边界

开关保存在房间身份文件旁的`room.json.control.json`。没有文件时明确默认关闭，读取不会自行创建它；首次修改才保存。文件含version/enabled/revision，不含密码、私钥或聊天内容，原身份文件不改。版本与文件摘要比较避免本机多页面覆盖；损坏配置拒绝启动，不静默退回关闭。申请与授权仅在内存中，网关重启不会保留旧批准。

审批HTTP入口是本机`POST /api/room/control`，要求回环连接、字面本机Host、唯一且匹配的Origin、JSON、专用请求头以及本机令牌。操作形状、策略revision和申请ID均校验；访客命令由后端检查，不能只修改页面绕过。云端不暴露本机审批接口。这里的本机页面边界不是操作系统用户隔离；同账号本机进程与已授权本机页面拥有者仍在信任范围内，显示的访客名称不构成实名身份验证。

旧非房间远程设备协议保留legacy协调模式。默认关闭仅用于新的公共房间策略，不擅自改变其他远程模式。已修好的DCEP/DTLS/SCTP与TURN连接算法保持不变。

## 验证记录

Go新增7项控制策略/HTTP测试覆盖默认关闭、只读/断线限制、持久化与损坏拒绝、申请去重、审批/拒绝/取消/过期/撤销、并发批准不替换持有者、版本冲突以及跨站/跨房间/远程自批拒绝。其中真实Pion连接验证未批准命令不转发、批准不会重放旧命令、撤销后的新命令被拒绝。最终专项race通过7.408秒；完整remote/service race与vet通过（75.683秒、2.841秒）。

网页44文件213项测试和类型检查通过，包含显式开关确认、只读轮询不审批、写入未知结果不自动重试、远程页面没有本机权限、默认关闭不发acquire及审批后才能写。最终打包各Go包检查通过，生成三平台41文件包；Windows仅交叉编译，未在Windows机器运行。

本机真实Chrome15组完整流程通过：`.refactor/reports/room-control-browser-20261004/result.json`，退出0，4次合成prompt、provider请求0。流程包括两个访客默认直接操作、房主确认开关、申请/关闭本机审批面板/批准不自动发送、拒绝/撤销/撤回/关闭恢复直接操作，原密码/二维码/实例隔离/链接重置及手机320/390/430布局回归保留。浏览器截图已生成；首次视觉预览在捕获前自动结束（WINDOW_NOT_FOUND），第二次独立预览成功，未改用全屏捕获。

实际上线网页的同套15组流程也已全部通过，报告`.refactor/reports/room-control-public-20261004/result.json`，原操作退出0且清理完成，4次合成prompt、provider请求0。测试采用最终安装程序、真实公开页面与临时办公房间，并实际操作本机房主界面批准/拒绝/撤销；没有批准任何生产访客，没有发送用户实际模型请求。物理手机上的本机审批联动仍由用户实际使用确认。一次operation.get等待参数被工具拒绝，未变更权限或重跑原测试；最终结果从原operation.output读取。

## 部署状态与回退

本机安装、Pi登记与运行网关为`~/.local/share/pi-cafe-space/0.1.0-room-control-20261004`。安装前后身份、凭据和room-device配置摘要相同；实际room.json.control.json不存在，因此当前生产房间使用默认关闭。已核对本机配置仅本机声明roomControl能力、程序摘要、launchd运行路径及健康接口；没有通过生产审批接口变更设置或批准用户。

本次仅重载受管办公网关以启用新的后端策略，未结束Pi或其任务。旧服务文件备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-room-control.plist`；新LaunchAgent SHA`0d4979d9c599e7087f35617662499ba1caa823e6114fd1da72f02292fe45233f`。旧目录保留，不删除回退版本。新控制功能不需要Pi本身重新登录或改模型设置；刷新本机和手机网页即可。

cloud镜像`pi-cafe-space-cloud:0.1.0-room-control-20261004`，版本目录`/srv/cafe-example/pi-cafe-space/releases/room-control-20261004`。先校验新程序与原配置摘要，备份、独立37893端口冒烟，再只重建cloud；Caddy/TURN配置和启动时间不变。本机和公网当前均为`assets/index-BtIZyT5V.js`、CSS`assets/index-iqSUbShJ.css`。精确本站WSS CSP保留。

服务器回执`/srv/cafe-example/pi-cafe-space/room-control-deployment.json`，备份`backups/before-room-control-20261004`。当前Compose SHA`f02c7f4d173b576acd974eb74eece2597339c6a5bd1790533d724bf6bec9b820`；cloud配置仍为`a4e2f01142a3451608b15961dee65055718890715e59717ddfa4f64673d07fb9`。旧cloud与旧网关不认识本机审批策略；房主开启审批后，不能无审阅地回退到旧程序而声称仍保持新授权约束。

最终包`.refactor/release/pack-IXi6h0/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA`25c8f10f8aad966bad2bef18ace4b801c94a967d55a228d5652d382aff016437`；Mac程序SHA`6188aab525451fdce4083e30cf8c58ab1c69e293353917b413df44782ba8af28`，Linux程序SHA`20dbcf245659a2f3ff460d129af1e29d984d88860b5123d865dc01c09322d866`，Web摘要`c6f6ca095ea5d06b632aa7fde036590336799b1901d3340e47f32b2352552eb7`。最终项目范围diff检查通过；没有commit/push或npm/GitHub release发布。
