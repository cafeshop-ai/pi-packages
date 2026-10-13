# 后台执行所有权

Go 候选已提供可选的 [独立后台会话](MANAGED_SESSIONS.md)：由 Relay 管理有限数量的原生 Pi RPC 子进程，每个进程拥有自己的会话，仍通过 `src/extension/` 接入同一协作协议。没有实现新的 SDK 会话状态机或 daemon 转录格式。

默认仅转发模式不变；后台能力需要本机显式配置、loopback 与强认证，不会自动从已有客户端接管其会话。

它不能和 `src/extension/` 中当前的 host extension 同时拥有同一个 Pi session；也不能直接启动
第二个 `InteractiveMode` 来附着已有 session JSONL。
