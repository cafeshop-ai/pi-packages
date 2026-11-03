# ACP 接入实验

**源码阶段：** Pi 与 Codex ACP 已接入托管 manager/API/网页流程；ACP 脚本进入候选发行 allowlist。新建/借用仍不是生产验收：尚未实机跑 Go 网关 + 浏览器 + 真实终端或部署。Pi 原生接入不替换。任务见仓库根 `.trellis/tasks/11-02-space-acp-v1/`。

本任务 **2 次真实 prompt 预算已全部使用**：一次临时新会话、一次用户确认的已有会话。没有自动重试。后续默认只跑离线测试；不得换输出目录绕过人工总预算。prompt 次数不是供应商 HTTP 次数，内部请求/重试未抓包统计。

## 当前能力

| 能力 | 证据/边界 |
| --- | --- |
| ACP v1 initialize、新建、文本 | 固定 `codex-acp 2.5.0` 本机 smoke 通过 |
| 已有活动会话挂接 | 受控 WebSocket-over-native-proxy；剥除模型、权限、MCP、instructions 覆盖；不回放历史 |
| 同一个活动 turn | ACP 与独立 native observer 收到同一 turn 的固定短回复，`end_turn`；挂接/发提示前后配置指纹一致 |
| Terminal display, real cancel/approval | The user confirmed the same-turn text in the native terminal; real cancel/approval remain unverified. Observer output alone is not terminal-display evidence. |
| Space 主机通道 | `space-host.mjs` 复用现有 host hello/snapshot/event/routed_command；官方 SDK + 假 Agent + loopback WS 端到端离线测试通过；不是生产 Go 网关+浏览器实测 |
| 网页能力 | 可选 `snapshot.agent` 在 TS/Go codec 保留；托管会话可选择 Pi/Codex ACP；模型设置禁用，运行中不提供 steer/followUp；旧 Pi 未提供此字段时行为不变 |
| 已有会话枚举/借用 | 管理权限用户只看到批准项目内会话名称、cwd、状态；不读 transcript；当前仅 Windows ACP socket；仅 idle 可选；关闭 borrowed host 只断开 |
| Manager 注册/正式包 | Go manager 保存 ACP metadata 和本机 session ID；浏览器不接收原生 session ID/ACP env；ACP scripts are packaged in the audited candidate and installed locally with explicit authorization; production acceptance remains pending |
| ACP v2、第二种 Agent、真实浏览器/终端、Linux attach | 未验收；不假装支持 |

## 离线测试（Windows PowerShell，仓库根）

如已存在隔离 SDK 安装目录，显式指定它；不自动安装、升级或访问真实 Codex：

```powershell
$env:CAFE_ACP_ROOT = 'C:/path/to/existing/isolated-acp-install'
npm run acp:test --workspace=@cafecodework/pi-cafe-space
npm test --workspace=@cafecodework/pi-cafe-space
npm run refactor:web:test --workspace=@cafecodework/pi-cafe-space
```

缺少 `CAFE_ACP_ROOT` 时，官方 SDK/自有子进程测试及一个 Space fixture 测试跳过。其余单元测试照常运行。fixture 的 prompt 是发送给本地假 Agent 的 JSON-RPC，不是模型调用。

## 实验 Space host 入口（仅源码 checkout，需再次授权真实使用）

**The audited local candidate now includes this entrypoint and has been installed with explicit authorization. Installation is not full production acceptance; no Pi reload or gateway restart was performed automatically.** 不会自动修改安装、启动网关或接管用户会话。不要在已经耗尽本任务预算的情况下运行可发送提示的配置。

先在源码 checkout 编译协议：`npx tsc -p packages/pi-cafe-space/tsconfig.json`。这只生成 checkout 内的 `dist`，不安装或重载 Pi。旧编译产物不支持 `snapshot.agent` 时入口必须拒绝启动。

本地操作者准备独立私有 JSON；不从房间消息或网页接收可执行文件、项目路径、socket、SDK 路径或 token。以下全为占位符，不能原样运行：

