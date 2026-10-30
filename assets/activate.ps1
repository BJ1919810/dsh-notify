# dsh-notify activation: bring DSH forward and tell the host which session was clicked.
#
# Started by activate.vbs when a toast with a `dshnotify:<sessionId>` launch URI
# is clicked. Two steps, in this order and for a reason:
#
#   1. Restore and raise the DSH window. The click's whole purpose is to end up
#      looking at DSH, and doing it first means that still happens if the host
#      is busy or the HTTP call below fails.
#   2. POST the session id to the plugin's loopback receiver. The browser half
#      polls it and switches the conversation.
#
# Settings live in activation.json next to this file (written by
# scripts/install-activation.ps1); the defaults below match the plugin defaults
# so a hand-installed copy still works.

param([Parameter(Position = 0)][string]$Uri = '')

$ErrorActionPreference = 'Stop'

$scheme = 'dshnotify'
$port = 5178
$settingsPath = Join-Path $PSScriptRoot 'activation.json'
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $json = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($json.scheme) { $scheme = [string]$json.scheme }
    if ($json.port) { $port = [int]$json.port }
  } catch {
    # A malformed settings file is not worth failing a click over.
  }
}

$sessionId = ''
$pattern = '^' + [regex]::Escape($scheme) + ':(?<id>[A-Za-z0-9][A-Za-z0-9._:-]{0,199})$'
if ($Uri -match $pattern) { $sessionId = $Matches['id'] }

# 1. Raise the window. The process name is the one the packaged desktop app
#    registers ("DeepSeek Harness"); the title match is the fallback for a build
#    that renamed the executable.
try {
  Add-Type -Namespace DshNotify -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
  $window = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName -eq 'DeepSeek Harness' } |
    Select-Object -First 1
  if ($null -eq $window) {
    $window = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like '*DeepSeek Harness*' } |
      Select-Object -First 1
  }
  if ($null -ne $window) {
    $handle = $window.MainWindowHandle
    if ([DshNotify.Win]::IsIconic($handle)) {
      [void][DshNotify.Win]::ShowWindow($handle, 9)   # SW_RESTORE
    } else {
      [void][DshNotify.Win]::ShowWindow($handle, 5)   # SW_SHOW
    }
    [void][DshNotify.Win]::SetForegroundWindow($handle)
  }
} catch {
  # Focus is best effort: the session handoff below is the part that matters.
}

if ([string]::IsNullOrEmpty($sessionId)) { exit 0 }

# 2. Hand the session id over. No output: this runs hidden, and a failure here
#    is reported by the receiver's absence, not by a message nobody sees.
try {
  $url = 'http://127.0.0.1:' + $port + '/activate?s=' + [uri]::EscapeDataString($sessionId)
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url | Out-Null
} catch {
}

exit 0
