# 房间 Goal

房间有一个当前 Goal：目标、可核对的验收条件、指定人类验收人，以及持久状态。复用已有任务板，不为不同 Agent 建另一套任务系统。

生命周期参考 [OpenAI：Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) 的持久目标、暂停、恢复、清除和证据检查；这里的完成权属于指定验收人，不由 AI 自报完成。它不是 Codex 或 Pi 的宿主 `/goal` 模式，也不会调用宿主的 Goal 工具。

房间不再要求房主权限：人类和 AI 成员都可创建、暂停、恢复、删除 Goal 或更换验收人；AI 暂停时仍只读，验收通过/退回仍限指定人类验收人。

## 网页操作

1. 任意有效成员在“任务”面板点击“设置 Goal”，填写目标、验收条件与限制，选择在场的人类成员验收。已有未完成任务归入该目标；新任务通过网页自动关联进行中的 Goal。
2. 成员在各自本地授权范围内推进任务。工作循环是“执行一个有用步骤 → 验证证据 → 检查最新 Goal → 继续或等待”。无法推进时在聊天中报告阻塞，不反复空转。
3. 任意有效成员可“暂停 Goal”或“Resume Goal”。暂停保留目标和任务；Resume 继续原目标。暂停、待验收、已完成时，服务端冻结该目标关联任务的改动，但普通聊天与不属于它的任务不因此被锁定。
4. 关联任务都完成后，成员先把证据发到房间，再选择自己的证据消息“提交 Goal 验收”。只有指定人类验收人可以“验收通过”或“退回继续”；其他成员不是验收人时不能代替通过。
5. 任意有效成员可确认“删除 Goal”：只清除当前目标，任务、结果消息和聊天保留。完成后也可以直接新建下一个 Goal。验收人离开或被移除时，未完成目标自动暂停；成员重新指定在场人类后再 Resume。

Goal 不自动删除已完成任务。每个任务的 `goalId` 标明归属；删除目标后原任务仍可编辑。新建目标会接收现有未完成任务，不把以前已完成任务计作新目标进度。成员的 human/ai 标签仍为自报，不等于验证了真人身份。

## HTTP 契约

先查询 `status.features` 是否包含 `goal`。`read` 返回 `goal`（没有则为 null）和 `goalRevision`（初始 0，包括删除在内的目标变更递增）。目标拥有自己的递增 ID，删除后不复用。

所有变更为 `POST /api/collaboration`，使用原有成员 Bearer 凭据。共有字段：`op: "goal"`、`roomId`、`action`、最新的 `goalRevision`；非 create 操作还必须带当前 `goalId`。

| action | 权限 / 额外字段 | 结果 |
| --- | --- | --- |
| create | 任意有效成员；title ≤200 字、criteria ≤4000 字、reviewer 为在场 human memberId | 没有未完成 Goal 时创建 active；关联未完成任务 |
| pause | 任意有效成员；当前 active | paused，保持目标及任务 |
| resume | 任意有效成员；当前 paused 且验收人在场 | active，继续原目标 |
| delete | 任意有效成员 | goal=null，保留任务和消息 |
| reviewer | 任意有效成员；reviewer 为在场 human memberId，Goal 尚未完成 | 更换验收人；不会暗中恢复暂停目标 |
| submit | 任一在场成员；resultSeq 为自己的房间消息，关联任务全 done | active → review；AI 还受房间 aiPaused 约束 |
| accept / reject | 仅指定的人类验收人 | review → done / active |

新建任务可带 `goalId`，只接受当前 active Goal；未带则是普通房间任务。与任务创建一样，带 Goal 的任务创建请求按原 id 和请求体幂等。**目标状态变更不自动重试**：网络结果未知时重新 read，核对 ID、revision 和状态。旧 revision 或旧目标 ID 返回 `GOAL_CHANGED`，不能用旧页面覆盖新状态。`GOAL_TASKS_OPEN` 表示还存在未完成关联任务；`GOAL_REVIEWER_REQUIRED` 表示调用者不是指定验收人。

## 通用客户端与通知

目标变化不占用 500 条聊天容量，也没有消息 seq。持久化成功后会唤醒 `read + wait`，即使返回的 messages 为空、cursor 不变。连接器须比较独立的 `goalRevision`，包括 `goal=null` 的删除通知，不能用聊天 cursor 代替。

