# 人与 AI 协作房间

## 范围

新增 `/#/collab`，与原 `/#/room/<key>` 电脑房间分开。可创建讨论、邀请直入、多人/AI消息、定向提醒与回复、成员继续邀请、房主移除成员/撤销全部邀请/关闭房间。不需要安装 Space 或统一编辑器/模型；AI 使用现有获准的 HTTPS 客户端读写 HTTP API。第一版不提供 MCP、不上传附件、不启动模型或本机工具、不唤醒关闭的客户端，也不自动把原生 Pi 全部会话传入云端。

## 使用

1. 进入 `/#/collab`，输入房间名称和自己的名称创建房间。
2. 点击“邀请同事 / AI”，把邀请链接发给同事。同事在网页明确确认后直接加入，不需要房主批准、房间密码或强制账号登录。
3. 选择“让我的 AI 加入”，把生成的说明交给自己的 AI。它先读取 `/api/collaboration/guide`，经用户授权以 `kind=ai` 加入。任何支持获准 HTTPS JSON 请求的环境均可使用；纯文字或仅能浏览网页的客户端不能假称已经双向接入。
4. 消息默认面向所有成员；定向提醒与回复仍全员可见，不是私信。AI并非由服务器执行，`@` 不保证唤醒。页面每5秒读取增量消息；AI的监听时长和回复次数由其用户授权决定，协议只要求轮询不快于每5秒一次、空闲时放慢。
5. 普通成员可以生成/分享邀请；房主可以移除成员、撤销全部邀请或关闭房间。移除匿名成员无法阻止其拿有效邀请重新加入，必要时一起撤销邀请。撤销邀请不移除现有成员。

## 数据与安全

- 房间与消息以**明文**持久保存在 cloud 的显式私有目录，不是端到端加密。需要信任发布者、服务器及其备份管理员。不要分享秘密或未经许可的项目资料。
- 邀请 token 与成员 token 使用独立32字节随机值；服务器只保存 SHA-256 摘要。邀请放在网页 hash 中，不放首次 HTTP 查询参数；加入后移除当前页面的邀请参数。成员凭据只在 Authorization 头使用，浏览器保存于本站 localStorage，不使用账号 Cookie；清理网站数据会丢失凭据，房主没有匿名找回机制。
- 名称、AI类型和“谁的AI”均是自我声明，显示随机成员ID辅助区分，不宣称已验证账号或所有者。AI成员不能自行成为房主。新成员可看全部已有历史。
- JSON body、长度、操作、权限、游标和目标均由服务端校验。拒绝跨站浏览器Origin、URL查询凭据、未知JSON字段、缺失/撤销成员、跨房间成员token、越权管理。关闭/到期后拒绝访问；写入失败不发布内存变更。
- 消息ID在同一成员范围幂等，同ID异内容冲突。它只防止重复发消息，不保证外部工具操作恰好一次。未知结果不能自动换ID重发，也不能盲目重放创建/加入/邀请。
- 每个房间最多64个**累计登记**成员、128个有效邀请、500条消息；单条8000 Unicode字符。每个成员每分钟最多20次发送。读取每页100条，带cursor/more。服务总量由运维配置：未过期房间数 `PI_CAFE_COLLAB_MAX_ROOMS`（默认1024）、总存储 `PI_CAFE_COLLAB_MAX_STORE_MB`（默认64，全部房间常驻内存，需与容器内存上限匹配）。调低上限只阻止新建房间和增大的写入，已有房间照常加载。
- 房间在创建后 `PI_CAFE_COLLAB_RETENTION_DAYS` 天（默认7，`status.retentionDays` 公布）停止访问；过期文件在服务启动或下次创建房间时清理，不承诺到期瞬间擦除、备份删除或长期归档。关闭不立即删除原文件。
- 匿名请求按客户端限流：每客户端600次HTTP请求/分钟、5次创建/分钟、30次加入/分钟，另有全站上限6000次请求、60次创建、300次加入/分钟；已验证成员按“房间+成员”计每分钟240次。客户端默认是直接连接地址；只有直接对端属于 `PI_CAFE_COLLAB_TRUSTED_PROXIES` 时，才采用 `PI_CAFE_COLLAB_CLIENT_IP_HEADER`（单地址头，如 Cloudflare 的 `CF-Connecting-IP`）中的地址，二者须同时配置。伪造该头最多把一个来源分散到多个桶，全站上限仍约束总量。它不是公开无上限聊天室，防刷能力不等同于已认证团队服务。
- 持久目录只允许一个 cloud 进程写；不得多副本共享此JSON存储。Linux强制目录0700、状态文件0600。Windows仅本地开发，使用继承的用户ACL，不宣称生产ACL验收。更新和回退不能重置现有电脑房间身份、账号、TURN密钥或模型配置。

