import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Bot, GrammyError, HttpError } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

const homeDir = os.homedir();
const workdir = path.resolve(homeDir, "codex-work");
const storePath = path.resolve(homeDir, ".codex-telegram", "sessions.json");
const timeoutMs = 900000;
const codexCommand = "codex";
const model = "gpt-5.6-luna";
const reasoningEffort = "medium";
const telegramProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, event, pid: process.pid, ...fields };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else console.log(output);
}

process.on("uncaughtException", (error) => {
  log("error", "process.uncaught_exception", { error: error?.stack || String(error) });
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  log("error", "process.unhandled_rejection", { error: reason?.stack || String(reason) });
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => log("warn", "process.signal", { signal }));
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
  client: {
    timeoutSeconds: 15,
    baseFetchConfig: telegramProxy ? { agent: new HttpsProxyAgent(telegramProxy) } : {},
  },
});
let sessions = await loadSessions();
const activeRequests = new Map();

function isAllowed(ctx) {
  return true;
}

async function loadSessions() {
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveSessions() {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(sessions, null, 2)}\n`);
  await fs.rename(temporaryPath, storePath);
}

function enqueue(chatId, task) {
  const previous = activeRequests.get(chatId) || Promise.resolve();
  if (activeRequests.has(chatId)) {
    log("info", "request.queued", { chatId, activeRequests: activeRequests.size });
  }
  const current = previous.catch(() => {}).then(task);
  activeRequests.set(chatId, current);
  return current.finally(() => {
    if (activeRequests.get(chatId) === current) activeRequests.delete(chatId);
    log("info", "request.queue_finished", { chatId, activeRequests: activeRequests.size });
  });
}

function codexArgs(sessionId, prompt) {
  const args = ["exec"];
  if (sessionId) args.push("resume", sessionId);
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  );
  if (!sessionId) args.push("--cd", workdir);
  args.push("--model", model, "-c", `model_reasoning_effort=\"${reasoningEffort}\"`);
  args.push(prompt);
  return args;
}

function runCodex(sessionId, prompt, requestId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    log("info", "codex.spawn_start", {
      requestId,
      resumed: Boolean(sessionId),
      promptLength: prompt.length,
    });
    const child = spawn(codexCommand, codexArgs(sessionId, prompt), {
      cwd: workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      log("error", "codex.timeout", {
        requestId,
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      child.kill("SIGTERM");
      finish(new Error(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      log("error", "codex.spawn_error", {
        requestId,
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        error: error.stack || String(error),
      });
      finish(error);
    });
    child.on("close", (code) => {
      log(code === 0 ? "info" : "error", "codex.closed", {
        requestId,
        pid: child.pid,
        code,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        stderrTail: stderr.trim().slice(-2000),
      });
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Codex exited with code ${code}`));
        return;
      }
      finish(null, parseCodexOutput(stdout));
    });
  });
}

function parseCodexOutput(output) {
  let newSessionId;
  let answer = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") newSessionId = event.thread_id || event.thread?.id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        answer = event.item.text || answer;
      }
      if (event.type === "agent_message.delta") answer += event.delta || "";
      if (event.type === "turn.completed" && event.turn?.status === "failed") {
        throw new Error(event.turn.error?.message || "Codex turn failed");
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return { sessionId: newSessionId, answer: answer.trim() || "Codex 没有返回文本。" };
}

async function sendLongMessage(ctx, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || ["(empty)"];
  for (const chunk of chunks) await ctx.reply(chunk);
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) {
    await ctx.reply("未授权的 chat。");
    return;
  }
  await next();
});

bot.command("start", (ctx) => ctx.reply("已连接 Codex。发送文本即可继续当前 session。\n/new 新建 session\n/status 查看状态"));
bot.command("help", (ctx) => ctx.reply("发送文本给 Codex。\n/new 新建 session\n/status 查看当前 session 状态"));

bot.command("new", async (ctx) => {
  const chatId = String(ctx.chat.id);
  log("info", "command.new", { chatId });
  await enqueue(chatId, async () => {
    delete sessions[chatId];
    await saveSessions();
    await ctx.reply("已新建 session。下一条消息将开始新的 Codex 会话。");
  });
});

bot.command("status", async (ctx) => {
  const chatId = String(ctx.chat.id);
  log("info", "command.status", { chatId });
  const sessionId = sessions[chatId]?.sessionId;
  await ctx.reply([
    `session: ${sessionId || "未创建"}`,
    `request: ${activeRequests.has(chatId) ? "运行中" : "空闲"}`,
    `workdir: ${workdir}`,
    "sandbox: danger-full-access",
  ].join("\n"));
});

bot.on("message:text", async (ctx) => {
  const prompt = ctx.message.text.trim();
  if (!prompt) return;
  const chatId = String(ctx.chat.id);
  const requestId = `${chatId}:${ctx.message.message_id}:${Date.now()}`;
  log("info", "telegram.message_received", {
    requestId,
    chatId,
    messageId: ctx.message.message_id,
    promptLength: prompt.length,
  });
  await enqueue(chatId, async () => {
    const current = sessions[chatId]?.sessionId;
    try {
      await ctx.reply(current ? "正在继续 Codex session…" : "正在创建 Codex session…");
      log("info", "telegram.ack_sent", { requestId, chatId, resumed: Boolean(current) });
      const result = await runCodex(current, prompt, requestId);
      sessions[chatId] = { sessionId: result.sessionId || current, updatedAt: new Date().toISOString() };
      await saveSessions();
      await sendLongMessage(ctx, result.answer);
      log("info", "telegram.response_sent", { requestId, chatId, answerLength: result.answer.length });
    } catch (error) {
      log("error", "request.failed", { requestId, chatId, error: error?.stack || String(error) });
      try {
        await ctx.reply(`Codex 调用失败：${error.message}`);
      } catch (replyError) {
        log("error", "telegram.error_reply_failed", {
          requestId,
          chatId,
          error: replyError?.stack || String(replyError),
        });
      }
    }
  });
});

bot.catch((error) => {
  const cause = error.error;
  if (cause instanceof GrammyError) log("error", "telegram.request_failed", { description: cause.description });
  else if (cause instanceof HttpError) log("error", "telegram.network_failed", { error: cause.stack || String(cause) });
  else log("error", "bot.error", { error: cause?.stack || String(cause) });
});

log("info", "server.started", {
  workdir,
  storePath,
  model,
  timeoutMs,
  proxyConfigured: Boolean(telegramProxy),
});
log("info", "telegram.connecting");
try {
  await bot.start({ onStart: (info) => log("info", "telegram.running", { username: info.username }) });
} catch (error) {
  log("error", "telegram.startup_failed", {
    error: error?.stack || error.description || error.message || String(error),
  });
  process.exitCode = 1;
}
