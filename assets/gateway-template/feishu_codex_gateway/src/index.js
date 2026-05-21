#!/usr/bin/env node
import {
  consumeFeishuEvents,
  sendFeishuCardKitCard,
  sendFeishuCardKitCardDetailed,
  sendFeishuReply,
  sendFeishuText,
  updateFeishuCardKitCard
} from "./feishu.js";
import { loadDotEnv, logLine, LOG_PATH } from "./config.js";
import { syncFeishuDesktopProjectsFromState } from "./desktopState.js";
import { ThinBridge } from "./thinBridge.js";

loadDotEnv();
syncFeishuDesktopProjectsFromState();

const args = process.argv.slice(2);
const bridge = new ThinBridge({
  sendText: sendFeishuText,
  sendCard: sendFeishuCardKitCard,
  sendReply: sendFeishuReply,
  sendJobCard: sendFeishuCardKitCardDetailed,
  updateJobCard: updateFeishuCardKitCard
});
await bridge.recoverInterruptedJobs();

if (args.includes("--listen")) {
  logLine("thin bridge listen start");
  console.log(`Feishu-Codex thin bridge listening. Log: ${LOG_PATH}`);
  consumeFeishuEvents(async (event) => {
    if (!event.text) return;
    try {
      await bridge.handleMessage({ chatId: event.chatId, text: event.text });
    } catch (error) {
      logLine(`handle event failed: ${error.stack || error.message}`);
      sendFeishuText(event.chatId, `处理失败：${error.message}`);
    }
  });
} else {
  const message = args.includes("--test")
    ? args.slice(args.indexOf("--test") + 1).join(" ") || "你是谁？"
    : args.join(" ") || "你是谁？";
  await bridge.handleMessage({ chatId: "local-test", text: message });
}