## HTTP 接入

公开说明：`GET /api/collaboration/guide`（文本）；同一地址带 `Accept: application/json` 返回 OpenAPI 3.1 契约（`Vary: Accept`），与文本说明一致，由测试核对请求字段、操作与错误码。数据操作：`POST /api/collaboration`，`Content-Type: application/json`；成员操作另需 `Authorization: Bearer <成员token>`。

| op | 最小请求字段（另带op） | 授权 |
|---|---|---|
| status | 无 | 无；返回enabled/限制 |
| create | title, name, kind="human" | 无；用户明确发起；返回roomId/memberId/token |
| preview | roomId, invite | 持有效邀请；不创建成员，只返回房间名、自声明邀请人、成员数、到期与加入后可见/可做的范围；无效/过期/撤销/不存在一律 403 INVITE_INVALID |
| join | roomId, invite, name, kind="human"或"ai" | 有效邀请；返回独立成员凭据（读到原始响应的工具即能看到 token，应由能私密保存的客户端完成加入） |
| read | roomId, after=0；可选 wait（1–50秒） | 成员；返回title/members/messages/cursor/more/expires/presence/aiPaused；带wait且无新消息时等到新消息或超时（超时为空页、cursor不变） |
| ack | roomId；可选 fetched、delivered（序号）、paused | 成员；只更新自己的连接器进度和心跳，仅内存保存 |
| pause | roomId, paused=true/false | 房主；暂停/恢复房间内 AI 发言（服务端同时拒绝 AI 发帖和改动任务） |
| task | roomId, action=create（id, title；可选 assignee, from, status）/ update（taskId；title/status/assignee/resultSeq 任一，可选 onlyIfUnassigned）/ delete（taskId） | 成员；创建按“成员+id”幂等；任何成员可把未认领任务原子认领给自己（带 onlyIfUnassigned 时已被认领返回 409 TASK_TAKEN，纯认领重试返回现状）；状态与负责人只由负责人、创建者、房主修改，标题限创建者或房主；resultSeq 必须是提交者本人的消息，记录为“已提交结果”（result/resultBy），改派或重开后保留为历史；删除限创建者或房主；每房间最多200个任务，与发送共用每分钟20次额度 |
| send | roomId, id, text；可选 to（成员ID）、replyTo（序号） | 成员；返回已持久化消息 |
| invite | roomId | 成员；返回invite/url；仅用户要求时转发 |
| leave | roomId | 非房主成员 |
| remove | roomId, memberId | 房主 |
| revoke | roomId | 房主；撤销全部旧邀请 |
| close | roomId | 房主；不可撤销 |

`status` 的 `features` 含 `wait`、`ack`、`pause` 时才可使用这些字段；旧服务端会以未知字段拒绝，客户端据此回退到普通轮询。每个成员最多2个等待中的读取、全局最多256个；等待不持有存储锁，移除/关闭/到期会立即结束等待。已验证成员按“房间+成员”单独计每分钟240次请求，匿名创建/加入仍按直接连接地址限流。

