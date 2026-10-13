# 远程协作版：本地验收记录

验收日期：2026-10-02（UTC）。工作树基于 `3987e9ce77cb9c15a79ff083a07c8e3ca2565543`，实现与本轮修复尚未提交。本轮恢复时已有远程模块与跨平台管理改动；这些内容被保留、核对并重新验证，不将已有改动冒充本轮从零编写。

## 交付范围

云端 Web/Go Relay 与办公电脑 Device Agent，支持一台电脑的多个 Pi 实例及多浏览器同时访问。提供云端 WebSocket 中继、可靠有序 WebRTC DataChannel、TURN 配置与限时凭据；业务路径建立后固定，断线不自动重放写操作。

用户/设备凭据分离，用户权限精确绑定设备和房间。Viewer 只读、Operator 需取得实例控制权、Admin 可以显式接管及管理后台实例。控制租约按远程连接和 Pi 实例隔离，不锁住原生终端。云端被信任参与授权；这不是独立扫码核验公钥、无需信任云端的零信任系统。

原生 Pi 保持模型调用、工具执行及 JSONL 所有权。后台实例使用 Windows Job 或 POSIX supervisor 管理自有进程，不接管用户已运行的 Pi。关闭网页/云端连接不停止 Pi；关闭办公电脑网关会清理其受管实例。这不是升级网关时任务无中断的独立常驻执行器。

## 实际工具链

| 项目 | 本轮观测 |
| --- | --- |
| 操作平台 | macOS arm64 |
| Node | 24.0.2 |
| Go | 1.26.2 darwin/arm64 |
| TypeScript | 5.9.3 |
| Vitest | 包内 4.1.11 |
| Vite | 6.4.3 |
| 隔离浏览器 | Chrome Canary 157.0.8084.0 |
| 隔离原生 Pi | 0.99.1 |

测试显式使用包内 `node_modules/vitest/vitest.mjs`；根 workspace 的 3.2.7 不是本轮最终验收版本。命令中的 Node 使用已安装绝对路径，不修改用户全局 PATH。

## 已完成验证

以下命令相对于 `packages/pi-cafe-space`；`go` 命令在 `relay` 子目录执行。

| 验证 | 实际结果 |
| --- | --- |
| 主包与 Web TypeScript noEmit | 两项退出码 0 |
| 包内 Vitest 主测试 | 13 文件，504 项通过，退出码 0 |
| 包内 Vitest Web 测试 | 29 文件，121 项通过，退出码 0 |
| `go test ./...` | 11 个包通过，部分使用 Go 缓存 |
| `go test -race -count=1 ./internal/remote ./internal/managed ./internal/service` | 三个包通过，退出码 0 |
| `go vet ./...` | 退出码 0 |
| 配置/启动安全与平台参数 Node 测试 | 4 项通过，0 skip，退出码 0 |
| 新鲜候选构建/嵌入资源/精确打包清单 | 三平台 29 文件包通过：darwin-arm64、linux-amd64、windows-amd64；后两者仅交叉编译与格式/哈希校验 |
| 最终发行回归及隔离源码重建 | 6 项通过、0 skip、退出码 0；包括源码摘要不匹配拒绝、未知文件保留、无 Node/Go 的嵌入资源服务和真实隔离源码 build/check/test |
| `git diff --check` | 退出码 0；没有 commit/push |

### WebRTC 与 TURN

`relay/internal/remote/rtc_test.go` 的 `TestWebRTCEndToEndDirectAndTURN` 在完整 Go 测试及 race 中执行。使用两个 Pion 端点与真实本地 UDP TURN 测试服务器，强制 TURN 子用例检查实际选中的候选类型为 relay；不是仅添加一个 TURN 配置后假定已经通过 TURN。两种路径均验证两个 Pi host、命令只到指定实例、回执及撤销授权关闭 DataChannel、无写入重放。

这仍是本机 loopback 实验，不证明运营商 NAT、公司防火墙或生产 coturn 的 UDP/TCP/TLS 全部可用。

### 真实浏览器：五组通过

`node scripts/remote/browser-test.mjs --binary <本轮候选> --browser <独立 Chrome 路径> --report <独立报告目录>`。

实际启动两个 Go 服务和三个隔离浏览器 context。Operator 与 Viewer 通过云端中继，Admin 使用真实浏览器 WebRTC 直连；检查管理员确认接管后原控制端失去写权限、其他设备继续共享相同会话、关闭一个浏览器不影响其余连接、实时禁用用户后该用户回到登录页。两条合成 prompt 总计只派发两次。390×844 页面无横向溢出且输入区域可见。

