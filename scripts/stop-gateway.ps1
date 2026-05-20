param(
  [string]$WorkspaceRoot
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = & (Join-Path $PSScriptRoot "resolve-workspace.ps1") -WorkspaceRoot $WorkspaceRoot
& (Join-Path $Root "scripts\stop_feishu_codex_gateway.ps1")
