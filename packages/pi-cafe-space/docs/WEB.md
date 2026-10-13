# Web client

当前是一个零构建依赖的静态移动 Web 客户端，源码位于 `web/public/`，构建时复制到 `dist/relay/public/` 并由 package 内的 relay 提供。

功能：

- token 登录（token 优先放在当前 tab 的 `sessionStorage`，若浏览器策略禁止 storage 则只保留在当前页面内存；loopback 页面仅在没有已保存 token 时自动使用本地开发 token，旧 tab 中的自定义 token 会被保留）；room ID 不接受前后空白
- 连接指定 room，并在同一 room 的多个 Pi 实例之间切换；每个实例的 snapshot、事件、命令和结果都按 `hostId` 隔离
- 查看所选 Pi 实例的 snapshot、assistant/text/thinking/tool 事件
- 向所选 Pi 实例发送 prompt、steer、follow-up
- abort 和 thinking level 设置
- 断线自动重连并以 snapshot 恢复；host 替换期间显示“连接中”，不会使用尚未同步的新 session；若命令恰好撞上 relay 的 `HOST_NOT_READY` ready gate，客户端只保留该明确标记的请求，收到新的权威 snapshot 后更新 fence 再重试，不会隐式重放普通写命令
- 通过 relay 请求当前 Pi 项目中的目录和文本文件（服务端不直接读电脑磁盘）
- 查看当前项目的历史 Pi 会话和历史 transcript；host 断开后可继续读取 relay 内存中已经缓存的历史结果（relay 重启或 30 分钟缓存过期后需重新启动 Pi 刷新）

当前客户端不直接连接 Pi，也不包含任何 Pi API Key。命令携带 stream/session/project-root fence，结果带目标 `hostId`，因此切换实例、项目目录或页面重连后不会把旧结果渲染到当前实例。`PI_COLLAB_ALLOWED_ORIGINS` 只用于增加跨源浏览器 Origin；同源和兼容性的无 `Origin` 连接仍依赖 client token 认证。目标重构已确定为 React + Vite + assistant-ui + SCSS Modules，并将 Relay 迁移至 Go + Gin；详见 [Web 与 Relay 重构方案](./WEB_REFACTOR_PLAN.md)。`web/src/` 的 React/assistant-ui、Go embed和候选launcher已实现，用户本机试用服务已启动；仓库默认生产入口仍未切换。本页上文描述的是旧静态客户端；新候选、原生Pi/Chrome受控验收和外部模型403边界见 [重构进度](./refactor/PROGRESS.md) 与 [候选记录](./refactor/CANDIDATE.md)。

## 新 Web 的房间 URL（已部署到本机试用）

房间是同一Relay中的Pi实例分组，不是项目目录、单个会话或密码。新构建支持：

```text
/#/rooms/manual-trial
/#/rooms/manual-trial/history/<编码后的历史会话ID>
```

- 打开带房间地址时，URL优先于原标签页记住的房间及默认房间；登录只填写客户端令牌。
- 房间名沿用1–64字符的字母/数字/下划线/连字符规则，首字符须是字母或数字。非法路径不会连接其他房间。
- 历史、当前对话与退出登录均保留房间路径；修改地址或浏览器后退切房间会清空旧视图/草稿/待处理请求，不重放命令。
- 房间名可以进入URL；**客户端令牌不能进入URL**，仍用原登录流程及sessionStorage。
- 原根地址仍可手填房间，提交后转为带房间路径；旧未带房间的历史书签仍兼容。

2026-09-28 已经用户授权更新37983，可直接打开 `http://127.0.0.1:37983/#/rooms/manual-trial`。只需客户端令牌，不再手填房间；令牌未变。实现见PROGRESS §38，实际更新及重连证据见§40。

## 客户端与会话操作（当前本机试用版）

当前37983为`pack-GGb8q7`，刷新网页即可；现有Pi无需为这次独立新建reload或重启。新后台进程直接加载更新后的扩展，全局注册入口保持不变。“客户端实例”展示接入房间的Pi及其当前会话，可能包含暂时保留的离线实例；历史仍按所选Pi项目读取。

会话查询与管理统一放在左侧：标题行提供“+ 新建”和铅笔改名，下方为搜索、客户端实例、后台会话和历史；右侧不放新建/改名。**新建现在选择白名单项目和名称，创建独立原生Pi，不切换已有客户端。** 无在线客户端或原客户端忙碌时也能从左侧创建；收到新host权威snapshot且仍在原视图后才自动选中。后台会话提供查看/打开/确认关闭，关闭停止其任务和工具、保留Pi已保存记录；新建和改名保持紧凑表单，取消/Esc恢复触发点与原草稿。跨会话后的网页草稿仍按既有scope规则清空。

手动Pi的改名/历史继续保留原生能力、忙碌、断线未知结果和完整作用域保护；后台Pi固定属于其会话，不允许通过继续历史替换自身身份。`/new`复用独立新建表单，`/name`复用改名；手机仍在同一左侧导航里管理。后台HTTP接口沿用client凭据且有同源校验；未配置manager时明确提示不可用，不回退为切换手动Pi。详见[后台会话](MANAGED_SESSIONS.md)、PROGRESS §57。

## `/` 命令与 `@` 文件引用

输入能力首版为`pack-Kmks1J`。刷新网页，并在所选Pi空闲时执行一次`/reload`启用新扩展；部署不会替用户reload或重启Pi。2026-09-30已修复本机注册入口保留旧ESM缓存的问题：若此前reload过仍提示缺能力，需在这次入口修复后再reload一次；不是放宽网页门禁，详见PROGRESS §53。§54另补齐旧打包版Pi的安装目录已被全局升级移除时的加载：入口不再依赖旧磁盘SDK路径；若此前reload变离线，请在最新入口部署后再reload，无需重启Pi。

