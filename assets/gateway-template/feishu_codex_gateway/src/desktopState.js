import fs from "node:fs";
import path from "node:path";
import { logLine } from "./config.js";
import { loadState } from "./state.js";

const SESSION_INDEX_PATH = path.join(process.env.USERPROFILE || "", ".codex", "session_index.jsonl");
const DEFAULT_THREAD_NAME = "Feishu Session";

export function registerFeishuDesktopProject(threadId, threadName = DEFAULT_THREAD_NAME) {
  if (!threadId) return;
  try {
    updateSessionIndexTitle(threadId, threadName);
    logLine(`desktop project registration skipped thread=${threadId}`);
  } catch (error) {
    logLine(`register desktop project failed: ${error.message}`);
  }
}

export function syncFeishuDesktopProjectsFromState() {
  const state = loadState();
  for (const chat of Object.values(state.bridgeChats || {})) {
    registerFeishuDesktopProject(chat.threadId, chat.threadName);
  }
}

function updateSessionIndexTitle(threadId, threadName) {
  if (!fs.existsSync(SESSION_INDEX_PATH)) return;
  const lines = fs.readFileSync(SESSION_INDEX_PATH, "utf8").split(/\r?\n/);
  let changed = false;
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const row = JSON.parse(line);
      if (row.id !== threadId || row.thread_name === threadName) return line;
      row.thread_name = threadName;
      changed = true;
      return JSON.stringify(row);
    } catch {
      return line;
    }
  });
  if (changed) fs.writeFileSync(SESSION_INDEX_PATH, nextLines.join("\n"), "utf8");
}
