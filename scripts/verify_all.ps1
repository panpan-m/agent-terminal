# Run the whole verification suite and collect one summary.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify_all.ps1
#
# Steps: pytest -> end-to-end (server + MCP + UI).
# Artifacts: artifacts/e2e/report.json, artifacts/e2e/ui/*.png
param(
    [string]$Python = ".venv\Scripts\python.exe",
    [switch]$SkipUi
)

$ErrorActionPreference = "Continue"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
$results = @()

Write-Host "== 1/2 pytest ==" -ForegroundColor Cyan
& $Python -m pytest -q
$results += [pscustomobject]@{ step = "pytest"; exit = $LASTEXITCODE }

if (-not $SkipUi) {
    Write-Host "== 2/2 end-to-end + UI ==" -ForegroundColor Cyan
    & $Python -X utf8 scripts\verify_e2e.py
    $results += [pscustomobject]@{ step = "e2e+ui"; exit = $LASTEXITCODE }
}

Write-Host ""
$results | Format-Table -AutoSize | Out-String | Write-Host
$failed = ($results | Where-Object { $_.exit -ne 0 }).Count
if ($failed -gt 0) {
    Write-Host "$failed step(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host "all verification steps passed" -ForegroundColor Green
