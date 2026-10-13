# @cafecodework/pi-context

Pi coding agent 扩展，提供 `/context` 命令。

![pi-context preview](./assets/context-preview.png)

## 功能

`/context` 会显示：

- 当前上下文窗口的实际使用量；
- 上下文窗口总大小；
- 使用百分比；
- System prompt、用户消息、助手文本、Thinking、工具调用、工具结果等分类估算；
- 每个分类在当前估算内容中的占比。

分类统计使用 Pi 当前会发送给模型的会话内容，并采用字符数除以 4 的方式进行估算。

## 安装

```bash
pi install git:github.com/cafecodework/pi-packages
```

如果从 monorepo 根目录安装没有加载本包，可以使用本地路径：

```bash
pi install C:\path\to\pi-packages\packages\pi-context
```

## 使用

在 Pi 中输入：

```text
/context
```

报告会作为自定义会话内容显示，但不会再次发送给模型。

## 开发

```bash
npm install
npm run typecheck
```
