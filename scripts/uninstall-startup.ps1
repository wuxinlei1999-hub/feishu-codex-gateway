param(
  [string]$WorkspaceRoot,
  [string]$TaskName = "FeishuCodexGateway"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = & (Join-Path $PSScriptRoot "resolve-workspace.ps1") -WorkspaceRoot $WorkspaceRoot
$UninstallScript = Join-Path $Root "scripts\uninstall_feishu_codex_gateway_startup.ps1"
& $UninstallScript -TaskName $TaskName
