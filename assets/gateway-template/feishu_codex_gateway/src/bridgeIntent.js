import { FEISHU_PROJECT_ROOT, truncate } from "./config.js";
import { codexAppServer, DEFAULT_MODEL } from "./codexAppServer.js";

const ROUTER_THREAD_NAME = "Feishu Gateway Router";
const ROUTER_REASONING = "low";

const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2"
]);

const ALLOWED_REASONING = new Set(["low", "medium", "high", "xhigh"]);

const ROUTER_INSTRUCTIONS = [
  "You are the intent router for a Feishu to Codex gateway.",
  "Return only one compact JSON object. No markdown. No explanation.",
  "Decide whether the user is asking for gateway/session/model management, or whether the message should be delegated to the active Codex task thread.",
  "Use delegate for project work, coding tasks, questions, summaries, file operations, brainstorming, or anything that should be handled by Codex in the active thread.",
  "Use management actions only when the user clearly asks to list/switch/create/read/archive/unarchive sessions, show current binding, change model, change reasoning effort, list/cancel jobs, or show gateway help.",
  "Actions: delegate, list_sessions, current_session, new_session, switch_session, set_model, cancel_job, list_jobs, archive_session, unarchive_session, read_session, help.",
  "For switch_session, prefer threadId from the provided sessions when there is a clear index, id, exact name, or close name match.",
  "For cancel_job, use it when the user asks to pause, stop, cancel, halt, or interrupt the current running task/job.",
  "For read_session/archive_session/unarchive_session, use the current session unless the user clearly provides a thread id.",
  "For set_model, output model and/or reasoning. Allowed reasoning values: low, medium, high, xhigh.",
  "JSON shape: {\"action\":\"delegate|list_sessions|current_session|new_session|switch_session|set_model|cancel_job|list_jobs|archive_session|unarchive_session|read_session|help\",\"threadId\":\"\",\"threadIndex\":0,\"targetName\":\"\",\"threadName\":\"\",\"model\":\"\",\"reasoning\":\"\"}"
].join("\n");

export async function classifyBridgeIntent({ text, chat, state, sessions }) {
  if (!state.routerThreadId) {
    state.routerThreadId = await codexAppServer.startThread({
      cwd: FEISHU_PROJECT_ROOT,
      name: ROUTER_THREAD_NAME,
      model: chat.model || DEFAULT_MODEL,
      reasoning: ROUTER_REASONING,
      baseInstructions: ROUTER_INSTRUCTIONS
    });
  }

  const prompt = buildRouterPrompt({ text, chat, sessions });
  const raw = await codexAppServer.runTurn({
    threadId: state.routerThreadId,
    text: prompt,
    cwd: FEISHU_PROJECT_ROOT,
    model: chat.model || DEFAULT_MODEL,
    reasoning: ROUTER_REASONING
  });
  return normalizeIntent(parseJsonObject(raw));
}

export async function classifyTaskDisposition({ text, activeJob, chat, state }) {
  if (!state.routerThreadId) {
    state.routerThreadId = await codexAppServer.startThread({
      cwd: FEISHU_PROJECT_ROOT,
      name: ROUTER_THREAD_NAME,
      model: chat.model || DEFAULT_MODEL,
      reasoning: ROUTER_REASONING,
      baseInstructions: ROUTER_INSTRUCTIONS
    });
  }

  const prompt = JSON.stringify({
    task: "Classify a new Feishu message while a Codex turn is already running. Return only JSON.",
    allowedActions: ["steer", "enqueue"],
    rule: "Use steer only when the new message is clearly a supplement, correction, constraint, clarification, or answer for the currently running task. Use enqueue when it is a separate new task or uncertain.",
    currentRunningTask: {
      jobId: activeJob?.id || "",
      title: activeJob?.title || "",
      originalText: activeJob?.text || "",
      lastEvent: activeJob?.lastEvent || ""
    },
    newUserMessage: text,
    outputShape: { action: "steer|enqueue", reason: "short" }
  });
  const raw = await codexAppServer.runTurn({
    threadId: state.routerThreadId,
    text: prompt,
    cwd: FEISHU_PROJECT_ROOT,
    model: chat.model || DEFAULT_MODEL,
    reasoning: ROUTER_REASONING
  });
  const parsed = parseJsonObject(raw);
  return parsed?.action === "steer" ? "steer" : "enqueue";
}

