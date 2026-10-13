# @cafecodework/pi-openai-search

在仓库根目录执行：

```sh
pi install ./packages/pi-openai-search
```

`openai_search` 工具通过 Codex `/alpha/search` 协议搜索和浏览网页。**自动跟随当前 Pi 会话的 Provider、模型和已有凭据，无需单独配置连接。** 不注册新的模型 Provider，不需要 MCP，也不调用聊天模型来生成搜索结果。

## 开始使用

1. 安装后在 Pi 中运行 `/reload`。
2. 直接让模型搜索，例如「搜索 OpenAI Codex 官方文档」。模型可直接调用工具，无需先运行任何配置命令。

要求 Pi **1.1.0+**、Node.js **22.19.0+**，以及当前连接支持 `/alpha/search`。切换 Pi 聊天模型后，下一次搜索自动使用新的连接，不会扫描或改用其他账户。使用 `router/auto` 等虚拟模型时，搜索复用当前分支里实际响应并发起工具调用的物理模型，不把虚拟模型的空 Base URL 当成服务地址，也不重新执行路由。

| 当前会话的 Provider | 自动使用的连接 |
| --- | --- |
| `openai-codex` | 当前登录及模型，固定请求 `https://chatgpt.com/backend-api/codex/alpha/search` |
| `cafe` 等中转 | 当前模型的 Base URL 加 `/alpha/search`，复用当前 Provider 的凭据和请求头 |

**不要为扩展添加 API Key。** 扩展通过 Pi 的模型注册表解析、刷新当前模型的凭据，不读取或复制 `auth.json`。中转不会借用直连账户的 OAuth token；`openai-codex` 只允许官方 ChatGPT 地址，并从 token 取得账户标识。

当前实际服务必须实现兼容的 `/alpha/search` 接口；普通 OpenAI-compatible `/chat/completions` 或 `/responses` 服务不一定支持。不支持时会报错，不会静默切换连接。虚拟模型尚未产生实际模型响应时，手动查看状态／测试会提示先发送一条消息；不会借用切换模型之前的旧连接。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/openai-search` 或 `/openai-search status` | 只显示当前会话连接及搜索限制；不弹选择菜单、不解析密钥、不发网络请求 |
| `/openai-search settings` | 可选：调整搜索过滤条件、输出预算和超时；不能指定连接 |
| `/openai-search test` | 使用当前会话连接查询 OpenAI Codex 官方文档；不上传聊天记录、不调用聊天模型 |
| `/openai-search reset` | 换用新的搜索会话，旧引用失效；不更改 Pi 登录信息 |

这些命令只用于查看、调试或调整搜索参数，模型正常调用工具不需要它们。TUI 中显式执行 `test` 会先确认额度消耗；无 UI 时不再弹窗。无 UI 的 SDK／RPC 场景也直接使用当前会话模型。

## 配置

**通常不需要创建配置文件。** 可选的搜索参数放在 `~/.pi/agent/pi-openai-search.json`；设置了 `PI_CODING_AGENT_DIR` 时使用该目录。仅读取此用户级文件，不读取项目同名配置。每次调用重新读取。

文件只包含搜索设置和请求限制，以下为默认值：

```json
{
  "settings": {
    "external_web_access": true,
    "allowed_callers": ["direct"]
  },
  "request": {
    "timeoutMs": 60000,
    "maxOutputTokens": 4000
  }
}
```

旧配置里的 `mode`、`direct`、`proxy` 字段会被忽略，不必手动删除；原有 `settings` 和 `request` 保留。不提供手动连接覆盖。

- 中转路径固定为 Base URL 加 `/alpha/search`：`https://proxy.example/v1` 得到 `https://proxy.example/v1/alpha/search`，不会丢失 `/v1`。
- Base URL 必须使用 HTTPS；仅 loopback（`localhost`、`127.0.0.1`、`[::1]`）允许 HTTP。禁止地址内嵌用户名、密码、查询参数或片段，也拒绝 HTTP 重定向和认证解析后的跨源跳转。
- 省略字段使用默认值；`timeoutMs` 范围为 1000–300000，`maxOutputTokens` 为 128–32000。超时包含凭据等待、串行排队和响应读取。
- 非法 JSON、未知字段、无效参数会报错，不会静默覆盖文件。设置保存先校验，再以临时文件重命名替换；检测到配置已变化时要求重新打开设置。

