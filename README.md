# cafecodework/pi-packages

## Packages

- [`pi-auto-router`](./packages/pi-auto-router) — 按任务分类路由模型与思考强度；分类器、分类依据和各档模型均可由用户配置，默认使用 Jev 与 Cafe Astra、Sol、Luna。
- [`@cafecodework/pi-cafe-space`](./packages/pi-cafe-space) — 通过 Go 网关、React 网页和 WebRTC，在手机／笔记本访问办公电脑的多个原生 Pi 实例；支持房间链接、Café 账号或访客身份、独立房间密码与可选操作审批。

- [`@cafecodework/pi-openai-search`](./packages/pi-openai-search) — 网页搜索工具，自动跟随当前 Pi 会话的 Provider、模型与凭据，无需单独配置连接，支持 Codex `/alpha/search` 协议与 Codemode。
- [`@cafecodework/pi-context`](./packages/pi-context) — 提供 `/context` 命令，显示上下文窗口使用量和分类估算。
- [`@cafecodework/pi-subagent`](./packages/pi-subagent) — 提供 `subagent` 工具，在隔离的 Pi 子进程中执行独立任务。
- [`@cafecodework/pi-theme-cafecode`](./packages/pi-theme-cafecode) — CaféCode 的 Pi 主题和界面扩展。

## Café Space 文档入口

[使用与部署概览](./packages/pi-cafe-space/README.md) · [安装与自托管](./packages/pi-cafe-space/docs/INSTALL.md) · [通用部署与回退](./packages/pi-cafe-space/docs/DEPLOYMENT_SPACE.md) · [Café 账号与 SSO](./packages/pi-cafe-space/docs/CAFE_SSO.md) · [开发交接](./packages/pi-cafe-space/docs/DEVELOPMENT_HANDOFF.md)

Space README 说明 cloud／identity／TURN／Caddy 和办公端 Pi 的分工，以及通用部署命令。实际服务器连接与运维明细保存在公开 Git 之外；文档中的用户和目录均使用明确示例。发布前检查见[文档隐私规范](./packages/pi-cafe-space/docs/PRIVACY.md)。

## 推荐配置

### 启用 Pi 内置 Codemode（Pi 0.99.0+）

推荐启用 `codemode`，让模型在 JavaScript 沙箱中编排工具调用、并行执行独立任务，并过滤大段结果。无需额外安装扩展，也无需配置 MCP。

在全局 `~/.pi/agent/settings.json` 中添加：

```json
{
  "defaultTools": ["+codemode"]
}
```

- 将此字段合并到现有配置，不要覆盖整个文件。如果已有 `defaultTools` 列表，在列表末尾追加 `"+codemode"`，保留原有工具。
- 默认模式为 `on`，原有工具仍可直接调用，不必设置 `codemode.mode`。
- 重启 Pi 后生效。项目级 `defaultTools` 或启动参数 `--tools` 若覆盖全局选择，也需要包含 `codemode`。
- 关闭时删除新增的 `"+codemode"` 条目；若 MCP 自动启用了它，还需在 `mcp.json` 顶层设置 `"autoEnableCodemode": false`。

## 推荐包

### [`i-have-adhd`](https://github.com/ayghri/i-have-adhd)

针对 ADHD / 易分心场景的交互规范扩展：强行要求第一行给动作、单步编号、抑制无关发散并提供确定性时间预估。

- **安装**：
  ```bash
  pi install https://github.com/ayghri/i-have-adhd
  ```
- **默认启用**：
  创建全局标志文件即可默认开启（每个新会话自动生效）：
  ```bash
  touch ~/.pi/agent/.i-have-adhd-always
  ```
  *(关闭方式：删除该文件 `rm ~/.pi/agent/.i-have-adhd-always`，或在会话中输入 `stop adhd mode` 临时停用)*

### [`ponytail`](https://github.com/DietrichGebert/ponytail)

极简实用主义开发技能：避免过度工程与无意义胶水代码，优先使用标准库和最少代码行解决问题。

- **安装**：
  ```bash
  pi install git:github.com/DietrichGebert/ponytail
  ```
- **用法**：
  支持 `/ponytail lite|full|ultra` 切换强度，或在对话中使用 `/ponytail-review` / `/ponytail-audit` 进行代码去臃肿审查。

### [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff)

Rust 原生、SIMD 加速的文件与文本搜索扩展，替代 Pi 默认的 `find` 和 `grep`（提供 `fffind`、`ffgrep` 工具）。

- **安装**：
  ```bash
  pi install npm:@ff-labs/pi-fff
  ```
- **推荐配置**（避免全量索引 Home 目录耗费资源）：
  在 `~/.pi/agent/pi-fff.json` 中配置：
  ```json
  {
    "enableHomeDirScanning": false
  }
  ```

### [`@benvargas/pi-openai-fast`](https://www.npmjs.com/package/@benvargas/pi-openai-fast)

OpenAI Fast 模式切换扩展，为支持的模型开启优先响应服务等级（priority service tier）。

- **安装**：
  ```bash
  pi install npm:@benvargas/pi-openai-fast
  ```

### [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)

结构化提问交互扩展。当模型需要确认决策或避免猜测时，可向用户提出带类型选项的选择题问卷。

- **安装**：
  ```bash
  pi install npm:@juicesharp/rpiv-ask-user-question
  ```

### [`pi-btw`](https://github.com/dbachelder/pi-btw)

支线插话扩展。在不中断当前任务、不污染主会话上下文的前提下，通过 `/btw` 发起独立的临时旁路问答。

- **安装**：
  ```bash
  pi install npm:pi-btw
  ```
- **用法**：
  ```bash
  /btw 这个函数的签名是什么？
  ```

### [`@narumitw/pi-goal`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal)

目标驱动的持续执行扩展：为会话维护一个可暂停、可恢复的 Goal，支持自动推进、完成/阻塞/等待状态，以及自动响应和无进展保护。

- **安装**：
  ```bash
  pi install npm:@narumitw/pi-goal
  ```
- **用法**：
  ```bash
  /goal 完成你的任务
  ```
