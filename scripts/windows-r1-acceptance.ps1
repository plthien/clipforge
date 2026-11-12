# R1 Windows local acceptance. No GitHub Actions or paid AI calls are required.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-r1-acceptance.ps1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportDir = Join-Path (Get-Location) "r1-local-results-$stamp"
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$results = New-Object System.Collections.Generic.List[object]

function Invoke-Gate([string]$Name, [string]$Command) {
  $log = Join-Path $reportDir ($Name + ".log")
  Write-Host ("R1 GATE START: " + $Name)
  $started = Get-Date
  $code = 0
  try {
    $lines = & cmd.exe /d /s /c "$Command" 2>&1
    $lines | Out-File -FilePath $log -Encoding utf8
    if ($LASTEXITCODE -ne 0) { $code = $LASTEXITCODE }
  } catch {
    $_ | Out-File -FilePath $log -Encoding utf8 -Append
    $code = 1
  }
  $results.Add([pscustomobject]@{ gate = $Name; exit_code = $code; duration_s = [int]((Get-Date) - $started).TotalSeconds; log = $log })
  if ($code -eq 0) { Write-Host ("R1 GATE PASS: " + $Name) } else { Write-Warning ("R1 GATE FAIL: " + $Name + " (see " + $log + ")") }
}

Invoke-Gate "versions" "node --version && pnpm --version"
Invoke-Gate "install" "pnpm install --frozen-lockfile"
Invoke-Gate "lint" "pnpm lint"
Invoke-Gate "test" "pnpm test"
Invoke-Gate "build" "pnpm build"
Invoke-Gate "bundle" "pnpm bundle:standalone"
$smokeProfile = Join-Path $reportDir "temp-electron-profile"
New-Item -ItemType Directory -Path $smokeProfile -Force | Out-Null
Invoke-Gate "electron-write" ('pnpm exec electron scripts/smoke-desktop.cjs "' + $smokeProfile + '" write')
Invoke-Gate "electron-read" ('pnpm exec electron scripts/smoke-desktop.cjs "' + $smokeProfile + '" read')
$results | ConvertTo-Json -Depth 4 | Out-File -FilePath (Join-Path $reportDir "results.json") -Encoding utf8
Write-Host ("R1 REPORT: " + $reportDir)
if (@($results | Where-Object { $_.exit_code -ne 0 }).Count -gt 0) { exit 1 }