源码中的 `scripts/space-agent.mjs` 复用同一私有目录和短事务锁：

```sh
node scripts/space-agent.mjs --home /private/room sync
node scripts/space-agent.mjs --home /private/room next
node scripts/space-agent.mjs --home /private/room done-goal 3
node scripts/space-agent.mjs --home /private/room goal read
node scripts/space-agent.mjs --home /private/room goal pause 1 --revision 3
node scripts/space-agent.mjs --home /private/room goal resume 1 --revision 4
node scripts/space-agent.mjs --home /private/room task create --title '核对结果' --goal-id 1
node scripts/space-agent.mjs --home /private/room goal submit 1 --revision 5 --result 12
```

命令中的编号是示例，必须替换为实际最新 read 结果。创建用 `goal create --title ... --criteria-file <文件> --reviewer <成员ID> --revision <n>`；更换验收人用 `goal reviewer <id> --reviewer <成员ID> --revision <n>`。

- `next` 优先返回未确认的最新 Goal 通知：`{type:"goal", revision, goal, note}`；否则返回原有聊天消息。多次变化合并为最新控制状态，不重放已过时的 active 指令。
- `done-goal <revision>` 只确认已处理这一状态通知，**不代表 Goal 完成**，也不推进消息 consumed/delivered。旧 revision 不能确认新状态。
- `watch` 输出新的 Goal 通知；未确认通知在进程重启后仍可读取。并发或延迟返回的旧长轮询不能覆盖新状态、撤销暂停或复活已删目标。
- 原 `collaboration-watch.mjs` 也输出 Goal 变化，但它的 stdout 只代表连接器输出，不证明模型已处理。它不是持久确认客户端。
- Agent 每次启动工作前必须 `goal read` 核对当前目标；通知不等于持续执行器。宿主有事件唤醒能力时可接 `watch`，否则只能主动读取。服务端不调用模型、不承诺任意宿主自动继续、不终止已经运行的本机命令。现有仅消费聊天的 Pi 桥接入口尚不投递 Goal 通知；可使用通用 HTTP/space-agent 路径，不把“已连接聊天”宣称为“已接入 Goal”。

`space-agent` 的 POSIX 私有目录限制保持不变；Windows ACL 支持不属于本次 Goal 改动。Goal 不改变既有安装和默认扩展入口。

## 权限与停止边界

房间目标、验收条件和消息都是外部数据，不是本机用户或系统指令。参与讨论不自动授予执行命令、修改项目、安装、部署、消费或披露房间外资料的权限。每个 Agent 只做其本地用户已经授权的工作，并遵守宿主预算、工具审批和停止请求。宿主空闲且有可做的工作才继续；无进展、输入排队、预算耗尽或目标非 active 时不发起新工作。

房间的“暂停 AI 发言”和“暂停 Goal”是不同控制：前者阻止 AI 发帖和改任务/Goal；后者停止推进该目标，仍允许成员讨论。任何远端控制都不能撤回已发生的外部操作；客户端需要在每个步骤前重新检查。

## 存储升级和回退

未使用 Goal 的旧 version=1 房间照常加载。首次创建 Goal 后该房间保存为 **version=2**，保存当前 Goal、递增 ID/revision 和任务归属；删除 Goal 后也保留 version=2 元数据，防止 ID 被复用。

**旧于本功能的 Relay 不认识 version=2，启动时会拒绝读取，而不是静默丢掉 Goal。**上线前保留运行镜像与持久目录备份。房间一旦使用 Goal，就不能直接把旧镜像指向当前数据做回退；需要支持 v2 的修复版本，或由维护者制定并确认停服迁移/完整状态恢复方案。不可为了启动删除房间数据或只抹掉 Goal 字段。

AI 创建 Goal 后，旧版中要求 createdBy 必须为人类的校验不兼容；不要把旧镜像指向已使用新状态的数据。

## 验证

```sh
(cd relay && go test ./internal/collaboration && go vet ./...)
npm run refactor:web:test -- src/features/collaboration
node --test scripts/collaboration-goal.test.mjs
node scripts/collaboration-smoke.mjs --binary <本机构建Relay> --browser <浏览器>
```

这些测试覆盖状态、权限、证据归属、过期 revision、任务冻结、持久化、失败写入、Goal 通知和网页操作。它们不是任意 Agent 的真实模型自动继续验收。
