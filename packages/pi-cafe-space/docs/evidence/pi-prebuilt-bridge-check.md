# Pi 协作桥接预构建入口验收

## 范围与产物

隔离工作树 pi-collaboration-inbox，基线 0ad827c，加当前未提交桥接与打包补丁。修改的构建脚本、测试、包声明和说明已同步到主工作树 e995686；不覆盖两个任务板既有的不同历史。

此候选包不是 ec57f2b 或线上最新版本的整包发布，不代表已合并、推送、发布或部署。普通 Pi 继续使用已加载的源码桥接，没有切换运行入口、重载、重启或改动凭据/身份/模型。

- Windows amd64 预构建归档：隔离工作树包目录下 .refactor/release/pack-1DBDI5/cafecodework-pi-cafe-space-0.1.0.tgz
- SHA-256：30241d483a8515c53071aea06f2848c46cebe58616f7cdad4fb534456935adcd
- 精确发布白名单共 48 个文件；新增 dist/collaboration/client.js、extension.js、listener.js。
- 默认 pi.extensions 仍只有 dist/extension/index.js（电脑网关）。只需讨论桥接时必须显式加载 dist/collaboration/extension.js；不能登记整个包并声称不启用网关。
- typebox 为宿主提供的 peer；没有增加生产依赖或捆绑宿主库。包内 README、INSTALL、AI_INSTALL 写明两个入口差异。

## 验证

Windows 原生 PowerShell / Node 23.11.0 / Go 1.24.2。所有模型均合成，服务为回环 HTTP。

| 检查 | 结果 |
| --- | --- |
| 白名单及 peer 新测试在旧实现上 | 两项断言失败（未包含桥接、未声明 peer） |
| 资产安全、Windows 卷号回归、路由及包规则 | 12/12；同步后的主工作树亦通过 |
| candidate + 包规则 | 7/7；包含缺桥接文件拒绝验证、未知文件保留、矩阵摘要检查 |
| 完整源码复制构建/prepack、产物验证、源码 check/test | 修正联合测试时间预算后通过，约 208 秒 |
| 隔离工作树源码 Vitest | 29 文件，650 通过、1 项平台相关跳过，约 31 秒 |
| 隔离工作树 Web Vitest | 54 文件，296/296，约 54 秒 |
| 本机 Go 全套 webembed 测试 | 12 包通过；源码复制 check 也执行 Go vet |
| 同步后主工作树根 typecheck / 包 check | 均通过 |
| 完整 npm run pack -- --platforms windows-amd64 | 通过；精确白名单、格式与摘要校验通过 |

将第一次归档（pack-NbAkgZ，SHA-256 75cad79a7b3449a406165b8b8ebd39efe5675bfa258af8eaf814ef583bc3e40f）解压到仓库之外的临时目录，不提供源码或 node_modules。在实际 Pi SDK 中只加载该归档的编译后独立入口：

| Pi SDK | 自动唤醒 | 共享回复 | 合成模型调用 | 心跳 | HTTP |
| --- | --- | --- | --- | --- | --- |
| 1.1.0 | 11 | 9 | 23 | 30 | 85 |
| 0.99.1 | 11 | 9 | 23 | 26 | 77 |

两者均确认：加载/status/reload 不自动联网；显式 connect/resume；手动 read/done 消费持久化；恢复不重投；身份/地址/token 变化或文件缺失在联网前拒绝；pause 停止心跳。模型请求无成员 token 和绑定路径。真实模型请求、非测试网络均为 0。

最终归档重新解压并验证；三个桥接 JS、private-json.js 及 package.json 与上述已测归档逐字节一致，未把只测源码冒称为已测包入口。

## 遇到的失败与修复

1. Windows 构建的资产读取误报 asset changed before open：路径 lstat 的 dev=0，但文件句柄有实际卷号。校验改为从父目录句柄取得卷号，与已有 private-json 策略一致；仍检查 inode、已知卷号、大小、链接和读取后的元数据，不放宽安全检查。新增 Windows 回归通过。
2. 为排除旧 Node 的单一版本问题，曾在临时目录从 nodejs.org 获取官方 Node 24.0.2，并按官方 SHA-256 核对；该版本也呈现相同卷号差异。未切换全局 Node，最终构建仍用 23.11.0。
3. 源码复制验收的全套 Node/Web/Go 联合测试两次达到旧 120 秒上限；其中第一次清理出现 EBUSY 掩盖超时。分别运行源码与 Web 均通过后，联合预算改为 240 秒，临时输出清理添加有界重试；最终完整通过。没有删除失败记录或缩减测试集。
4. 对 CRLF 工作树强制 core.autocrlf=false 进行 diff --check 会把换行误报为整文件尾随空白；按仓库原有 core.autocrlf=true 检查，两工作树均通过，未改 Git 配置或批量重写换行。

## 未包含

- 没有发布/安装候选包，没有替换当前普通 Pi 的源码入口。
- 未验收 Linux/macOS 发布包、真实模型/浏览器、物理断网、长期在线或 Windows 通用 POSIX 客户端 ACL。
- 未处理 ec57f2b 独立审查、Caddy 或生产部署。
