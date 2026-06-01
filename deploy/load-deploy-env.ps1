# 从 deploy/deploy.local.env 加载进程环境变量（不提交 Git）
# 并按 FMZ_DEPLOY_TARGET 解析 deploy/servers.json 中的主机与密钥路径
# 用法（在仓库根目录）：  . ./deploy/load-deploy-env.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$repoRoot = Split-Path -Parent $here
$envFile = Join-Path $here "deploy.local.env"
if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Host "未发现 $envFile 。请先执行: copy deploy\deploy.local.env.example deploy\deploy.local.env 并填入本机部署目标。"
  return
}
Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }
  $eq = $line.IndexOf("=")
  if ($eq -lt 1) { return }
  $key = $line.Substring(0, $eq).Trim()
  $val = $line.Substring($eq + 1).Trim()
  if (
    ($val.Length -ge 2) -and (
      ($val.StartsWith('"') -and $val.EndsWith('"')) -or
      ($val.StartsWith("'") -and $val.EndsWith("'"))
    )
  ) {
    $val = $val.Substring(1, $val.Length - 2)
  }
  Set-Item -Path "Env:$key" -Value $val
}
$resolveScript = Join-Path $repoRoot "scripts\fmz-deploy-env.mjs"
$printed = & node $resolveScript --print-env 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Error ($printed -join "`n")
}
foreach ($line in $printed) {
  if ($line -notmatch "^([^=]+)=(.*)$") { continue }
  Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
}
Write-Host "已加载 $envFile （目标: $env:FMZ_DEPLOY_TARGET → $env:FMZ_DEPLOY_SSH_HOST）"
