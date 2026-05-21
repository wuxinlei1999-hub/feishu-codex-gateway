import crypto from "node:crypto";
import { truncate } from "./config.js";

export const ACTIVE_JOB_STATUSES = new Set(["starting", "running", "canceling"]);
export const OPEN_JOB_STATUSES = new Set(["queued", ...ACTIVE_JOB_STATUSES]);
export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled", "interrupted"]);

export function createJob(state, { chatId, threadId, text, cwd, model, reasoning }) {
  state.jobs ||= {};
  const id = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const now = new Date().toISOString();
  state.jobs[id] = {
    id,
    chatId,
    threadId,
    turnId: "",
    status: "queued",
    title: firstLine(text, 80) || "Codex 任务",
    text: String(text || ""),
    cwd: cwd || "",
    model: model || "",
    reasoning: reasoning || "",
    lastEvent: "已排队，等待前一个任务完成",
    cardId: "",
    cardSequence: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: "",
    completedAt: "",
    error: "",
    lastPushedSignature: ""
  };
  return state.jobs[id];
}

export function markJobStarting(state, jobId) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.status = "starting";
  job.lastEvent = "正在启动 Codex 任务";
  job.startedAt ||= new Date().toISOString();
  touch(job);
  return job;
}

export function attachTurn(state, jobId, turnId) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.turnId = turnId || job.turnId;
  job.status = "running";
  job.lastEvent = "Codex 已开始处理";
  job.startedAt ||= new Date().toISOString();
  touch(job);
  return job;
}

export function updateJobFromCodexEvent(state, jobId, message) {
  const job = getJob(state, jobId);
  if (!job) return null;

  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    return job;
  }

  const method = message?.method || "event";
  const params = message?.params || {};
  job.lastEvent = describeCodexEvent(method, params);
  if (method === "turn/completed") {
    const status = params.turn?.status || params.status || "";
    if (status === "interrupted") {
      job.status = "canceled";
      job.lastEvent = "任务已被取消";
    } else if (status === "failed") {
      job.status = "failed";
      job.lastEvent = "任务失败";
    } else {
      job.status = "completed";
      job.lastEvent = "任务已完成，正在发送最终回复";
    }
    job.completedAt = new Date().toISOString();
  } else if (method === "turn/failed" || method === "error") {
    if (params.willRetry) {
      job.status = "running";
    } else {
      job.status = "failed";
      job.error = truncate(JSON.stringify(message), 500);
      job.completedAt = new Date().toISOString();
    }
  } else if (job.status !== "canceling") {
    job.status = "running";
  }
  touch(job);
  return job;
}

export function markJobCompleted(state, jobId) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.status = "completed";
  job.lastEvent = "任务已完成，正在发送最终回复";
  job.completedAt ||= new Date().toISOString();
  touch(job);
  return job;
}

export function markJobFailed(state, jobId, error) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.status = job.status === "canceling" ? "canceled" : "failed";
  job.error = error?.message || String(error || "");
  job.lastEvent = job.status === "canceled" ? "任务已取消" : "任务失败";
  job.completedAt = new Date().toISOString();
  touch(job);
  return job;
}

export function markJobCanceling(state, jobId) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.status = "canceling";
  job.lastEvent = "正在请求 Codex 取消任务";
  touch(job);
  return job;
}

export function markStaleRunningJobs(state) {
  let changed = false;
  for (const job of Object.values(state.jobs || {})) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    job.status = "interrupted";
    job.lastEvent = "网关已重启，上一轮任务状态已失效";
    job.completedAt ||= new Date().toISOString();
    touch(job);
    changed = true;
  }
  return changed;
}

export function markJobSteered(state, jobId, text) {
  const job = getJob(state, jobId);
  if (!job) return null;
  job.lastEvent = `已追加补充：${truncate(firstLine(text, 120), 120)}`;
  touch(job);
  return job;
}

export function findActiveJobForChat(state, chatId) {
  return Object.values(state.jobs || {})
    .filter((job) => job.chatId === chatId && ACTIVE_JOB_STATUSES.has(job.status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

export function findActiveJobForThread(state, threadId) {
  return Object.values(state.jobs || {})
    .filter((job) => job.threadId === threadId && ACTIVE_JOB_STATUSES.has(job.status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

export function findNextQueuedJobForThread(state, threadId) {
  return Object.values(state.jobs || {})
    .filter((job) => job.threadId === threadId && job.status === "queued")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

export function recentJobsForChat(state, chatId, limit = 5) {
  return Object.values(state.jobs || {})
    .filter((job) => job.chatId === chatId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

export function getJob(state, jobId) {
  return state.jobs?.[jobId] || null;
}

export function jobSignature(job) {
  return [
    job.status,
    job.turnId,
    job.lastEvent,
    job.error
  ].join("|");
}

export function buildJobCard(job) {
  const title = cardTitle(job.status);
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true, summary: { content: title } },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `**${title}**`,
            `- 状态：${statusText(job.status)}`,
            `- 当前事件：${job.lastEvent || "处理中"}`,
            `- 任务：${escapeMarkdown(job.title || job.id)}`,
            job.turnId ? `- turn：${job.turnId}` : "",
            job.error ? `- 错误：${escapeMarkdown(truncate(job.error, 300))}` : ""
          ].filter(Boolean).join("\n")
        }
      ]
    }
  };
}

export function jobListText(jobs) {
  if (!jobs.length) return "当前没有任务记录。";
  return jobs.map((job, index) => [
    `${index + 1}. ${statusText(job.status)}｜${job.title || job.id}`,
    `job: ${job.id}`,
    job.turnId ? `turn: ${job.turnId}` : "",
    `事件：${job.lastEvent || "-"}`
  ].filter(Boolean).join("\n")).join("\n\n");
}

function describeCodexEvent(method, params) {
  if (method === "turn/started") return "Codex 已开始处理";
  if (method === "turn/completed") return "Codex 回合已完成";
  if (method === "turn/failed") return "Codex 回合失败";
  if (method === "error" && params?.willRetry) return "Codex 遇到错误，正在重试";
  if (method === "error") return "Codex 返回错误";
  if (method === "item/agentMessage/delta") return "正在生成回复";
  if (method === "turn/plan/updated") return "计划已更新";
  if (method === "turn/diff/updated") return "代码变更已更新";
  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage") return "已生成一段回复";
    if (item.type === "functionCall" || item.type === "toolCall") return `工具调用完成：${item.name || item.call_id || item.type}`;
    if (item.type) return `步骤完成：${item.type}`;
    return "一个步骤已完成";
  }
  if (method === "item/started") {
    const item = params.item || {};
    return item.type ? `开始步骤：${item.type}` : "开始新的处理步骤";
  }
  return method;
}

function cardTitle(status) {
  if (status === "queued") return "Codex 任务排队中";
  if (status === "completed") return "Codex 任务完成";
  if (status === "failed") return "Codex 任务失败";
  if (status === "canceling") return "Codex 任务取消中";
  if (status === "canceled") return "Codex 任务已取消";
  if (status === "interrupted") return "Codex 任务状态已失效";
  return "Codex 任务进行中";
}

function statusText(status) {
  return {
    queued: "排队中",
    starting: "启动中",
    running: "运行中",
    canceling: "取消中",
    canceled: "已取消",
    completed: "已完成",
    failed: "失败",
    interrupted: "状态已失效"
  }[status] || status;
}

function firstLine(value, maxLength) {
  return truncate(String(value || "").split(/\r?\n/)[0].trim(), maxLength);
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\*/g, "\\*").replace(/_/g, "\\_");
}
