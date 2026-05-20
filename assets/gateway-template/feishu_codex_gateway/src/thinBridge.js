import { FEISHU_PROJECT_ROOT, WORKSPACE_ROOT, logLine, truncate } from "./config.js";
import {
  codexAppServer,
  DEFAULT_MODEL,
  DEFAULT_REASONING
} from "./codexAppServer.js";
import { registerFeishuDesktopProject } from "./desktopState.js";
import { classifyBridgeIntent, displayThreadName, isRouterThread, normalizeModelConfig } from "./bridgeIntent.js";
import { buildProjectSessionCards, loadDesktopWorkspaceRoots } from "./sessionCards.js";
import { loadState, saveState } from "./state.js";

const DEFAULT_THREAD_NAME = "Feishu Session";

export class ThinBridge {
  constructor({ sendText, sendCard, sendReply }) {
    this.sendText = sendText;
    this.sendCard = sendCard;
    this.sendReply = sendReply || sendText;
    this.queue = Promise.resolve();
  }

  handleMessage(event) {
    this.queue = this.queue
      .then(() => this.handleMessageNow(event))
      .catch((error) => {
        logLine(`bridge queue error: ${error.stack || error.message}`);
        this.sendText(event.chatId, `\u5904\u7406\u5931\u8d25\uff1a${error.message}`);
      });
    return this.queue;
  }

  async handleMessageNow({ chatId = "local-test", text }) {
    const startedAt = Date.now();
    const state = loadState();
    const bindingKey = getBindingKey(chatId);
    const chat = getBridgeChat(state, bindingKey, chatId);
    normalizeChat(chat);
    saveState(state);
    logLine(`bridge message chat_id=${chatId} binding=${bindingKey} thread_id=${chat.threadId || "(none)"} text=${truncate(text, 300)}`);

    const shortcut = parseShortcutCommand(text);
    if (shortcut) {
      const sessions = needsSessions(shortcut) ? await loadSessions() : [];
      logLine(`bridge intent chat_id=${chatId} action=${shortcut.action} target=${shortcut.threadId || shortcut.threadIndex || shortcut.targetName || ""} route=shortcut elapsed_ms=${Date.now() - startedAt}`);
      await this.handleManagementIntent({ chatId, chat, state, intent: shortcut, sessions });
      return;
    }

    if (!shouldUseIntentRouter(text)) {
      logLine(`bridge intent chat_id=${chatId} action=delegate route=fast elapsed_ms=${Date.now() - startedAt}`);
      await this.delegateToCodex({ chatId, chat, state, text });
      return;
    }

    const sessions = await loadSessions();
    const intent = await classifyBridgeIntent({ text, chat, state, sessions });
    saveState(state);
    logLine(`bridge intent chat_id=${chatId} action=${intent.action} target=${intent.threadId || intent.threadIndex || intent.targetName || ""} route=router elapsed_ms=${Date.now() - startedAt}`);

    if (intent.action !== "delegate") {
      await this.handleManagementIntent({ chatId, chat, state, intent, sessions });
      return;
    }

    await this.delegateToCodex({ chatId, chat, state, text });
  }

  async handleManagementIntent({ chatId, chat, state, intent, sessions }) {
    if (intent.action === "new_session") {
      chat.threadName = intent.threadName || DEFAULT_THREAD_NAME;
      chat.threadId = await codexAppServer.startThread({
        cwd: chat.cwd,
        name: chat.threadName,
        model: chat.model,
        reasoning: chat.reasoning
      });
      registerFeishuDesktopProject(chat.threadId, chat.threadName);
      chat.updatedAt = now();
      saveState(state);
      this.sendText(chatId, [
        `\u5df2\u65b0\u5efa\u5e76\u7ed1\u5b9a Codex \u4f1a\u8bdd\uff1a${chat.threadName}`,
        `thread: ${chat.threadId}`,
        `model: ${chat.model}`,
        `reasoning: ${chat.reasoning}`
      ].join("\n"));
      return;
    }

    if (intent.action === "current_session") {
      this.sendText(chatId, currentSessionText(chat));
      return;
    }

    if (intent.action === "list_sessions") {
      await this.sendSessions(chatId, chat, sessions);
      return;
    }

    if (intent.action === "switch_session") {
      const target = resolveSessionTarget(intent, sessions);
      if (!target) {
        this.sendText(chatId, `\u6ca1\u627e\u5230\u8981\u5207\u6362\u7684\u4f1a\u8bdd\u3002\n\n${sessionTextList(sessions)}`);
        return;
      }
      chat.threadId = target.id;
      chat.threadName = displayThreadName(target) || DEFAULT_THREAD_NAME;
      chat.cwd = target.cwd || chat.cwd || FEISHU_PROJECT_ROOT;
      chat.updatedAt = now();
      saveState(state);
      this.sendText(chatId, [
        `\u5df2\u5207\u6362\u5230\uff1a${chat.threadName}`,
        `thread: ${chat.threadId}`,
        `cwd: ${chat.cwd}`,
        `model: ${chat.model}`,
        `reasoning: ${chat.reasoning}`
      ].join("\n"));
      return;
    }

    if (intent.action === "set_model") {
      const next = normalizeModelConfig(intent);
      if (!next.model && !next.reasoning) {
        this.sendText(chatId, modelHelpText(chat));
        return;
      }
      if (next.model) chat.model = next.model;
      if (next.reasoning) chat.reasoning = next.reasoning;
      chat.updatedAt = now();
      saveState(state);
      this.sendText(chatId, `\u5df2\u66f4\u65b0\u6a21\u578b\u914d\u7f6e\uff1amodel=${chat.model}, reasoning=${chat.reasoning}`);
      return;
    }

    if (intent.action === "help") {
      this.sendText(chatId, helpText(chat));
    }
  }

