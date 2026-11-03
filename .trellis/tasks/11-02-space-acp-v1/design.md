# 设计

## 边界

Space 网关（认证/设备控制权）→ 统一会话接口 → AcpAdapter → codex-acp → Codex App Server。Pi 原生接入继续保留。

实验执行仍以 scripts/acp 为边界；在 TS/Go 协议和现有网页增加可选显示能力，不把实验入口自动安装或部署。官方 SDK 统一消息协议，受控 native proxy 仅保护共享传输，不复制 Codex 消息 adapter。共享会话与历史恢复是独立能力。Managed registration, the web new/attach flows and release allowlisting are implemented; production acceptance remains pending.

## 安全与可靠性

1. 只启动/关闭本次创建的 adapter 进程。不会 kill 用户 Codex 或共享 daemon。
2. 不提供文件/terminal 客户端能力，所有权限请求拒绝；新建 smoke 确认只读模式，固定 smoke 观察到工具活动即请求取消。实验 host 可以显示 native 工具事件，不擅自改变共享会话的工具配置；这些措施都不是 OS 沙箱。
3. 预算在发送前消耗，失败也不返还；断线/超时为结果未知，不重发，不静默新建替代会话。
4. 只接收绑定 sessionId 的消息，保留取消与完成区别。共享运行时仅通过已验证的 guarded transport 显式启用，不能从 loadSession 能力推断。
5. probe 只保存去敏后的版本、能力、事件计数、stop reason 和通过状态；不保存认证内容、环境变量、原始 stderr 或用户历史。

## 已有会话挂接保护

用户已用 /status 确认目标；无覆盖挂接和同一 turn 文本已通过，配置指纹保持一致。共享 launch 删除 CODEX_CONFIG/INITIAL_AGENT_MODE，native bridge 对 thread/resume 只转发 threadId/excludeTurns，对 turn/start 只保留 threadId/text。不回放历史，不发权限模式/MCP/instructions 覆盖。不把确认目标等同发送授权；任务真实 prompt 2/2 已用完。

## 后续门槛

源码 AcpSpaceHost 经现有 authenticated host 通道发送 canonical snapshot/event，独立校验 stream/session/cwd，按 sourcePeerId/clientRequestId 去重；断开不重发，不关闭借用 daemon。结果未知沿既有 HOST_OFFLINE 语义呈现，不能伪装成确定拒绝。

可选 snapshot.agent 仅为显示能力；TS/Go 都校验并丢弃未知内部字段。网页对 modelControl:false 禁用模型/推理表单，对 deliveryControl:false 禁止运行中 steer/followUp。旧 Pi 未提供该字段时不改变行为。

离线官方 SDK/假 Agent/WS fixture 不代替 Go 网关+浏览器+真实终端双端验收。Managed registration, web flows and candidate packaging are implemented. Real approval/cancel, crash recovery, another ACP agent and Linux runtime validation remain release acceptance gates.
