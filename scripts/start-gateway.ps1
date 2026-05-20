param(
  [string]$WorkspaceRoot,
  [switch]$UseProxy,
  [string]$ProxyHost = "127.0.0.1",
  [int]$ProxyPort = 39766
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = & (Join-Path $PSScriptRoot "resolve-workspace.ps1") -WorkspaceRoot $WorkspaceRoot
$StartScript = Join-Path $Root "scripts\start_feishu_codex_gateway.ps1"

if ($UseProxy) {
  & $StartScript -UseProxy -ProxyHost $ProxyHost -ProxyPort $ProxyPort
} else {
  & $StartScript
}
