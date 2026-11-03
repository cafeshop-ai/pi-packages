# Space ACP-first v1

## 当前目标

用户要求继续实现至完整产品：连接本机已有会话与 Space 新建托管会话同等重要；优先使用 ACP，不因协议统一替换 Pi 原生能力。只有实证无法补齐的缺口才考虑 Codex 专用补充。

## 已完成阶段

- 官方 SDK 的单会话 adapter、能力协商、事件归属、取消、未知结果不重试及明确进程所有权。
- 固定 codex-acp 2.5.0 的新建文本 smoke；共享 WebSocket-over-native-proxy 的非回放挂接和同一 turn 文本验证。原有模型/权限等配置指纹保持一致。
- 可选源码 Space host 入口：复用既有认证主机通道、命令 fences/去重、短文本/工具事件有界映射、断开仅回收自有进程。
- TS/Go 的可选 Agent 能力元数据；网页禁用本机管理模型表单和不支持的运行中插话；旧 Pi 默认不变。

## 完整验收（未完成，不得标 done）

- [x] 隔离 adapter、共享 transport、源码 host 与离线测试。
- [x] Codex 新建与共享挂接的真实文本证据；两次 prompt 总预算用完。
- [x] 源码托管注册与网页新建/连接入口；发行 allowlist 和配置文档已更新。
- [x] Generate and audit the offline candidate package.
- [ ] Production-shaped Go gateway/browser/terminal acceptance, real approval/cancel and crash recovery.
- [ ] Pi 完整产品回归与第二种 ACP Agent；Linux 实机运行单独标注。

## 边界

不自动安装、部署、升级、重载 Pi 或修改身份/凭据/模型；不修改敏感本机房间配置。当前实验版权限审批全部拒绝、不提供 ACP 客户端文件/terminal API，不能假装具有完整审批支持，也不把客户端能力当成 OS 沙箱。

本任务实际模型提示预算 2/2，禁止追加或重试。之后只跑离线 fixture；进一步真实使用必须由用户重新明确授权。未知结果不能自动重发。共享会话不回放历史、不覆盖现有配置；关闭借用连接不结束用户 daemon/TUI。