  async delegateToCodex({ chatId, chat, state, text }) {
    const startedAt = Date.now();
    if (!chat.threadId) {
      chat.threadId = await codexAppServer.startThread({
        cwd: chat.cwd,
        name: chat.threadName,
        model: chat.model,
        reasoning: chat.reasoning
      });
      chat.updatedAt = now();
      saveState(state);
      logLine(`bridge created thread chat_id=${chatId} thread_id=${chat.threadId}`);
    } else {
      logLine(`bridge reuse thread chat_id=${chatId} thread_id=${chat.threadId}`);
      registerFeishuDesktopProject(chat.threadId, chat.threadName);
      await codexAppServer.setThreadName(chat.threadId, chat.threadName).catch((error) => {
        logLine(`set thread name before turn failed: ${error.message}`);
      });
    }

    const reply = await codexAppServer.runTurn({
      threadId: chat.threadId,
      text,
      cwd: chat.cwd,
      model: chat.model,
      reasoning: chat.reasoning
    });
    logLine(`bridge codex turn completed chat_id=${chatId} thread_id=${chat.threadId} elapsed_ms=${Date.now() - startedAt}`);
    chat.updatedAt = now();
    saveState(state);
    this.sendReply(chatId, reply);
  }

  async sendSessions(chatId, chat, sessions) {
    const { cardKitCard, fallbackCard } = buildProjectSessionCards({
      threads: sessions,
      currentChat: chat,
      savedRoots: loadDesktopWorkspaceRoots()
    });
    if (this.sendCard) {
      this.sendCard(chatId, cardKitCard, fallbackCard);
    } else {
      this.sendText(chatId, sessionTextList(sessions));
    }
  }
}

async function loadSessions() {
  const result = await codexAppServer.request("thread/list", { limit: 100 }, 30000);
  return (result?.data || []).filter((thread) => !isRouterThread(thread));
}

function parseShortcutCommand(text) {
  const trimmed = String(text || "").trim();
  if (/^\/new\b/.test(trimmed)) {
    return { action: "new_session", threadName: trimmed.replace(/^\/new\b/, "").trim() };
  }
  if (/^\/current\b/.test(trimmed)) return { action: "current_session" };
  if (/^\/sessions\b/.test(trimmed)) return { action: "list_sessions" };
  if (/^\/help\b/.test(trimmed)) return { action: "help" };
  if (/^\/switch\b/.test(trimmed)) {
    const arg = trimmed.replace(/^\/switch\b/, "").trim();
    return { action: "switch_session", targetName: arg, threadId: isLikelyThreadId(arg) ? arg : "" };
  }
  if (/^\/model\b/.test(trimmed)) {
    return { action: "set_model", ...parseModelArgs(trimmed.replace(/^\/model\b/, "").trim()) };
  }
  return null;
}

function needsSessions(intent) {
  return ["list_sessions", "switch_session"].includes(intent.action);
}

function shouldUseIntentRouter(text) {
  const value = normalizeText(text);
  if (!value) return false;
  if (isLikelyThreadId(value)) return true;
  if (/^(help|\?)$/i.test(value)) return true;
  if (/\b(session|thread|model|reasoning|switch|current|new|help)\b/i.test(value)) return true;
  if (/(gpt[-\s]?\d|gpt\d|\b5\.[245]\b).*(reasoning|model|low|medium|high|xhigh)/i.test(value)) return true;

  const objectWords = /(\u4f1a\u8bdd|\u7ed8\u753b|\u56de\u8bdd|\u5bf9\u8bdd|\u9879\u76ee|\u6a21\u578b|\u63a8\u7406|\u6df1\u5ea6)/;
  const actionWords = /(\u54ea\u4e9b|\u5217\u8868|\u5f53\u524d|\u7ed1\u5b9a|\u5207\u6362|\u5207\u5230|\u6362\u5230|\u65b0\u5efa|\u521b\u5efa|\u6539\u6210|\u8bbe\u7f6e|\u8c03\u6574)/;
  if (objectWords.test(value) && actionWords.test(value)) return true;
  if (/(\u5e2e\u52a9|\u6307\u4ee4|\u547d\u4ee4)/.test(value)) return true;
  if (/(gpt[-\s]?\d|gpt\d|\b5\.[245]\b|\u6a21\u578b).*(\u4f4e|\u4e2d|\u9ad8|\u8d85\u9ad8|\u63a8\u7406|\u6df1\u5ea6)/i.test(value)) return true;
  return false;
}

