# Register the `dshnotify:` URI scheme so a clicked toast can reach this plugin.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-activation.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-activation.ps1 -Port 5178 -Scheme dshnotify
#
# Writes to HKCU only (no elevation), and only below
# HKCU\Software\Classes\<scheme>. Undo with uninstall-activation.ps1.
#
# The scheme name and port are also written to assets\activation.json, which is
# what assets\activate.ps1 reads — so the handler and the receiver cannot drift
# apart without the file being edited by hand.

param(
  [string]$Scheme = 'dshnotify',
  [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'

if ($Scheme -notmatch '^[a-z][a-z0-9+.-]{1,30}$') {
  throw "invalid scheme '$Scheme': lowercase letters, digits, '+', '.', '-' only"
}
if ($Port -lt 1024 -or $Port -gt 65535) {
  throw "invalid port '$Port': 1024..65535"
}

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'assets\activate.vbs'
if (-not (Test-Path -LiteralPath $vbs)) {
  throw "activation handler missing: $vbs"
}

$key = "HKCU:\Software\Classes\$Scheme"
New-Item -Path $key -Force | Out-Null
# These three values are what makes Windows treat the key as a URL protocol
# handler: a title, the protocol marker, and the command line that receives the
# clicked URI as %1. Without the marker, ShellExecute refuses the scheme.
New-ItemProperty -Path $key -Name '(Default)' -Value "URL:dsh-notify activation" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

$commandKey = Join-Path $key 'shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
$command = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + $vbs + '" "%1"'
New-ItemProperty -Path $commandKey -Name '(Default)' -Value $command -PropertyType String -Force | Out-Null

# Build the window raiser next to the handler. A toast click has to bring DSH
# forward within a few milliseconds; PowerShell cannot (it needs ~2 s to start),
# so the same Win32 calls are compiled once, here, into a tiny executable.
$focusSource = Join-Path $PSScriptRoot 'focus-window.cs'
$focusExe = Join-Path $root 'assets\focus.exe'
if (Test-Path -LiteralPath $focusSource) {
  try {
    Add-Type -Path $focusSource -OutputAssembly $focusExe -OutputType WindowsApplication
    Write-Output "focus helper: $focusExe"
  } catch {
    Write-Warning "could not build the focus helper (the handler falls back to PowerShell): $($_.Exception.Message)"
  }
}

# The handler's own settings: read by assets\activate.ps1.
$settingsPath = Join-Path $root 'assets\activation.json'
@{ scheme = $Scheme; port = $Port } | ConvertTo-Json -Compress | Set-Content -LiteralPath $settingsPath -Encoding UTF8

Write-Output "registered $Scheme`: -> $vbs"
Write-Output "handler settings: $settingsPath (scheme=$Scheme port=$Port)"
Write-Output "enable the receiver in the plugin config: activate: true, activationPort: $Port, activationScheme: $Scheme"
