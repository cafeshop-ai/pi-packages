# Café账号与Space单点登录

> 公开文档中的 `/srv/cafe-example` 为脱敏后的示例目录，不是线上路径。账号协议与公共产品域名保留；具体连接信息、私钥位置和回退文件由维护者在仓库外保存，见[文档隐私规范](PRIVACY.md)。

## 当前状态：已实现并上线

2026-10-04。主站`https://www.cafecode.work`与Space`https://space.cafecode.work`已接入统一账号。用户确认这是测试环境，可直接修改原服务器项目；本机镜像仅用于编辑构建，21个明确的主站源码/部署文件已比较基线后回写`/srv/cafe-example/edel-garden`，其余原有未提交修改没有重置或覆盖。

Space本机与cloud运行`0.1.0-cafe-sso-20261004`。主站继续使用原账号、密码、2FA、刷新令牌与用户数据库，不新增Space注册或账号密码系统。新增身份服务只维护标准OIDC协议状态、应用会话及必要身份映射。

## 用户交互

首次进入Space或扫码到某个房间，明确选择「使用 Café 账号登录」或「以访客身份继续」。主站已有登录时复用原认证；没有登录时走原主站登录页。登录完成或取消均返回原Space房间，而不是丢失二维码目标。主站登录页的取消按钮也保留原房间。

账号显示主站昵称#固定ID及「Café账号」标签，访客自定义昵称并沿用原浏览器访客身份。同账号跨设备显示相同身份ID，但操作授权仍绑定本次应用登录与浏览器密钥，不自动转给其他设备；同昵称也不能冒领。已经明确选择访客时，不因为主站存在登录态而静默切成账号。

**账号登录不替代房间密码。** 两种身份都必须输入房主提供的房间密码。账号用户在Space只看见房间密码框，不再次输入账号密码。主站管理员进入私人房间仍是普通operator，不自动成为房主；审批开启时仍须明确申请和批准。批准不自动发送草稿。

身份菜单区分仅退出Space与退出所有Café应用。切换身份、退出或会话失效会断开该账号的房间连接，不取消已经运行的Pi任务。切为访客要明确选择并重新通过房间密码，不继承账号控制权。访客连接不依赖主站在线或主站登录态。

## 协议与安全边界

主站OIDC规范签发者`https://www.cafecode.work/oidc`，Space为第一方RP。采用oidc-provider 9.12.2、openid-client 6.8.8、jose 6.2.12的授权码流程，强制PKCE S256、state、nonce和精确回调。不是仅跳转主站登录，也不是把主站access/refresh token放进Space链接。

主站同源`/api/v1/auth/me`验证原有token并只映射稳定账号ID、昵称、可选头像；主站角色、余额、邮箱、模型密钥不被用来授权Space。主站侧会话与Space会话使用独立的主机限定Secure/HttpOnly Cookie。账号原密码不存入身份服务。必要的主站访问令牌及应用协议状态在AES-GCM加密SQLite记录中，密钥独立私有保存；主站和Space不共享父域Cookie。

公开授权入口仍是HTTPS主站。授权码换取token、读取OP签名密钥的后端请求通过标准客户端customFetch固定到同机身份服务，只允许/oidc/token和/oidc/jwks，不经Cloudflare传输客户端密钥。浏览器回调仍按真实HTTPS签发者校验。身份交互完成路径处于标准库交互Cookie的路径范围，OP挂载保留originalUrl/baseUrl，不放宽Cookie或回调验证。

登录跳转只携带随机事务标识，原房间key和返回目标存于浏览器本地事务记录，房间密码不持久保存。测试确认房间key和密码没有进入主站账号API。

办公网关的`accountIssuer`必须等于配置的Space公共来源+/api/identity。网关独立验证受限ES256账户声明的签名、issuer、audience、60秒期限、房间摘要、连接ID、随机数及浏览器公钥，先通过原房间密码后才加入Hub。只接受固定可信JWKS地址，拒绝重定向和算法混淆。访客签名路径、角色、当前会话与命令校验保留。

## 退出、停用与有效期

Space页面正常每15秒刷新应用会话，账号房间每20秒更新最长60秒的连接绑定身份声明。主站账户状态最多缓存15秒；主站退出、Space退出、统一退出或账号停用后不能继续换取有效声明。即使浏览器忽略退出提示，办公网关仍会在声明到期关闭账号连接。此处是有界失效，不声称所有断线立即同步；账号停用最坏受15秒缓存、60秒声明和约1秒维护周期影响。