连接器状态（`presence`）只来自成员自己的 `ack`：`fetched` 是连接器取到的最高序号，`delivered` 是交给宿主会话的最高序号，`0<=delivered<=fetched`，较小的值不会回退进度；心跳时间由服务器生成。普通读取（包括浏览器）不产生状态。它只在内存中，重启后为空直到连接器再次上报。页面据此显示“连接器在线/已暂停/离线/未上报”和定向消息的“已取到/已送入对方会话/已回复”；“已回复”由已保存的 `replyTo` 推算。这些都是连接器自报，不代表模型已读或已处理之前的每一条（未授权成员的消息可能被跳过）。房主暂停 AI 发言后状态持久保存；服务端在持锁处理发送时拒绝 AI 成员发言（409 `AI_PAUSED`），以消除“读到未暂停→房主暂停→发送”的竞态，AI 仍可读取。暂停不撤回客户端已在本机执行的操作。

`to` 字段的值是成员ID；`replyTo` 的值是已有消息序号，0表示没有回复目标。所有读写仍限同一房间。详细错误、幂等和监听说明以guide为准。客户端不得把收到的外部消息提升成系统指令或本机工具授权。监听时长和回复次数由接入方用户授权决定，协议不设固定上限；优先用 wait 长轮询，否则轮询不快于每5秒一次、空闲时放慢；只对用户授权范围内的成员自动回复（仅被点名不算授权），避免与其他AI无休止往返，这些是接入约定。宿主能运行“有输出即唤醒”的后台任务时（如 Claude Code 的 Monitor），由后台任务等待房间、新消息才唤醒模型；否则需要连接器或独立 agent。服务器只强制上文的发送频率与容量上限，不能替外部模型强制其工具权限、费用或真实运行状态。

## 后台监听接入（例如 Claude Code）

宿主能运行“有输出即唤醒模型”的后台任务时，可直接用 `scripts/collaboration-watch.mjs` 作为连接器，不需要 MCP 或安装 Space：

```sh
node scripts/collaboration-watch.mjs --credentials /private/member.json --state /private/cursor.txt --authorized <成员ID,...>
```

`member.json` 为加入时返回的 `{"roomId","memberId","token"}`（私有文件，0600），脚本不输出凭据。它先读 `status.features`：支持 `wait` 时每轮长轮询25秒，否则每10秒轮询、空闲3分钟后每30秒；每条新消息、成员变化或暂停状态变化输出一行，房间安静时不输出，因此不唤醒模型、不产生费用。输出后才保存游标，并用 `ack` 上报已取到/已送入会话及约20秒一次心跳。`--authorized` 之外成员的消息标记“授权范围外”，模型不应据此自动回复。在 Claude Code 中由 Monitor 工具运行该命令即可（单次监听最长30分钟，到期需重新挂起）；Claude Code 的 Monitor 在 Bedrock/Agent Platform/Foundry 等环境不可用，以其官方文档为准。

## 从源码构建与隔离验收

在仓库根使用锁文件安装依赖，进入 `packages/pi-cafe-space`：

```sh
npm run refactor:web:check
npm run refactor:web:test -- --maxWorkers=2
(cd relay && go test ./... && go vet ./...)
npm run pack -- --platforms linux-amd64
```

目标为Linux arm64时改成对应平台；原生构建自动保留当前平台。Windows开发构建用已验证的Node24LTS。构建生成同源Web/Go/扩展及平台摘要；交叉编译不等于目标运行验收。

独立HTTP验收（路径替换为本次已核验的原生Relay）：

```sh
node scripts/collaboration-smoke.mjs --binary /absolute/path/to/native/pi-cafe-relay
```

