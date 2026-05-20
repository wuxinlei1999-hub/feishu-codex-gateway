param(
  [string]$WorkspaceRoot,
  [string]$TaskName = "FeishuCodexGateway",
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = & (Join-Path $PSScriptRoot "resolve-workspace.ps1") -WorkspaceRoot $WorkspaceRoot
$InstallScript = Join-Path $Root "scripts\install_feishu_codex_gateway_startup.ps1"

if ($RunNow) {
  & $InstallScript -TaskName $TaskName -RunNow
} else {
  & $InstallScript -TaskName $TaskName
}