主站原有/auth/logout被固定服务器代理先撤销关联SSO会话，再转发原主站刷新令牌注销；浏览器本地clearSession也通知身份服务。注销指纹阻止迟到的旧token同步重新建立SSO。Space单独退出不退出主站。统一退出须确认且主站账号与Space账号相同，撤销该账号全部关联的Café/Space SSO会话，并注销当前浏览器主站refresh token。**不宣称撤销了主站后端所有设备的既有API/refresh token**，主站原系统未提供这种全设备操作；其他主站设备仍遵守其原生登录策略。

标准OIDC back-channel logout端点校验RS256签名、issuer/audience、sid、事件、时间、无nonce与jti重放，仅撤销匹配应用会话。退出和撤销不终止Pi已派发任务。

## 验收

1. 身份服务10项真实标准OP/RP与存储测试通过，并在实际Node24 LTS Docker镜像构建内再次运行。包含授权码/PKCE、一次性回调、错误浏览器不可消费事务、精确回调、加密落盘与重启、独立退出、主站退出/停用、统一退出账号匹配和迟到响应、后台退出签名/重放/范围。
2. 主站TypeScript、原完整跨目录契约检查和Vite构建通过。保留旧账号登录、2FA及第三方登录组件。新增SSO路由仅为明确页面路径，未改模型API或后台业务服务。
3. Space49文件236项网页测试、TypeScript通过；完整Go remote/service race与vet通过（88.631秒/3.093秒）。新增4项账户Pion/声明回归验证错误房间密码仍拒绝、主站admin不升级、审批独立、跨设备不继承、过期声明即使客户端不退出也会断开。
4. 完整本机浏览器9组通过：`.refactor/reports/cafe-sso-browser-release-20261004/result.json`。实际主站React登录/取消页面、标准OP/RP、真实Go cloud/office和浏览器WebRTC，只有主站账户API是合成测试。一次合成主站登录、一次合成Pi消息，模型请求0。覆盖账号登录返回原房间、取消、独立房间密码、审批、退出不影响访客及不继承权限。
5. 实际公网5组通过：`.refactor/reports/cafe-sso-public-20261004/result.json`。真实www与Space路由、OIDC元数据/公钥、真实主站登录页面→取消→原房间、临时办公网关访客验密/合成Pi联动、匿名账号声明拒绝、390px无横向溢出。一次合成Pi消息，模型请求0，**没有代替用户登录真实主站账号**。真实账户登录后的后端已由上述完整合成账号联调验证，用户现有真实账号/2FA可首次实际体验确认。

首轮标准库测试曾因/oidc挂载丢失而失败，修复原始挂载元数据后通过，没有放宽协议。浏览器早期定位失败来自移动导航隐藏、语言入口和错误密码后按钮名称变化，保留各报告；修正测试按实际可见交互操作。最终支持登录取消和内部交换的候选9组通过。

## 运行位置

主站独立服务原项目：`/srv/cafe-example/edel-garden/services/identity`，Compose：`deploy/identity/compose.yaml`。容器`edel-garden-identity`、镜像`edel-garden-identity:0.1.0-cafe-sso-20261004`、镜像ID`sha256:5f7ee77d1a9ff9a89b7086016370a480d57be6e92830833077b8eab61faa5dfa`，回环监听127.0.0.1:20124，非root1000、只读程序、cap_drop ALL。实际基础运行时Node24.21.0 LTS Krypton，不可变基础镜像`node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`。

密钥：`.secrets/identity/keys.json`，用户1000、0600；数据库：`data/identity/sessions.sqlite`，父目录0700。密钥初始化只允许首次创建，未输出密钥内容。备份SQLite必须连同对应密钥安全备份，不能把keys.json提交到Git或放进前端资源。

主站新静态资源：`/srv/cafe-example/caddy/config/cafe-console/cafe-sso-20261004`，容器路径`/etc/caddy/cafe-console/cafe-sso-20261004`，实际入口JS`index-DXT-MdS7.js`。Caddy仅将88个明确React页面和确实存在的新/assets交给新静态目录；旧chunk若不在新目录仍由原Control处理，其他模型/API路由不改。身份接口不记访问日志，敏感响应no-store/no-referrer。主站Control、Gateway、数据库及TURN没有重启，Caddy仅验证后平滑reload。

Caddy当前SHA`071cc7d4c30c732f64cf2f6ed5c1aa0455a585dbc218fd29f56eae1f54eaafc0`。原配置/21文件基线/身份构建和启动报告在`/srv/cafe-example/edel-garden/data/sso-backups/cafe-sso-20261004`，Caddy原文件`Caddyfile.before`。服务器主站原HEAD为2ce0ddd7e46e170fe2c1963ab597997dea17a249，原工作树大量修改未重置。

