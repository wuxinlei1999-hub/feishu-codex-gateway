$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Gateway = Join-Path $Root "feishu_codex_gateway"
$GatewayIndex = [System.IO.Path]::GetFullPath((Join-Path $Gateway "src\index.js"))
$GatewayIndexPattern = [regex]::Escape($GatewayIndex)
$RelativeGatewayIndexPattern = '(^|\s|")src[\\/]index\.js(\s|"|$)'

function Test-GatewayProcess($Process) {
  return $Process.Name -match "^node(\.exe)?$" -and
    $Process.CommandLine -and
    $Process.CommandLine -match "--listen" -and
    (
      $Process.CommandLine -match $GatewayIndexPattern -or
      $Process.CommandLine -match $RelativeGatewayIndexPattern
    )
}

$AllProcesses = Get-CimInstance Win32_Process
$RootProcesses = $AllProcesses |
  Where-Object { Test-GatewayProcess $_ }

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

function Test-LarkCliProcess($Process) {
  return ($Process.Name -match "^lark-cli(\.exe)?$") -or
    ($Process.CommandLine -and $Process.CommandLine -match "@larksuite[\\/]cli")
}

$Processes = @()
foreach ($Process in $RootProcesses) {
  $Processes += $Process
  $DirectChildren = @($AllProcesses | Where-Object { $_.ParentProcessId -eq $Process.ProcessId })
  $LarkChildren = @($DirectChildren | Where-Object { Test-LarkCliProcess $_ })
  foreach ($Child in $LarkChildren) {
    $Processes += $Child
    $Processes += Get-ChildProcesses -ParentId $Child.ProcessId -ProcessList $AllProcesses
  }
}

$Processes = $Processes | Sort-Object ProcessId -Unique | Sort-Object ParentProcessId -Descending

foreach ($Process in $Processes) {
  Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Stopped PID=$($Process.ProcessId) $($Process.Name)"
}
