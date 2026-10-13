# 会话工作区：OpenChamber交互参考，Café视觉实现

## 参考与范围

参考 [OpenChamber](https://openchamber.dev) 的官方桌面/手机截图，以及其 [公开源码](https://github.com/openchamber/openchamber/tree/566ba61852526ab30800c3a0cb82e51825d8bc60) 中的ChatContainer与SidebarHeader。参考重点是会话优先的侧栏、明确的当前上下文、收起辅助面板、独立滚动的对话、贴近输入框的模型操作，以及手动上翻后的回到底部入口。官网截图不是可交互demo；本轮没有运行或安装OpenChamber。

没有移植其源码、图标、商标、依赖、OpenCode runtime或业务模块。保留本项目Café深浅主题、字体与语义tokens，以及React、SCSS Modules、shadcn/Base UI、assistant-ui外部Store runtime。未引入Git、worktree、终端、任务调度等功能。

## 已实现

- 合并原全局栏和工作区工具栏。桌面左侧会话导航可收起；文件栏默认关闭，按需展开。手机会话/文件使用既有Sheet，不替换中央Composer或工具节点。
- 当前Pi会话以紧凑行展示名称、项目路径、在线状态。搜索同时匹配活动实例和所选实例的历史元数据；清除搜索恢复完整列表，不发送搜索命令。
- 选定实例后自动读取历史；按最近修改排序并分为今天、昨天、更早。显示真实消息数、日期、选中状态；保留手动刷新、错误/空列表/无匹配及截断提示。
- 路由改变时复用既有有界history缓存，仅允许完整scope（room/host/stream/session/cwd）和host revision匹配的列表，后台继续刷新。没有新增无界缓存，也不会用另一实例或旧上下文的结果填充列表。
- 对话标题显示实际会话/路径和就绪、运行、等待本地输入状态。历史页有明确的只读标题和返回当前对话入口；opaque session ID继续按既有HashRouter规则编码。
- 模型与思考设置由侧栏移到输入区按钮打开的Sheet中；复用现有Gateway命令、校验和Select，手机嵌套Select先关闭自身再关闭Sheet。
- 正文适度放大、用户消息使用轻底色、思考区减少盒状边界。复制消息只在用户点击时写剪贴板，只复制文本part，失败有反馈；工具结果、原始HTML和思考不混进文本复制。
- 上翻不会因流式更新或切换主题被拉回；出现“回到最新”按钮，明确点击后恢复跟随。发送和中止仍经Gateway，空闲时不显示无用的中止按钮；运行时仍要求明确选择steer/followUp。保留IME、Shift+Enter、单次发送、结果未知及本地Pi等待语义。

## 原生会话管理（2026-09-29 补齐）

- 侧栏提供**新建会话**与**重命名当前会话**；历史预览提供**继续此会话**。历史本身仍是只读预览，明确确认后才切换所选 Pi 实例，不创建第二个实例或 Web-owned AgentSession。
- 命令贯通 TypeScript/Go 协议、Relay、Gateway 与 Pi extension。新建/继续调用原生 `ExtensionCommandContext.newSession/switchSession`；改名调用 `pi.setSessionName`，由既有 `session_info_changed` 更新投影。没有直接改写用户会话文件。
- 新命令要求在线/ready、`sessionControl: true` 能力声明与完整 stream/session/cwd 校验。运行、等待本地 UI 或有排队消息时拒绝切换；异步查找后再次检查上下文和原生空闲状态。继续只接受当前项目/会话目录内的 opaque ID，不接受客户端路径。
- 确认面板说明目标 Pi、草稿清空和本地确认。保留 Pi 的 before-switch 取消钩子；取消返回 `SESSION_CANCELLED`。新建/继续的 `dispatched` 仅表示 Pi 已接受交接，完成状态以新扩展重连后的快照为准；超时/断连不自动重发，也不谎报成功。
- **已有 Pi 需要在空闲时执行一次 `/reload`。** 部署只更新扩展文件，不自动重启/reload 用户 Pi；旧扩展上的按钮禁用并显示提示。新的普通 Pi 启动会加载新版本。

尚未实现删除会话、直接改名未加载的历史或跨会话草稿保存。先继续某历史，便可改名当前会话。空会话的持久化时机遵循 Pi 原生行为。草稿仍遵守既有 scope/view fence：开关面板、主题、语言与改名保留当前草稿，切换会话/房间/历史视图清空。

## 验证与部署

- Web typecheck，23 files / 91 tests。新增会话过滤/排序/日期边界、剪贴板成功/失败、自动历史读与scope、同scope缓存连续展示及折叠侧栏保留输入节点测试。
- theme4、shadcn2、assets8及实际Go+编译Web集成通过；正式pack执行Go webembed测试与Windows amd64构建，25文件候选。
- 隔离Chrome SxS：10组检查、24组布局，覆盖1440、1280、1024、900、720、640、390、320宽度及短屏、深浅主题、Sheet/Tooltip/Select真实键盘、只读历史、运行/等待/认证失败、严格CSP。额外检查侧栏无内部横向溢出、搜索/清除、面板开关保留草稿、回到最新、Composer单边界及forced-colors。剪贴板业务使用隔离单元mock检查，未写用户系统剪贴板。
- 上述布局首版为`pack-eJNDdn`，见[PROGRESS §49](./PROGRESS.md)。当前本机37983已部署会话管理补齐版`pack-kvUZKf`，详见§50。未控制用户Chrome、重启/reload用户Pi、调用真实模型、commit/push或切换生产。
- 会话管理补齐版：主TS 13 files/491 tests，Web 23 files/93 tests；正式25文件pack、Go webembed/build与Go+编译bundle集成通过。隔离Chrome11组/24布局验证桌面/手机嵌套确认、Escape、草稿保留/清空、取消反馈、opaque历史继续。另以**全新隔离 Pi 0.85.1 + 候选Go Relay**完成5组原生生命周期检查，含真实持久化改名、本地确认取消后恢复空闲、新建/继续和旧上下文拒绝；0 agent turn、0 provider call，临时进程/目录已清理。证据：`.refactor/reports/R15-session-controls/`。
- 证据：`.refactor/reports/R15-session-workspace/`；桌面/手机深浅截图`workspace-{dark,light}-{1440,390}.png`及`history-dark-1440.png`均为合成数据，不是用户会话或真实模型验收。
