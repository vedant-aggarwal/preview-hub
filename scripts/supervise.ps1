# Keeps the preview hub running. Started at logon by the PreviewHub scheduled task (via launch.vbs, no window).
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$hub = Join-Path $root 'src\hub.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
while ($true) {
  & $node $hub | Out-Null
  # exit code 3 = ports already taken (another hub instance is serving): back off longer
  if ($LASTEXITCODE -eq 3) { Start-Sleep -Seconds 30 } else { Start-Sleep -Seconds 3 }
}
