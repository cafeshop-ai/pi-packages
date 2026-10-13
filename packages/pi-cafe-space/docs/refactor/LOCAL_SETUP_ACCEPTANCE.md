# Café Space 本机首次初始化验收

## 最终补充：6–20位，无复杂度规则（2026-10-03）

按用户进一步补充，新的访问令牌限定6–20位，随机按钮生成20位；不要求大小写、数字或符号组合，输入的首尾空白/控制字符仍拒绝。网页属性、提示、前端提交与后端首次保存保持一致。已保存的历史较长令牌仍可读取登录，不做截断、轮换或重置；增加了相应重启兼容回归。以下上一轮256位上限不再适用于新设置。

最终Web类型检查、30文件137项测试通过，config/service race及构建时Go11包通过；真实浏览器和Pi针对最终稳定安装的5组端到端验收通过，截图和报告位于 `.refactor/reports/setup-style-6-20-20261003/`。随机生成长度20位及6位简单值的保存、登录与重启均实际验证。没有模型调用。

当前启用安装为 `/Users/example-user/.local/share/pi-cafe-space/0.1.0-setup-ui-6-20-20261003`。LaunchAgent已重载，HTTP返回 `index-BYfuWciM.js`；Mac二进制SHA-256 `112f5612bc15e6be6f08e85c22d068ef3bd97bf374264e49ac866ddde85bde58`，Web摘要 `f07edf9f93bc558e6643ecbc02ed4624338aba8e7990c9c4e692885b6e73f889`。最终检查发现本机已完成初始化（setupRequired=false），凭据在本次重载前后字节摘要相同，未读取输出或改写令牌。保留原安装目录，未重启用户Pi。为展示新表单而清空设置不属于本轮操作。

## 上一轮修订：原工作台风格与最低6位令牌（2026-10-03）

已按用户反馈移除概念图式装饰，实际页面沿用原有主题变量、字体、通用控件。初始化卡片宽440px，标题24px，标签左对齐，桌面输入框40px，生成随机令牌为标签行辅助操作，显示/隐藏内嵌输入框，仅保留一个主按钮。没有新增背景图、渐变或另一套主题；主工作区样式未变。320px及390px浏览器视口均验证无横向溢出，保存按钮可见。

用户最新要求为自定义令牌最低6位，不设复杂度门槛；纯数字、重复字符、中文都可用。前后端一致拒绝不足6位、超过256 UTF-16单元、首尾空白和控制字符。内部Pi host密钥仍独立随机生成；同源、挑战、并发初始化与私有文件保护未移除。本节替代下方首版记录的强度规则。

最终Web类型检查及30文件135项测试通过（初始化表单13项）；config/service race通过；三平台构建时Go11包通过。真实Chrome与Pi0.99.1直接使用新稳定安装，在临时端口/凭据目录完成5组验收，包含六位简单令牌保存登录、同一Pi自动接入、重新启动保留凭据，以及原风格布局尺寸。provider请求0。证据位于 `.refactor/reports/setup-style-min6-20261003/`，截图均为空表单，不含用户令牌。桌面窄屏不等于手机真机验收；Linux/Windows仅交叉编译。

实际已启用 `/Users/example-user/.local/share/pi-cafe-space/0.1.0-setup-ui-20261003`，旧安装目录保留。LaunchAgent仅切换二进制路径，凭据路径不变。新Mac二进制SHA-256为 `e60e014502be8b7caaa660fbe9efc32b8da45954d2cd77c2ad74f71fccd15b35`，Web摘要 `0e8d67fedee6e1f81aa470e5d60dfb90cc5633c376dec39db85911db005db683`。首次紧接bootout的bootstrap返回I/O错误；读取确认服务不存在、未监听后，仅重试bootstrap成功。最终实际HTTP返回新页面资源 `index-DVFAMcRZ.js`，setupRequired=true，正式令牌文件仍不存在，未代用户设置。Pi进程未被关闭。浏览器刷新即可看到新版表单。

## 首版历史记录（以下为当时的行为与验证）

