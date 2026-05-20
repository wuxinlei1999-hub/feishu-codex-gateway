param(
  [string]$WorkspaceRoot
)

$DefaultWorkspaceRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Codex\feishu-codex-gateway-workspace"

if (-not $WorkspaceRoot -or -not $WorkspaceRoot.Trim()) {
  $WorkspaceRoot = $env:FEISHU_CODEX_WORKSPACE_ROOT
}

if (-not $WorkspaceRoot -or -not $WorkspaceRoot.Trim()) {
  if (Test-Path -LiteralPath (Join-Path (Get-Location) "feishu_codex_gateway\src\index.js")) {
    $WorkspaceRoot = (Get-Location).Path
  } else {
    $WorkspaceRoot = $DefaultWorkspaceRoot
  }
}

$Resolved = Resolve-Path -LiteralPath $WorkspaceRoot -ErrorAction Stop
$IndexPath = Join-Path $Resolved "feishu_codex_gateway\src\index.js"
if (-not (Test-Path -LiteralPath $IndexPath)) {
  throw "Not a Feishu-Codex gateway workspace: $Resolved"
}

$Resolved.Path
