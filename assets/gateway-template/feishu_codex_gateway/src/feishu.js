import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import iconv from "iconv-lite";
import { logLine, truncate } from "./config.js";

function larkCommand() {
  const configured = process.env.FEISHU_CODEX_LARK_CLI || process.env.LARK_CLI_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  return process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
}

let cachedBotName = "";

export function getFeishuBotName() {
  const configured = String(process.env.FEISHU_CODEX_ASSISTANT_NAME || "").trim();
  if (configured) return configured;
  if (cachedBotName) return cachedBotName;

  const command = larkCommand();
  const result = spawnSync(
    command,
    ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot"],
    { encoding: "utf8", errors: "replace", shell: usesCmdShim(command), timeout: 6000 }
  );
  if (result.status !== 0) {
    logLine(`get feishu bot name failed code=${result.status}: ${truncate(result.stderr || result.stdout, 800)}`);
    return "Feishu Codex Assistant";
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const name = String(parsed?.bot?.app_name || parsed?.data?.bot?.app_name || parsed?.data?.app_name || "").trim();
    if (name) {
      cachedBotName = name;
      return cachedBotName;
    }
  } catch (error) {
    logLine(`parse feishu bot name failed: ${error.message}`);
  }
  return "Feishu Codex Assistant";
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
  const sections = splitReplySections(text);
  if (sections.length > 1) return sendFeishuSectionedReply(chatId, sections, mode);
  if (mode === "raw" || mode === "text") return hasLineBreak(text) ? sendFeishuReplyCard(chatId, text) : sendFeishuPlainText(chatId, text);
  if (mode === "post" || mode === "markdown") return hasLineBreak(text) ? sendFeishuReplyCard(chatId, text) : sendFeishuText(chatId, text);
  if (mode === "card") return sendFeishuReplyCard(chatId, text);
  if (mode === "auto" && !shouldUseCard(text) && !hasLineBreak(text)) return sendFeishuText(chatId, text);
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
  const sections = splitReplySections(text, 5200);
  if (sections.length > 1) return sendFeishuSectionedReply(chatId, sections, "card");
  const chunks = splitText(prepareFeishuMarkdown(text, 2), 5200);
  let ok = true;
  for (const [index, chunk] of chunks.entries()) {
    ok = sendSectionCardWithFallback(chatId, chunk, index, chunks.length) && ok;
  }
  return ok;
}

export function sendFeishuCardKitCard(chatId, card, fallbackCard = card) {
  return sendFeishuCardKitCardDetailed(chatId, card, fallbackCard).ok;
}

export function sendFeishuCardKitCardDetailed(chatId, card, fallbackCard = card) {
  if (!chatId || chatId === "local-test") {
    console.log(JSON.stringify(card, null, 2));
    return { ok: true, cardId: "local-card" };
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
    if (sent.status === 0) return { ok: true, cardId };
    logLine(`send cardkit card_id failed code=${sent.status}: ${truncate(sent.stderr || sent.stdout, 1200)}`);
  } else {
    logLine(`create cardkit card failed code=${created.status}: ${truncate(createText, 1200)}`);
  }

  return { ok: sendFeishuInteractiveCard(chatId, fallbackCard), cardId: "" };
}