2026-10-03 UTC，基于现有 main@3987e9c 未提交工作树。此次仅新增本机首次访问令牌初始化、状态显示与安装更新；不是新增公网服务器部署，也没有调用模型。

## 行为

Pi 状态栏统一为 `café space: connected` / `connecting` / `reconnecting` / `disconnected`。本机尚未设置令牌时显示 `café space: setup required` 并提示网页地址。网页支持自定义令牌、确认输入和由用户点击生成随机令牌，页面加载不会自动保存。

初始化前 `/api/config` 返回 `setupRequired:true`，`/ws` 返回 423。初始化仅接受 loopback、字面 Host、同源请求与随机挑战；拒绝重复字段、超大请求和明显弱令牌。凭据完整写入私有临时文件，再以不覆盖方式发布；并发初始化仅一个成功。初始化后接口不返回令牌、不允许再次覆盖。损坏/公开可读的凭据不降级为开发默认值。

本机文件保存独立的网页访问令牌与随机 Pi host 密钥。该文件依赖 OS 用户权限保护，不宣称加密存储。浏览器只得到保存确认；Pi 从本机私有文件读取 host 密钥。用户选择的令牌仅进入现有网页登录流程。

## 本轮证据

- 主 TypeScript：14 文件，507 测试通过；含状态栏精确文本、凭据文件权限和端口范围测试。
- Web：30 文件，128 测试通过；含 6 项初始化表单与缓存令牌不得在初始化前发送的回归。
- 主包、Web 类型检查退出 0；Go 全部 11 包测试和 `go vet ./...` 退出 0。
- `go test -race -count=1 ./internal/service ./internal/config` 通过；新增 5 个本机初始化顶层测试（含跨源、并发、持久化、损坏文件和真实 WS 新旧令牌认证子用例）。
- `scripts/remote/onboarding-test.mjs` 使用真实 Pi 0.99.1、独立 Chrome Canary 157.0.8084.0、随机 loopback 端口和临时凭据目录，4 组端到端验证通过。保存自定义令牌后同一 Pi 自动连接，没有为了初始化重启 Pi；服务重启保留凭据并重连。新浏览器只看到登录页，旧开发 token 被拒绝。390px 视口无横向溢出。
- 报告与截图：`.refactor/reports/local-onboarding-20261003/`。这是桌面 Chrome 窄屏，不是真机手机验收。
- 新三平台候选构建成功；Mac 业务二进制 SHA-256 为 `84eb9c9703dfe378f8e61829de584628d799fa6aaf451f796123049d6ee5f598`，Web 摘要 `a6716ae7cb8acbe71f3d9215d888816bd3b69e6ab8287d61e21457846502cab1`。Linux/Windows 仅交叉编译，不冒充运行验收。

## 本机安装

已将用户包切换到 `/Users/example-user/.local/share/pi-cafe-space/0.1.0-onboarding-20261003`，复用已核实的 ws 8.21.3；原 `0.1.0` 目录保留。Pi 原生 install/remove 只变更 Café Space 包登记，未写入模型/provider 配置。

LaunchAgent `com.cafecodework.pi-cafe-relay` 指向新版稳定二进制，监听 `127.0.0.1:37891`，去除固定开发令牌，显式使用 `/Users/example-user/.config/pi-cafe-space/credentials-37891.json` 与 HOME。实际安装验证时服务运行，返回 setupRequired=true；该凭据文件不存在，未代用户设置正式令牌。用已安装扩展做只读 RPC 验证，得到 `café space: setup required`，退出 0；没有 prompt/provider 请求。

当前已运行的旧 Pi 进程须原生 `/reload` 或新启动才能加载新扩展；网页刷新不替终端换代码。首次保存后新版 Pi 的凭据采用则不要求再重启。

不自动迁移显式自定义 token、云端账户或 managed 配置。服务仍仅本机可访问。本机账户/管理员属于信任边界；忘记令牌不通过未认证网页重置。本轮格式化工具返回独立元数据错误，未执行也未换通道格式化；其余编译、运行及安装证据如上。
