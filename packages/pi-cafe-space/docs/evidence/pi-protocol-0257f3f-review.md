# Pi 独立协议复核：0257f3f

日期：2026-10-23 UTC。被测提交：`0257f3f78f2ce73e8b9eff9d09080254cac19aed`。

范围：新成员 16 字名称限制、可选 AI 类型标签、旧成员兼容性与必要权限回归。Windows 原生 Go 1.24.2、Node 23.11.0、Vitest 3.2.7。使用独立 detached worktree、临时 Store 和合成身份；没有生产写入、模型调用或重新加入真实房间。

## 已通过

- 原有 `go test ./internal/collaboration ./internal/httpserver` 与两包 `go vet` 通过。
- 新增独立 `TestIndependentMemberCompatibility` 整组重复 10 次通过：16 个汉字和 16 个 emoji 可加入；17/48 字的新名称返回 NAME_TOO_LONG；旧 48 字成员名称与 AI 标签在保存、重启、普通写入、再次重启后保留；读取不暴露 token/tokenHash。
- 合法标签 `constructor` 不提升成员移除权限，也不能绕过房主暂停 AI 发言；类型字段只进入校验、存储与显示路径。
- 既有 `web/src/features/collaboration/Collaboration.test.tsx`：21/21 通过。

## 未通过：两个独立反例

### 1. 49 字名称错误码不一致

`relay/internal/collaboration/rooms.go:610–613,670–676`：超长判定额外要求 `validText(name,48,false)` 成立，导致 49 个汉字同时超出新旧上限时落到 INVALID_FIELDS。

独立测试 `TestIndependentNameOverflow49` 对 create 与 join 均观察到 HTTP 400，但错误码为 `INVALID_FIELDS`；约定及 guide 要求超过 16 字使用 `NAME_TOO_LONG`。不是成员被错误创建或权限绕过。

最小重现输入：普通有效 create 或带有效邀请的 join，`name = strings.Repeat("名",49)`，其余字段合法。

建议：新成员长度错误码不要受旧名称兼容上限限制；旧存储的 48 字加载规则不变。

### 2. 合法 AI 类型名触发原型属性查表

`web/src/features/collaboration/Collaboration.tsx:78–79`：`agentNames` 是普通对象，`agentNames[agent]` 也会读取继承属性。

`constructor` 符合公开 agent 正则，服务端允许并可持久化。但独立 Vitest 断言：

```ts
expect(agentLabel('constructor')).toBe('constructor');
```

实际收到 `[Function Object]`，不是标签字符串。`pi` 和 `my-agent` 对照均正确。

建议：只查表的自有属性，例如 `Object.hasOwn(agentNames, agent)`；保留未知合法类型原样显示，并补此用例。

## 证据与边界

独立探针留在隔离审查工作树中，未修改被测实现：

- `relay/internal/collaboration/independent_members_test.go`
- `web/src/features/collaboration/independent-agent-label.test.ts`

首次复核将成功回归与故意失败的反例分开运行，未把既有套件通过当成两个缺口已关闭。0257f3f 的失败记录保留；后续关闭依据见下节。本轮没有 race detector、真实浏览器、POSIX 客户端或生产部署验收。

## 后续独立复测：b641e90（2026-10-23 UTC）

精确被测提交：`b641e90027fe4b6cff3db4c77c77126bfad65a1b`。沿用同一隔离审查工作树，仅切换 detached HEAD；原先两个独立探针保持原样，未修改被测实现。

- `TestIndependentNameOverflow49` 的 create/join 原失败输入均通过；与 `TestIndependentMemberCompatibility` 一起重复 10 次通过。旧 48 字名称的保存/重启与权限边界回归继续通过。
- 原独立 `agentLabel('constructor')` 断言通过；既有及提交新增网页测试 22 项也通过，本次定向网页合计 23/23。
- collaboration/httpserver 两包 `go test -count=1` 与 `go vet` 通过，网页 `tsc --noEmit -p web/tsconfig.json` 通过。新提交自带 17/48/49/200 字 create/join 测试随 Go 套件通过。
- 源码确认新成员超长判定不再依赖 legacyName；旧存储仍采用 48 字规则。标签查询改为 Object.hasOwn，只读取映射表自有属性。

**结论：两个已报告反例在 b641e90 独立关闭。** 这是该提交的定向复测，不是生产发布、全仓库完整验收或未知 Agent 的新一轮盲测。对端报告的 925ad8d 上线时间仍未由本端独立验证。未运行本轮 race detector、真实浏览器、POSIX 客户端或模型测试；没有合并、部署或更换普通会话/身份/凭据。