- 输入开头的`/`会按所选Pi列出可用扩展命令、技能和提示词模板；↑↓选择、Enter/Tab补全、Esc关闭，补全不会执行。补全后再发送执行；运行中不执行斜杠命令。相同命令名遵从Pi原生优先级。
- `/new`打开独立新建表单，`/name [名称]`打开当前会话改名面板；`/resume`打开项目历史供只读查看/确认继续；`/model`和`/thinking`打开模型/思考设置，`/thinking high`可直接设置等级。原生扩展命令仍在Pi执行，本地确认及终端UI需在Pi处理。`/reload`等仅TUI支持的命令和未知名称会明确拒绝，不当成模型prompt。
- `@`按当前项目目录补全：选择目录继续、选择文件插入`@"路径"`，支持中文和空格。普通消息会在发送时由Pi读取并附带引用文本，最多8个文件、每个64 KiB、总计128 KiB；超限、二进制、敏感路径或越界均拒绝，不发送残缺内容。输入框会列出将附带的文件，删除对应引用即可移除。`\@`或邮箱中的`@`不作为文件引用。
- 命令参数里的`@`只补全路径，具体处理遵从命令本身；不是给任意扩展命令偷偷附加文件内容。补全按目录加载，不递归索引整个仓库；`#`本轮未改动。
- 保留IME、Shift+Enter、上下文隔离、取消/断线未知结果及不重放写操作。证据见PROGRESS §52；504项TS、96项Web、隔离浏览器及真实Pi0.99.1的离线合成验收通过，无外部模型调用。

## Café Workspace 界面（已部署到本机试用）

新候选按`cafe-design`规范重做了登录、实例/历史导航、对话、输入区、工具结果、文件预览及模型设置。深色使用暖咖啡底和奶油文字，浅色使用暖纸张底；颜色、字体、间距、圆角集中在`web/src/styles/tokens.scss`。顶部主题按钮仅切换页面外观，不重连、不发送命令；主题和语言均为页面内存状态，刷新后回到默认。

仍使用React和assistant-ui的原有消息/runtime适配；没有引入第二个AgentSession、Web工具执行器或模型API。桌面保留三栏及文件收起，小屏采用焦点可恢复的抽屉；短屏为对话保留滚动空间。完整改动与实际验证边界见[设计记录](./refactor/CAFE_UI.md)。

本机试用的历史Radix部署现已由pack-ZzSXoX shadcn候选替换；界面及房间URL保持。深浅Café主题继续沿用，当前共享控件换为Base UI Select/Sheet/Tooltip，详见下文。

## 当前试用方案：shadcn/ui + Tailwind（已部署）

用户已明确改用shadcn/ui官方Base Nova组件及Tailwind v4，共享控件位于`web/src/components/ui/shadcn/`。thinking/delivery现在使用Base UI Select，抽屉用Sheet；既有Café深浅tokens映射到Tailwind，页面SCSS Modules与assistant-ui消息层保持不变。Base CSPProvider禁用style标签注入，所需CSS编译到同源外部资源，服务器CSP未放宽。

Skill已按指定命令安装到项目`.pi/skills/`。Web87 tests、真实Chrome合成UI/CSP/键盘检查及Windows嵌入候选构建通过，详见[SHADCN_UI](./refactor/SHADCN_UI.md)、PROGRESS §43。

此前pack-KLqeoM紧凑控件版：移除侧栏重复的“当前对话”，历史页保留明确返回入口；思考等级/发送方式改为紧凑横排、不撑满整行，保留40px操作高度。本次只需刷新网页，未改Pi扩展。原生会话管理沿用上一版：在会话工作区布局上补齐侧栏新建/重命名当前会话、历史页继续此会话。确认后调用原生Pi生命周期接口，保留忙碌、上下文、取消和结果未知保护；不另建AgentSession、不引入Git等扩展。历史默认只读，点击继续才切换。**已有Pi请在空闲时执行一次 `/reload`**；部署未自动reload用户Pi，旧扩展按钮禁用并显示提示。网页刷新即可加载新UI；详见[会话工作区说明](./refactor/SESSION_WORKSPACE.md)及PROGRESS §50。

沿用的pack-8liyMf修复：Composer输入框聚焦只显示包含发送操作的完整外框，不再有上半部内框；其余控件沿用pack-lVn7uC的描边修复。此前普通按钮淡底，列表/辅助操作无边框，表单细边框保留；焦点只显示一套提示，高对比度模式仍可见。仅重启Relay，3个Pi host自动重连，未改Pi/Chrome进程、会话或凭据。刷新或Ctrl+F5加载新资源；实现与部署证据见PROGRESS §45–48。

## 上一版：Radix 基础控件（历史部署，已被shadcn候选替换）

§41–42版本通过`web/src/components/ui/`使用Button、IconButton、Input、Textarea、NativeSelect、Label、Tooltip及Drawer。弹层采用Radix Dialog/Tooltip，Label采用Radix Primitives；其余保留原生表单元素，统一Café tokens与SCSS Modules样式。主题内portal保持深浅色及语言，Dialog提供背景ARIA隔离和焦点管理，原闭合details的Tab边界保护保留。

不使用Radix Select及默认Dialog Overlay的运行时样式注入，不为组件库放宽CSP；思考级别和delivery仍用原生选择器。范围和组件验证见[Radix记录](./refactor/RADIX_UI.md)与PROGRESS §41。2026-09-29经授权只更新并重启37983的Relay至pack-7Yb74q；3个在线Pi自动重连，未重启Pi/Chrome、执行Pi reload、改会话或发模型请求。部署证据见PROGRESS §42。
