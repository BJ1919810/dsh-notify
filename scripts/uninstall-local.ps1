# 还原 install-local.ps1 对 desktop profile 做的一切改动。
#
# 两件事都要做：删掉 node_modules 里的 junction，并把包名从
# `dsh.profile.bundles` 里移除。只删一个是不够的——bundles 里留着一个解析
# 不到的包名，DSH 启动时同样会报错。

$ErrorActionPreference = 'Stop'

$profileDir = "C:\Users\Administrator\.dsh\profiles\desktop"
$target     = Join-Path $profileDir "node_modules\dsh-notify"
$manifest   = Join-Path $profileDir "package.json"
$backup     = Join-Path $profileDir "package.json.bak-dshnotify"
$name       = "dsh-notify"

if (Test-Path $target) {
  # 只删 junction 本身（-Recurse 关掉），绝不碰它指向的源码目录
  [System.IO.Directory]::Delete($target, $false)
  Write-Host "removed junction $target"
} else {
  Write-Host "no junction at $target"
}

if (Test-Path $backup) {
  Copy-Item $backup $manifest -Force
  Remove-Item $backup
  Write-Host "restored package.json from backup and removed the backup"
} else {
  Write-Host "no backup; removing the bundle entry by hand instead"
  $pkg = Get-Content $manifest -Raw | ConvertFrom-Json
  $remaining = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne $name }
  if ($remaining.Count -eq @($pkg.dsh.profile.bundles).Count) {
    Write-Host "  '$name' was not in dsh.profile.bundles"
  } else {
    $pkg.dsh.profile.bundles = $remaining
    $pkg | ConvertTo-Json -Depth 12 | Set-Content $manifest -Encoding utf8
    Write-Host "  removed '$name' from dsh.profile.bundles"
  }
}

Write-Host ""
Write-Host "--- dsh.profile.bundles 现在 ---"
(Get-Content $manifest -Raw | ConvertFrom-Json).dsh.profile.bundles | ForEach-Object { "  - $_" }
Write-Host ""
Write-Host "注意：patch/bundle 层在启动时合成，还原同样要重启 DSH 才生效。"
