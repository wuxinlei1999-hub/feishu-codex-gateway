param(
  [switch]$UseProxy,
  [string]$ProxyHost = "127.0.0.1",
  [int]$ProxyPort = 39766
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Gateway = Join-Path $Root "feishu_codex_gateway"
$GatewayIndex = [System.IO.Path]::GetFullPath((Join-Path $Gateway "src\index.js"))
$GatewayIndexPattern = [regex]::Escape($GatewayIndex)
$RelativeGatewayIndexPattern = '(^|\s|")src[\\/]index\.js(\s|"|$)'
$LogDir = Join-Path $Root ".feishu_codex_gateway"
$LogPath = Join-Path $LogDir "gateway.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-GatewayProcess($Process) {
  return $Process.Name -match "^node(\.exe)?$" -and
    $Process.CommandLine -and
    $Process.CommandLine -match "--listen" -and
    (
      $Process.CommandLine -match $GatewayIndexPattern -or
      $Process.CommandLine -match $RelativeGatewayIndexPattern
    )
}

function Get-ChildProcesses([int]$ParentId, $ProcessList) {
  $children = @($ProcessList | Where-Object { $_.ParentProcessId -eq $ParentId })
  foreach ($child in $children) {
    $child
    Get-ChildProcesses -ParentId $child.ProcessId -ProcessList $ProcessList
  }
}

$AllProcesses = Get-CimInstance Win32_Process

$Existing = $AllProcesses |
  Where-Object { Test-GatewayProcess $_ }

if ($Existing) {
  if (-not $UseProxy) {
    $Existing | Select-Object ProcessId,Name,CommandLine
    Write-Output "Feishu-Codex gateway is already running."
    exit 0
  }

  foreach ($Process in $Existing) {
    $ProcessesToStop = @($Process) + @(Get-ChildProcesses -ParentId $Process.ProcessId -ProcessList $AllProcesses)
    foreach ($ProcessToStop in $ProcessesToStop) {
      Stop-Process -Id $ProcessToStop.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Output "Stopped existing Feishu-Codex gateway PID=$($ProcessToStop.ProcessId) before switching to proxy mode."
    }
  }
}

if (-not (Test-Path (Join-Path $Gateway "node_modules"))) {
  Push-Location $Gateway
  npm install
  Pop-Location
}

$OldUseProxy = $env:FEISHU_CODEX_USE_PROXY
$OldProxyHost = $env:FEISHU_CODEX_PROXY_HOST
$OldProxyPort = $env:FEISHU_CODEX_PROXY_PORT
try {
  if ($UseProxy) {
    $env:FEISHU_CODEX_USE_PROXY = "1"
    $env:FEISHU_CODEX_PROXY_HOST = $ProxyHost
    $env:FEISHU_CODEX_PROXY_PORT = [string]$ProxyPort
  }

  $Process = Start-Process `
    -WindowStyle Hidden `
    -FilePath node `
    -ArgumentList @((Join-Path $Gateway "src/index.js"), "--listen") `
    -WorkingDirectory $Gateway `
    -PassThru
}
finally {
  $env:FEISHU_CODEX_USE_PROXY = $OldUseProxy
  $env:FEISHU_CODEX_PROXY_HOST = $OldProxyHost
  $env:FEISHU_CODEX_PROXY_PORT = $OldProxyPort
}

Write-Output "Started Feishu-Codex gateway PID=$($Process.Id)"
if ($UseProxy) {
  Write-Output "Gateway will use Codex app-server proxy at ${ProxyHost}:${ProxyPort}"
}
Write-Output "Log: $LogPath"
