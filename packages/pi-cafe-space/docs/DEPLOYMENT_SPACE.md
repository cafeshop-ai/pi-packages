# Café Space 部署与维护（公开通用指南）

本文只保留可公开的架构、部署流程和示例变量，不是某台服务器的连接清单。真实源站地址、SSH 登录信息、个人路径、私钥与数据库位置、具体回退文件及原发布回执由维护者保存在仓库之外的私有运维记录中，不应提交到公开 Git。

已有环境按私有运维记录操作。不要把示例路径或默认端口当成真实实例的配置，也不要依据历史文档覆盖正在运行的服务。返回 [README](../README.md)；隐私与提交规则见 [PRIVACY.md](PRIVACY.md)。

## 服务边界

| 组件 | 职责 | 典型部署方式 |
|---|---|---|
| Space cloud | 嵌入的 React 网页、房间登记、WebRTC 信令 | Go 单程序容器，仅对反向代理暴露内部端口 |
| identity | 复用主站账号、OIDC、Space 会话与身份声明 | 独立 Node 服务；持久化登录会话数据与签名密钥 |
| TURN | 直连受限时中转加密的 WebRTC 流量 | 按网络配置独立监听，不走普通 HTTP 反代 |
| HTTPS 代理 | TLS 与按域名、路径转发 | 复用现有代理，保留其他站点 |
| 办公端网关及 Pi | 验证房间密码、审批和命令准入，执行模型与工具 | 在办公电脑运行，不由 cloud 代替执行 |

浏览器业务通过 WebRTC 与办公端网关通信；必要时经过 TURN。已有房间仍受信令与授权生命周期约束，cloud 重启可能导致连接重建。公开入口不是不可信多租户计算沙箱。

## 域名和路径

自托管示例可使用 `space.example.com` 和 `accounts.example.com`，这些是示例而非服务地址。

Space 的 `/api/identity/*` 转发至身份服务；其他 Space 页面、登记与信令请求转发至 cloud。主站 OIDC、SSO 与退出相关接口转发至同一身份系统；其他主站页面和业务保持原路由。准确的路径、issuer、回调和内部端点应由管理员从当前配置核对，不从公开文档推断。

账号登录只证明身份，仍需要房间密码；操作审批由房主配置。相关协议说明见 [CAFE_SSO.md](CAFE_SSO.md)。

## 持久化与配置

程序版本与持久状态分开。cloud 使用版本化的二进制／镜像；办公端保留原房间身份与密码校验文件；identity 保留签名密钥和会话数据库。配置可只读挂载，需更新的数据库使用独立数据卷或受限目录。

私有运维记录至少包含各服务的 Compose 文件位置、项目名、镜像标识、数据挂载、回退依据和验证结果。记录必须放在公开仓库之外，并限制为维护者可访问；不要把未脱敏副本放进同一公开仓库的另一个目录。

加密传输不等于无需信任网站：发布者及所提供的网页 JavaScript 仍是信任边界。文档也不能作为访问密钥、Cookie 或用户会话的备份。

## 构建与发布

从仓库根目录开始执行以下命令，先安装锁定依赖，再进入包目录构建：

```sh
npm ci --ignore-scripts
cd packages/pi-cafe-space
npm run pack -- --platforms linux-amd64,windows-amd64
```

执行前应从实际所在目录确认上述相对路径。生成的包路径和摘要以命令输出为准；Linux／Windows 交叉编译不是目标系统运行验收。安装及新服务器配置见 [INSTALL.md](INSTALL.md)。

发布顺序：验证候选和目标平台，上传到独立版本目录，构建目标镜像，保留旧配置／镜像，更新对应 Compose 后只切换所需服务。主站身份服务有独立构建和测试，不应为更新它重建所有主站服务。Git push 和服务部署是两步；文档修改通常无需重新部署业务容器。

## 运维命令模板

在目标服务器上，由维护者按私有记录设置下面变量。它们不包含密码；未设置时命令会停止。保留原 Compose 项目名，避免因为目录名不同而意外创建第二套服务。

```sh
: "${SPACE_PROJECT:?请设置实际 Space Compose 项目名}"
: "${SPACE_COMPOSE:?请设置实际 Space Compose 文件绝对路径}"
: "${IDENTITY_PROJECT:?请设置实际身份服务 Compose 项目名}"
: "${IDENTITY_COMPOSE:?请设置实际身份服务 Compose 文件绝对路径}"

docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" ps
docker compose -p "$IDENTITY_PROJECT" -f "$IDENTITY_COMPOSE" ps
```

仅在候选镜像已经存在、Compose 已指向该版本、原配置已保留时更新服务：

```sh
docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" up -d --no-build --no-deps cloud
docker compose -p "$IDENTITY_PROJECT" -f "$IDENTITY_COMPOSE" up -d --no-build --no-deps identity
```

排查日志时只查看所需服务，向外分享前脱敏：

```sh
docker compose -p "$SPACE_PROJECT" -f "$SPACE_COMPOSE" logs --tail=80 cloud
docker compose -p "$IDENTITY_PROJECT" -f "$IDENTITY_COMPOSE" logs --tail=80 identity
```

服务名 `cloud`／`identity` 来自模板，自定义部署应检查实际名称。一般业务更新不需要重启 TURN 或 HTTPS 代理，不运行整机清理或删除数据卷。

## 验证与回退

检查实际资源版本、身份接口与匿名访问边界、错误和正确房间密码、第二个设备的 WebRTC 连接及房主审批。`/healthz` 只能说明相应 HTTP 服务可用，不证明端到端连接或真实账号登录成功。

失败时恢复原 Compose 和镜像，仅重建对应服务。保留签名密钥、会话数据和办公端身份，不通过重置密码或删除数据库修复启动。办公网关拥有可选托管 Pi 进程，重启网关可能影响这些进程；手动 Pi 另有生命周期，不应一概视为无影响。

公开的源码与测试摘要可记录在 [DEVELOPMENT_HANDOFF.md](DEVELOPMENT_HANDOFF.md)。实例地址、个人目录和完整回执只保留在维护者私有记录中。

## 隐私修复范围

公开版已移除原运维日志中的真实连接信息与个人路径，原文已在仓库外私有保存。本次按用户选择只修当前版本和后续提交邮箱，不重写已公开的 Git 历史。因此旧提交、既有克隆与缓存中的内容不因本次提交自动消失。
