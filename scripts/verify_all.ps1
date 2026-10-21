# Run the whole verification suite and collect one summary.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify_all.ps1
#
# Steps: pytest -> end-to-end (server + MCP + UI) -> ttyd (if the binary exists).
# Artifacts: artifacts/e2e/report.json, artifacts/e2e/ui/*.png, artifacts/ttyd/report.json
param(
    [string]$Python = ".venv\Scripts\python.exe",
    [switch]$SkipUi,
    [switch]$SkipTtyd
)

$ErrorActionPreference = "Continue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
$results = @()

Write-Host "== 1/3 pytest ==" -ForegroundColor Cyan
& $Python -m pytest -q
$results += [pscustomobject]@{ step = "pytest"; exit = $LASTEXITCODE }

if (-not $SkipUi) {
    Write-Host "== 2/3 end-to-end + UI ==" -ForegroundColor Cyan
    & $Python -X utf8 scripts\verify_e2e.py
    $results += [pscustomobject]@{ step = "e2e+ui"; exit = $LASTEXITCODE }
}

if (-not $SkipTtyd -and (Test-Path "tools\ttyd\ttyd.exe")) {
    Write-Host "== 3/3 ttyd ==" -ForegroundColor Cyan
    & $Python -X utf8 scripts\ttyd_check.py
    $results += [pscustomobject]@{ step = "ttyd"; exit = $LASTEXITCODE }
}
elseif (-not $SkipTtyd) {
    Write-Host "ttyd.exe not present; skipping (see docs/ttyd.md)" -ForegroundColor Yellow
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = ($results | Where-Object { $_.exit -ne 0 }).Count
if ($failed -gt 0) {
    Write-Host "$failed step(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "all verification steps passed" -ForegroundColor Green