### 搜索设置

运行 `/openai-search settings`，或修改文件中的 `settings`。这些字段来自上游协议，**是否生效由实际服务决定**。

| 字段 | 可用值／结构 |
| --- | --- |
| `external_web_access` | `true`、`false`、`"cached"`、`"indexed"`、`"live"`；默认 `true` |
| `search_context_size` | `"low"`、`"medium"`、`"high"` |
| `filters` | `{ "allowed_domains": ["openai.com"], "blocked_domains": ["example.com"] }`；域名不带协议、路径或通配符 |
| `user_location` | `{ "type": "approximate", "country": "CN", "region": "Shanghai", "city": "Shanghai", "timezone": "Asia/Shanghai" }`；除 `type` 外均可省略 |
| 图像与调用来源 | `image_settings: { "max_results": 4, "caption": true }`；`allowed_callers` 接受 `"direct"`、`"shell"`、`"code_interpreter"`，默认 `["direct"]` |

`allowed_callers` 是发送给服务的协议设置，不会给 Pi 增加 shell／代码执行权限。提供位置会将其随请求发送，未配置时不自动推断位置。

## 工具参数

一次调用至少包含一种操作。独立操作可以组合；依赖本次新返回引用的操作必须放在下一次调用。完整字段和校验见 [src/protocol.ts](src/protocol.ts)。

| 网页操作 | 参数示例 |
| --- | --- |
| `search_query` | `[{ "q": "OpenAI Codex docs", "recency": 30, "domains": ["developers.openai.com"] }]`；`recency`／`domains` 可省略；最多 4 条，4 条时必须显式设置 `response_length` 为 `medium` 或 `long` |
| `image_query` | `[{ "q": "Mount Fuji" }]`；也接受 `recency`／`domains` |
| `open` | `[{ "ref_id": "https://example.com", "lineno": 10 }]`；行号可省略，也接受当前会话的页面引用 |
| `click` / `find` | `click: [{ "ref_id": "turn1view0", "id": 5 }]`；`find: [{ "ref_id": "https://example.com", "pattern": "Example" }]` |
| `screenshot` | `[{ "ref_id": "<PDF URL 或当前会话引用>", "pageno": 0 }]`；PDF 页码从 0 开始 |

| 专项操作 | 参数示例 |
| --- | --- |
| `finance` | `[{ "ticker": "AMD", "type": "equity", "market": "USA" }]`；类型还包括 `fund`、`crypto`、`index`；市场可省略 |
| `weather` | `[{ "location": "France, Paris", "start": "2026-10-12", "duration": 3 }]`；日期／天数可省略 |
| `sports` | `[{ "fn": "standings", "league": "nba" }]`；另支持 `schedule`，以及球队、对手、日期范围、场数、区域设置；自动补齐上游需要的 `tool: "sports"` |
| `time` | `[{ "utc_offset": "+08:00" }]` |
| `response_length` | 顶层 `"short"`、`"medium"`、`"long"`，可省略 |

### Codemode 示例

工具默认直接暴露，也可以由 Pi 内置 Codemode 调用：

```js
const result = await tools.openai_search({
  search_query: [{ q: "OpenAI Codex official documentation", domains: ["developers.openai.com"] }],
  response_length: "short"
});
text(result.output);
text(result.results);
```

结构化输出包含 `output`、可选的 `results`、`truncated`，截断时还包含 `fullOutputPath`，已识别的服务操作错误还包含 `error`。保留 `results` 缺失、`null`、空数组的区别，也保留未知结果类型；不透传顶层 `encrypted_output`。