function parseModelArgs(raw) {
  const parts = String(raw || "").split(/\s+/).filter(Boolean);
  const result = {};
  for (const part of parts) {
    const [key, value] = part.includes("=")
      ? part.split("=", 2)
      : [looksLikeReasoning(part) ? "reasoning" : "model", part];
    if (/^(model|\u6a21\u578b)$/i.test(key)) result.model = value;
    if (/^(reasoning|\u63a8\u7406|\u6df1\u5ea6)$/i.test(key)) result.reasoning = value;
  }
  return result;
}

function looksLikeReasoning(value) {
  return /^(low|medium|high|xhigh|\u4f4e|\u4e2d|\u9ad8|\u8d85\u9ad8)$/i.test(String(value || "").trim());
}

function resolveSessionTarget(intent, sessions) {
  if (intent.threadId) {
    const exact = sessions.find((thread) => thread.id === intent.threadId || thread.id?.startsWith(intent.threadId));
    if (exact) return exact;
  }
  if (intent.threadIndex > 0 && intent.threadIndex <= sessions.length) {
    return sessions[intent.threadIndex - 1];
  }
  const targetName = normalizeText(intent.targetName || intent.threadName);
  if (!targetName) return null;
  return sessions.find((thread) => normalizeText(displayThreadName(thread)) === targetName)
    || sessions.find((thread) => normalizeText(displayThreadName(thread)).includes(targetName))
    || sessions.find((thread) => targetName.includes(normalizeText(displayThreadName(thread))));
}

function getBindingKey(chatId) {
  return chatId || "local-test";
}

function getBridgeChat(state, bindingKey, sourceChatId) {
  state.bridgeChats ||= {};
  state.bridgeChats[bindingKey] ||= {
    threadId: "",
    threadName: DEFAULT_THREAD_NAME,
    cwd: FEISHU_PROJECT_ROOT,
    sourceChatId,
    model: DEFAULT_MODEL,
    reasoning: DEFAULT_REASONING,
    updatedAt: now()
  };
  return state.bridgeChats[bindingKey];
}

function normalizeChat(chat) {
  if (!chat.threadName) chat.threadName = DEFAULT_THREAD_NAME;
  if (!chat.cwd || chat.cwd === WORKSPACE_ROOT) chat.cwd = FEISHU_PROJECT_ROOT;
  chat.model ||= DEFAULT_MODEL;
  chat.reasoning ||= DEFAULT_REASONING;
  chat.updatedAt ||= now();
}

function currentSessionText(chat) {
  return [
    `\u5f53\u524d\u7ed1\u5b9a\u4f1a\u8bdd\uff1a${chat.threadName}`,
    `thread: ${chat.threadId || "\u5c1a\u672a\u521b\u5efa"}`,
    `cwd: ${chat.cwd}`,
    `model: ${chat.model}`,
    `reasoning: ${chat.reasoning}`
  ].join("\n");
}

function sessionTextList(sessions) {
  if (!sessions.length) return "\u6682\u65f6\u6ca1\u6709\u53ef\u5207\u6362\u7684\u4f1a\u8bdd\u3002";
  return sessions.map((thread, index) => `${index + 1}. ${displayThreadName(thread) || "(untitled)"}\n${thread.id}`).join("\n\n");
}

function modelHelpText(chat) {
  return [
    `\u5f53\u524d\uff1amodel=${chat.model}, reasoning=${chat.reasoning}`,
    "\u53ef\u7528\u6a21\u578b\uff1agpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2",
    "\u53ef\u7528\u63a8\u7406\u6df1\u5ea6\uff1alow, medium, high, xhigh",
    "\u793a\u4f8b\uff1a\u5207\u5230 gpt-5.5 \u9ad8\u6df1\u5ea6"
  ].join("\n");
}

function helpText(chat) {
  return [
    "\u6211\u53ef\u4ee5\u76f4\u63a5\u7406\u89e3\u4f60\u7684\u81ea\u7136\u8bed\u8a00\u6307\u4ee4\u3002",
    "\u7ba1\u7406\u80fd\u529b\uff1a\u67e5\u770b\u5f53\u524d\u4f1a\u8bdd\u3001\u5217\u51fa\u4f1a\u8bdd\u3001\u5207\u6362\u4f1a\u8bdd\u3001\u65b0\u5efa\u4f1a\u8bdd\u3001\u5207\u6362\u6a21\u578b/\u63a8\u7406\u6df1\u5ea6\u3002",
    "\u5feb\u6377\u547d\u4ee4\uff1a/current, /sessions, /switch <name|id|index>, /new [name], /model model=gpt-5.5 reasoning=high",
    `\u5f53\u524d\uff1amodel=${chat.model}, reasoning=${chat.reasoning}`
  ].join("\n");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function isLikelyThreadId(value) {
  return /^019[a-z0-9-]{8,}$/i.test(String(value || ""));
}

function now() {
  return new Date().toISOString();
}
