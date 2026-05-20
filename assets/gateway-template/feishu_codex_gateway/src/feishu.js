import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import iconv from "iconv-lite";
import { logLine, truncate } from "./config.js";

function larkCommand() {
  const localExe = process.env.LARK_CLI_PATH || "";
  if (localExe && fs.existsSync(localExe)) return localExe;
  return process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
}

function usesCmdShim(command) {
  return process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
}

export function sendFeishuText(chatId, text) {
  const displayText = prepareFeishuMarkdown(text, 1);
  if (!chatId || chatId === "local-test") {
    console.log(displayText);
    return;
  }
  const chunks = splitText(displayText);
  chunks.forEach((chunk, index) => {
    logLine(`send feishu chat_id=${chatId} chunk=${index + 1}: ${truncate(chunk, 500)}`);
    const command = larkCommand();
    const result = spawnSync(
      command,
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--markdown", chunk],
      { encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
    );
    if (result.status !== 0) {
      logLine(`send feishu failed code=${result.status}: ${truncate(result.stderr || result.stdout, 1200)}`);
    }
  });
}

export function sendFeishuReply(chatId, text) {
  const mode = String(process.env.FEISHU_CODEX_RENDER_MODE || "auto").toLowerCase();
  if (mode === "raw" || mode === "text") return sendFeishuPlainText(chatId, text);
  if (mode === "post" || mode === "markdown") return sendFeishuText(chatId, text);
  if (mode === "card") return sendFeishuReplyCard(chatId, text);
  if (mode === "auto" && !shouldUseCard(text)) return sendFeishuText(chatId, text);
  return sendFeishuReplyCard(chatId, text);
}

function shouldUseCard(text) {
  const value = String(text || "");
  return /```[\s\S]*?```/.test(value) || findMarkdownTablesOutsideCodeBlocks(value).length > 0;
}

export function sendFeishuPlainText(chatId, text) {
  if (!chatId || chatId === "local-test") {
    console.log(text);
    return true;
  }
  const command = larkCommand();
  const result = spawnSync(
    command,
    ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", String(text || "").trim()],
    { encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
  );
  if (result.status !== 0) {
    logLine(`send plain text failed code=${result.status}: ${truncate(result.stderr || result.stdout, 1200)}`);
    return false;
  }
  return true;
}

export function sendFeishuReplyCard(chatId, text) {
  const chunks = splitText(prepareFeishuMarkdown(text, 2), 5500);
  let ok = true;
  for (const chunk of chunks) {
    ok = sendFeishuInteractiveCard(chatId, buildReplyCard(chunk)) && ok;
  }
  return ok;
}

export function sendFeishuCardKitCard(chatId, card, fallbackCard = card) {
  if (!chatId || chatId === "local-test") {
    console.log(JSON.stringify(card, null, 2));
    return true;
  }

  const command = larkCommand();
  const createPayload = JSON.stringify({
    type: "card_json",
    data: JSON.stringify(card)
  });
  const created = spawnSync(
    command,
    ["api", "POST", "/open-apis/cardkit/v1/cards", "--as", "bot", "--data", "-"],
    { input: createPayload, encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
  );
  const createText = created.stdout || created.stderr || "";
  let cardId = "";
  try {
    const parsed = JSON.parse(createText);
    cardId = parsed?.data?.card_id || parsed?.card_id || "";
  } catch {
    // Fall through to fallback sender.
  }

  if (created.status === 0 && cardId) {
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const sent = spawnSync(
      command,
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", content],
      { encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
    );
    if (sent.status === 0) return true;
    logLine(`send cardkit card_id failed code=${sent.status}: ${truncate(sent.stderr || sent.stdout, 1200)}`);
  } else {
    logLine(`create cardkit card failed code=${created.status}: ${truncate(createText, 1200)}`);
  }

  return sendFeishuInteractiveCard(chatId, fallbackCard);
}

export function sendFeishuInteractiveCard(chatId, card) {
  if (!chatId || chatId === "local-test") {
    console.log(JSON.stringify(card, null, 2));
    return true;
  }
  const command = larkCommand();
  const result = spawnSync(
    command,
    ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", JSON.stringify(card)],
    { encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
  );
  if (result.status !== 0) {
    logLine(`send interactive card failed code=${result.status}: ${truncate(result.stderr || result.stdout, 1200)}`);
    return false;
  }
  logLine(`send interactive card chat_id=${chatId}: ${truncate(toCardSummaryText(JSON.stringify(card)), 500)}`);
  return true;
}

function buildReplyCard(markdownText) {
  const summaryText = toCardSummaryText(markdownText);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      summary: summaryText ? { content: summaryText.slice(0, 120) } : undefined
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: markdownText
        }
      ]
    }
  };
}

function toCardSummaryText(markdownText) {
  return String(markdownText || "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`#|[\]()~:-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function consumeFeishuEvents(onMessage) {
  const command = larkCommand();
  const child = spawn(
    command,
    ["event", "consume", "im.message.receive_v1", "--as", "bot"],
    { shell: usesCmdShim(command) }
  );
  child.on("error", (error) => {
    logLine(`lark consumer spawn failed: ${error.message}`);
  });
  child.stdout.on("data", (data) => {
    for (const line of decodeOutput(data).split(/\r?\n/)) {
      const event = parseEventLine(line);
      if (event) onMessage(event);
    }
  });
  child.stderr.on("data", (data) => {
    const text = decodeOutput(data).trim();
    if (text) logLine(`lark stderr: ${truncate(text, 1200)}`);
  });
  child.on("exit", (code, signal) => {
    logLine(`lark consumer exited code=${code} signal=${signal}`);
  });
  return child;
}

function decodeOutput(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  return buffer.toString("utf8");
}

function parseEventLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const raw = JSON.parse(trimmed);
    const event = raw.event || raw;
    const message = event.message || event;
    const sender = event.sender || {};
    const content = parseContent(message.content || event.content || "");
    return {
      chatId: message.chat_id || event.chat_id,
      messageId: message.message_id || event.message_id || raw.message_id,
      senderId: sender.sender_id?.open_id || sender.sender_id?.user_id || event.sender_id,
      messageType: message.message_type || event.message_type,
      text: repairMojibake(content.text || String(content || "").trim()),
      raw
    };
  } catch {
    return null;
  }
}

