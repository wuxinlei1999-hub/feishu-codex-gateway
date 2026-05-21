# Feishu-Codex Gateway Reference

## Architecture

Stable mode runs an independent Codex app-server and sends results back to Feishu:

```text
Feishu bot
-> lark-cli event consumer
-> local gateway
-> one bound Codex app-server thread
-> Feishu bot reply
```

This is the default because it does not modify how Codex Desktop starts. Feishu-bound sessions may appear as normal Codex Desktop conversations; the stable bridge does not force Desktop project/sidebar ownership.

## Fresh Machine Setup

Installing this skill alone is not enough to connect Feishu and Codex. The skill includes the gateway code template, but the runtime still needs the Feishu CLI, a Feishu self-built app, app permissions, and user authorization/configuration.

This desktop skill is the standalone new-user version. It should be usable without the creator's personal `lark-cli` skill, local workspace names, saved state, logs, or credentials.

From zero, the expected chain is:

```text
Install this skill
-> install Node.js/npm if missing
-> install @larksuite/cli
-> configure or create a Feishu/Lark app
-> enable bot and event subscription permissions
-> publish/install the app to the tenant
-> install the bundled gateway template from this skill
-> start the gateway
-> test Feishu bot chat
```

### 1. Install Lark CLI

Use npm when `lark-cli.cmd` is missing:

```powershell
npm install -g @larksuite/cli
lark-cli.cmd --help
```

On Windows, prefer `lark-cli.cmd` over the PowerShell shim.

### 2. Configure Feishu App Credentials

There are two setup paths:

```powershell
# Create or configure a new app through the CLI/browser flow.
lark-cli.cmd config init --new

# Or bind an existing app with App ID and App Secret.
lark-cli.cmd config init --app-id <cli_xxx> --app-secret-stdin
```

For the existing-app path, the user must provide the Feishu app `App ID` and `App Secret`. Do not print or commit the secret. Prefer `--app-secret-stdin` so it is not exposed in the process list.

The CLI setup flow may give a browser URL or verification flow. Let the user open the URL and finish authorization/setup in the browser.

### 3. Request User Authorization When Needed

For user-level operations, use Device Flow:

```powershell
lark-cli.cmd auth login --domain im,event
```

For agent workflows that need a non-blocking handoff:

```powershell
lark-cli.cmd auth login --domain im,event --no-wait --json
```

Send the verification URL to the user, wait for confirmation, then complete with the returned device code:

```powershell
lark-cli.cmd auth login --device-code <device_code>
```

The Feishu-Codex gateway itself primarily sends and receives as the bot, but auth checks are still useful when testing CLI setup and scopes.

### 4. Feishu Console Configuration

The Feishu/Lark app usually needs:

- Bot capability enabled.
- Long-connection event subscription enabled.
- Event: `im.message.receive_v1`.
- Message receive/send permissions for bot messaging.
- CardKit/card permissions if sending CardKit cards.
- The app republished or reinstalled after permission changes.

Check configured scopes:

```powershell
lark-cli.cmd auth scopes --format pretty
lark-cli.cmd auth status --verify
```

### 5. Test CLI Event and Message Path

Check event availability and schema:

```powershell
lark-cli.cmd event list
lark-cli.cmd event schema im.message.receive_v1
```

Start a short event consumer:

```powershell
lark-cli.cmd event consume im.message.receive_v1 --as bot --timeout 60s
```

Send a test bot message when a chat id is known:

```powershell
lark-cli.cmd im +messages-send --as bot --chat-id <oc_xxx> --text "test"
```

### 6. Install the Bundled Gateway Code

This skill includes the current gateway application template at:

```text
assets\gateway-template\
```

Install it into the default workspace:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-gateway.ps1 -InstallDependencies
```

Or choose a custom workspace:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-gateway.ps1 -WorkspaceRoot C:\path\to\workspace -InstallDependencies
```

The template contains:

```text
feishu_codex_gateway\src\index.js
feishu_codex_gateway\src\jobStatus.js
feishu_codex_gateway\package.json
feishu_codex_gateway\package-lock.json
scripts\start_feishu_codex_gateway.ps1
scripts\status_feishu_codex_gateway.ps1
scripts\stop_feishu_codex_gateway.ps1
scripts\install_feishu_codex_gateway_startup.ps1
scripts\uninstall_feishu_codex_gateway_startup.ps1
```

It intentionally excludes:

```text
.env
.feishu_codex_gateway\
node_modules\
logs
tokens
secrets
```

Then start it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_feishu_codex_gateway.ps1
```

## Default Local Workspace

```text
<Documents>\Codex\feishu-codex-gateway-workspace
```

Important paths:

```text
feishu_codex_gateway\
scripts\start_feishu_codex_gateway.ps1
scripts\status_feishu_codex_gateway.ps1
scripts\stop_feishu_codex_gateway.ps1
scripts\install_feishu_codex_gateway_startup.ps1
scripts\uninstall_feishu_codex_gateway_startup.ps1
.feishu_codex_gateway\state.json
.feishu_codex_gateway\gateway.log
```

Default settings:

```text
Default Codex thread: Feishu Session
Project directory: <workspace>\Feishu
Model: gpt-5.5
Reasoning: high
Assistant name: Feishu bot app name
```

The bundled gateway resolves `lark-cli` from `PATH` by default. If a user installed it somewhere non-standard, set `FEISHU_CODEX_LARK_CLI` or `LARK_CLI_PATH` to the full executable path.

For new Codex sessions, the gateway asks Feishu for the configured bot name:

```powershell
lark-cli.cmd api GET /open-apis/bot/v3/info --as bot
```

It uses `bot.app_name` in the session instructions so the assistant self-name matches the bot users see in Feishu. Set `FEISHU_CODEX_ASSISTANT_NAME` to override this manually.

## Feishu App Requirements

The Feishu/Lark app usually needs:

- Bot capability enabled.
- Long-connection event subscription.
- `im.message.receive_v1` event.
- Message receive/send scopes.
- App republished or reinstalled after scope changes.

Use the official CLI on Windows as `lark-cli.cmd` if the `.ps1` shim is blocked.

## Run Commands

From the workspace root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start_feishu_codex_gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\status_feishu_codex_gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\stop_feishu_codex_gateway.ps1
```

