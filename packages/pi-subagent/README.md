# @cafecodework/pi-subagent

一个轻量、异步的 Pi 子 Agent 扩展。它把独立任务交给临时 Pi 子进程执行，主 Agent 可以在后台任务运行时继续工作。

## 设计范围

保留一套小而明确的接口：

| action | 行为 |
| --- | --- |
| `spawn` | 启动任务并立即返回 job ID |
| `status` | 查看状态和最新结果 |
| `wait` | 等待任务，单次最多等待 120 秒 |
| `kill` | 终止运行中的任务 |

其他特性：

- 最多同时运行 4 个子 Agent；
- 完成后通过 steering message 自动通知主会话；
- 子进程不保存 session，并禁用 extensions、skills、prompt templates 和 context files；
- 支持 `~/.pi/agent/agents/*.md` 用户角色；
- 项目 `.pi/agents/*.md` 默认不加载，必须显式选择 scope，未信任项目需要确认；
- 角色的 model、tools 和 system prompt 是固定边界，单次调用不能覆盖；
- 只保留最近 50 个任务记录。

本扩展刻意不提供 parallel 数组、chain 工作流和复杂流式 TUI。需要并行时连续调用多次 `spawn`。

## 安装

```text
pi install git:github.com/cafecodework/pi-packages
```

也可以安装本地 package：

```text
pi install C:\path\to\pi-packages\packages\pi-subagent
```

## quick_explorer

在 `~/.pi/agent/agents/quick_explorer.md` 中定义低成本只读角色：

```markdown
---
name: quick_explorer
description: Bounded, low-ambiguity, read-only checks with independently verifiable results.
model: cafe/gpt-5.6-luna:max
tools:
  - read
  - grep
  - find
  - ls
---

You are quick_explorer.
Handle deterministic searches, inventories, comparisons, and mechanical verification.
Do not edit files. Return concise findings with evidence and file references.
Escalate ambiguity to the parent agent instead of expanding scope.
```

调用示例：

```text
subagent({
  "action": "spawn",
  "agent": "quick_explorer",
  "task": "盘点 src 中的认证模块并返回文件引用"
})
```

该角色没有 `bash`、`write` 或 `edit`，所以在 Pi 工具层面不能修改文件。Pi 本身没有类似 Codex `sandbox_mode = "read-only"` 的内置操作系统沙箱；如果角色需要 shell，同时还要求强隔离，应在容器、VM 或其他沙箱中运行 Pi。

## 项目角色

默认 `agentScope` 为 `user`。只有明确需要仓库内角色时才使用：

```text
subagent({
  "action": "spawn",
  "agent": "project_reviewer",
  "agentScope": "project",
  "task": "审查当前变更"
})
```

支持的 scope：

- `user`：只读取 `~/.pi/agent/agents`，默认值；
- `project`：只读取最近的 `.pi/agents`；
- `both`：同时读取，项目角色覆盖同名用户角色。

未信任项目的本地角色不会静默执行；交互模式会请求确认，非交互模式会拒绝。

## 原始任务

不指定 `agent` 时可以直接提供模型和工具：

```text
subagent({
  "action": "spawn",
  "task": "运行测试并汇总失败",
  "model": "cafe/gpt-5.6-luna:max",
  "tools": "read,bash,grep,find,ls"
})
```

原始任务默认工具为 `read,bash,grep,find,ls`。这不是沙箱；`bash` 拥有当前 Pi 进程的系统权限。

## 查询与终止

```text
subagent({ "action": "status", "jobId": "sa-1" })
subagent({ "action": "wait", "jobId": "sa-1" })
subagent({ "action": "kill", "jobId": "sa-1" })
```

省略 `jobId` 时，会选择最近一个仍在运行的任务。

## 开发

```bash
npm install
npm run typecheck
npm run pi-subagent:test
```
