import fs from "node:fs";
import { ensureDataDir, STATE_PATH, logLine } from "./config.js";

function defaultState() {
  return { version: 1, bridgeChats: {}, routerThreadId: "" };
}

export function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_PATH)) {
    const state = defaultState();
    saveState(state);
    return state;
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      version: state.version || 1,
      bridgeChats: state.bridgeChats || {},
      routerThreadId: state.routerThreadId || ""
    };
  } catch (error) {
    logLine(`state read failed: ${error.message}`);
    return defaultState();
  }
}

export function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    version: state.version || 1,
    bridgeChats: state.bridgeChats || {},
    routerThreadId: state.routerThreadId || ""
  }, null, 2), "utf8");
}
