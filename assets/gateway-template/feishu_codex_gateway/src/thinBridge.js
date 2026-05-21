import { FEISHU_PROJECT_ROOT, WORKSPACE_ROOT, logLine, truncate } from "./config.js";
import {
  codexAppServer,
  DEFAULT_MODEL,
  DEFAULT_REASONING
} from "./codexAppServer.js";
import { registerFeishuDesktopProject } from "./desktopState.js";
import { classifyBridgeIntent, classifyTaskDisposition, displayThreadName, isRouterThread, normalizeModelConfig } from "./bridgeIntent.js";
import { buildProjectSessionCards, loadDesktopWorkspaceRoots } from "./sessionCards.js";
import { loadState, saveState } from "./state.js";
import {
  attachTurn,
  buildJobCard,
  createJob,
  findActiveJobForChat,
  findActiveJobForThread,
  findNextQueuedJobForThread,
  jobListText,
  jobSignature,
  markJobCanceling,
  markJobCompleted,
  markJobFailed,
  markJobInterrupted,
  markJobStarting,
  markJobSteered,
  markStaleRunningJobs,
  recentJobsForChat,
  updateJobFromCodexEvent
} from "./jobStatus.js";

const DEFAULT_THREAD_NAME = "Feishu Session";

export class ThinBridge {
  constructor({ sendText, sendCard, sendReply, sendJobCard, updateJobCard }) {
    this.sendText = sendText;
    this.sendCard = sendCard;
    this.sendReply = sendReply || sendText;
    this.sendJobCard = sendJobCard;
    this.updateJobCard = updateJobCard;
    this.queue = Promise.resolve();
    this.jobCardQueues = new Map();
  }