```json
{
  "mode": "new",
  "relayUrl": "ws://127.0.0.1:37891/ws",
  "roomId": "your-local-computer-room",
  "hostId": "codex-acp-local",
  "token": "REPLACE_WITH_EXISTING_HIGH_ENTROPY_HOST_TOKEN",
  "acpRoot": "C:/private/isolated-acp-install",
  "codex": "C:/path/to/installed/native/codex.exe",
  "cwd": "C:/explicitly-approved/project",
  "stateDirectory": "C:/private/unique-acp-host-attempt",
  "promptBudget": 0
}
```

- `mode: new` 创建本次拥有的只读会话；上限 0–2 次 prompt。只关闭自有 adapter/App Server，不操作 Pi。
- `mode: attach` 必须移除 `cwd`，增加绝对 `socket` 和经用户 `/status` 确认的 `threadId`；上限 0–1 次 prompt。cwd 来自 native 元数据，必须是已经 loaded 且 idle 的会话。共享 launcher 当前仅 Windows 验证。
- `promptBudget: 0` 不允许模型提示，但启动/握手仍可能发账户、模型列表等非推理请求。只有获得新授权后才可提高预算。
- JSON 在 POSIX 须 mode 600；Windows 须操作者设置私有 ACL。不得提交或分享配置；host token 不输出到日志。
- `stateDirectory/host-attempt.json` 独占创建，失败/断线后也保留，禁止自动重跑；共享提示另有 `.prompt-attempt` 发送前持久标记。人工核查未知结果后才能决定新的尝试，不能自动清除标记或换目录。

```powershell
npm run acp:space --workspace=@cafecodework/pi-cafe-space -- --config C:/private/acp-host.json
```

入口只允许 loopback `ws`，必须使用强 host token；不自行发现本机凭据。进入 Space 后仍使用现有网关的房间认证、控制权与设备授权。讨论房间成员身份不授予电脑控制权。

## 运行语义

- 每次连接有新 stream fence；所有命令校验 stream/session/cwd。命令按 sourcePeerId/clientRequestId 去重；冲突拒绝，达到有界容量时停止接受，不能丢弃未知写后自动重发。
- 只支持短文本 prompt 和取消本连接正在执行的 turn；文件附件、steer/followUp、模型/权限切换、历史/生命周期命令明确拒绝。取消外部终端 turn 不支持。
- `dispatched` 不等于 turn 完成；只有 ACP prompt 返回才报告 `applied`。失去响应/连接进入未知状态，不重试。所有权限请求拒绝，不提供 ACP 客户端文件/terminal API；这不是限制 Agent 自有工具的 OS 沙箱。
- Transcript 只来自真实 Agent 通知，不把请求正文伪装成 Agent 回显。文本/思考/工具输出有界；截断后发布权威 snapshot。已有历史不回放，`historyTruncated: true`。
- `Ctrl+C` 或主机通道断开仅关闭本次拥有的 adapter/proxy；借用 daemon/TUI 不关闭。进程 cleanup 没有按进程名全局查杀。

## 只读共享后台检查（0 prompt）

先由用户保持 Codex 终端开启，从原生 daemon status 获得现有 socket；不要为了测试 start/restart/update。

```powershell
npm run acp:shared-check --workspace=@cafecodework/pi-cafe-space -- --codex C:/path/to/codex.exe --socket C:/path/to/control.sock
```

只允许 initialize/initialized/thread/loaded/list，两个独立客户端比较 loaded IDs，不通过 title/preview/history 猜测目标。原始 proxy 是字节流，必须在其上做 WebSocket upgrade。

`acp:shared-probe` 提供已实现的零 prompt attach-only 与独立授权的 `--live` 路径。已有 live 报告已经足够，不要在本任务再次执行。`acp:probe` 的新建 smoke 与只读/low 配置只适用于自有临时新会话，不能覆盖已有会话。

## 交付门槛

Candidate packaging/audit and the authorized local install are complete. Explicit local configuration and Go gateway/browser/native-terminal acceptance are still required.审批/取消真实验收、ACP 未知结果/崩溃恢复、Linux attach、第二种 Agent 仍未完成。不得将当前源码能力描述为完整上线的通用 Agent 支持。
