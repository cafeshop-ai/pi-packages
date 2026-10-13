# shadcn/ui + Tailwind 接入

2026-09-29，按用户“换成shadcn/ui方案，并接入Tailwind、安装shadcn/ui skill”的明确授权实现。**源码及新候选已验证并部署；37983现运行此候选。** 部署owner/范围及未触碰Pi、Chrome、session/模型请求的证据见PROGRESS §44。

后续修复（实现见PROGRESS §45，已按§46部署）：普通按钮默认secondary而非outline，host/文件列表用ghost；全局原生focus fallback置于base层，shadcn使用单层2px语义ring，高对比度保留系统outline。已验证的新候选见[CANDIDATE](./CANDIDATE.md)。

Composer截图反馈另见PROGRESS §47–48（已部署）：焦点提示移至包含操作按钮的完整外框，不再给textarea上半部单独画框；独立Textarea的样式保持。

## 组件与样式

- 使用官方 `@shadcn` registry 的 **Base Nova / Base UI** 实现，而不是再包装Radix。CLI实际版本 `shadcn@4.21.0`，先 `info` / `docs` / `search` / `add --dry-run`，再生成9个本地组件。配置入口：package根 `components.json`。
- `web/src/components/ui/shadcn/`：Button、Input、Textarea、Label、Sheet、Tooltip、Select、Field、Separator。选择器的两处业务入口（thinking / delivery）都接入真正的Select，不再使用原生select。Item位于Group内，字段采用Field/FieldGroup/FieldLabel。
- `Controls.tsx`只保留原业务调用的variant/loading适配，Drawer改用Sheet；没有修改Gateway/Store、assistant-ui消息/runtime、原生Pi所有权。聊天不再引入另一套shadcn聊天runtime或模型API。
- Tailwind **4.3.3** 通过 `@tailwindcss/vite` 构建成外部CSS，`web/src/styles/tailwind.css`使用语义tokens映射现有Café配色。保留深浅主题、中文/英文portal继承。Tailwind Preflight替代Web入口的normalize导入；页面/聊天SCSS Modules继续保留，**没有声称已将全站SCSS重写为Tailwind**。
- shadcn来源MIT许可保存在组件目录的LICENSE，并合入候选THIRD-PARTY-NOTICES。构建显式收集Tailwind和tw-animate-css的CSS许可，因为这些由插件内联，不一定出现在Rollup模块清单。

## CSP与本地适配

服务器仍为 `style-src 'self'; script-src 'self'`，未加入unsafe-inline、nonce或远程资源。Base UI也有可选的style注入，不能仅凭更换库就宣称解决：这里使用它公开支持的 **`CSPProvider disableStyleElements`**，把Select所需的滚动条规则放入外部CSS。真实Chrome打开Tooltip、Sheet和嵌套Select后，style标签计数及CSP violation均为0。

保留的源码适配：

1. Sheet/Tooltip/Select的portal接受当前主题容器；不挂到丢失主题的body。
2. 普通Button默认type=button，保留40px操作尺寸、稳定loading占位；主题只由语义tokens决定，去掉registry自带的dark色值覆盖。
3. Input使用原生input承载shadcn样式，保留既有HTMLInputElement ref、浏览器校验、maxLength和输入法事件，避免当前Base Input宽泛HTMLElement ref与项目React类型的冲突。Label/Textarea同样是原生语义。
4. Sheet提供标题、焦点恢复、Escape及背景隔离；保留原闭合details/hidden/inert的Tab边界回归保护。Tooltip显式保留tooltip角色，键盘focus/hover/Escape均验证。
5. 使用已有clsx与tailwind-merge组成项目`cn()`，不保留CLI新引入的另一套`cn`依赖。

已删除本项目直接依赖的Radix Dialog/Label/Tooltip及旧Controls/Drawer样式模块。assistant-ui内部仍可能有Radix传递依赖；本次没有改动或伪称删除它们。

## 依赖和skill

- `@base-ui/react@1.8.0`、`class-variance-authority@0.7.1`、`lucide-react@1.48.0`、`tailwind-merge@3.7.0`。
- 构建：`tailwindcss@4.3.3`、`@tailwindcss/vite@4.3.3`、`tw-animate-css@1.4.0`、既有版本显式声明 `postcss@8.5.26`。
- 包安装使用仓库的npm lock、Node22.23.2/npm11.16.0，禁用lifecycle；不创建pnpm-lock或改用pnpm管理应用依赖。恢复npm顺带更新的无关pi-subagent lock版本。
- 用户指定的命令实际执行为 `pnpm dlx skills add shadcn/ui --agent pi --yes`，安装到项目 `.pi/skills/shadcn/` 和 `.pi/skills/migrate-radix-to-base/`；来源与hash记录在根 `skills-lock.json`。已阅读并按前者的组件配置、官方来源、语义tokens、Field、Group和render组合规则执行。没有按后者的通用建议清理工作树或自动commit。

## 资产校验

旧资产检查一律拒绝CSS反斜线，与Tailwind合法转义选择器冲突。改为使用已经安装的PostCSS解析：只允许选择器里的转义，声明值/属性及at-rule参数仍拒绝转义，拒绝普通/混淆import、外部或缺失url、无效语法。先补失败测试，再修改共享validator，构建/发行/源码构建走同一入口。文件、总量、计数、链接/路径、动态JS引用及CSP限制不变；不是关闭校验来通过打包。

## 验证及边界

证据在 `.refactor/reports/R15-shadcn/`：

- `baseline.txt`：修改前Web check、86 tests及构建通过；`baseline-hashes.json`保存既有源码/lock边界。
- `red.txt`、`assets-red.txt`及对应后续通过记录：新增Select/资产检查回归。
- `verify-final.txt`：Web **23 files / 87 tests**、Web/package/root typecheck、assets/plugin **9**、theme **4**、shadcn约束 **2**、更新安全 **3**、Go webembed全量tests/build、实际Go+bundle集成以及25文件候选通过。
- `browser.json`：Chrome155.0.8047.0隔离profile/context，**9组检查 / 24组布局采样**，另含2种主题的Tooltip采样、320px Select边界、真实键盘选择、嵌套Sheet Escape、delivery不选不能发送、选择本身不发命令及thinking/prompt payload校验；纯合成fixture，无原生WebSocket/Pi/provider请求。
- `source-build.txt`：隔离完整源码副本的最终build/check/test验证，未动当前dist。
- `closeout.json`：源码/lock白名单、旧archive、已安装25文件、候选/浏览器资源digest和运行服务核对。

JSDOM不能可靠提供Floating UI布局；实际打开选择器的JSDOM尝试有超时记录，未通过提高timeout或假装零尺寸有效掩盖。Composer/协议集成单测使用明确的轻量选择控件替身，保留原业务断言；真实Select到Gateway的交互断言移到Chrome。浏览器初期失败来自Tooltip焦点模拟、Base的关闭列表保留DOM、嵌套列表自动聚焦时序；最终断言检查实际可见性/焦点，不要求隐藏列表必须卸载。

Vite主JS约985KB的500KB提示保留，不提高warning阈值。仍只验证Windows amd64；外部provider的历史HTTP403不重试。本轮没有部署、重启Pi/Chrome/37983、改注册或会话、执行R19、commit/push。用户自己的浏览器页面没有被导航/刷新。

后续维护从package根运行 `npx shadcn@latest info --json`，更新组件先 `add <name> --dry-run` / `--diff`；不能覆盖上述本地CSP/portal/尺寸适配。新候选位置见 [CANDIDATE](./CANDIDATE.md)。
