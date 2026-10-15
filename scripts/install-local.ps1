# 把本地 dsh-notify 装进 desktop profile 做端到端验证。
# 先备份 cordis.patch.yml；验证完用 scripts/uninstall-local.ps1 还原。

$ErrorActionPreference = 'Stop'

$profileDir = "C:\Users\Administrator\.dsh\profiles\desktop"
$pluginDir  = "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-notify"
$target     = Join-Path $profileDir "node_modules\dsh-notify"
$patchFile  = Join-Path $profileDir "cordis.patch.yml"
$backup     = Join-Path $profileDir "cordis.patch.yml.bak-dshnotify"

if (-not (Test-Path $backup)) {
  Copy-Item $patchFile $backup
  Write-Host "backed up cordis.patch.yml -> cordis.patch.yml.bak-dshnotify"
} else {
  Write-Host "backup already exists, keeping it"
}

# junction（不需要管理员权限），指向工作区里的插件源码
if (Test-Path $target) {
  # 只删 junction 本身，不动目标目录
  [System.IO.Directory]::Delete($target, $false)
  Write-Host "removed previous junction"
}
New-Item -ItemType Junction -Path $target -Target $pluginDir | Out-Null
Write-Host "linked $target -> $pluginDir"

# 追加 profile patch 条目（已存在则跳过）
$patch = Get-Content $patchFile -Raw
if ($patch -match 'dsh-notify') {
  Write-Host "cordis.patch.yml already mentions dsh-notify, leaving it alone"
} else {
  $entry = @'

- id: dsh-notify
  name: dsh-notify
  config:
    notifyOn: every-turn
    includeSummary: true
    settleDelayMs: 400
'@
  Add-Content -Path $patchFile -Value $entry -NoNewline
  Write-Host "appended dsh-notify entry to cordis.patch.yml"
}

Write-Host ""
Write-Host "--- cordis.patch.yml tail ---"
Get-Content $patchFile -Tail 10
Write-Host ""
Write-Host "--- verify resolution ---"
Test-Path (Join-Path $target "package.json")
Test-Path (Join-Path $target "lib\index.js")
