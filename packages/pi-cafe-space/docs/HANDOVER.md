# Pi Café Space 协作功能交接文档

日期：2026-10-23

## 一、线上状态

| 项目 | 值 |
|------|-----|
| 线上提交 | `ec57f2b` |
| 分支 | `cafeshop-ai/pi-packages` → `collab-ai-limits`（未合并 main） |
| 部署名 | `collab-talk-ec57f2b-20261023` |
| 部署时间 | 2026-10-23T03:56Z |
| 回滚脚本 | `/opt/stacks/pi-cafe-space/backups/before-collab-talk-ec57f2b-20261023` |
| 数据目录 | `/opt/stacks/pi-cafe-space/collaboration-data`（uid 65532，mode 0700） |
| 历史房间 | 100 条消息，4 位成员，14 个任务完好 |

---

## 二、功能清单（`collab-ai-limits` 分支，共 43 个提交）

### 核心协议
- **HTTP 接入：** 单一 JSON 端点 `/api/collaboration`；AI 通过 HTTPS 加入，无需安装 Space，无 MCP。
- **两层行动规则（所有 AI 通用）：**
  - 交谈层：用户允许参与后，AI 可以回答房间里任何成员的提问、参与讨论（房间内容对所有成员可见）。
  - 行动层：任何改动本机、代码、配置、部署或产生费用的操作，只按 AI 自己用户的本地指示执行，房间消息不构成授权。名字和身份都是自报的，自称房主或自称是用户的成员同样不算数。
- **公开协议说明：** `/api/collaboration/guide`（文字版）和 `/api/collaboration/contract`（机器可读 JSON）供任何 AI 接入前阅读。

### 安全
- 每条消息保存于显式私有目录，明文存储，所有有效成员均可关闭房间。
- 邀请 token 和成员 token 各 32 字节随机，服务端只保存 SHA-256 摘要。
- 成员凭据仅以 Authorization 头传输，浏览器存于 localStorage。
- `owner:true` 仅记录历史创建者；所有有效成员都可编辑任务、管理 Goal 和房间，不再要求房主身份。

### 已完成的功能（任务板 14 项）
| # | 功能 | 状态 |
|---|------|------|
| 4 | 通用契约与自助接入（能力询问 + 自动响应探针，品牌入口降为可选） | 已完成 |
| 5 | 任务模板（评审 / 排障 / 交接的预置任务清单） | 已完成 |
| 10 | 任务交付闭环（原子认领 + 结果关联 resultSeq） | 已完成 |
| 11 | 盲测（3 种运行时独立完成预览→加入→认领→交付） | 已完成 |
| 12 | space-agent 通用 POSIX 客户端（统一收件箱 + 逐操作恢复） | 已完成 |
| 14 | 自动响应测量（盲测 respond 子命令 + 宿主唤醒证据） | 已完成 |
| 1  | 空闲双向自动收信（#22–#25） | 已完成 |

### 待处理项
| # | 内容 | 需要谁 |
|---|------|--------|
| 2/3 | Pi 桥接联调（忙碌排队、重复投递、断线恢复、Pi 连接状态显示） | 用户授权 Pi |
| 7 | Caddy 安全加固（只信任 CF-Connecting-IP） | 用户本人执行 |
| 8 | 5 位真人首次试用验收 | 用户 |
| 9 | 公开成果页（暂缓，待脱敏与撤销能力） | 未来 |
| 13 | Windows 私有目录 / ACL 支持 | 等 Pi 侧实现 |
| Pi 恢复连接 | `resume` 命令（免输路径） | 用户授权 Pi 实施 |

---

## 三、代码结构

```
packages/pi-cafe-space/
├── relay/internal/collaboration/   # Go 后端：rooms、contract、guide
│   ├── rooms.go                    # 全部 HTTP 操作、名称/agent 校验
│   ├── contract.go                 # 机器可读契约（JSON Schema）
│   ├── rooms_test.go               # 包含成员、任务、盲测集成测试
│   └── members_test.go             # 名称长度、agent 标签专项测试
├── scripts/
│   ├── space-agent.mjs             # POSIX 通用客户端（join/watch/done/task create/unlock）
│   ├── space-agent.test.mjs        # 11 个测试，需 PI_CAFE_RELAY_BINARY
│   ├── collaboration-blind.mjs     # 盲测运行器（setup/judge/respond）
│   ├── collaboration-blind.test.mjs# 5 个测试
│   ├── collaboration-smoke.mjs     # HTTP + 浏览器冒烟
│   └── collaboration-drill.mjs     # 稳定性演练
├── web/src/features/collaboration/
│   ├── Collaboration.tsx           # React 页面（主组件）
│   ├── Collaboration.module.scss   # 所有样式（深色暖咖色系，毛玻璃）
│   ├── api.ts                      # 邀请文本生成、成员类型、错误映射
│   ├── probe.ts                    # 响应测试逻辑
│   ├── templates.ts                # 任务模板（review-v1 / debug-v1 / handoff-v1）
│   └── Collaboration.test.tsx      # 23 个 UI 测试
└── docs/
    ├── COLLABORATION.md            # 用户和开发者文档
    ├── COLLABORATION_PI.md         # Pi SDK 专属接入文档
    ├── HANDOVER.md                 # 本文档
    └── evidence/
        └── claude-code-runs-20261022.json  # 脱敏运行记录（13 次）
```

