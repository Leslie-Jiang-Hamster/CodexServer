# Feishu Codex Server

通过飞书调用本机 Codex CLI。使用飞书 WebSocket 长连接，不需要公网回调地址。每个飞书 chat 单独保存 Codex session；普通消息继续当前 session，`/new` 清除当前 session，`/status` 查看状态。

固定运行参数：

- 工作目录：`~/codex-work`
- 命令：`codex`
- 模型：`gpt-5.6-luna`
- 推理强度：`medium`
- 超时：15 分钟
- session 文件：`~/.codex-feishu/sessions.json`

## 启动

```bash
npm install
cp .env.example .env
# 填入 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_ALLOWED_OPEN_IDS
npm start
```

飞书应用需要开启机器人能力、申请 `im:message` 权限，在事件订阅中选择长连接模式，并订阅 `im.message.receive_v1`。

运行机器需要已经完成 `codex login`。Codex 使用 `--dangerously-bypass-approvals-and-sandbox`，因此具备 full access；消息发送者必须命中 `FEISHU_ALLOWED_OPEN_IDS`，否则会被拒绝。

## 命令

- `/new`：删除当前 chat 的 session，下一条消息开启新会话
- `/status`：显示 session ID、运行状态、工作目录和 sandbox 模式
- `/help`：显示帮助