Space本机网关：`~/.local/share/pi-cafe-space/0.1.0-cafe-sso-20261004`。原Pi扩展登记、models.json/settings.json、房间身份/密码/审批文件不改；只在room-device.json增加固定accountIssuer，再重载受管网关。没有结束手动Pi任务。旧启动与配置分别备份`~/.local/share/pi-cafe-space/deploy-space-20261003/before-cafe-sso.plist`和`before-cafe-sso-room-device.json`。新plist SHA`31163147b09d911e37bf1f7268dd157d131dfbe99595d07d3a2901a164cbfd9a`，新room-device SHA`bd1f04b931a555cbc2420a74ff906603b5865c7098f4b3f3a4a17d53bece8766`。

Spacecloud：`pi-cafe-space-cloud:0.1.0-cafe-sso-20261004`，程序`/srv/cafe-example/pi-cafe-space/releases/cafe-sso-20261004/pi-cafe-relay`。实际JS`assets/index-O6Lt3U16.js`、CSS`assets/index-pSHAdXQk.css`。Compose SHA`72c4b519be0023eb44863a93a4e75c23314f7fbeb09fb3fde4fac6a8eca04f77`，cloud.json SHA`5515d231648aa6459bb19bce532a8e067caa48d5ef20c96528c613cca8cff89a`，仅增加accountIssuer；回执`cafe-sso-deployment.json`，备份`backups/before-cafe-sso-20261004`。

首次cloud切换因原子替换文件时仅保存0400权限、未保存65532所有者，导致配置不可读；旧版本回退同样受影响。日志确认permission denied后恢复65532:65532所有权，重新切换并通过健康/能力/公网检查。该短时故障与修正均保留在原操作回执，不能把首轮失败说成未影响服务。后续回退必须保留cloud.json的65532:65532及0400，不能只恢复内容。

最终44文件包`.refactor/release/pack-m1smMe/cafecodework-pi-cafe-space-0.1.0.tgz`，SHA`e54ac493203d6fd4c9a29a37ed1afcd1ee698cc2b0e9ef3f4bce001c88b15bcd`；Mac程序`80d8fee11d539070fa6579a32ba04c88398017b09e7b3abda71d139860b303a4`，Linux程序`580ccf359afadba5a5ac741e24af2a7ebe413a4dc1f97f9f416221fb0d53df9c`，Web摘要`8d1a9edeca1e539c5e2d7ff0daee183d9753ca8ddd7cae0c3495a593e0551c5d`。Windows仅交叉编译，既有大JS分块警告保留。无需为本轮SSO重新/reload Pi，刷新主站和Space网页即可。

## 运维与边界

主站用户资料仍以原Control为准；新身份服务不是注册中心。每个接入的新办公网关须明确配置相同accountIssuer，账户路径才可用，访客不需要主站认证服务。主站/Space管理员角色不映射房主。

撤回本轮部署应同时评估主站静态/OIDC路由、身份容器、Space账号能力和办公网关信任配置；不能只删除身份容器却保持账号入口可用。恢复旧Space网关意味着不再验证Café账号，必须先停用账号入口或清理账号连接。私有密钥及原主站数据禁止随源码回退删除。

本轮未创建或修改真实主站用户、密码或数据库表。身份服务只创建自身会话数据库。原Space访客、二维码分享、控制审批、Pi终端审批和已修复的自定义思考选择均保留。

## 2026-10-05 测试环境代码发布

用户明确要求直接提交推送并上线，不以真实账号手动验收为发布前置。主站SSO的21个已部署源码/配置文件及两份说明已单独提交为`79ccaaa1ad8259aedfea6630c94bfd014351f717`，正常推送到`Shirtiny/edel-garden`的`main`并核对远端HEAD；主站原有52个无关修改文件完整保留，没有夹带提交、重置或覆盖。五个已有接入文件的HEAD字节均与SSO变更前备份一致，提交字节均匹配部署清单。

Space的SSO功能和本记录同批提交到`cafecodework/pi-packages`；具体提交以包含本记录的Git版本及远端main为准。会话数据库、签名私钥、运行凭据和构建产物均不入库。线上继续使用已验证的cafe-sso-20261004版本，不为Git提交重复重启服务或轮换密钥。真实账号/2FA尚未代替用户操作，这属于验收范围说明，不阻止本次测试环境发布。
