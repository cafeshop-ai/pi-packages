# 公开文档与提交隐私

本仓库的 README、docs、历史参考文档以及 Git 提交元数据都可能公开可见。把资料从 README 移到同仓库的 docs 或历史章节，不会让它变成私有。

## 公开和私有边界

公开文档保留产品介绍、公开产品域名、协议路径、架构分工、通用配置和明确标注的示例。默认开发端口、示例文件名与功能模块不是访问凭据，不需要为隐藏实现而删除整个安装说明。

真实源站地址、SSH 账户和连接方式、个人主目录、具体运维挂载、私钥／会话数据的实际位置以及未脱敏回执，应保存在公开 Git 之外的私有运维记录中。密钥、密码、Cookie、令牌、真实房间链接和用户会话正文不得进入公开资料。

公开历史文档中的 `example-user` 与 `/srv/cafe-example` 是脱敏示例，不是维护者的实际主机信息。原始技术与运维记录另有私有副本；公开的旧章节只作实现追溯，不能据此执行当前服务器操作。

## 提交前检查

检查 staged diff，而不仅是当前 README。核对所有修改文件、被移入历史目录的内容、相对链接，以及作者和提交者邮箱。检查发现时只报告文件、行号和类别，不在新的日志、issue 或提交信息里再次粘贴敏感内容。

提交邮箱使用本人在 GitHub 核对的 noreply 地址，可仅对当前仓库设置，避免影响其他项目。示例值必须换成本人的已验证地址：

```sh
git config --local user.email 'YOUR_VERIFIED_NOREPLY_EMAIL'
```

这不改变已有提交，也不自动修改 GitHub 网页编辑的邮箱隐私设置。使用其他电脑或网页提交前，也要核对对应环境的身份配置。不要把别人的邮箱或任意猜测的 GitHub ID 写入配置。

敏感原文不能作为新增测试样例、脚本常量或“禁止词列表”重新提交。校验程序应使用通用规则或私下提供的匹配值，输出脱敏结果。

## 旧辅助脚本的路径参数

历史安装／验收脚本不再写死个人路径。它们不是当前日常安装入口，也不会在缺少参数时自动找用户凭据：

| 脚本 | 必须明确提供的配置 |
|---|---|
| `scripts/refactor/local-registration/setup.mjs` | `CAFE_LEGACY_AGENT_DIR`：绝对 Pi agent 目录 |
| `scripts/refactor/local-registration/smoke.mjs` | `CAFE_LEGACY_INSTALLED_DIR`、`CAFE_LEGACY_PI_ROOT`：绝对目录 |
| `scripts/refactor/manual-install.mjs` | 原有 Windows／手动授权条件，加 `CAFE_LEGACY_PI_ROOT`、`CAFE_LEGACY_MODELS_FILE` |
| `scripts/remote/production-rtc-test.mjs` | `--credentials` 绝对路径和 `--device` 目标名称；可选 `--origin` |

只有明确需要旧模式的维护者才应运行这些脚本。语法检查不代表已重新做过 Windows 安装或真实生产连接验收。正常安装仍使用 [INSTALL.md](INSTALL.md)。

## 已公开内容的处理

删除当前文件中的内容只修复新版本；旧提交、分支、标签、克隆和缓存可能继续保留旧内容。重写 Git 历史会改变提交号并影响协作者，必须单独确认范围、备份与同步方式，不能为了清理隐私直接覆盖他人更新。

本次用户已选择修复当前版本和后续邮箱，旧历史暂不重写；仓库可见性、其他分支和线上服务不因此改变。若发现可用凭据已经公开，应先评估撤销／轮换，再处理历史，而不是声称删除文本就能让凭据失效。

## 官方参考

- [GitHub：设置提交邮箱](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)
- [GitHub：noreply 邮箱格式](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)
- [GitHub：从仓库移除敏感数据](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
