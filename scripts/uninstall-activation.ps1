# Remove the `dshnotify:` URI scheme registered by install-activation.ps1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-activation.ps1
#
# Deletes HKCU\Software\Classes\<scheme> and the handler settings file. The
# plugin keeps working without it — the toast simply stops being clickable,
# which is exactly the pre-activation behaviour.

param([string]$Scheme = 'dshnotify')

$ErrorActionPreference = 'Stop'

if ($Scheme -notmatch '^[a-z][a-z0-9+.-]{1,30}$') {
  throw "invalid scheme '$Scheme'"
}

$key = "HKCU:\Software\Classes\$Scheme"
if (Test-Path -LiteralPath $key) {
  Remove-Item -LiteralPath $key -Recurse -Force
  Write-Output "removed $key"
} else {
  Write-Output "nothing registered at $key"
}

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root 'assets\activation.json'
if (Test-Path -LiteralPath $settingsPath) {
  Remove-Item -LiteralPath $settingsPath -Force
  Write-Output "removed $settingsPath"
}