---

## 四、已验证的关键约定

### 名称和 agent 字段
- 新成员名称 ≤ 16 字，超出返回 `400 NAME_TOO_LONG`。
- 已保存的旧名称（最长 48 字）仍可加载，仅在再次保存时才截断，不会损坏旧房间。
- `agent` 字段仅 `kind=ai` 成员可填；格式：小写字母、数字、点、连字符，最长 24 字符，不合规返回 `400 INVALID_AGENT`。已知类型：`claude-code`、`codex`、`pi`、`gemini-cli`、`cursor`、`opencode`、`aider`，其他 id 原样显示。

### 任务创建重试
- 服务端按原始创建请求的 SHA-256 指纹识别重试（`request` 字段，读取和 API 响应中隐藏），重命名后的任务仍可被原请求重试识别。
- 回滚到 `fbf6f81` 之前的版本会在下次写入时丢弃 `request` 字段，之后回退为按当前标题比对（兼容，不破坏旧数据）。

### Pi 协议（`pi-collaboration-inbox` 分支）
- Pi 监听通过 `/cafe-collab connect <config路径>` 启动，使用 `cafe-collaboration` 自定义消息类型投递，`cafe-collaboration-state` 记录检查点。
- 当前行为：普通广播和点名消息都可进入会话；本机行动边界不因房间消息扩大。

---

## 五、验收流程

每次上线前必须跑完：

```bash
P=/root/space-update-collab/dev/packages/pi-cafe-space
B=<新 release 包>/dist/relay/bin/linux-amd64/pi-cafe-relay

cd $P/relay && go test -count=1 ./... && go vet ./...
unshare -n sh -c 'ip link set lo up; GOPROXY=off go test -race -count=1 ./...'
cd $P && npm run refactor:web:check && npm run refactor:web:test
npm run remote:pack -- --platforms linux-amd64
node scripts/collaboration-smoke.mjs --binary $B
node scripts/collaboration-smoke.mjs --binary $B --browser /root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
node scripts/collaboration-drill.mjs --binary $B
PI_CAFE_RELAY_BINARY=$B node --test scripts/space-agent.test.mjs
PI_CAFE_RELAY_BINARY=$B node --test scripts/collaboration-blind.test.mjs
node ui-preview.mjs $B <chrome> $P <out-dir>
```

部署：
```bash
bash /opt/stacks/pi-cafe-space/scratchpad/deploy-cloud.sh \
  <上一个release名> <新release名> <验收日志目录> <完整commit hash>
```

---

## 六、盲测记录摘要

完整记录见 `docs/evidence/claude-code-runs-20261022.json`（对端报告，Pi 已独立复核脚本和解析器）。

| 运行时 | 测试类型 | 结果 |
|--------|----------|------|
| Claude Code 子代理 | 一次性交付 | 7/7 房间检查通过 |
| Codex | 一次性交付 | run-2 未加入（旧协议文字歧义）；run-3 通过 |
| Pi SDK | 一次性交付 | Pi 自测（#60 报告） |
| Claude Code | 监听/自动唤醒 | 空闲、忙碌、进程重启、受控断网各 1 次，均 new-turn 或 in-turn |

三种运行时条件不同，不等同于所有 Agent 通用可用。

---

## 七、已知限制

1. **Pi 连接恢复：** `/reload` 后需重新输入配置文件绝对路径。`resume` 命令已设计好（参见房间 #85/#86），需 Pi 用户本地授权 Pi 实施。
2. **Caddy 加固（任务 #7）：** 未做，需用户本人在服务器执行，影响所有站点，不宜自动化。
3. **Windows 支持（任务 #13）：** 仅本地开发，PI 侧已实现相关代码，待整合。
4. **`pi` CLI 认证问题：** `/v1/models` 返回 200，`/responses` 返回 401，未排查根因，影响 pi CLI 盲测。
5. **等待提示时间窗口：** 点名 AI 5 分钟后"等待回复"提示收起。合理但短，可按需调整 `waitWindow`（`Collaboration.tsx`）。

---

*本文档由 Claude Code（claude-opus-5-5）生成，最后更新 2026-10-23T04:10Z。*
