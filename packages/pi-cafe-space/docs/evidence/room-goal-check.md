# Room Goal：本机验证

日期：2026-10-24。基线：`609b7d2e6fbe41ed2a65d0e06a253de02d5496a0`；本记录验证其上的 Goal 工作树改动，不代表这些改动已提交或上线。

## 已执行

| 检查 | 结果 / 边界 |
| --- | --- |
| `npm run refactor:relay:build` | Windows 原生 Go + Web + 扩展构建通过；包含带 `webembed` 的 Go 全套测试。Vite 仍有既有的大 chunk 警告。 |
| `go test ./internal/collaboration -count=1`、`go vet ./...` | 通过。覆盖生命周期、指定人类验收、证据归属、任务冻结、旧 revision、验收人离开/移除、保存失败不污染内存、持久化、删除不复用 ID、500 条消息满容量时仍可控制 Goal。 |
| Web 测试、Web/源代码 TypeScript | Web 55 文件、310 测试通过；两份 TypeScript 检查通过。 |
| `npm run test -- src/collaboration` | 65 个原有 Pi 桥接测试通过。这只证明聊天兼容，不证明 Pi 接收 Goal。 |
| `collaboration-smoke.mjs` + Windows Edge | 12 组隔离 HTTP/浏览器检查通过。真实 create/pause/resume/submit/accept/delete；房主不是验收人时没有通过权限；删除后任务仍在；两个隔离浏览器同步。1440、1280、390、320px 无水平溢出，320px 的长条件创建表单也检查通过，无页面异常。 |
| Linux 原生 `node --test scripts/collaboration-goal.test.mjs scripts/space-agent.test.mjs` | 16 测试通过，0 跳过。复用本机既有 Linux Node v24.22.1；Windows 原生 Go 交叉编译 Linux Relay，在 WSL 的独立 `/tmp` 目录实际运行二进制、客户端与测试，未在 Windows 工作树内使用 Linux Git/Node。包含私有文件权限、进程重启未确认通知重放、Goal 与聊天分别确认、过期控制拒绝、暂停/恢复、AI 不得通过、未知 Goal 写入不重放。 |

浏览器报告：`.refactor/goal-browser/result.json`；截图：同目录 `discussion-*.png`、`goal-create-320.png`。Linux 测试输出：`.refactor/goal-posix-tests.txt`。这些是本机合成数据，不包含生产房间凭据。

## 未证明 / 发布前注意

- 真实模型调用为 0；没有连接、更新或重启用户 Pi，没有修改用户模型、身份或凭据，没有触碰生产部署。
- 未执行 macOS、Windows 通用客户端 ACL、真实 Agent Goal 自动继续、长时间物理断网或公网验收。现有 Pi 聊天桥接不投递 Goal 变化；当前支持通用 HTTP、源码 `space-agent` 和通用 watcher 路径。
- 没有运行本次发布包全平台矩阵或生产容器回退。创建首个 Goal 会把房间保存成 v2；旧 Relay 拒绝此格式。上线前必须备份数据，不能将旧镜像直接指向已升级数据。完整规则见 [房间 Goal](../COLLABORATION_GOAL.md)。