本地云端入口是 HTTP/WS，不是公网 WSS 证书验收；旧测试输出中的 WSS 标签应理解为生产部署路径的名称，实际证据范围以此说明为准。使用的是合成 Pi peers，真实 provider 调用次数为 0。

报告：`.refactor/reports/remote-browser-20261002-final/result.json`，同目录 `desktop.png`、`mobile.png`。这是桌面浏览器缩小视口，不是真机 iOS/Android 锁屏、切后台或蜂窝网络测试。

### 真实原生 Pi：四组通过

`node scripts/remote/native-test.mjs --binary <本轮候选> --pi-root <隔离 Pi 0.99.1> --candidate <候选目录> --report <独立报告目录>`，**未传 `--allow-provider`**。

在全新临时 project/home/agent/state 内启动两个原生 RPC Pi，验证独立创建和重复创建 ID 不增加进程、原生命名投影、关闭重开保留 UUID 且另一实例不变、空会话名称正常关闭后可以恢复。测试脚本退出码 0，执行了自身进程/临时资源清理；不连接已有用户 Pi。

报告：`.refactor/reports/remote-native-20261002-final/result.json`。`providerRequests=0`、`providerCompleted=false`；不能把此测试描述为真实模型响应或非空 JSONL 对话持久化验收。

## 本轮修复与可重复交付

补充 `TestTURNReservesAnICEServerSlot` 后先观测到失败：8 个静态 ICE 服务器加动态 TURN 时，配置被接受但生成信令超过 8 项上限。修复为启用动态 TURN 时为其保留一项，不提高协议预算；七项静态加 TURN 的正向用例也检查最终帧可编码。修复后完整 remote/service 构建与 race 通过。

补齐 `remote:pack`、`remote:setup`、`remote:run`、`remote:test`；`remote:pack -- --platforms linux-amd64,windows-amd64` 可将额外平台与本平台放入同一候选。多平台 helper 使用同一份 Go/Web/TS 构建输入摘要，并检查生成的 ELF/PE/Mach-O 格式及 SHA-256。交叉编译不运行目标二进制；其元数据标记 `cross-compiled-not-runtime-tested`。

额外补充并先复现了发行一致性缺口：只凭版本、Web 摘要及二进制自身哈希，不能拒绝旧 Go 源码构建的其他平台二进制。现在原生构建记录 `goDigest`，交叉编译前与发行时均校验当前 Go 源码和嵌入资源摘要；每个平台的 Go/TS/Web 摘要必须相同。新回归先出现“Missing expected rejection”，修复后与其余五项发行/源码重建检查全部通过。最终 Mac 业务二进制和 Web/TS 字节仍与真实浏览器、原生 Pi 验收版本相同。

候选路径：`.refactor/release/package/`。每次 pack 使用新的 `.refactor/release/pack-*/` 目录，精确文件列表与归档 SHA-256 保存在该目录的 `pack-report.json`。运行产物摘要取 `dist/relay/build.json`，不要用过期目录、旧 PID 或旧哈希替代当前回执。

本轮 Mac 运行验收的业务二进制 SHA-256 为 `1594c693c6a0a035327069ce155a546ce2f7a3103230f56103206accc66305ee`，Web 摘要为 `b7fe9725a1b2d01b952e4d1420ca847988695d2410780680da8cc1575adb11d3`，扩展 TS 摘要为 `743a28533b0527ef6d2c86bbd07862e4f1a2b3f14063e272ea622256bd84cec3`。后续仅文档/打包命令变化不等于新运行实现已验收；若任一业务摘要改变，应重新执行对应验收。

## 未执行或不承诺的项目

没有部署到用户公网服务器、配置正式域名/证书、防火墙或正式 TURN；没有安装全局 Pi 扩展、修改 provider 配置或请求真实模型。本轮只有 Mac 原生运行证据，其他操作系统需目标环境验收。没有宣称手机后台持续在线、任意网络必定直连、无云端信任、全世界端到端延迟或无中断热升级。

已有离线/历史报告（包括其他目录中的 provider 报告）不自动纳入本轮结论。旧本地 TS/DOM 默认 build 保留兼容；使用新远程版必须走 remote:pack 及新候选，不能将旧 build/prepack 输出当作新版本。