  async recoverInterruptedJobs() {
    const state = loadState();
    const threadIds = new Set(
      Object.values(state.jobs || {})
        .filter((job) => job.status === "queued" && job.threadId)
        .map((job) => job.threadId)
    );
    if (!markStaleRunningJobs(state) && threadIds.size === 0) return;
    saveState(state);
    for (const job of Object.values(state.jobs || {})) {
      if (job.status === "interrupted") {
        if (job.threadId) threadIds.add(job.threadId);
        this.publishJob(job);
      }
    }
    for (const threadId of threadIds) {
      await this.processNextQueuedJob(threadId);
    }
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

  enqueueBackground(label, work) {
    this.queue = this.queue
      .then(work)
      .catch((error) => {
        logLine(`bridge background queue error ${label}: ${error.stack || error.message}`);
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

    if (intent.action === "cancel_job") {
      await this.cancelActiveJob({ chatId, state });
      return;
    }

    if (intent.action === "list_jobs") {
      this.sendText(chatId, jobListText(recentJobsForChat(state, chatId)));
      return;
    }

    if (intent.action === "archive_session" || intent.action === "unarchive_session") {
      const threadId = intent.threadId || chat.threadId;
      if (!threadId) {
        this.sendText(chatId, "当前没有绑定会话，无法操作。");
        return;
      }
      const action = intent.action === "archive_session" ? "归档" : "恢复";
      try {
        if (intent.action === "archive_session") {
          await codexAppServer.archiveThread(threadId);
        } else {
          await codexAppServer.unarchiveThread(threadId);
        }
        this.sendText(chatId, `已${action}当前 Codex 会话：${threadId}`);
      } catch (error) {
        this.sendText(chatId, `${action}失败：${error.message}`);
      }
      return;
    }

    if (intent.action === "read_session") {
      await this.readSession({ chatId, chat, intent });
      return;
    }

    if (intent.action === "help") {
      this.sendText(chatId, helpText(chat));
    }
  }

  async delegateToCodex({ chatId, chat, state, text }) {
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

    let latestState = loadState();
    let latestChat = getBridgeChat(latestState, getBindingKey(chatId), chatId);
    normalizeChat(latestChat);
    saveState(latestState);

    let activeJob = findActiveJobForThread(latestState, latestChat.threadId);
    if (activeJob) {
      const disposition = await classifyTaskDisposition({ text, activeJob, chat: latestChat, state: latestState }).catch((error) => {
        logLine(`task disposition classify failed: ${error.message}`);
        return "enqueue";
      });
      latestState = loadState();
      latestChat = getBridgeChat(latestState, getBindingKey(chatId), chatId);
      normalizeChat(latestChat);
      activeJob = latestState.jobs?.[activeJob.id] || findActiveJobForThread(latestState, latestChat.threadId);
      if (activeJob && disposition === "steer" && activeJob.turnId) {
        try {
          await codexAppServer.steerTurn({ threadId: activeJob.threadId, turnId: activeJob.turnId, text });
          const latestState = loadState();
          markJobSteered(latestState, activeJob.id, text);
          saveState(latestState);
          await this.publishJob(latestState.jobs[activeJob.id]);
          this.sendText(chatId, `已追加到当前任务：${activeJob.title}`);
          return;
        } catch (error) {
          logLine(`turn steer failed; enqueue instead job_id=${activeJob.id}: ${error.message}`);
          if (isNoActiveTurnError(error)) {
            const staleState = loadState();
            const staleJob = markJobInterrupted(
              staleState,
              activeJob.id,
              "当前 Codex turn 已不活跃，网关已自动收尾"
            );
            saveState(staleState);
            await this.publishJob(staleJob);
          }
        }
      }
    }

    latestState = loadState();
    latestChat = getBridgeChat(latestState, getBindingKey(chatId), chatId);
    normalizeChat(latestChat);
    const job = createJob(latestState, {
      chatId,
      threadId: latestChat.threadId,
      text,
      cwd: latestChat.cwd,
      model: latestChat.model,
      reasoning: latestChat.reasoning
    });
    saveState(latestState);

    const currentActiveJob = findActiveJobForThread(latestState, latestChat.threadId);
    const nextQueuedJob = findNextQueuedJobForThread(latestState, latestChat.threadId);
    if (currentActiveJob || nextQueuedJob?.id !== job.id) {
      logLine(`bridge queued job chat_id=${chatId} thread_id=${latestChat.threadId} job_id=${job.id}`);
      this.sendText(chatId, `已排队：${job.title}\n前一个任务完成后开始。`);
      if (!currentActiveJob) await this.processNextQueuedJob(latestChat.threadId);
      return;
    }

    await this.startQueuedJob(job.id);
  }

  async startQueuedJob(jobId) {
    const startedAt = Date.now();
    const state = loadState();
    const job = markJobStarting(state, jobId);
    if (!job) return;
    saveState(state);
    await this.publishJob(job);

    let turnId;
    let completion;
    try {
      const started = await codexAppServer.startTurnStream({
        threadId: job.threadId,
        text: job.text,
        cwd: job.cwd,
        model: job.model,
        reasoning: job.reasoning,
        onEvent: (message) => this.handleJobEvent(job.id, message)
      });
      turnId = started.turnId;
      completion = started.completion;
    } catch (error) {
      logLine(`bridge codex turn start failed chat_id=${job.chatId} thread_id=${job.threadId} error=${error.stack || error.message}`);
      const failedState = loadState();
      markJobFailed(failedState, job.id, error);
      saveState(failedState);
      await this.publishJob(failedState.jobs[job.id]);
      this.sendText(job.chatId, `任务启动失败：${error.message}`);
      await this.processNextQueuedJob(job.threadId);
      return;
    }
    const latestState = loadState();
    attachTurn(latestState, job.id, turnId);
    saveState(latestState);
    await this.publishJob(latestState.jobs[job.id]);

    completion.then((reply) => {
      this.enqueueBackground(`complete job ${job.id}`, async () => {
        logLine(`bridge codex turn completed chat_id=${job.chatId} thread_id=${job.threadId} elapsed_ms=${Date.now() - startedAt}`);
        const latestState = loadState();
        const latestChat = getBridgeChat(latestState, getBindingKey(job.chatId), job.chatId);
        latestChat.updatedAt = now();
        markJobCompleted(latestState, job.id);
        saveState(latestState);
        await this.publishJob(latestState.jobs[job.id]);
        this.sendReply(job.chatId, reply);
        await this.processNextQueuedJob(job.threadId);
      });
    }).catch((error) => {
      this.enqueueBackground(`fail job ${job.id}`, async () => {
        logLine(`bridge codex turn failed chat_id=${job.chatId} thread_id=${job.threadId} error=${error.stack || error.message}`);
        const latestState = loadState();
        markJobFailed(latestState, job.id, error);
        saveState(latestState);
        await this.publishJob(latestState.jobs[job.id]);
        this.sendText(job.chatId, `任务失败：${error.message}`);
        await this.processNextQueuedJob(job.threadId);
      });
    });
  }

  async processNextQueuedJob(threadId) {
    const state = loadState();
    if (findActiveJobForThread(state, threadId)) return;
    const next = findNextQueuedJobForThread(state, threadId);
    if (!next) return;
    await this.startQueuedJob(next.id);
  }

  async handleJobEvent(jobId, message) {
    const state = loadState();
    const job = updateJobFromCodexEvent(state, jobId, message);
    if (!job) return;
    saveState(state);
    if (!shouldPublishJobEvent(message, job)) return;
    await this.publishJobIfChanged(job);
  }

  async publishJobIfChanged(job) {
    const signature = jobSignature(job);
    if (job.lastPushedSignature === signature) return;
    job.lastPushedSignature = signature;
    await this.publishJob(job);
  }

  async publishJob(job) {
    if (!job) return;
    const previous = this.jobCardQueues.get(job.id) || Promise.resolve();
    const next = previous
      .catch((error) => {
        logLine(`job card queue recovered job_id=${job.id}: ${error.message}`);
      })
      .then(() => this.publishJobNow(job.id))
      .catch((error) => {
        logLine(`job card publish failed job_id=${job.id}: ${error.stack || error.message}`);
      });
    this.jobCardQueues.set(job.id, next);
    next.finally(() => {
      if (this.jobCardQueues.get(job.id) === next) {
        this.jobCardQueues.delete(job.id);
      }
    });
    return next;
  }

  async publishJobNow(jobId) {
    const state = loadState();
    const job = state.jobs?.[jobId];
    if (!job) return;
    const card = buildJobCard(job);
    const signature = jobSignature(job);
    if (job.cardId && this.updateJobCard) {
      const nextSequence = (job.cardSequence || 0) + 1;
      job.cardSequence = nextSequence;
      saveState(state);
      if (this.updateJobCard(job.cardId, card, nextSequence)) {
        const latestState = loadState();
        if (latestState.jobs?.[job.id]) {
          latestState.jobs[job.id].cardSequence = nextSequence;
          latestState.jobs[job.id].lastPushedSignature = signature;
          saveState(latestState);
        }
        return;
      }
      logLine(`job card update failed job_id=${job.id} card_id=${job.cardId}`);
      return;
    }
    if (this.sendJobCard) {
      const result = this.sendJobCard(job.chatId, card, card);
      if (result?.ok && result.cardId) {
        const state = loadState();
        if (state.jobs?.[job.id]) {
          state.jobs[job.id].cardId = result.cardId;
          state.jobs[job.id].cardSequence = 0;
          state.jobs[job.id].lastPushedSignature = signature;
          saveState(state);
        }
        job.cardId = result.cardId;
        job.cardSequence = 0;
        job.lastPushedSignature = signature;
        return;
      }
    }
    this.sendText(job.chatId, `${job.title}\n状态：${job.status}\n事件：${job.lastEvent}`);
  }

  async cancelActiveJob({ chatId, state }) {
    const job = findActiveJobForChat(state, chatId);
    if (!job) {
      this.sendText(chatId, "当前没有正在运行的任务。");
      return;
    }
    markJobCanceling(state, job.id);
    saveState(state);
    await this.publishJob(job);
    if (!job.turnId) {
      this.sendText(chatId, "任务还在启动中，暂时没有 turnId；已标记为取消中。");
      return;
    }
    try {
      await codexAppServer.interruptTurn(job.turnId, job.threadId);
      this.sendText(chatId, `已发送取消请求：${job.id}`);
    } catch (error) {
      if (isNoActiveTurnError(error)) {
        const latestState = loadState();
        const staleJob = markJobInterrupted(
          latestState,
          job.id,
          "Codex 已没有活跃 turn，网关已自动收尾并继续队列"
        );
        saveState(latestState);
        await this.publishJob(staleJob);
        this.sendText(chatId, "当前任务已经不活跃，已自动收尾并继续队列。");
        await this.processNextQueuedJob(job.threadId);
        return;
      }
      this.sendText(chatId, `取消请求失败：${error.message}`);
    }
  }

  async readSession({ chatId, chat, intent }) {
    const threadId = intent.threadId || chat.threadId;
    if (!threadId) {
      this.sendText(chatId, "当前没有绑定会话，无法读取。");
      return;
    }
    try {
      const result = await codexAppServer.readThread(threadId);
      this.sendText(chatId, summarizeThreadRead(result, threadId));
    } catch (error) {
      this.sendText(chatId, `读取会话失败：${error.message}`);
    }
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

function shouldPublishJobEvent(message, job) {
  if (isTerminalJob(job)) return true;
  const method = message?.method || "";
  if (method === "turn/started" || method === "turn/failed" || method === "error") return true;
  if (method === "item/started" || method === "item/completed") return true;
  return false;
}

function isTerminalJob(job) {
  return ["completed", "failed", "canceled", "interrupted"].includes(job?.status);
}

function isNoActiveTurnError(error) {
  return /no active turn/i.test(error?.message || String(error || ""));
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
  if (/^\/cancel\b/.test(trimmed) || /^(取消任务|停止任务|中断任务)$/.test(trimmed)) {
    return { action: "cancel_job" };
  }
  if (/^\/jobs\b/.test(trimmed) || /^(任务列表|查看任务)$/.test(trimmed)) {
    return { action: "list_jobs" };
  }
  if (/^\/archive\b/.test(trimmed) || /^(归档当前会话|归档会话)$/.test(trimmed)) {
    const arg = trimmed.replace(/^\/archive\b/, "").trim();
    return { action: "archive_session", threadId: isLikelyThreadId(arg) ? arg : "" };
  }
  if (/^\/unarchive\b/.test(trimmed) || /^(恢复当前会话|恢复会话)$/.test(trimmed)) {
    const arg = trimmed.replace(/^\/unarchive\b/, "").trim();
    return { action: "unarchive_session", threadId: isLikelyThreadId(arg) ? arg : "" };
  }
  if (/^\/read\b/.test(trimmed) || /^(读取当前会话|查看当前会话)$/.test(trimmed)) {
    const arg = trimmed.replace(/^\/read\b/, "").trim();
    return { action: "read_session", threadId: isLikelyThreadId(arg) ? arg : "" };
  }
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
  if (/\b(session|thread|model|reasoning|switch|current|new|help|cancel|stop|halt|pause|interrupt|job|jobs|archive|unarchive|read)\b/i.test(value)) return true;
  if (/(gpt[-\s]?\d|gpt\d|\b5\.[245]\b).*(reasoning|model|low|medium|high|xhigh)/i.test(value)) return true;

  if (/(\u53d6\u6d88|\u505c\u6b62|\u4e2d\u65ad|\u6682\u505c|\u505c\u4e00\u4e0b|\u5148\u505c|\u522b\u8dd1\u4e86)/.test(value)) return true;

  const objectWords = /(\u4f1a\u8bdd|\u7ed8\u753b|\u56de\u8bdd|\u5bf9\u8bdd|\u9879\u76ee|\u6a21\u578b|\u63a8\u7406|\u6df1\u5ea6|\u4efb\u52a1)/;
  const actionWords = /(\u54ea\u4e9b|\u5217\u8868|\u5f53\u524d|\u7ed1\u5b9a|\u5207\u6362|\u5207\u5230|\u6362\u5230|\u65b0\u5efa|\u521b\u5efa|\u6539\u6210|\u8bbe\u7f6e|\u8c03\u6574|\u67e5\u770b|\u8bfb\u53d6|\u53d6\u6d88|\u505c\u6b62|\u4e2d\u65ad|\u6682\u505c|\u5f52\u6863|\u6062\u590d)/;
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

function summarizeThreadRead(result, threadId) {
  const thread = result?.thread || result?.data?.thread || result?.data || result || {};
  const items = result?.items || result?.data?.items || thread.items || thread.messages || [];
  const title = displayThreadName(thread) || thread.name || thread.title || "(未命名)";
  const previewItems = Array.isArray(items) ? items.slice(-3).map((item) => {
    const role = item.role || item.author || item.type || "item";
    const text = extractThreadItemText(item);
    return text ? `${role}: ${truncate(text, 180)}` : "";
  }).filter(Boolean) : [];
  return [
    `会话：${title}`,
    `thread: ${thread.id || threadId}`,
    previewItems.length ? "\n最近内容：" : "",
    previewItems.join("\n\n")
  ].filter(Boolean).join("\n");
}

function extractThreadItemText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => part.text || part.content || "").join("").trim();
  }
  if (item.message) return extractThreadItemText(item.message);
  return "";
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
    "\u7ba1\u7406\u80fd\u529b\uff1a\u67e5\u770b\u5f53\u524d\u4f1a\u8bdd\u3001\u5217\u51fa\u4f1a\u8bdd\u3001\u5207\u6362\u4f1a\u8bdd\u3001\u65b0\u5efa\u4f1a\u8bdd\u3001\u5207\u6362\u6a21\u578b/\u63a8\u7406\u6df1\u5ea6\u3001\u53d6\u6d88\u4efb\u52a1\u3001\u8bfb\u53d6/\u5f52\u6863\u4f1a\u8bdd\u3002",
    "\u5feb\u6377\u547d\u4ee4\uff1a/current, /sessions, /switch <name|id|index>, /new [name], /model model=gpt-5.5 reasoning=high, /jobs, /cancel, /read, /archive, /unarchive",
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