文本和结构化结果各保留约 16 KB，文本最多 1000 行。超过展示限制时，完整已校验、已脱敏的响应写入系统临时目录，可读取 `fullOutputPath`。单次 HTTP 响应最多 2 MiB；临时文件不自动清理。图像与 PDF 结果按服务返回的文本／结构展示，不额外抓取图片二进制。

## 搜索会话与安全

- 每个 Pi 会话维护独立搜索 ID。同一连接的请求串行执行，Codemode 并发调用也会排队；取消或超时不会自动重发 POST，服务端仍可能已处理请求。
- 当前分支保存搜索 ID、连接标识哈希和最近 1024 个引用，不保存请求头或 token。恢复同一会话分支可继续使用引用；新建、fork、树跳转、连接／账户变化或手动 reset 后重新开始。上游仍可能让引用过期。
- 不上传历史消息或本地文件；只发送工具参数、用户配置的搜索设置、模型 ID、输出预算和搜索 ID。不要把密钥或私有项目内容放进查询；查询和网页结果会进入普通 Pi 会话记录。
- 网页是外部、不可信内容，不是指令。引用来源使用真实 URL 的 Markdown 链接，不把 `turn…` 内部引用当成可访问链接。已知凭据和终端控制字符会从响应中清理；不回显任意服务端错误正文。
- 支持 Pi 认证解析返回的网络代理环境及进程的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（兼容小写），只支持 HTTP(S) 代理，不支持 SOCKS／PAC。不更改全局 HTTP dispatcher，也不关闭 TLS 验证。

## 实测状态与限制

当前实现依据 [Codex `a9b0815167` 的搜索协议](https://github.com/openai/codex/blob/a9b0815167/codex-rs/codex-api/src/search.rs)。这是内部 alpha 接口，不是稳定的公共 API；账户权限、中转实现和上游版本都可能影响功能。

使用已有 **`cafe/gpt-6.1-sol`** 凭据进行的本地测试：

| 范围 | 结果 |
| --- | --- |
| 网页搜索、按原始 URL 打开／查找 | 返回可用文本 |
| 图片搜索、finance、weather、sports、time | 返回对应内容；未独立核验数据准确性 |
| 按搜索引用继续打开 | HTTP 409 `search_session_affinity_lost`；引用式 open／find／click 未验证成功 |
| 测试 PDF 的 screenshot | HTTP 200 中返回操作错误，扩展正确标为失败；不能据此声称所有 PDF 都不支持 |
| 直连 ChatGPT | 有离线账户／token／地址隔离测试；本机未登录 `openai-codex`，尚未完成真实请求验证 |

遇到 `search_session_affinity_lost` 时，改用原始 URL 做 open／find，或让中转管理员修复上游账户绑定。扩展不会静默重试同一个引用，也不会掩盖错误为「没有搜索结果」。不是所有 HTTP 200 都代表操作成功；实现识别了已观察到的错误前缀，其余情况仍需阅读返回内容。

## 开发检查

在仓库根目录运行：

```sh
npm test --workspace @cafecodework/pi-openai-search
npm run check --workspace @cafecodework/pi-openai-search
npm run typecheck
```

离线测试覆盖协议校验、凭据与地址隔离、代理隧道／绕过、响应限制、取消、配置写入、会话恢复、切换模型后的连接跟随，以及无搜索配置文件时的 Pi 实际加载器／Codemode 调用（包含虚拟模型的真实路由、工具执行与后续响应流程）。不会使用真实凭据或访问外部搜索服务。

开发用的独立真实联调脚本（参数用于模拟当前模型，不是工具的连接配置；使用已有 Pi 凭据，可能消耗额度）：

```sh
npm run test:live --workspace @cafecodework/pi-openai-search -- --provider cafe --model gpt-6.1-sol --all
```

去掉 `--all` 仅检查搜索与引用式导航。直连使用 `--direct --model <已有的 openai-codex 模型 ID>`。脚本会输出各操作结果；失败或无法验证导航时以非零状态结束，当前 `cafe` 的引用绑定限制会使完整联调退出码为 1。
