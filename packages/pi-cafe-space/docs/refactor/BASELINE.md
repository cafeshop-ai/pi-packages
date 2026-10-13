# R00 基线记录

> 本记录对应用户授权的 R00。它只记录现场和现有检查结果，不代表 R01 或后续任务已获授权。

## 1. 采集信息

- 采集时间：2026-09-10 13:25（本地时间，命令输出时间）
- 仓库：`C:\Users\example-user\Documents\cafecodework-pi-packages`
- 分支：`main`
- HEAD：`cf20beaf65097173b78a632a79df615b9576e5ce`
- HEAD subject：`fix(pi-cafe-space): harden relay, host projection, and process ownership`
- 上游状态：`main...origin/main [ahead 1]`
- R00 开始前工作区已有的修改/未跟踪文件：
  - `packages/pi-cafe-space/docs/RELAY.md`（modified）
  - `packages/pi-cafe-space/docs/WEB.md`（modified）
  - `packages/pi-cafe-space/docs/REFACTOR_EXECUTION.md`（untracked）
  - `packages/pi-cafe-space/docs/RELAY_GO_REFACTOR_PLAN.md`（untracked）
  - `packages/pi-cafe-space/docs/WEB_REFACTOR_PLAN.md`（untracked）
  - `packages/pi-cafe-space/docs/refactor/CONTRACTS.md`（untracked）
  - `packages/pi-cafe-space/docs/refactor/PROGRESS.md`（untracked）
  - `packages/pi-cafe-space/docs/refactor/TASKS.md`（untracked）
- R00 自身只新增了 package `.gitignore` 中的 `.refactor/` 忽略规则，以及本文件、忽略目录下的证据；没有覆盖上述已有文档修改。
- `git diff --check`：通过。

## 2. 原生工具链

| 工具 | 实测结果 |
| --- | --- |
| Node | `D:\software\scoop\apps\nvm\current\nodejs\nodejs\node.exe`，`v23.11.0` |
| npm | `D:\software\scoop\apps\nvm\current\nodejs\nodejs\npm.cmd`，`10.9.2` |
| Windows PowerShell | `5.1.26100.9168` |
| Go | `D:\dev\go\bin\go.exe`，`go1.24.2 windows/amd64` |
| Go 环境 | `GOOS=windows`，`GOARCH=amd64`，`GOROOT=D:\dev\go`，`GOPATH=C:\Users\example-user\go` |

本轮没有安装依赖、修改 PATH、创建 Go module 或生成 Web 项目。

## 3. 当前实现盘点

- package 版本：`@cafecodework/pi-cafe-space@0.1.0`。
- `private: true`，MIT，Node engine `>=22.19.0`。
- 当前依赖只有 `ws@8.21.3`；peer 为 `@earendil-works/pi-coding-agent`；当前 dev 依赖含 `@types/ws@8.18.1`、`vitest@3.2.4`。
- 当前 Web 是 `web/public/` 下的原生 HTML/JS/CSS/PWA 静态客户端；R00 观察到 5 个文件、约 82,606 bytes。
- 当前 Relay 是 `src/relay/` 下的 Node.js/TypeScript、`node:http` + `ws` 实现；默认端口由入口约定为 `37891`。
- 当前 Pi extension 是 `src/extension/` 下的 TypeScript。
- 当前没有 `packages/pi-cafe-space/relay/go.mod`，没有 `packages/pi-cafe-space/web/src/`。
- 当前已有 `dist/` 是历史/现有构建目录（观察到 26 个文件、约 568,160 bytes）；R00 没有修改它。
- 当前 package `build` 先执行 `clean` 删除 `dist`，再运行 `tsc` 并复制 `web/public`；`prepack` 会调用 `build`。因此本轮没有运行 `build` 或 `prepack`。
- 当前 package check/test 只覆盖现有 TS 源码；未来 Web/Go 命令在 R09/R03/R16/R18 才建立。

## 4. 现有测试基线

按执行入口规定，在原生 Windows PowerShell 环境通过 `npm.cmd` 执行：

```text
npm.cmd run typecheck
npm.cmd run pi-cafe-space:check
npm.cmd run pi-cafe-space:test
```

结果：

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run pi-cafe-space:check` | 0 | 通过 |
| `npm.cmd run pi-cafe-space:test` | 0 | 6 个 test files、65 tests 全部通过；无 skipped |

现有 6 组测试及实测数量：

- `src/extension/connection-warning.test.ts`：5
- `src/protocol/index.test.ts`：24
- `src/extension/file-commands.test.ts`：6
- `src/relay/server.test.ts`：27
- `src/extension/snapshot-compaction.test.ts`：1
- `src/extension/connection-lifecycle.test.ts`：2

## 5. 保护与未决事项

- R00 没有启动、停止或连接现有 Pi、`37891` Relay、`9222` Chrome，也没有删除 PID marker、session JSONL 或用户配置。
- 没有运行会覆盖 `dist` 的命令，没有启动 Go/React candidate。
- Go 工具链当前可见，但 Go/Gin/Gorilla 版本和 API 尚未核准；由 R01/R03 处理，不能把工具链存在当作 Go Relay 已实现。
- assistant-ui/React/Vite 尚未安装或实施；不能把当前 65 项 TS 测试当作新 Web 验收。
- 真实 native Pi、完整候选产物、浏览器 E2E、远程部署和故障/进程 ownership 验证仍未完成。
- 当前 baseline 成功只说明现有 Node/静态 Web 版本没有回归；不批准 R01 或任何后续任务。