From this skill folder, use the wrapper scripts:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\status-gateway.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\stop-gateway.ps1
```

Pass `-WorkspaceRoot <path>` when using a different checkout.

## Autostart

Install a current-user Windows scheduled task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

Remove it:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-startup.ps1
```

The task name is `FeishuCodexGateway`. It runs at Windows logon and calls the workspace's idempotent start script. It does not depend on Codex Desktop launching.

## Gateway Actions

Shortcut commands:

```text
/current   show the current bound Codex thread
/new       create a new bound Codex thread for the Feishu chat
/sessions  list known gateway sessions
/switch    switch binding by session name, index, or id
/model     change model and reasoning, e.g. /model model=gpt-5.5 reasoning=high
/cancel    cancel/interrupt the current running Codex task
/jobs      show recent Feishu gateway tasks
/read      read the current bound Codex session
/archive   archive the current or specified session
/unarchive restore the current or specified archived session
/help      show command help
```

Natural language can also route to management actions: current session, list sessions, switch session, new session, model/reasoning changes, cancel/pause/stop a task, list jobs, read the current session, archive/unarchive sessions, and help. Router prompts include the current action list on every route request so old router threads do not keep stale action capabilities. Other text delegates to the currently bound Codex thread with full Codex permissions.

When a Codex task is already running, a router turn classifies the next Feishu message as either `steer` or `enqueue`:

- `steer`: supplement, correction, constraint, clarification, or answer for the current running task.
- `enqueue`: separate task, or any uncertain case.

Queued jobs should acknowledge with a short text message and should not show a task card until they actually start.

## Reply Rendering

New Feishu-bound Codex sessions get Feishu reply-format instructions through Codex app-server base instructions. The sender layer should preserve complete Codex output.

Current rendering behavior:

- One-line normal replies may use plain Markdown.
- Multi-line, long, or multi-section replies are split by Markdown chapters or paragraphs and sent section by section as interactive markdown cards, regardless of whether the original Codex output looked like a card, Markdown, plain text, or another reply shape.
- Code blocks and Markdown tables use interactive markdown cards.
- If Feishu rejects a card because a Markdown table exceeds card limits, retry that section with the table converted to list rows.
- Full session `response_item` final answer is preferred over shorter app-server event text.
- Angle brackets are escaped before sending Markdown so XML-like tags are visible as text.
- Codex turns intentionally have no hard reply timeout, so long tasks can finish and push final answers back to Feishu.
- Task status cards are sent through CardKit. Card updates must be serialized per job to avoid Feishu `300317 sequence number compare failed` errors. If a status-card update fails, log it and keep going; do not create a duplicate completion card because the final Codex reply is the completion signal.

Avoid direct multi-line `lark-cli im +messages-send --markdown` or `--text` sends for final answers. In testing, those paths can store only the first line/body title, while interactive cards preserve the full content.

Keep task status cards lightweight. The final answer should be separate from the task card and may be plain text or sectioned interactive markdown cards depending on length and content.

## Network Requirement

Keep VPN enabled and enable TUN mode in the VPN client when available. Without TUN mode, Feishu WebSocket may connect normally while Codex app-server stalls when talking to the Codex/OpenAI backend.

Typical symptom in `.feishu_codex_gateway\gateway.log`:

```text
Reconnecting... 1/5
Reconnecting... 2/5
...
Reconnecting... 5/5
```

If this appears, check VPN and TUN mode before changing gateway code.

## Troubleshooting

If Feishu does not reply:

1. Run `scripts\status-gateway.ps1`.
2. Confirm a Node process for `feishu_codex_gateway\src\index.js --listen` exists.
3. Confirm `lark-cli event consume im.message.receive_v1 --as bot` exists.
4. Check `.feishu_codex_gateway\gateway.log` for `feishu-websocket: connected`.
5. Check whether the message was received: search the log for `bridge message`.
6. If received but slow, look for Codex reconnect logs and verify VPN/TUN.
7. Confirm the gateway uses `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`, not the WindowsApps shim.
8. Test slash commands such as `/current` or `/sessions` to separate routing latency from Codex execution latency.
9. If status cards duplicate or fail to update, check for CardKit `300317` sequence errors and confirm per-job card update queuing is present in `src\thinBridge.js`.

## Proxy Warning

Do not use proxy mode by default, and do not modify Codex Desktop startup environment variables. Proxy mode was experimental and can break normal Desktop startup if environment variables are left behind. Use the stable independent app-server gateway unless the user explicitly asks to debug shared Desktop/app-server internals.

## Open Source Notes

Do not commit local secrets or runtime state:

```text
.env
.feishu_codex_gateway\state.json
.feishu_codex_gateway\gateway.log
*.bak-feishu-*
```

A reusable open-source version should expose workspace root, project name, thread name, model, and reasoning effort as config while keeping the bridge logic small.