function parseContent(content) {
  if (typeof content !== "string") return content || {};
  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

function repairMojibake(text) {
  const source = String(text || "");
  if (!looksMojibake(source)) return source;
  const repaired = iconv.decode(iconv.encode(source, "gb18030"), "utf8");
  if (!repaired || repaired.includes("\uFFFD")) return source;
  return repaired;
}

function looksMojibake(text) {
  return /[鎴浣鐩堟槸涓绋炰涔戣瘽瀹犲湪鍝勫]/.test(text);
}

function splitText(text, limit = 1800) {
  const source = String(text || "");
  if (source.length <= limit) return [source];
  const chunks = [];
  for (let i = 0; i < source.length; i += limit) {
    chunks.push(source.slice(i, i + limit));
  }
  return chunks;
}

function sanitizeFeishuMarkdown(text) {
  return String(text || "").trim();
}

function prepareFeishuMarkdown(text, cardVersion = 2) {
  return optimizeMarkdownStyle(sanitizeFeishuMarkdown(text), cardVersion);
}

function optimizeMarkdownStyle(text, cardVersion = 2) {
  try {
    let result = optimizeMarkdownStyleInner(text, cardVersion);
    result = stripInvalidImageKeys(result);
    return result;
  } catch {
    return String(text || "");
  }
}

function optimizeMarkdownStyleInner(text, cardVersion = 2) {
  const mark = "___CB_";
  const codeBlocks = [];
  let result = String(text || "").replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = "") => {
    const block = match.slice(String(prefix).length);
    return `${prefix}${mark}${codeBlocks.push(block) - 1}___`;
  });

  const hasH1toH3 = /^#{1,3} /m.test(result);
  if (hasH1toH3) {
    result = result.replace(/^#{2,6} (.+)$/gm, "##### $1");
    result = result.replace(/^# (.+)$/gm, "#### $1");
  }

  if (cardVersion >= 2) {
    result = result.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");

    result = result.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
    result = result.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
    result = result.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (match, _table, offset) => {
      const after = result.slice(offset + match.length).replace(/^\n+/, "");
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return match;
      return `${match}\n<br>\n`;
    });
    result = result.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
    result = result.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
    result = result.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");

    codeBlocks.forEach((block, index) => {
      result = result.replace(`${mark}${index}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    codeBlocks.forEach((block, index) => {
      result = result.replace(`${mark}${index}___`, block);
    });
  }

  return result.replace(/\n{3,}/g, "\n\n");
}

function stripInvalidImageKeys(text) {
  if (!String(text || "").includes("![")) return text;
  return String(text || "").replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (fullMatch, _alt, value) => {
    if (String(value || "").startsWith("img_")) return fullMatch;
    return "";
  });
}

function findMarkdownTablesOutsideCodeBlocks(text) {
  const value = String(text || "");
  const withoutCodeBlocks = value.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, "\n");
  return withoutCodeBlocks.match(/\|.+\|[\r\n]+\|[-:| ]+\|/g) || [];
}
