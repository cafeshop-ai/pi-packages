# Radix 基础控件接入

## 范围

用户明确选择 Radix UI Primitives 后，沿用 Café Workspace tokens、React、SCSS Modules 和 assistant-ui。这里只替换基础控件及弹层交互，不改 Relay/Store/Gateway、runtime、路由、工具执行或会话所有权，也不引入 Radix Themes、Tailwind 或第二套主题。

本文保留§41–42的历史实现记录。pack-7Yb74q曾部署于本机试用37983，现已由pack-ZzSXoX替换；当前源码及试用为[shadcn/ui + Tailwind](./SHADCN_UI.md)，部署记录见PROGRESS §44。实际部署边界见PROGRESS §42–43、[CANDIDATE](./CANDIDATE.md)。

## 依赖与组件

将已经存在于依赖图的版本声明为此workspace的直接依赖：

- `@radix-ui/react-dialog@1.1.23`
- `@radix-ui/react-tooltip@1.2.16`
- `@radix-ui/react-label@2.1.15`

Node22.23.2/npm11.16.0离线安装，禁用lifecycle；没有新增包版本或升级其他workspace。根lock只增加这三个声明。API核对来自Radix官方Dialog/Tooltip/Label文档及以上实际安装版本的types/source。

所有业务页面从`web/src/components/ui/`使用控件：

| 文件 | 职责 |
| --- | --- |
| `Controls.tsx` / `Controls.module.scss` | 共享Button、IconButton、Input、Textarea、NativeSelect、Radix Label；基础尺寸、边框、primary/quiet及disabled/loading样式 |
| `UiProvider.tsx` | 共享Tooltip Provider及主题内部portal容器 |
| `Tooltip.tsx` | Radix Tooltip，支持键盘焦点、hover、Escape和碰撞定位；可见状态只属于组件 |
| `Drawer.tsx` / `Drawer.module.scss` | Radix modal Dialog，实例/文件抽屉共用，标题、关闭、焦点、Escape及外部点击 |

`Button`默认`type="button"`，提交按钮须显式指定`type="submit"`；`loading`同时提供稳定的蒸汽占位、`aria-busy`及disabled。原来的busy业务锁、Gateway gate仍保留，不能仅靠disabled阻止重复操作。输入控件透传原生ref、required、maxLength、输入法和键盘事件。

使用示例：

```tsx
<main data-theme="dark" lang="zh-CN">
  <UiProvider>
    <Label htmlFor="client-token">客户端令牌</Label>
    <Input id="client-token" type="password" maxLength={4096} required />
    <Button type="submit" variant="primary" loading={connecting}>连接</Button>
    <IconButton label="切换主题" onClick={toggleTheme}>
      <Icon name="sun" />
    </IconButton>
  </UiProvider>
</main>
```

`UiProvider`必须位于带主题和语言属性的main内，portal落在workspace的inert面板之外；因此浅色Tooltip/Drawer不会掉回body的默认深色。不要在各页面单独创建body portal、复制皮肤或再包一个主题Provider。

## 严格 CSP 与原生选择器

沿用服务器的`style-src 'self'`，不加`unsafe-inline`、nonce白名单或内联style标签，不修改依赖源码。

- 当前Radix Select内部固定使用RemoveScroll，Viewport也注入style标签。**本次没有采用Radix Select**；思考级别、delivery仍使用统一样式的`NativeSelect`，保留空值、原生移动端选择器及已有事件语义。
- Dialog的默认Overlay同样会触发RemoveScroll运行时样式；这里使用Radix Content的modal交互和外部SCSS遮罩。现有shell已限制滚动区域，抽屉自身滚动且设置overscroll containment，不需要注入body滚动锁样式。
- Radix FocusScope负责焦点约束，保留原来的闭合details/hidden/inert/disabled边界过滤，防止闭合模型设置中的输入框误入Tab循环。
- Portal、定位和焦点辅助节点在真实Chrome及现有CSP下验证；没有把JSDOM结果当作CSP或布局证据。

原生button/input/textarea/select不是“漏迁移”：它们保留浏览器表单语义；交互复杂的Dialog/Tooltip交给Radix。当前没有新增不需要的DropdownMenu、Popover、Toast等依赖或控件。

## 验证与失败记录

证据：`.refactor/reports/R15-radix/`。

- `verify-final.txt`退出0：Web **22 files / 86 tests**；Web/package/root类型检查；8项资产/plugin检查、4项主题/对比度、3项已有更新安全测试；fresh Vite6.4.3、Go1.24.2 webembed tests/build、25-file pack和实际Go+嵌入React bundle集成通过。
- Chrome155.0.8047.0：**8组检查、24组布局采样、2组Tooltip定位/主题采样**。深浅主题、桌面/短屏/手机、真实focus/hover/Escape/Tab、外部点击、断点变化清理、背景ARIA隔离、焦点恢复、closed details、busy尺寸、草稿/工具DOM/滚动保持、只读历史与鉴权失败均验证。没有截屏或完整WCAG审计。
- 隔离profile/context、合成WebSocket，0真实WebSocket、无真实Pi命令或provider请求；现有监听owner、已安装包和旧archive不变。临时浏览器、profile、context及integration进程已清理。
- 先保存before快照并写红测。最初抽屉测试在Radix异步恢复焦点前断言失败，改用waitFor保留同一焦点要求。Tooltip的JSDOM路径反复超时；未声称定位了库缺陷，也没有提高timeout。其完整focus/hover/Escape/portal断言移到真实Chrome，单测保留基础语义及本地操作；未用mock伪造最终通过。
- 第一次浏览器focus检查因为自有background target未获得前台焦点而失败，后来只对自有target启用focus emulation并bringToFront。新增hover退出测试最初只发送一次远距离移动，停在Radix刚建立的grace polygon上；补充越过该区域的第二次移动后通过，没有关闭hoverable content。
- 初次手动Vite命令误用根Vite7，日志保留，不作为核准构建证据；随后包内Vite6及最终npm流程重新构建。npm顺带修改的无关pi-subagent lock版本已恢复为本轮before值，最终结构比较只有三个声明差异。
- `closeout.json`核对允许修改的Web文件、依赖/lock范围、TS digest不变、最终archive及浏览器实际asset哈希一致。sa-14只读子任务超时，无审查结论被采用。

主JS chunk约836.06kB的Vite警告仍保留，没有放宽阈值。未重跑外部模型、原生Pi工具专项或Go race/fuzz；这些不因基础控件测试通过而视为重新验收。

## 本机试用部署

2026-09-29用户明确“更新”后，将37983安装包更新为本节archive。精确25文件包差异仅为README、Relay executable、build.json及package.json四项；其余21项逐文件哈希不变。没有npm install/lifecycle；Trial archive引用同步更新。仅重启已核对身份的Relay，3个原在线Pi ready重连且上下文摘要保持；没有Pi reload、Chrome控制、会话写入或provider请求。5个实际HTTP资源哈希和新binary身份核验通过，详见PROGRESS §42。

当前入口为`http://127.0.0.1:37983/#/rooms/manual-trial`，已有浏览器标签刷新或Ctrl+F5后即可使用。本次不包含新的视觉/模型验收，不构成R19生产切换；外部provider 403状态不变。
