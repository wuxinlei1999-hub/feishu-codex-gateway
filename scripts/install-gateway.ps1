param(
  [string]$WorkspaceRoot,
  [switch]$Force,
  [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

if (-not $WorkspaceRoot -or -not $WorkspaceRoot.Trim()) {
  $WorkspaceRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Codex\feishu-codex-gateway-workspace"
}

$SkillRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TemplateRoot = Join-Path $SkillRoot "assets\gateway-template"
$GatewayTemplate = Join-Path $TemplateRoot "feishu_codex_gateway"
$ScriptsTemplate = Join-Path $TemplateRoot "scripts"

if (-not (Test-Path -LiteralPath (Join-Path $GatewayTemplate "src\index.js"))) {
  throw "Gateway template is missing: $GatewayTemplate"
}

New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path

$TargetGateway = Join-Path $WorkspaceRoot "feishu_codex_gateway"
$TargetScripts = Join-Path $WorkspaceRoot "scripts"

if ((Test-Path -LiteralPath $TargetGateway) -and -not $Force) {
  throw "Gateway already exists at $TargetGateway. Re-run with -Force to overwrite."
}

if (Test-Path -LiteralPath $TargetGateway) {
  Remove-Item -LiteralPath $TargetGateway -Recurse -Force
}
if (Test-Path -LiteralPath $TargetScripts) {
  Remove-Item -LiteralPath $TargetScripts -Recurse -Force
}

Copy-Item -LiteralPath $GatewayTemplate -Destination $WorkspaceRoot -Recurse -Force
Copy-Item -LiteralPath $ScriptsTemplate -Destination $WorkspaceRoot -Recurse -Force

if ($InstallDependencies) {
  Push-Location $TargetGateway
  try {
    npm install
  } finally {
    Pop-Location
  }
}

Write-Output "Installed Feishu-Codex gateway workspace:"
Write-Output $WorkspaceRoot
Write-Output ""
Write-Output "Next:"
Write-Output "1. Configure lark-cli and Feishu app permissions."
Write-Output "2. Start gateway:"
Write-Output "   powershell -ExecutionPolicy Bypass -File `"$TargetScripts\start_feishu_codex_gateway.ps1`""
