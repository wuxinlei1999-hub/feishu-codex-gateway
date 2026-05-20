param(
  [string]$TaskName = "FeishuCodexGateway",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) {
  Write-Output "Startup task is not installed: $TaskName"
  exit 0
}

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StartScript = [System.IO.Path]::GetFullPath((Join-Path $Root "scripts\start_feishu_codex_gateway.ps1"))
$TaskMatchesWorkspace = @($Task.Actions | Where-Object {
  $_.Arguments -like "*$StartScript*"
}).Count -gt 0

if (-not $TaskMatchesWorkspace -and -not $Force) {
  Write-Output "Startup task exists but belongs to another workspace: $TaskName"
  Write-Output "Use -Force only if you intentionally want to remove that task."
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Uninstalled startup task: $TaskName"
