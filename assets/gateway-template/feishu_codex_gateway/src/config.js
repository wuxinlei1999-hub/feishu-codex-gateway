import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GATEWAY_ROOT = path.resolve(__dirname, "..");
export const WORKSPACE_ROOT = path.resolve(GATEWAY_ROOT, "..");
export const FEISHU_PROJECT_ROOT = path.join(WORKSPACE_ROOT, "Feishu");
export const DATA_DIR = path.join(WORKSPACE_ROOT, ".feishu_codex_gateway");
export const STATE_PATH = path.join(DATA_DIR, "state.json");
export const LOG_PATH = path.join(DATA_DIR, "gateway.log");
export const CODEX_WORKSPACE_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || WORKSPACE_ROOT, "Documents", "Codex");

export function loadDotEnv() {
  const envPath = path.join(WORKSPACE_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FEISHU_PROJECT_ROOT, { recursive: true });
}

export function logLine(message) {
  ensureDataDir();
  const stamp = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${stamp}] ${message}\n`, "utf8");
}

export function truncate(text, limit = 1800) {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 80).trimEnd()}\n\n...[truncated]`;
}
