import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { logLine, truncate, WORKSPACE_ROOT } from "./config.js";

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 39765;
export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_REASONING = "high";
const DEFAULT_SANDBOX_MODE = "danger-full-access";
const DEFAULT_SANDBOX_POLICY = { type: "dangerFullAccess" };
const DEFAULT_THREAD_NAME = "Feishu Session";

export const FEISHU_REPLY_FORMAT_INSTRUCTIONS = [
  "Feishu reply content requirements:",
  "- Reply naturally in Chinese, optimized for mobile reading: concise, clear, and not over-sectioned.",
  "- Answer short questions briefly; do not expand just to look complete.",
  "- Default to one message with lightweight headings only when useful. Do not split or over-structure short replies.",
  "- Use tables only for short status, statistics, compact key-value data, or brief A/B comparisons. Avoid tables with more than 3 columns, more than 8 rows, or long sentence-like cells.",
  "- Do not put long-form content, explanations, reports, memories, personas, issue analysis, or optimization suggestions inside tables; use grouped lists or paragraphs instead.",
  "- If the user asks for an exact string such as OK or PROJECT_OK, or asks for one sentence only, obey that exact shape.",
  "- For code, logs, or command output: explain first in Chinese, then put code/log/output in standalone fenced code blocks.",
  "- Before high-risk actions such as writing files, installing dependencies, deleting, committing, pushing, or deploying, explain the action and wait for confirmation.",
  "- Feishu message rendering is handled by the gateway; do not mention render mode or internal formatting rules in replies."
].join("\n");

const BASE_INSTRUCTIONS = [
  "\u4f60\u662f\u4ece\u98de\u4e66\u63a5\u5165\u7684 Codex \u52a9\u624b\uff0c\u540d\u5b57\u53eb\u5c0f\u6811\u3002",
  "\u7528\u6237\u4f1a\u76f4\u63a5\u5728\u98de\u4e66\u91cc\u4e0e\u4f60\u5bf9\u8bdd\uff0c\u8bf7\u7528\u4e2d\u6587\u81ea\u7136\u56de\u590d\u3002",
  "\u4f60\u53ef\u4ee5\u5e2e\u52a9\u7528\u6237\u7406\u89e3\u9879\u76ee\u3001\u63a8\u8fdb\u9879\u76ee\u3001\u8fd0\u884c\u68c0\u67e5\u3001\u603b\u7ed3\u7ed3\u679c\u3002",
  "Feishu mobile reading first: keep normal replies clearly sectioned; put code, logs, and command output in standalone fenced code blocks.",
  "\u9664\u975e\u7528\u6237\u660e\u786e\u8981\u6c42\u4f60\u505c\u4e0b\u7b49\u786e\u8ba4\uff0c\u5426\u5219\u4f60\u5e94\u8be5\u6309 Codex \u7684\u9ad8\u6743\u9650\u5de5\u4f5c\u6d41\u63a8\u8fdb\u4efb\u52a1\u3002",
  "\u5982\u679c\u7528\u6237\u63d0\u5230\u201c\u8fd9\u4e2a\u9879\u76ee\u201d\u201c\u7ee7\u7eed\u63a8\u8fdb\u201d\uff0c\u8bf7\u7ed3\u5408\u5f53\u524d\u5de5\u4f5c\u76ee\u5f55\u548c\u4e0a\u4e0b\u6587\u7406\u89e3\u3002",
  FEISHU_REPLY_FORMAT_INSTRUCTIONS
].join("\n");

export class CodexAppServerClient {
  constructor() {
    this.process = null;
    this.socket = null;
    this.transport = null;
    this.starting = null;
    this.initialized = false;
    this.nextId = 0;
    this.pending = new Map();
    this.turns = new Map();
    this.buffer = "";
  }

