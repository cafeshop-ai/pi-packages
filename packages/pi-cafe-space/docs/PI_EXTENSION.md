# Pi extension

`src/extension/` 是 Pi Cafe Space package 中由 Pi 加载的 host extension。构建后的入口是 `dist/extension/index.js`，并由 package 根目录 `package.json` 的 `pi.extensions` 声明。

在父仓库根目录构建并安装：

```powershell
cd C:\Users\example-user\Documents\cafecodework-pi-packages
npm run pi-cafe-space:build
pi install C:\Users\example-user\Documents\cafecodework-pi-packages\packages\pi-cafe-space
```

扩展默认在普通 `pi` 启动时连接 `ws://127.0.0.1:37891/ws`。如果 loopback relay 尚未运行，它会启动同一 package 中的 `dist/relay/index.js`。多个普通 `pi` 实例可以使用同一个 room；每个实例通过进程内稳定、跨进程随机的 `peerId` 注册为独立 host，不会互相拒绝。需要固定实例名称时可设置 `PI_COLLAB_PEER_ID`（不同运行时不要复用同一个值）。

使用 `PI_COLLAB_ENABLED=0` 可为单次进程关闭自动连接。远程或显式配置可使用 `PI_COLLAB_RELAY_URL`、`PI_COLLAB_ROOM`、`PI_COLLAB_HOST_TOKEN` 和可选的 `PI_COLLAB_PEER_ID`。relay 暂时不可用时扩展仍会指数退避并自动重连；连接 warning 最多每 60 秒提示一次，Pi 状态栏仍会显示当前连接状态。自动拉起的 relay 子进程使用最小化的 OS 启动环境，不继承 Pi/provider 的凭据变量。
