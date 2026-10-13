# Café Workspace UI

## 范围与来源

用户明确要求按`cafecodework/cafe-design-skill`重构Pi Cafe Space的Web页面。最初重构只重做呈现层，保留React、assistant-ui、SCSS Modules、HashRouter及现有Relay/Store/Gateway的所有权和隔离规则，没有新增依赖。后续按用户选择接入Radix基础控件，仍沿用本设计系统；该补充候选尚未部署，见[RADIX_UI](./RADIX_UI.md)及PROGRESS §41。

设计依据是`cafe-design`的`926e11c4d9cd70c8bb4d10eb5723bfb56f8c777b`：已阅读SKILL、foundations、components、motion、CSS starter、source map，并在隔离浏览器打开离线specimen。采用**Workspace**而非Public首页方案，不复制商城结构、标语、活动、价格、Café Shop字标或业务内容。使用本机字体栈，没有引入字体下载、字体文件或额外授权素材；原Pi Cafe Space图标只调整颜色。

## 设计落地

| 区域 | 实现 |
| --- | --- |
| 主题 | `web/src/styles/tokens.scss`集中管理两套Workspace配色、字体、间距、圆角、阴影、列宽和动效曲线；组件SCSS不再散落硬编码色值 |
| 深色 / 浅色 | espresso底、cream文字、caramel强调；浅色为暖纸张底；文字accent与按钮fill分离，错误/成功/警告保留语义颜色 |
| 外壳 | 稳定的小型品牌标题、房间标识、语言、主题、连接状态和退出；紧凑工具栏，不增营销hero |
| 实例 / 历史 | 选中实例、真实在线状态、紧凑ID；历史按需读取，保留房间路径及opaque ID，不造示例会话 |
| 对话 | 保留assistant-ui Provider/Thread/Message Parts和Pi runtime；用户消息与assistant正文有不同层次，Markdown/code/table、reasoning、工具卡片共享tokens |
| 工具 | 原真实ID关联、折叠生命周期和输出位置不变；参数/输出、空输出、失败、冲突仍可见，不独立成工具面板 |
| 输入 | 单一原Composer、原IME/Enter/队列/abort逻辑；输入区域与发送操作统一成面板，提示键位；busy保留标签占位和accessible name，使用三条SVG蒸汽，不让按钮跳宽 |
| 文件 / 设置 | 目录与预览按需读取，当前文件有选中态；模型设置仍折叠并由原Gateway提交，不因样式改变自动发送 |
| 登录 | 小型纸张面板、令牌用途说明、已选URL房间；token仍为password字段，不进URL或普通store |
| 空 / 错误状态 | 真实无实例、空对话、空目录、无历史、认证失败及等待本地Pi状态；不伪造模型回复、工具或可用性 |
| 响应式 | 保留既定240px / flexible / 300px桌面列和文件折叠；tablet/mobile仍是原带焦点管理的抽屉；短横屏压缩顶部和textarea，避免消息区域被挤没 |

主题是与语言一样的**当前页面内存状态**，不新增storage key；刷新默认深色。切主题/语言不重建socket、scope、工具DOM或草稿；主题不是认证状态。根main设置当前UI语言。未实现系统主题跟随或跨标签页主题同步，也不把它们列为通过项。

## 文件索引

