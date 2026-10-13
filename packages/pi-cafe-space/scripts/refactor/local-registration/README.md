# 本机普通 Pi 注册接线

此目录是用户本机试用接线，不是发行包，也不属于普通测试或R19生产切换。

已启用的全局入口：`C:\Users\example-user\.pi\agent\cafe-space-local\extension.ts`。
它加载已安装的当前候选，默认连接 `ws://127.0.0.1:37983/ws` / `manual-trial`。

- 正常启动 `pi` 自动注册；已有Pi由用户在各窗口执行 `/reload`。
- 显式relay/room、协作opt-out和peer ID仍优先；普通实例使用candidate生成的不同ID。
- 不创建AgentSession，不改模型设置，不移动cwd/会话，不发送模型请求。
- adapter只为精确的本机目标注入Relay默认令牌，不向其他endpoint注入。
- 安装目录 `.refactor/manual-trial/` 与全局adapter都须保留。
- `Stop.cmd`会停止共享试用Relay和专用Pi/Chrome；不会终止普通Pi，但会中断它们的Web连接。只关闭专用Pi时，退出那个Pi窗口即可。

`connection.json`只记录私有试用配置的位置；Relay令牌仍在试用目录的`credentials.json`，不是provider密钥。该basename被现有远程文件策略拒读。

`registration-backup.json`位于全局adapter目录，只保留替换前后那一个package条目及settings哈希。需要恢复时，在全局`settings.json`的packages中仅将对应新条目替回`oldEntry`；不要用旧配置覆盖其他新设置。随后由用户reload。其他扩展/provider设置未变。

## `/reload` 更新缓存修复

原入口的原生 `import(fileURL)` 会跨 `/reload` 保留ESM缓存，导致安装包已经更新但普通Pi仍上报旧能力。现复用候选所在保留workspace已安装的jiti，同步转换本包并关闭moduleCache；SDK通过Pi提供的静态导入传入virtualModules，ws继续用原生模块，不清理其他扩展缓存。不能再从运行中Pi的安装路径解析jiti/SDK：全局升级可删除旧安装目录，而旧的打包版Pi仍在内存中运行。仅给入口URL加随机参数不能刷新协议/文件读取等相对依赖，因此没有采用。

此入口仅用于已验收的Windows/Node本机接线，不是Bun/SEA发行兼容承诺。2026-09-30修复已复制至拥有标记和备份的全局入口；Relay/候选包无需重建或重启。已有Pi仍需用户在空闲时执行一次`/reload`，这次会同时更新入口和依赖。

`PI_CAFE_TEST_PI_ROOT=<Pi包目录> node --test scripts/refactor/local-registration/reload.test.mjs`用真实Pi loader验证同进程入口/依赖/仅依赖变更及已预热原生缓存；不启动会话或模型。未提供路径时明确skip。已通过Pi0.84.4/0.99.1 loader；新增嵌入SDK且磁盘SDK路径不存在的回归，校验candidate实际复用传入SDK对象。

真实原生回归：`node scripts/refactor/session-controls-native.mjs --allow-native --input-assist --registration-reload --previous-archive <旧候选tgz> --pi-root <Pi包目录>`。在临时Pi里先实际复现“更新后reload仍旧”，再替换入口并连续reload，确认sessionId/cwd/空会话保持、inputAssist出现以及命令/文件端到端可用。三个离线合成provider响应，零真实模型/网络请求；不对用户Pi发reload。证据见`.refactor/reports/R18-registration-reload/`；追加`--bundled-pi`以实际`dist/bundle/cli.js`验收，证据写入`R18-registration-offline/`。旧磁盘路径被删除的情况是loader级合成测试；不冒充在用户老进程中已验收。

## 专项检查

使用批准的Node22执行`defaults.test.mjs`。`smoke.mjs`会启动受控的真实Pi进程，在独立room验证自动加载、不同实例、opt-out和敏感文件拒读；不发送prompt，不调用模型。它需要原生进程测试权限，不接入普通tests。其agent配置只镜像这一个注册项，不冒充全套全局扩展兼容验收。

`setup.mjs prepare/activate`会改本机文件和全局Pi注册，只有明确获准时运行。它拒绝覆盖已有准备目录/备份，activate要求smoke通过且源码哈希一致；不是可随意重复执行的安装命令。当前已完成，不要重跑。