export function normalizeModelConfig({ model, reasoning }) {
  const next = {};
  if (model) {
    const normalizedModel = normalizeModelName(model);
    if (ALLOWED_MODELS.has(normalizedModel)) next.model = normalizedModel;
  }
  if (reasoning) {
    const normalizedReasoning = normalizeReasoning(reasoning);
    if (ALLOWED_REASONING.has(normalizedReasoning)) next.reasoning = normalizedReasoning;
  }
  return next;
}

export function isRouterThread(thread) {
  return displayThreadName(thread) === ROUTER_THREAD_NAME;
}

export function displayThreadName(thread) {
  const name = String(thread?.name || "").trim();
  if (name) return name;
  const preview = String(thread?.preview || "").trim().replace(/\s+/g, " ");
  return preview ? preview.slice(0, 40) : "";
}

function buildRouterPrompt({ text, chat, sessions }) {
  return JSON.stringify({
    routerInstructions: ROUTER_INSTRUCTIONS,
    userMessage: text,
    current: {
      threadId: chat.threadId || "",
      threadName: chat.threadName || "",
      cwd: chat.cwd || "",
      model: chat.model || "",
      reasoning: chat.reasoning || ""
    },
    sessions: sessions.slice(0, 80).map((thread, index) => ({
      index: index + 1,
      id: thread.id || "",
      name: displayThreadName(thread),
      cwd: thread.cwd || ""
    }))
  });
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return { action: "delegate" };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { action: "delegate", parseError: truncate(text, 300) };
    }
  }
}

function normalizeIntent(intent) {
  const action = String(intent?.action || "delegate").trim();
  const allowed = new Set([
    "delegate",
    "list_sessions",
    "current_session",
    "new_session",
    "switch_session",
    "set_model",
    "cancel_job",
    "list_jobs",
    "archive_session",
    "unarchive_session",
    "read_session",
    "help"
  ]);
  if (!allowed.has(action)) return { action: "delegate" };
  return {
    action,
    threadId: String(intent.threadId || "").trim(),
    threadIndex: Number.isInteger(intent.threadIndex) ? intent.threadIndex : Number(intent.threadIndex || 0),
    targetName: String(intent.targetName || "").trim(),
    threadName: String(intent.threadName || "").trim(),
    ...normalizeModelConfig(intent)
  };
}

function normalizeModelName(model) {
  const value = String(model).trim().toLowerCase().replace(/\s+/g, "");
  const aliases = new Map([
    ["5.5", "gpt-5.5"],
    ["gpt5.5", "gpt-5.5"],
    ["5.4", "gpt-5.4"],
    ["gpt5.4", "gpt-5.4"],
    ["5.4mini", "gpt-5.4-mini"],
    ["gpt5.4mini", "gpt-5.4-mini"],
    ["codex", "gpt-5.3-codex"],
    ["spark", "gpt-5.3-codex-spark"],
    ["5.2", "gpt-5.2"],
    ["gpt5.2", "gpt-5.2"]
  ]);
  return aliases.get(value) || value;
}

function normalizeReasoning(reasoning) {
  const value = String(reasoning).trim().toLowerCase().replace(/\s+/g, "");
  const aliases = new Map([
    ["\u4f4e", "low"],
    ["\u4e2d", "medium"],
    ["\u9ad8", "high"],
    ["\u8d85\u9ad8", "xhigh"],
    ["extra", "xhigh"],
    ["extra-high", "xhigh"],
    ["super", "xhigh"]
  ]);
  return aliases.get(value) || value;
}
