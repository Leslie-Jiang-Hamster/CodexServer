import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";

const homeDir = os.homedir();
const workdir = path.resolve(homeDir, "codex-work");
const storePath = path.resolve(homeDir, ".codex-feishu", "sessions.json");
const timeoutMs = 900000;
const model = "gpt-5.6-luna";
const reasoningEffort = "medium";
const busyMessage = "当前有任务正在执行，请稍候。你可以发送 /status 查看状态。";
const activeChildren = new Set();
const activeRequests = new Map();
const allowedOpenIds = new Set(String(process.env.FEISHU_ALLOWED_OPEN_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
let channel;
let shuttingDown = false;
let sessions = await loadSessions();

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event, pid: process.pid, ...fields };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output); else console.log(output);
}

process.on("uncaughtException", (error) => { log("error", "process.uncaught_exception", { error: error?.stack || String(error) }); process.exitCode = 1; });
process.on("unhandledRejection", (reason) => { log("error", "process.unhandled_rejection", { error: reason?.stack || String(reason) }); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("warn", "process.signal", { signal });
    for (const child of activeChildren) child.kill("SIGTERM");
    const forceKillTimer = setTimeout(() => { for (const child of activeChildren) child.kill("SIGKILL"); }, 10000);
    forceKillTimer.unref();
    try { await channel?.disconnect(); } catch (error) { log("error", "feishu.disconnect_failed", { error: error?.stack || String(error) }); }
  });
}

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
if (!allowedOpenIds.size) throw new Error("FEISHU_ALLOWED_OPEN_IDS is required; refusing to run without an explicit sender allowlist");

async function loadSessions() {
  try { return JSON.parse(await fs.readFile(storePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
async function saveSessions() {
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, storePath);
}
function enqueue(chatId, task) {
  const previous = activeRequests.get(chatId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  activeRequests.set(chatId, current);
  return current.finally(() => { if (activeRequests.get(chatId) === current) activeRequests.delete(chatId); });
}
function codexArgs(sessionId, prompt) {
  const args = ["exec"];
  if (sessionId) args.push("resume", sessionId);
  args.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");
  if (!sessionId) args.push("--cd", workdir);
  args.push("--model", model, "-c", `model_reasoning_effort=\"${reasoningEffort}\"`, prompt);
  return args;
}
function parseCodexOutput(output) {
  let newSessionId;
  let answer = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") newSessionId = event.thread_id || event.thread?.id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text || answer;
      if (event.type === "agent_message.delta") answer += event.delta || "";
      if (event.type === "turn.completed" && event.turn?.status === "failed") throw new Error(event.turn.error?.message || "Codex turn failed");
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return { sessionId: newSessionId, answer: answer.trim() || "Codex 没有返回文本。" };
}
function runCodex(sessionId, prompt, requestId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("codex", codexArgs(sessionId, prompt), { cwd: workdir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error(`Codex timed out after ${timeoutMs}ms`)); }, timeoutMs);
    log("info", "codex.spawn_start", { requestId, resumed: Boolean(sessionId), promptLength: prompt.length });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", finish);
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      log(code === 0 ? "info" : "error", "codex.closed", { requestId, pid: child.pid, code, signal, durationMs: Date.now() - startedAt, stderrTail: stderr.trim().slice(-2000) });
      if (code !== 0) finish(new Error(stderr.trim() || (signal ? `Codex terminated by ${signal}` : `Codex exited with code ${code}`)));
      else { try { finish(null, parseCodexOutput(stdout)); } catch (error) { finish(error); } }
    });
  });
}
async function sendText(chatId, text, replyTo) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || ["(empty)"];
  for (const chunk of chunks) await channel.send(chatId, { text: chunk }, replyTo ? { replyTo } : undefined);
}
async function handleMessage(message) {
  const senderId = String(message.senderId || "");
  if (!allowedOpenIds.has(senderId)) { log("warn", "feishu.sender_rejected", { senderId, chatId: message.chatId }); return; }
  const prompt = String(message.content || "").trim();
  if (!prompt) return;
  const chatId = String(message.chatId);
  if (activeRequests.has(chatId)) { await sendText(chatId, busyMessage, message.messageId); return; }
  const requestId = `${chatId}:${message.messageId}:${Date.now()}`;
  await enqueue(chatId, async () => {
    const current = sessions[chatId]?.sessionId;
    try {
      if (prompt === "/new") { delete sessions[chatId]; await saveSessions(); await sendText(chatId, "已新建 session。下一条消息将开始新的 Codex 会话。", message.messageId); return; }
      if (prompt === "/status") { await sendText(chatId, [`session: ${current || "未创建"}`, `request: ${activeRequests.has(chatId) ? "运行中" : "空闲"}`, `workdir: ${workdir}`, "sandbox: danger-full-access"].join("\n"), message.messageId); return; }
      if (prompt === "/help") { await sendText(chatId, "发送文本给 Codex。\n/new 新建 session\n/status 查看当前 session 状态", message.messageId); return; }
      await sendText(chatId, current ? "正在继续 Codex session…" : "正在创建 Codex session…", message.messageId);
      const result = await runCodex(current, prompt, requestId);
      sessions[chatId] = { sessionId: result.sessionId || current, updatedAt: new Date().toISOString() };
      await saveSessions();
      await sendText(chatId, result.answer, message.messageId);
      log("info", "feishu.response_sent", { requestId, chatId, answerLength: result.answer.length });
    } catch (error) {
      log("error", "request.failed", { requestId, chatId, error: error?.stack || String(error) });
      try { await sendText(chatId, `Codex 调用失败：${error.message}`, message.messageId); } catch (replyError) { log("error", "feishu.error_reply_failed", { requestId, error: replyError?.stack || String(replyError) }); }
    }
  });
}

channel = createLarkChannel({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  transport: "websocket",
  loggerLevel: LoggerLevel.info,
  policy: { requireMention: false, dmMode: "open" },
});
channel.on("message", (message) => handleMessage(message).catch((error) => log("error", "feishu.message_handler_failed", { error: error?.stack || String(error) })));
channel.on("reject", (event) => log("warn", "feishu.message_rejected", { reason: event.reason }));
channel.on("reconnecting", () => log("warn", "feishu.reconnecting"));
channel.on("reconnected", () => log("info", "feishu.reconnected"));
channel.on("error", (error) => log("error", "feishu.error", { error: error?.stack || String(error) }));
log("info", "server.started", { workdir, storePath, model, timeoutMs, transport: "websocket", allowlistedSenders: allowedOpenIds.size });
try {
  await channel.connect();
  log("info", "feishu.connected", { botName: channel.botIdentity?.name || "unknown" });
} catch (error) {
  log("error", "feishu.connect_failed", { error: error?.stack || String(error) });
  process.exitCode = 1;
}