  async ensureStarted() {
    if (this.transport && this.transport.isAlive() && this.initialized) return;
    if (this.starting) return this.starting;

    this.starting = this.startProcessAndInitialize()
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async startProcessAndInitialize() {
    if (this.shouldUseProxy()) {
      if (!this.socket || this.socket.destroyed) {
        await this.connectProxy();
      }
    } else if (!this.process || this.process.exitCode !== null) {
      this.spawnProcess();
    }
    await this.sendRawRequest("initialize", {
      clientInfo: { name: "feishu-codex-thin-bridge", version: "0.1.0" },
      capabilities: {}
    }, 30000);
    this.initialized = true;
    logLine("codex app-server initialized");
  }

  shouldUseProxy() {
    const raw = process.env.FEISHU_CODEX_PROXY_PORT || process.env.CODEX_PROXY_PORT || "";
    if (raw.trim()) return true;
    return ["1", "true", "yes"].includes(String(process.env.FEISHU_CODEX_USE_PROXY || "").toLowerCase());
  }

  proxyHost() {
    return process.env.FEISHU_CODEX_PROXY_HOST || process.env.CODEX_PROXY_HOST || DEFAULT_PROXY_HOST;
  }

  proxyPort() {
    const raw = process.env.FEISHU_CODEX_PROXY_PORT || process.env.CODEX_PROXY_PORT || String(DEFAULT_PROXY_PORT);
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid Codex proxy port: ${raw}`);
    }
    return port;
  }

  connectProxy() {
    this.initialized = false;
    return new Promise((resolve, reject) => {
      const host = this.proxyHost();
      const port = this.proxyPort();
      const socket = net.createConnection({ host, port });
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        settled = true;
        this.socket = socket;
        this.transport = {
          write: (payload) => socket.write(payload, "utf8"),
          isAlive: () => !socket.destroyed
        };
        logLine(`connected codex app-server proxy ${host}:${port}`);
        resolve();
      });
      socket.once("error", fail);
      socket.on("data", (chunk) => this.handleStdout(chunk));
      socket.on("close", () => {
        logLine("codex app-server proxy socket closed");
        this.initialized = false;
        this.transport = null;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("codex app-server proxy socket closed"));
          clearTimeout(pending.timer);
        }
        this.pending.clear();
        this.turns.clear();
      });
    });
  }

  spawnProcess() {
    this.initialized = false;
    const codexExe = resolveCodexExecutable();
    logLine(`starting codex app-server exe=${codexExe}`);
    this.process = spawn(codexExe, ["app-server"], {
      cwd: WORKSPACE_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    this.transport = {
      write: (payload) => this.process.stdin.write(payload, "utf8"),
      isAlive: () => this.process && this.process.exitCode === null
    };
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) logLine(`codex app-server stderr: ${truncate(text, 1200)}`);
    });
    this.process.on("exit", (code, signal) => {
      logLine(`codex app-server exited code=${code} signal=${signal}`);
      this.initialized = false;
      this.transport = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server exited code=${code}`));
        clearTimeout(pending.timer);
      }
      this.pending.clear();
      this.turns.clear();
    });
  }

  async request(method, params, timeoutMs = 60000) {
    await this.ensureStarted();
    return this.sendRawRequest(method, params, timeoutMs);
  }

  sendRawRequest(method, params, timeoutMs) {
    if (!this.transport || !this.transport.isAlive()) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, method, params });
    this.transport.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch {
        logLine(`codex app-server non-json stdout: ${truncate(line, 1000)}`);
      }
    }
  }

  handleMessage(message) {
    if (this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.handleNotification(message);
  }

  handleNotification(message) {
    const method = message.method;
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    if (!turnId) {
      if (method === "error" || method === "warning") {
        logLine(`codex ${method}: ${truncate(JSON.stringify(message), 1200)}`);
      }
      return;
    }

    const turn = this.turns.get(turnId);
    if (!turn) return;
    if (turn.onEvent) {
      Promise.resolve(turn.onEvent(message)).catch((error) => {
        logLine(`codex turn event handler failed turn_id=${turnId}: ${error.message}`);
      });
    }

    if (method === "item/agentMessage/delta") {
      turn.delta.push(params.delta || "");
      return;
    }
    if (method === "item/completed") {
      const item = params.item || {};
      if (item.type === "agentMessage" && item.text) {
        turn.final.push(item.text);
      }
      return;
    }
    if (method === "turn/completed") {
      this.finishTurn(turnId, null);
      return;
    }
    if (method === "error" && params.willRetry) {
      logLine(`codex turn retrying: ${truncate(JSON.stringify(message), 1200)}`);
      return;
    }
    if (method === "turn/failed" || method === "error") {
      this.finishTurn(turnId, new Error(JSON.stringify(message)));
    }
  }

  finishTurn(turnId, error) {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    if (error) {
      turn.reject(error);
      return;
    }
    const eventText = turn.final.join("\n").trim() || turn.delta.join("").trim();
    const sessionText = eventText ? "" : readLatestSessionFinalAnswer(turn.threadId, turn.startedAt);
    if (!eventText && sessionText) {
      logLine(`codex final answer recovered from session thread_id=${turn.threadId} event_len=${eventText.length} session_len=${sessionText.length}`);
    }
    const text = sessionText || eventText;
    if (turn.onEvent) {
      Promise.resolve(turn.onEvent({
        method: "turn/finalText",
        params: { turnId, threadId: turn.threadId, text }
      })).catch((handlerError) => {
        logLine(`codex final text handler failed turn_id=${turnId}: ${handlerError.message}`);
      });
    }
    turn.resolve(text || "Codex \u5df2\u5b8c\u6210\uff0c\u4f46\u6ca1\u6709\u8fd4\u56de\u6587\u672c\u3002");
  }

  async startThread({ cwd = WORKSPACE_ROOT, name = DEFAULT_THREAD_NAME, model = DEFAULT_MODEL, reasoning = DEFAULT_REASONING, baseInstructions = BASE_INSTRUCTIONS } = {}) {
    const result = await this.request("thread/start", {
      cwd,
      model,
      reasoningEffort: reasoning,
      approvalPolicy: "never",
      sandbox: DEFAULT_SANDBOX_MODE,
      baseInstructions
    }, 60000);
    const threadId = result?.thread?.id || result?.id;
    if (!threadId) {
      throw new Error(`thread/start did not return thread id: ${JSON.stringify(result)}`);
    }
    await this.request("thread/name/set", { threadId, name }, 10000).catch((error) => {
      logLine(`set thread name failed: ${error.message}`);
    });
    return threadId;
  }

  async resumeThread(threadId) {
    await this.request("thread/resume", { threadId }, 60000);
  }

  async setThreadName(threadId, name = DEFAULT_THREAD_NAME) {
    await this.request("thread/name/set", { threadId, name }, 10000);
  }

  async startTurnStream({ threadId, text, cwd = WORKSPACE_ROOT, model = DEFAULT_MODEL, reasoning = DEFAULT_REASONING, onEvent }) {
    await this.resumeThread(threadId).catch((error) => {
      logLine(`thread resume before turn failed: ${error.message}`);
    });
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd,
      model,
      reasoningEffort: reasoning,
      approvalPolicy: "never",
      sandboxPolicy: DEFAULT_SANDBOX_POLICY
    }, 60000);
    const turnId = result?.turn?.id || result?.id;
    if (!turnId) {
      throw new Error(`turn/start did not return turn id: ${JSON.stringify(result)}`);
    }
    const completion = new Promise((resolve, reject) => {
      this.turns.set(turnId, { resolve, reject, delta: [], final: [], threadId, startedAt, onEvent });
    });
    if (onEvent) {
      await Promise.resolve(onEvent({ method: "turn/started", params: { turnId, threadId } }));
    }
    return { turnId, completion };
  }

  async runTurn(args) {
    const { completion } = await this.startTurnStream(args);
    return completion;
  }

  async steerTurn({ threadId, turnId, text }) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }]
    }, 10000);
  }

  async interruptTurn(turnId, threadId = "") {
    return this.request("turn/interrupt", threadId ? { threadId, turnId } : { turnId }, 10000);
  }

  async archiveThread(threadId) {
    return this.request("thread/archive", { threadId }, 10000);
  }

  async unarchiveThread(threadId) {
    return this.request("thread/unarchive", { threadId }, 10000);
  }

  async readThread(threadId) {
    return this.request("thread/read", { threadId }, 30000);
  }
}

