# 独立后台会话（Go 候选 / 本机进程所有权）

远程版已包含 Windows Job Object 与 macOS/Linux POSIX supervisor；本轮 macOS arm64 原生 Pi 0.99.1 生命周期验收见 [REMOTE_ACCEPTANCE](refactor/REMOTE_ACCEPTANCE.md)。Linux/Windows 新远程版仍需目标平台运行验收。网页连接、角色和控制权配置见 [REMOTE_ACCESS](REMOTE_ACCESS.md)。

左侧 **新建** 创建新的后台 Pi，而不是向当前客户端发送 `new_session`。没有在线客户端、或原客户端正在工作时也可以创建。现有手动 Pi 的进程、会话和项目均不改变；新会话就绪并收到权威 snapshot 后，只有发起操作且仍在原视图的网页会选中它。

## 本机配置

以下 JSON 是历史 Windows 配置示例（Node 22.23.2、原生 Pi 0.99.1）；Mac/Linux 应使用自身的绝对可执行路径和显式 OS 环境。本轮 Mac 使用 Node 24.0.2 与原生 Pi 0.99.1，未使用真实 provider。需使用支持 `--session-id`、`--offline`、`--no-approve` 的 Pi CLI；不提供对旧 CLI 的提示词降级。先建立专用管理目录，然后令 `PI_COLLAB_MANAGED_CONFIG` 指向本机 JSON 文件。通过 Go binary、候选 `run-relay.mjs` 或 `start-relay.ps1` 显式启动；普通扩展自动启动不会隐式启用管理器。

```json
{
  "node": "C:/Tools/node/node.exe",
  "cli": "C:/Tools/pi/dist/bundle/cli.js",
  "extension": "C:/Packages/pi-cafe-space/dist/extension/index.js",
  "agentDir": "C:/Users/me/.pi/agent",
  "stateDir": "C:/Users/me/cafe-managed",
  "env": {
    "SystemRoot": "C:/Windows",
    "USERPROFILE": "C:/Users/me",
    "APPDATA": "C:/Users/me/AppData/Roaming",
    "LOCALAPPDATA": "C:/Users/me/AppData/Local",
    "TEMP": "C:/Users/me/AppData/Local/Temp",
    "TMP": "C:/Users/me/AppData/Local/Temp",
    "PATH": "C:/Tools/git/bin;C:/Tools/node;C:/Windows/System32",
    "PATHEXT": ".COM;.EXE;.BAT;.CMD"
  },
  "projects": [
    { "id": "workspace", "name": "My workspace", "room": "main", "cwd": "C:/Projects/workspace" }
  ]
}
```

路径必须存在且为绝对路径。CLI、扩展、项目和 agent/state 目录启动时规范化；项目 ID 与规范化 cwd/room 一起写入登记，不能借重新配置同一个 ID 来把已有会话迁入其他项目。最多 16 个项目，网页只能选择项目 ID，不能传入路径、可执行文件、CLI 参数或环境变量。

管理器仅允许 loopback bind，且 host/client token 必须显式、高熵、非默认、非 placeholder、彼此不同。JSON `env` 是本机管理员给 Pi 的环境，不是 Relay 的整个环境继承；不接受 `NODE_OPTIONS`、`NODE_PATH` 和 `PI_COLLAB_*` 覆写。不要把此文件、原生 agent 目录或 Relay 凭据交给网页。实际 provider 凭据由原生 Pi 从 `agentDir` 读取；管理 API 不读取、回传或复制它们。

后台 Pi 以 `--mode rpc --offline --no-extensions -e <固定扩展> --no-approve --no-themes` 启动。`--offline` 禁止自动启动联网，不禁止用户后续明确发送的模型请求。仅加载固定协作扩展，不自动执行全局/项目第三方扩展，不替用户批准项目资源。原生内置工具、模型配置和已允许的 skills/templates 仍由 Pi 管理；需要依赖额外扩展的自定义 provider 时，应继续使用手动 Pi，不能假定这里会自动加载它。

