# 还原 install-local.ps1 对 desktop profile 做的一切改动。
# 用于测试完不想留着本地插件的情况。

$ErrorActionPreference = 'Stop'

$profileDir = "C:\Users\Administrator\.dsh\profiles\desktop"
$target     = Join-Path $profileDir "node_modules\dsh-notify"
$patchFile  = Join-Path $profileDir "cordis.patch.yml"
$backup     = Join-Path $profileDir "cordis.patch.yml.bak-dshnotify"

if (Test-Path $target) {
  # 只删 junction 本身（-Recurse 关掉），绝不碰它指向的源码目录
  [System.IO.Directory]::Delete($target, $false)
  Write-Host "removed junction $target"
} else {
  Write-Host "no junction at $target"
}

if (Test-Path $backup) {
  Copy-Item $backup $patchFile -Force
  Remove-Item $backup
  Write-Host "restored cordis.patch.yml from backup and removed the backup"
} else {
  Write-Host "no backup found; cordis.patch.yml left as-is (check it by hand)"
}

Write-Host ""
Write-Host "--- cordis.patch.yml 现在 ---"
Get-Content $patchFile