export const codexAppServer = new CodexAppServerClient();

function resolveCodexExecutable() {
  const explicit = process.env.FEISHU_CODEX_CLI_PATH?.trim();
  if (explicit) return explicit;

  if (process.platform !== "win32") return "codex";

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [];

  const rootExe = path.join(binDir, "codex.exe");
  if (fs.existsSync(rootExe)) candidates.push(rootExe);

  try {
    for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(binDir, entry.name, "codex.exe");
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  } catch {
    // Fall through to PATH lookup.
  }

  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  return candidates[0] || "codex";
}

const sessionFileCache = new Map();

function readLatestSessionFinalAnswer(threadId, startedAt) {
  const file = findSessionFile(threadId);
  if (!file) return "";

  let latest = "";
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (startedAt && record.timestamp && record.timestamp < startedAt) continue;
      const payload = record.payload || {};
      if (record.type !== "response_item") continue;
      if (payload.type !== "message" || payload.role !== "assistant") continue;
      if (payload.phase && payload.phase !== "final_answer") continue;
      const text = (payload.content || []).map((item) => item.text || "").join("").trim();
      if (text) latest = text;
    }
  } catch (error) {
    logLine(`read session final answer failed thread_id=${threadId}: ${error.message}`);
  }
  return latest;
}

function findSessionFile(threadId) {
  if (!threadId) return "";
  if (sessionFileCache.has(threadId)) {
    const cached = sessionFileCache.get(threadId);
    if (fs.existsSync(cached)) return cached;
  }

  const root = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "sessions");
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        sessionFileCache.set(threadId, fullPath);
        return fullPath;
      }
    }
  }
  return "";
}