export function updateFeishuCardKitCard(cardId, card, sequence = 1) {
  if (!cardId || cardId === "local-card") {
    console.log(JSON.stringify(card, null, 2));
    return true;
  }
  const command = larkCommand();
  const payload = JSON.stringify({
    card: {
      type: "card_json",
      data: JSON.stringify(card)
    },
    uuid: `update-${cardId}-${sequence}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sequence
  });
  const result = spawnSync(
    command,
    ["api", "PUT", `/open-apis/cardkit/v1/cards/${cardId}`, "--as", "bot", "--data", "-"],
    { input: payload, encoding: "utf8", errors: "replace", shell: usesCmdShim(command) }
  );
  if (result.status !== 0) {
    logLine(`update cardkit card failed code=${result.status}: ${truncate(result.stderr || result.stdout, 1200)}`);
    return false;
  }
  return true;
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

function sendFeishuSectionedReply(chatId, sections, mode) {
  logLine(`send sectioned reply chat_id=${chatId} sections=${sections.length} mode=${mode}`);
  let ok = true;
  for (const [index, section] of sections.entries()) {
    ok = sendSectionCardWithFallback(chatId, prepareFeishuMarkdown(section, 2), index, sections.length) && ok;
  }
  return ok;
}

function sendSectionCardWithFallback(chatId, markdownText, index, total) {
  const title = sectionCardTitle(markdownText, index, total);
  if (sendFeishuInteractiveCard(chatId, buildReplyCard(markdownText, title))) return true;
  if (findMarkdownTablesOutsideCodeBlocks(markdownText).length === 0) return false;
  const fallbackText = prepareFeishuMarkdown(convertMarkdownTablesToLists(markdownText), 2);
  logLine(`retry section card without markdown tables section=${index + 1}/${total}`);
  return sendFeishuInteractiveCard(chatId, buildReplyCard(fallbackText, `${title} list`));
}

function buildReplyCard(markdownText, title = "") {
  const summaryText = title || toCardSummaryText(markdownText);
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

function sectionCardTitle(markdownText, index, total) {
  const heading = /^(?:#{1,6})\s+(.+)$/m.exec(String(markdownText || ""));
  const title = heading?.[1] || toCardSummaryText(markdownText) || "Reply";
  const cleanTitle = title.replace(/[*_`#|[\]()~:-]/g, "").replace(/\s+/g, " ").trim();
  return `${index + 1}/${total} ${cleanTitle}`.slice(0, 120);
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

function splitReplySections(text, limit = 5200) {
  const source = String(text || "").trim();
  if (!source) return [""];
  const headingSections = splitByMarkdownHeadings(source);
  const baseSections = headingSections.length > 1 ? headingSections : [source];
  const sections = [];
  for (const section of baseSections) {
    if (section.length <= limit) {
      sections.push(section);
      continue;
    }
    sections.push(...splitSectionByParagraphs(section, limit));
  }
  return sections.filter((section) => section.trim());
}

function splitByMarkdownHeadings(text) {
  const level = chooseSectionHeadingLevel(text);
  if (!level) return [];
  const headingRegex = new RegExp(`^#{${level}}\\s+.+$`, "gm");
  const matches = [];
  let match;
  while ((match = headingRegex.exec(text)) !== null) {
    matches.push({ index: match.index });
  }
  if (matches.length < 2) return [];

  const prefix = text.slice(0, matches[0].index).trim();
  const parts = matches.map((current, index) => {
    const next = matches[index + 1];
    return text.slice(current.index, next ? next.index : text.length).trim();
  }).filter(Boolean);
  if (prefix && parts[0]) parts[0] = `${prefix}\n\n${parts[0]}`;
  return parts;
}

function chooseSectionHeadingLevel(text) {
  const h2Count = countHeadingLevel(text, 2);
  if (h2Count >= 2) return 2;
  const h1Count = countHeadingLevel(text, 1);
  if (h1Count >= 2) return 1;
  return null;
}

function countHeadingLevel(text, level) {
  const regex = new RegExp(`^#{${level}}\\s+.+$`, "gm");
  let count = 0;
  while (regex.exec(text) !== null) count += 1;
  return count;
}

function splitSectionByParagraphs(text, limit) {
  const chunks = splitByParagraphs(text, limit);
  if (chunks.length <= 1) return chunks;
  const heading = /^(#{1,2}\s+.+)$/m.exec(String(text || ""))?.[1];
  if (!heading) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0 || chunk.startsWith(heading)) return chunk;
    return `${heading}（续 ${index + 1}/${chunks.length}）\n\n${chunk}`;
  });
}

function splitByParagraphs(text, limit) {
  const paragraphs = String(text || "").split(/\n{2,}/);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= limit) {
      current = paragraph;
    } else {
      chunks.push(...splitText(paragraph, limit));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hasLineBreak(text) {
  return /\r?\n/.test(String(text || ""));
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

function convertMarkdownTablesToLists(text) {
  return String(text || "").replace(/((?:^\|.*\|\s*$\n?)+)/gm, (table) => {
    const rows = table.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (rows.length < 2 || !/^\|[-:| ]+\|$/.test(rows[1])) return table;
    const headers = rows[0].split("|").slice(1, -1).map((cell) => cell.trim());
    const bodyRows = rows.slice(2);
    return bodyRows.map((row) => {
      const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
      const pairs = headers.map((header, index) => `${header}: ${cells[index] || ""}`).join("; ");
      return `- ${pairs}`;
    }).join("\n");
  });
}
