$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Gateway = Join-Path $Root "feishu_codex_gateway"
$GatewayIndex = [System.IO.Path]::GetFullPath((Join-Path $Gateway "src\index.js"))
$GatewayIndexPattern = [regex]::Escape($GatewayIndex)
$AllProcesses = Get-CimInstance Win32_Process
$RootProcesses = $AllProcesses |
  Where-Object {
    $_.Name -match "^node(\.exe)?$" -and
    $_.CommandLine -match $GatewayIndexPattern -and
    $_.CommandLine -match "--listen"
  }

if (-not $RootProcesses) {
  Write-Output "Feishu-Codex gateway is not running."
  exit 0
}

function Get-ChildProcesses([int]$ParentId, $ProcessList) {
  $children = @($ProcessList | Where-Object { $_.ParentProcessId -eq $ParentId })
  foreach ($child in $children) {
    $child
    Get-ChildProcesses -ParentId $child.ProcessId -ProcessList $ProcessList
  }
}

$Processes = @()
foreach ($Process in $RootProcesses) {
  $Processes += $Process
  $Processes += Get-ChildProcesses -ParentId $Process.ProcessId -ProcessList $AllProcesses
}

$Processes = $Processes | Sort-Object ProcessId -Unique | Sort-Object ParentProcessId -Descending

foreach ($Process in $Processes) {
  Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Stopped PID=$($Process.ProcessId) $($Process.Name)"
}
