# Feishu Codex Gateway

A thin TeleCodex-style bridge for Feishu/Lark and Codex.

```text
Feishu bot message
-> lark-cli event consumer
-> local gateway
-> one bound Codex app-server thread
-> Feishu bot reply
```

The bridge does not try to be a second brain. It connects Feishu to a long-lived Codex conversation, then lets Codex understand the message and decide how to help.

## What It Solves

- Chat with Codex from Feishu mobile or desktop.
- Keep one Feishu chat bound to one Codex app-server thread by default.
- Create a new bound thread with a command when needed.
- Push the final Codex answer back to Feishu as the bot.
- Keep the Feishu bridge usable without forcing Codex Desktop project/sidebar metadata.
- Let natural-language management requests switch sessions or model settings through gateway actions.

## Default Names

```text
Default Codex thread: Feishu Session
Project directory: <workspace>\Feishu
```

The gateway creates the project directory automatically.

Default model: `gpt-5.5`, high reasoning.

## Stable Mode

Stable mode runs an independent `codex app-server` and sends results back to Feishu.

```text
Feishu bot -> local gateway -> independent codex app-server -> Feishu bot
```

This is the default mode because it does not modify how Codex Desktop starts.

## Desktop Metadata

The stable bridge does not force Codex Desktop project/sidebar ownership. Feishu-bound sessions may appear as normal Desktop conversations.

The gateway may update `~\.codex\session_index.jsonl` thread names, but it should not keep writing `.codex-global-state.json`, pin threads, or set global startup overrides such as `CODEX_CLI_PATH` or `CODEX_PROXY_*`.

## Run

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_feishu_codex_gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\status_feishu_codex_gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\stop_feishu_codex_gateway.ps1
```

The start script launches:

```text
node feishu_codex_gateway/src/index.js --listen
lark-cli event consume im.message.receive_v1 --as bot
```

## Start Automatically

Install a current-user Windows scheduled task so the gateway starts whenever this Windows user logs in:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install_feishu_codex_gateway_startup.ps1
```

Remove the scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall_feishu_codex_gateway_startup.ps1
```

The startup task calls `scripts\start_feishu_codex_gateway.ps1`, which is idempotent: if the gateway is already running, it does not start a duplicate.

## Commands

```text
/current   show the current bound Codex thread
/new       create a new bound Codex thread for this Feishu chat
/sessions  list known gateway sessions
/switch    switch the Feishu chat binding by session name, index, or id
/model     change model and reasoning, for example: /model model=gpt-5.5 reasoning=high
/help      show help
```

Shortcut commands go straight to gateway actions. Other text is first classified as either a gateway management action or a Codex task. Gateway actions include current session, list sessions, switch session, new session, model/reasoning changes, and help. Everything else is delegated to the currently bound Codex thread with full Codex permissions.

New Codex sessions receive Feishu reply-format instructions through their base instructions. Existing sessions are not auto-patched during normal chat.

Codex turns intentionally have no hard reply timeout, so long-running tasks can finish and still be pushed back to Feishu. Low-level app-server startup and JSON-RPC requests still use short technical guardrails so broken connections fail visibly.

Feishu replies should preserve complete Codex output. The gateway prefers the full session `response_item` final answer over the shorter app-server event text, because XML-like markers such as `oai-mem-citation` can be stripped from event text. Long or multi-section replies are split by Markdown chapters or paragraphs before sending, regardless of whether the original output looked like a card, Markdown, plain text, or another reply shape. Multi-line replies are sent as interactive markdown cards because direct `--markdown` and `--text` CLI sends can drop body content after the first line. If a card fails because a Markdown table exceeds Feishu card limits, the gateway retries that section with the table converted to list rows. Before sending Markdown to Feishu, the gateway escapes angle brackets so tags are visible as plain text instead of being interpreted.

## Network Requirement

Keep VPN enabled before using the Feishu-Codex gateway, and enable TUN mode in the VPN client when available. Without TUN mode, Codex app-server may connect to Feishu normally but stall when talking to the Codex/OpenAI backend, causing repeated stream reconnects such as `Reconnecting... 1/5` through `5/5` before it eventually recovers or becomes very slow.

## State and Logs

```text
.feishu_codex_gateway/state.json
.feishu_codex_gateway/gateway.log
```

Each Feishu `chat_id` maps to a Codex thread id, thread name, working directory, model, reasoning effort, and update time. `routerThreadId` stores the internal intent-classification thread used for natural-language management actions.

## Feishu App Requirements

The Feishu/Lark app usually needs:

- Bot capability enabled.
- Long-connection event subscription.
- `im.message.receive_v1` event.
- Message receive/send scopes.
- App republished or reinstalled after scope changes.

## Open Source Notes

Do not commit local secrets or runtime state:

```text
.env
.feishu_codex_gateway/state.json
.feishu_codex_gateway/gateway.log
*.bak-feishu-*
```

A reusable open-source version should expose workspace root, project name, thread name, model, and reasoning effort as config while keeping the default bridge logic small.

## Proxy Mode Warning

A shared app-server proxy could theoretically make Desktop and Feishu use the exact same live app-server stream, but it can affect Desktop startup if configured incorrectly. Keep it out of the default path.
