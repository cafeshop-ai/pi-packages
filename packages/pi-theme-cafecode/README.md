# @cafecodework/pi-theme-cafecode

面向 Pi 的 CaféCode 风格主题和界面扩展，作为 `cafecodework` 的独立主题项目维护。

## 包含内容

- 深色、浅色、ANSI 和色觉友好主题变体；
- 启动欢迎横幅；
- 模型、目录和 Git 分支状态栏；
- CaféCode 风格 spinner 和回合摘要；
- 工具调用的紧凑渲染、连续调用分组和 diff 展示；
- Thinking 内容的折叠显示；
- `❯` 风格的输入提示符；
- `/cafe-theme`、`/cafe-theme-tools` 和 `/cafe-theme-spinner` 命令。

这是一个独立维护的基础版本，后续会在此基础上继续调整颜色、布局和交互细节。

## 安装

从 monorepo 安装：

```text
pi install git:github.com/cafecodework/pi-packages
```

也可以安装本地目录：

```text
pi install C:\path\to\pi-packages\packages\pi-theme-cafecode
```

如果使用扩展自己的欢迎横幅，可以在 `~/.pi/agent/settings.json` 中关闭 Pi 默认启动头部：

```json
{ "quietStartup": true }
```

## 使用

安装后可通过 `/settings` 的 Theme 选项浏览主题，并使用以下命令进行配置：

```text
/cafe-theme
/cafe-theme-tools
/cafe-theme-spinner
```

主题 ID 统一使用 `cafe-theme-*`，例如 `cafe-theme-dark`、`cafe-theme-light`，另有 `-ansi` 和 `-daltonized` 变体，配色不变。

扩展偏好保存于 `~/.pi/settings.json`：

```json
{
  "cafe-theme": "cafe-theme-dark",
  "cafe-theme-tools-group": true,
  "cafe-theme-tools-extra-detail": false
}
```

Pi 自身的主题选择仍使用 `~/.pi/agent/settings.json` 中的 `theme` key，其值改为新的主题 ID。旧扩展设置可兼容读取，保存时改为新 key；显式设置的新 key 优先。

搭配仓库的 `pi-auto-router` 时，spinner 会在思考强度旁显示本次路由的模型，例如：

```text
Ebbing… (2m 15s · ↓ 3.9k tokens · thinking with xhigh effort · cafe/gpt-6-astra)
```

思考强度来自路由结果，不是 `router/auto` 的选中值；窄终端优先保留模型名称，缩减时间和 token 信息。

主题资源位于 `theme/`，界面扩展位于 `extension/`，后续修改这两个目录即可继续定制。

## 开发

```bash
npm install
npm run typecheck
# 在仓库根目录运行主题与路由联动的回归测试（不调用外部模型）：
node --test packages/pi-theme-cafecode/test/*.test.mjs
```

## 许可

MIT
