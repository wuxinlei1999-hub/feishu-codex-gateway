---
name: feishu-codex-gateway
description: Operate, troubleshoot, and package the local Feishu/Lark to Codex gateway that lets a Feishu bot chat with a long-lived Codex app-server thread. Use when the user mentions Feishu/Lark connecting to Codex, the Feishu-Codex gateway, Xiaoshu bot chat, gateway startup/autostart, Feishu message routing, session/model switching from Feishu, gateway logs, lark-cli event consume, or repeated Codex stream reconnects such as Reconnecting 1/5 through 5/5.
---

# Feishu Codex Gateway

## Purpose

Use this skill for the local Feishu/Lark bot to Codex gateway. The verified stable chain is:

```text
Feishu bot message
-> lark-cli event consume im.message.receive_v1 --as bot
-> local Feishu-Codex gateway
-> independent Codex app-server thread
-> Feishu bot reply
```

Do not route normal chat through hard-coded replies or `codex exec` one-shot sessions. The gateway should bridge messages into a long-lived Codex thread and let Codex do the reasoning.

## Quick Workflow

1. Read `references/gateway.md` when you need architecture, fresh-machine setup, defaults, routing, render mode, startup, or troubleshooting details.
2. For a fresh machine, install the bundled gateway template first:

```powershell
powershell -ExecutionPolicy Bypass -File <skill>\scripts\install-gateway.ps1 -InstallDependencies
```

3. Use scripts from `scripts/` when operating the local gateway from outside the installed workspace scripts folder.
4. Check status before changing anything:

```powershell
powershell -ExecutionPolicy Bypass -File <skill>\scripts\status-gateway.ps1
```

5. Start or restart only the gateway unless the user explicitly asks to touch Codex Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File <skill>\scripts\start-gateway.ps1
powershell -ExecutionPolicy Bypass -File <skill>\scripts\stop-gateway.ps1
```

6. Install current-user Windows logon autostart when requested:

```powershell
powershell -ExecutionPolicy Bypass -File <skill>\scripts\install-startup.ps1
```

## Guardrails

- Installing this skill alone does not install `lark-cli`, create a Feishu app, or grant Feishu permissions. The skill does include a bundled gateway template under `assets/gateway-template`; install it with `scripts/install-gateway.ps1`.
- Do not modify Codex Desktop startup variables, `CODEX_CLI_PATH`, or proxy settings by default.
- Keep the stable independent app-server gateway as the default path.
- Do not use proxy mode unless the user explicitly asks to debug shared Desktop/app-server internals.
- Do not print Feishu app secrets, tokens, cookies, device codes, or verification URLs.
- If replies are slow and logs show `Reconnecting... 1/5` through `5/5`, check VPN and TUN mode before changing gateway code.
- The startup task is a current-user Windows scheduled task named `FeishuCodexGateway`.

## Local Defaults

The default installed workspace is:

```text
<Documents>\Codex\feishu-codex-gateway-workspace
```

Default gateway state and logs:

```text
.feishu_codex_gateway\state.json
.feishu_codex_gateway\gateway.log
```

Default Feishu-bound Codex settings:

```text
Thread name: Feishu Session
Project directory: <workspace>\Feishu
Model: gpt-5.5
Reasoning: high
```

## Resources

- `references/gateway.md`: full architecture, command, routing, rendering, network, and troubleshooting notes.
- `assets/gateway-template/`: the bundled gateway app source and project scripts; it excludes secrets, runtime state, logs, and `node_modules`.
- `scripts/install-gateway.ps1`: copy the bundled gateway template into a local workspace and optionally run `npm install`.
- `scripts/start-gateway.ps1`: start the gateway from the known workspace.
- `scripts/status-gateway.ps1`: inspect gateway processes, startup task, state, and recent logs.
- `scripts/stop-gateway.ps1`: stop the gateway and child processes.
- `scripts/install-startup.ps1`: register Windows logon autostart.
- `scripts/uninstall-startup.ps1`: remove Windows logon autostart.
