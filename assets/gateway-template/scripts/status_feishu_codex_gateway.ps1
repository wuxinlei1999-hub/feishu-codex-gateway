$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Gateway = Join-Path $Root "feishu_codex_gateway"
$GatewayIndex = [System.IO.Path]::GetFullPath((Join-Path $Gateway "src\index.js"))
$GatewayIndexPattern = [regex]::Escape($GatewayIndex)
$RelativeGatewayIndexPattern = '(^|\s|")src[\\/]index\.js(\s|"|$)'
$StatePath = Join-Path $Root ".feishu_codex_gateway\state.json"
$LogPath = Join-Path $Root ".feishu_codex_gateway\gateway.log"
$StartupTaskName = "FeishuCodexGateway"

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
$GatewayProcesses = @($AllProcesses |
  Where-Object { Test-GatewayProcess $_ })

function Get-ChildProcesses([int]$ParentId, $ProcessList) {
  $children = @($ProcessList | Where-Object { $_.ParentProcessId -eq $ParentId })
  foreach ($child in $children) {
    $child
    Get-ChildProcesses -ParentId $child.ProcessId -ProcessList $ProcessList
  }
}

$Processes = @()
foreach ($Process in $GatewayProcesses) {
  $Processes += $Process
  $Processes += Get-ChildProcesses -ParentId $Process.ProcessId -ProcessList $AllProcesses
}

$Processes = $Processes | Sort-Object ProcessId -Unique | Select-Object ProcessId,ParentProcessId,Name,CommandLine
$ExpectedStartupScript = [System.IO.Path]::GetFullPath((Join-Path $Root "scripts\start_feishu_codex_gateway.ps1"))

if ($Processes) {
  $Processes
} else {
  Write-Output "Feishu-Codex gateway is not running."
}

$StartupTask = Get-ScheduledTask -TaskName $StartupTaskName -ErrorAction SilentlyContinue
if ($StartupTask) {
  $TaskMatchesWorkspace = @($StartupTask.Actions | Where-Object {
    $_.Arguments -like "*$ExpectedStartupScript*"
  }).Count -gt 0
  Write-Output "`nStartup task:"
  if ($TaskMatchesWorkspace) {
    Write-Output "$($StartupTask.TaskName): $($StartupTask.State)"
  } else {
    Write-Output "$($StartupTask.TaskName): installed for another workspace"
  }
} else {
  Write-Output "`nStartup task is not installed: $StartupTaskName"
}

if (Test-Path $StatePath) {
  Write-Output "`nState: $StatePath"
  Get-Content $StatePath -Encoding UTF8 -TotalCount 80
}

if (Test-Path $LogPath) {
  Write-Output "`nRecent log:"
  Get-Content $LogPath -Encoding UTF8 -Tail 40
}
