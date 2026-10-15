# 在 desktop profile 的 dsh.profile.bundles 里启用或停用某个 bundle。
#
# 为什么需要这个脚本、而不是手改 JSON：
#   运行中的 DSH 宿主会用内存里的组合状态回写 profile 的 package.json（实测：
#   写入后几秒到几十秒内被覆盖回原样）。它不会因此重载你的改动，只是把它抹掉。
#   所以运行期间做这类编辑是徒劳的——必须在 DSH 完全退出后改，再启动才生效。
#
#   另一个坑：这个文件不是「改了就热生效」的层。bundles 决定加载器在启动时
#   合成哪些包，改动只在启动时读取。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File set-bundle-state.ps1 -Name dsh-custom-instructions -Action enable
#   powershell -ExecutionPolicy Bypass -File set-bundle-state.ps1 -Name dsh-notify -Action disable

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][ValidateSet('enable', 'disable')][string]$Action,
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
)

$ErrorActionPreference = 'Stop'

# --- 1. DSH 必须已经退出，否则改动会被回写 ---------------------------------
$running = @()
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  if ($p.ProcessName -like 'DeepSeek Harness*') { $running += $p }
}
$hostProcess = Get-CimInstance Win32_Process -Filter "Name LIKE 'DeepSeek Harness%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' -or $_.CommandLine -like '*dsh\*' }
if ($running.Count -gt 0 -or $hostProcess) {
  Write-Host "❌ DSH 仍在运行（进程 $($running.Count) 个）。" -ForegroundColor Red
  Write-Host "   运行中的宿主会用内存状态回写 profile 配置，你的改动会被抹掉。"
  Write-Host "   请先完全退出 DeepSeek Harness（不是只关闭窗口），再运行本脚本。"
  exit 1
}
Write-Host "ok   DSH 未运行，可以安全修改"

# --- 2. 备份 + 验证 JSON ---------------------------------------------------
$manifest = Join-Path $ProfileDir "package.json"
if (-not (Test-Path $manifest)) { throw "not found: $manifest" }

$source = Get-Content $manifest -Raw
$pkg = $source | ConvertFrom-Json
if ($null -eq $pkg.dsh -or $null -eq $pkg.dsh.profile -or $null -eq $pkg.dsh.profile.bundles) {
  throw "profile package.json has no dsh.profile.bundles array - refusing to guess"
}

$backup = "$manifest.bak-$($Name -replace '[^A-Za-z0-9]', '_')"
Copy-Item $manifest $backup -Force
$before = @($pkg.dsh.profile.bundles)

# --- 3. 精确改一行文本，保住原有格式 ---------------------------------------
$lines = $source -split "`n"
$present = $before -contains $Name
$desired = $Action -eq 'enable'

if ($present -eq $desired) {
  Write-Host "ok   '$Name' 已经是 $(if ($desired) { '启用' } else { '停用' }) 状态，无需改动"
  Remove-Item $backup
  exit 0
}

$anchor = $before | Where-Object { $_ -ne $Name } | Select-Object -Last 1
if ($null -eq $anchor) { throw "cannot find an anchor row to edit against" }
$anchorIndex = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i].Trim() -eq "`"$anchor`"") { $anchorIndex = $i; break }
}
if ($anchorIndex -lt 0) { throw "anchor row `"$anchor`" not found in the file text" }

$indent = [regex]::Match($lines[$anchorIndex], '^\s*').Value
if ($desired) {
  if (-not $lines[$anchorIndex].TrimEnd().EndsWith(',')) { $lines[$anchorIndex] = $lines[$anchorIndex].TrimEnd() + ',' }
  $lines = @($lines[0..$anchorIndex]) + @("$indent`"$Name`"") + @($lines[($anchorIndex + 1)..($lines.Count - 1)])
  Write-Host "ok   在 `"$anchor`" 之后插入 `"$Name`""
} else {
  # 删掉目标行，并保证前一行仍以逗号结尾（如果是列表最后一项则改为无逗号）
  $targetIndex = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq "`"$Name`"") { $targetIndex = $i; break }
  }
  if ($targetIndex -lt 0) { throw "`"$Name`" is in the parsed list but not found in the file text" }
  $kept = @($lines[0..($targetIndex - 1)]) + @($lines[($targetIndex + 1)..($lines.Count - 1)])
  $prev = $targetIndex - 1
  if ($prev -ge 0) { $kept[$prev] = $kept[$prev].TrimEnd().TrimEnd(',') }
  $lines = $kept
  Write-Host "ok   移除 `"$Name`""
}

$updated = $lines -join "`n"
# 写之前先确认它仍然是合法 JSON——一个手写文本编辑把配置弄坏，比没改成更糟
try { $null = $updated | ConvertFrom-Json } catch { throw "edit would produce invalid JSON; aborting ($_)" }
Set-Content -Path $manifest -Value $updated -Encoding utf8 -NoNewline

$after = @((Get-Content $manifest -Raw | ConvertFrom-Json).dsh.profile.bundles)
if (($after -contains $Name) -ne $desired) { throw "write did not take effect as expected" }

Write-Host ""
Write-Host "--- dsh.profile.bundles 现在 ---"
$after | ForEach-Object { "  - $_" }
Write-Host ""
Write-Host "备份：$backup"
Write-Host "下一步：启动 DSH。bundles 只在启动时合成，改动没有热生效。"
