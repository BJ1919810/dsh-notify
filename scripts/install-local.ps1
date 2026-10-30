# ⛔ 已废弃：用 set-bundle-state.mjs（或 set-bundle-state.cmd）代替。
#
# 这个脚本用 PowerShell 的 ConvertTo-Json 写 profile 的 package.json。它在
# Windows PowerShell 5.1 上正常，但在 PowerShell 7 上会产出带尾随逗号的 JSON，
# 而那不是合法 JSON——DSH 启动时直接拒绝并报 `Unexpected token ', {'`。这个
# 缺陷已经在真实环境里造成过一次启动失败，所以下面加了硬性拦截：在 PowerShell 7
# 上直接拒绝运行。保留这个文件只是为了留下记录，正确做法是：
#
#   node scripts/set-bundle-state.mjs --name dsh-notify --action enable
#
# 把本地 dsh-notify 装进 desktop profile，用于真实环境验证。
#
# 机制（这一步我第一次做错了，值得写清楚）：
#   profile 的 cordis.patch.yml 是「按 id 覆盖已有条目」的层。往里面写
#   `- id: 某个还不存在的插件` 只会得到一个指向不存在目标的 patch 行，DSH
#   启动时会报 "cannot get property \"config\" without inject"。
#   要让一个新插件进入加载器树，必须把它加进 profile 的
#   `dsh.profile.bundles`，由加载器读取该包自己的 `dsh.bundle.patch`（insert
#   行）来插入条目。参考实现：dsh-custom-instructions、dsh-context 都只出现在
#   bundles 里，不出现在 patch 里。
#
# 所以这里做两件事：node_modules 里建 junction（让包可解析），并把包名加进
# `dsh.profile.bundles`。

$ErrorActionPreference = 'Stop'

# 硬性拦截：PowerShell 7 下这个脚本会写出非法 JSON
if ($PSVersionTable.PSVersion.Major -ge 7) {
  Write-Host "❌ 本脚本在 PowerShell $($PSVersionTable.PSVersion) 下会写出非法 JSON（尾随逗号），" -ForegroundColor Red
  Write-Host "   DSH 会因此无法启动。请改用：" -ForegroundColor Red
  Write-Host "   node scripts/set-bundle-state.mjs --name dsh-notify --action enable" -ForegroundColor Yellow
  exit 1
}

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pluginDir  = Split-Path -Parent $PSScriptRoot
$target     = Join-Path $profileDir "node_modules\dsh-notify"
$manifest   = Join-Path $profileDir "package.json"
$backup     = Join-Path $profileDir "package.json.bak-dshnotify"
$name       = "dsh-notify"

# 只备份一次：不要用当前（可能已被改动的）状态覆盖真正的原始状态
if (-not (Test-Path $backup)) {
  Copy-Item $manifest $backup
  Write-Host "backed up package.json -> package.json.bak-dshnotify"
} else {
  Write-Host "backup already exists, keeping it"
}

# 1. 让包可解析
if (Test-Path $target) {
  [System.IO.Directory]::Delete($target, $false)   # 只删 junction，不动源码
  Write-Host "removed previous junction"
}
New-Item -ItemType Junction -Path $target -Target $pluginDir | Out-Null
Write-Host "linked $target -> $pluginDir"

# 2. 把它作为 bundle 加入 profile
$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
if ($null -eq $pkg.dsh.profile.bundles) {
  throw "profile package.json has no dsh.profile.bundles array - refusing to guess"
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -contains $name) {
  Write-Host "already in dsh.profile.bundles, leaving it alone"
} else {
  $pkg.dsh.profile.bundles = $bundles + $name
  $pkg | ConvertTo-Json -Depth 12 | Set-Content $manifest -Encoding utf8
  Write-Host "added '$name' to dsh.profile.bundles"
}

Write-Host ""
Write-Host "--- dsh.profile.bundles 现在 ---"
(Get-Content $manifest -Raw | ConvertFrom-Json).dsh.profile.bundles | ForEach-Object { "  - $_" }
Write-Host ""
Write-Host "--- 解析检查 ---"
Test-Path (Join-Path $target "package.json")
Test-Path (Join-Path $target "lib\index.js")
Write-Host ""
Write-Host "注意：patch/bundle 层在启动时合成，必须重启 DSH 才会加载。"
