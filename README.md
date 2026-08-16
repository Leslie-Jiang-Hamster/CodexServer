# Telegram Codex Server

通过 Telegram 调用本机 Codex CLI。每个 Telegram chat 单独保存 session；普通消息继续当前 session，`/new` 清除当前 session，`/status` 查看状态。

固定运行参数：

- 工作目录：`~/codex-work`
- 命令：`codex`
- 模型：`gpt-5.6-luna`（官方模型 ID）
- 推理强度：`medium`
- 超时：15 分钟
- session 文件：`~/.codex-telegram/sessions.json`

## 启动

```bash
npm install
cp .env.example .env
# 填入 TELEGRAM_BOT_TOKEN
npm start
```

程序会自动使用系统的 `HTTP(S)_PROXY` 环境变量（适用于 WSL 中通过本机代理访问 Telegram API 的情况）。

运行机器需要已经完成 `codex login`。Bot 使用 `--dangerously-bypass-approvals-and-sandbox`，因此具备 full access；当前版本只有 bot token 可配置，没有 chat 白名单，请不要把 bot 暴露给不可信用户。

## 命令

- `/new`：删除当前 chat 的 session，下一条消息开启新会话
- `/status`：显示 session ID、运行状态、工作目录和 sandbox 模式
- `/help`：显示帮助
