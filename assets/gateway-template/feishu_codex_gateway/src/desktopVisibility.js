import fs from "node:fs";
import path from "node:path";
import { logLine, STATE_PATH, truncate } from "./config.js";

const CODEX_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");

export function registerDesktopVisibility(threadId, cwd) {
  if (!threadId || !cwd || !fs.existsSync(GLOBAL_STATE_PATH)) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(GLOBAL_STATE_PATH, "utf8"));
  } catch (error) {
    logLine(`global state read failed: ${error.message}`);
    return;
  }

  const cwdText = path.resolve(cwd);
  let changed = false;

  const hints = ensureObject(state, "thread-workspace-root-hints");
  if (hints[threadId] !== cwdText) {
    hints[threadId] = cwdText;
    changed = true;
  }

  const pinned = ensureArray(state, "pinned-thread-ids");
  if (!pinned.includes(threadId)) {
    pinned.unshift(threadId);
    changed = true;
  } else if (pinned[0] !== threadId) {
    state["pinned-thread-ids"] = [threadId, ...pinned.filter((id) => id !== threadId)];
    changed = true;
  }

  const savedRoots = ensureArray(state, "electron-saved-workspace-roots");
  if (!savedRoots.includes(cwdText)) {
    savedRoots.unshift(cwdText);
    changed = true;
  }

  const projectOrder = ensureArray(state, "project-order");
  if (!projectOrder.includes(cwdText)) {
    projectOrder.unshift(cwdText);
    changed = true;
  }

  if (JSON.stringify(state["active-workspace-roots"]) !== JSON.stringify([cwdText])) {
    state["active-workspace-roots"] = [cwdText];
    changed = true;
  }

  const persisted = ensureObject(state, "electron-persisted-atom-state");
  const persistedHints = ensureObject(persisted, "thread-workspace-root-hints");
  if (persistedHints[threadId] !== cwdText) {
    persistedHints[threadId] = cwdText;
    changed = true;
  }

  if (JSON.stringify(persisted["active-workspace-roots"]) !== JSON.stringify([cwdText])) {
    persisted["active-workspace-roots"] = [cwdText];
    changed = true;
  }

  if (!changed) return;
  try {
    fs.writeFileSync(`${GLOBAL_STATE_PATH}.tmp`, JSON.stringify(state), "utf8");
    fs.renameSync(`${GLOBAL_STATE_PATH}.tmp`, GLOBAL_STATE_PATH);
    logLine(`desktop visibility registered thread_id=${threadId} cwd=${cwdText}`);
  } catch (error) {
    logLine(`global state write failed: ${error.message}`);
  }
}

export function syncDesktopVisibilityFromState() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    for (const chat of Object.values(state.bridgeChats || {})) {
      registerDesktopVisibility(chat.threadId, chat.cwd);
    }
  } catch (error) {
    logLine(`desktop visibility sync failed: ${truncate(error.stack || error.message, 1000)}`);
  }
}

export function touchSessionIndex(threadId, threadName) {
  if (!threadId || !fs.existsSync(CODEX_HOME)) return;
  const entry = {
    id: threadId,
    thread_name: threadName || "",
    updated_at: new Date().toISOString()
  };
  try {
    fs.appendFileSync(SESSION_INDEX_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    logLine(`session index touch failed: ${error.message}`);
  }
}

export function startDesktopVisibilityKeepalive() {
  syncDesktopVisibilityFromState();
  setInterval(syncDesktopVisibilityFromState, 15000).unref();
}

function ensureObject(target, key) {
  if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
    target[key] = {};
  }
  return target[key];
}

function ensureArray(target, key) {
  if (!Array.isArray(target[key])) {
    target[key] = [];
  }
  return target[key];
}