## 所有权与保存

- 每个后台会话使用独立原生 RPC 进程、固定 UUID 和 `managed-<UUID>` host ID；不会接管手动 Pi 或附着其 JSONL。
- `registry.json` 仅保存项目/房间/cwd、创建 ID、名称与进程状态元数据；原生会话存在 `stateDir/sessions/<projectId>/`。Relay 不生成、修改或重写 Pi JSONL。
- Windows 文件锁保证同一登记目录只有一个 manager owner；不扫描 PID 接管进程，也不按旧 PID 结束进程。每个直接创建的进程树放进带 `KILL_ON_JOB_CLOSE` 的 Windows Job Object，Relay 崩溃时也回收其工具子进程。
- macOS/Linux 使用专用 supervisor、存活管道与进程组，仅回收自身派生组；网关退出时由 supervisor 处理组内子进程。不按旧 PID 猜测所有权，主动脱离进程组的子进程不在此保证内。
- **关闭实例** 要求确认，会停止该实例的任务与工具。先读原生状态保留名称、关闭 stdin，最多等待 8 秒后回收本管理器拥有的 Job；不会操作手动 Pi。
- **打开** 恢复同一个原生 UUID，不自动继续中断的任务。Relay 重启后登记仍在，但所有后台项显示已关闭；不会自动重启或重放 prompt。
- Pi 在首个用户/助手消息前不写会话文件。新建空会话的初始名称保存在登记中；正常关闭时保留 Pi 当前名称，重开只在 Pi 没有原生名称时恢复。崩溃前尚未产生任何对话的临时改名仍遵循 Pi 的未保存 setup 语义；已有对话的名称/内容由 Pi 原生保存。
- 后台实例拒绝 `new_session`/`resume_session` 来切换自身身份；请在左侧创建或打开另一后台会话。手动 Pi 的原生历史继续功能不变。

## 网络与资源边界

公开 `/api/config` 仅增加可选 `managedSessions: true`。管理入口固定为同源 `POST /api/workspace`，必须同时通过 Origin 和 client bearer token 校验；不接受 query 参数或未知 JSON 字段，body 最多 4096 字节。操作仅有 `list/create/open/close`，任何返回均不包括命令行、环境、agent 目录、provider 配置或 token。

创建 ID 在进程启动前原子登记，相同 ID 的重复创建返回同一项，不会再次启动；冲突参数拒绝。超时/断线显示“结果未知”，不自动重试写入，应先刷新后台列表核对。Web 的读取和自动选择有房间、连接代次、认证状态、视图及手动选择保护。Pi RPC 的 `get_state` 只用于启动/关闭元数据，不发送模型 prompt；无法处理的原生确认明确取消，不自动批准。

最多同时运行 8 个后台进程，登记最多 100 项。没有自动淘汰、删除会话或调度池；达到限制后拒绝创建，不能通过静默删除记录解除限制。后续若增加删除，必须保留创建 ID 的幂等 tombstone 并单独确认是否删除原生记录。

## 验证

```sh
cd relay
go test ./...
```

在包目录使用固定 Node 工具链：

```sh
npm run refactor:web:check
npm run refactor:web:test -- --maxWorkers=2
npm run refactor:pack
node scripts/refactor/managed-native.mjs --allow-native --pi-root <原生 Pi 包目录>
node scripts/refactor/cafe-ui-browser.mjs --allow-browser-context --managed-sessions
```

原生验收使用临时 project/agent/home/state、随机 token/端口，验证无已有客户端创建、两个后台实例、手动 Pi 不变、空会话改名、关闭/重开、原生保存和 Relay 崩溃回收。含 **1 次离线合成 provider 响应、0 真实 provider 请求**。浏览器使用自有隔离 context 和合成 WebSocket/管理 API，不操作用户页面。
