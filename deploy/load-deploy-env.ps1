# 从 deploy/deploy.local.env 加载进程环境变量（不提交 Git）
# 用法（在仓库根目录）：  . ./deploy/load-deploy-env.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$envFile = Join-Path $here "deploy.local.env"
if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Host "未发现 $envFile 。请先执行: copy deploy\deploy.local.env.example deploy\deploy.local.env 并填入本机密钥路径等。"
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
Write-Host "已加载 $envFile"