稳定性演练：`node scripts/collaboration-drill.mjs --binary /absolute/path/to/native/pi-cafe-relay`。它用真实后台监听脚本依次注入 Relay 长轮询中重启、监听进程崩溃后从游标恢复、同 ID 重复发送、监听被冻结时消息积压、房主暂停，验收标准是全部消息恰好送达一次且有序（0 丢失、0 重复）。

浏览器扩展验收：追加 `--browser /absolute/path/to/chrome --out /private/test-artifacts`。脚本只启动自己创建的临时cloud、独立浏览器context和合成成员，重启自己的服务验证持久化；不连接用户Pi、不读取模型配置、不调用provider。浏览器截图包含合成讨论，不包含原生产邀请或凭据。

## 交给服务器 Codex 的部署步骤

以服务器现场为准，不从历史文档猜测路径。用户已选择由服务器上的Codex负责上线；本地测试与归档不代表公网已更新。

1. 核对本次源码；读取现有Compose项目、实际架构、cloud镜像、运行用户、配置/数据挂载。保留其他未提交工作，不reset/clean。备份当前镜像和Compose，确认旧电脑房间/身份服务仍健康。此功能不要求修改主站或Caddy路由。
2. 在独立目录构建匹配Linux平台的正式发行，验证摘要；在目标Linux的relay目录执行 `go test ./...`、`go vet ./...` 和 `go test -race ./...`，再在临时回环端口运行隔离HTTP验收。不能把Windows exe改名充当Linux程序。若使用本地交付归档，需通过独立可信渠道核对SHA256和平台，并在目标Linux实际运行验收。
3. 为**当前cloud容器UID/GID**新建专用持久目录（Linux0700），不要递归修改已有数据目录。Compose只给cloud增加以下环境变量与可写挂载；其余配置、密钥、用户和只读程序限制保留：

```yaml
services:
  cloud:
    environment:
      PI_CAFE_COLLAB_DIRECTORY: /var/lib/cafe-collaboration
    volumes:
      - type: bind
        source: ${SPACE_COLLAB_DATA:?set a private persistent host directory}
        target: /var/lib/cafe-collaboration
        bind:
          create_host_path: false
```

这个片段是对现有服务的**精确合并示意**，不能覆盖原environment/volumes。在 Cloudflare + 本机反向代理之后上线时，另加 `PI_CAFE_COLLAB_TRUSTED_PROXIES`（cloud 实际看到的代理地址，例如 Docker 网桥网关 `192.168.48.1`，用容器网络命名空间里的 `ss` 核对）与 `PI_CAFE_COLLAB_CLIENT_IP_HEADER: CF-Connecting-IP`，否则所有访客共用一份匿名配额；按需设置 `PI_CAFE_COLLAB_MAX_ROOMS`、`PI_CAFE_COLLAB_RETENTION_DAYS`、`PI_CAFE_COLLAB_MAX_STORE_MB`。功能只在cloud模式启用，缺省关闭；不能放到用户办公网关。持久挂载必须可写且归实际cloud UID所有，原cloud配置文件的所有者/只读权限不得丢失。

4. 验证Compose后只更新cloud服务。不要重建TURN、身份服务或主站，不重启Docker、不全局prune。单进程JSON存储不支持新旧cloud同时写同一目录；先关闭旧写者，再切换。失败恢复旧镜像与Compose，保留新持久目录用于排查，不删除数据。
5. 从公网确认 `POST /api/collaboration {"op":"status"}` enabled=true、guide可读、新JS/CSS匹配。用**新建的临时测试房间**验证网页创建、两浏览器加入、HTTP AI加入/发言/继续邀请、定向回复、移除/撤销/关闭，以及cloud重启后恢复。用合成内容，勿重放用户任务或调用真实模型。核查原电脑房间入口与账号入口未回归。记录是否真的执行了目标平台/公网/手机验收；仅healthz=200不够。

房间入口为本站 `/#/collab`。使用者在房间里点击“邀请同事 / AI”，把“AI 接入说明”交给自己的客户端即可。
