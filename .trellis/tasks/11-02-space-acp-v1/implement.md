# 执行清单

1. [完成] 隔离 ACP adapter/probe，官方 SDK、预算、事件/权限/进程所有权测试。
2. [完成] 本机新建文本 smoke 与已有 loaded 会话无覆盖挂接；同一活动 turn 经独立 native observer 确认。实际提示 2/2，不再发送。
3. [完成] 源码实验 Space host、新建/借用本机入口、TS/Go 能力字段和网页不可用控制禁用；离线 SDK→假 Agent→WS 通道测试。
4. [源码完成；离线候选包已生成/审计] Go manager/API、Pi/Codex ACP 选择与挂接 UI、不透明浏览器 targetKey、本机私有 ACP identity registry、配对 socket-path policy、发行 allowlist 和 setup 文档; the audited archive was subsequently installed locally with explicit authorization (see the current handoff in evidence.md).
5. [待验收] 生产形态 Go 网关/浏览器/真实终端，真实审批/取消与崩溃恢复，第二种 Agent 和 Linux 实机；不得因本机 smoke、交叉编译或 fixture 通过而勾选。

## 最新检查

- ACP：28 通过、2 跳过；没有真实 Codex/model 调用。源码 Vitest：662 通过、2 跳过；Web：57 文件/316 测试通过；Go `./...`、两项 TypeScript check 通过。
- `npm run refactor:build:test`：9/9 通过。候选包 62 文件，SHA-256 `7f52681e8a46181c05aa710b5798fc31898a30a4add6dd505577b72620da996d`；Windows amd64 本机构建，Linux amd64 交叉编译（未运行）。候选包 4 份 Markdown 的 7 个本地链接/锚点检查通过。
- Git whitespace 检查通过；Git 提示部分文件下次写入时 LF 将转换为 CRLF。独立 quick_explorer 复核在默认 600 秒超时，没有可用结论，不算独立审查通过。
- Live prompt budget: 2/2 exhausted. The archive is installed locally; production deployment and full ACP acceptance remain pending. No automatic Pi reload or gateway restart. Preparing `review/cafe-acp-managed-sessions`; see the current handoff in `evidence.md`.