- `web/src/styles/{tokens,global}.scss`：统一主题与基础控件；`web/index.html`和`web/static/{icon.svg,manifest.webmanifest}`：首屏/安装外壳颜色。
- `web/src/app/App.tsx` / `App.module.scss`：页面外壳、实例区、登录容器和对话上下文标题；`App.test.tsx`同步新登录标题，并保留明确未连接/不建socket断言。
- `web/src/components/ui/Icon.tsx`：静态装饰图标与BusyLabel；不包含网络、执行器或第三方图标依赖。
- `web/src/layouts/WorkspaceLayout*`：工具栏/抽屉视觉；原breakpoint/focus/Tab/关闭逻辑保留。
- `web/src/features/auth/LoginForm*`、`features/history/History*`、`features/files/FilesPane*`、`features/hosts/ModelControls*`：仅呈现和辅助说明/装饰。
- `web/src/features/chat/components/{Composer,Conversation,ToolPart,labels}*`：消息角色外观、空态、工具样式及输入布局；runtime/converter/CollapseState均未改。
- `web/src/i18n/ui.ts`：新文案双语；`web/src/app/cafeUi.test.tsx`：四项交互回归。
- `scripts/refactor/cafe-theme.test.mjs`：四项tokens/对比度/颜色集中化/首屏检查。
- `scripts/refactor/cafe-ui-{browser,fixture}.mjs`：显式开启的原生浏览器UI验收，仅合成数据，绝不进入发行包。

## 验证与边界

最终证据位于`.refactor/reports/R15-cafe-ui/`，对应[PROGRESS §39](./PROGRESS.md)。

- Web typecheck、**21 files / 82 tests**；额外**4项**theme tests验证两主题普通文本配色至少4.5:1、控件边线至少3:1、主按钮文字至少4.5:1。它们检查声明的token组合，不冒称全页面/所有状态的完整WCAG审计。
- Windows Chrome SxS，fresh独立profile、9333空闲才启动；只操作自有off-the-record context。实际生产bundle从构建staging通过该target的Fetch interception加载，采用当前服务的严格CSP；WebSocket被专用fixture替换，**0 native WebSocket / 0真实Pi或provider请求**。这是浏览器布局/行为测试，不是再次进行原生Pi或模型验收。
- **24组**几何采样：dark/light各覆盖1440×900、1280×720、1024×768、900×700、720×450、390×844、320×640、640×360；另测登录、64字符room、历史、空态、running和waiting_local_ui。断言无文档横向溢出、主要控件不出屏、发送可见、有至少48px的净消息滚动空间（非空对话）。720×450是额外小CSS viewport，不冒充真实200%浏览器缩放。
- 真实Tab/Escape焦点恢复、文件抽屉、主题/语言不丢draft/tool DOM、用户上滚不抢位置、readonly历史无composer、发送busy尺寸不变、reduced-motion、认证失败清token均通过。无runtime/console/CSP错误或外部资产请求。
- fresh Vite+Go webembed tests/build、25-file pack、真实Go+actual-bundle集成、8项assets/plugin测试及31 protected文件检查通过。未放宽CSP、帧/缓存限额、鉴权或文件策略。

### 失败与修正

1. 先写的Cafe UI四项红测暴露原页面无主题/凭据说明/空态/busy语义；实现后通过。
2. 浏览器第一次预检发现旧trial Chrome已不在9333监听，按owner gate拒绝附着；没有停止任何浏览器。改为端口确认空闲后创建新的自有SxS/profile，符合原隔离测试约束。
3. 初次CDP脚本意外返回DOM节点，序列化报`Object reference chain is too long`。修正测试表达式只返回void/标量；不是放宽应用断言。
4. 增补净对话高度检查发现640×360虽无横向溢出，消息区却只剩padding；`browser-short-red.txt`保留失败。修复short-height header/textarea布局，`browser-short-green.txt`及最终同一断言通过。

## 本机试用部署

UI实现和隔离验收完成时未更新运行中的服务。随后用户明确要求“更新和重启”，2026-09-28 已将37983的Relay更新为pack-BjCbwa；仅重启该Relay，未重启Pi/Chrome、重载Pi或改变provider。新包包含房间URL和Cafe UI，详见[CANDIDATE](./CANDIDATE.md)及PROGRESS §40。

已核对25个安装文件与archive一致、5个实际HTTP资源哈希、健康状态、3个Pi自动重连与上下文保持。旧37891/9222监听owner不变，旧archive及更新备份保留。网页入口为`http://127.0.0.1:37983/#/rooms/manual-trial`，用户自行刷新；本次部署没有新的浏览器视觉验收、模型请求、R19切换、发布或commit/push。
