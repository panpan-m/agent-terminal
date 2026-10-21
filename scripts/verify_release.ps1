# One-command release verification.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify_release.ps1
#
# 1. build the SPA            4. ttyd (real ConPTY)
# 2. pytest                   5. PyInstaller build
# 3. server + MCP + UI e2e    6. packaged-binary e2e
param(
    [string]$Python = ".venv\Scripts\python.exe",
    [switch]$SkipBuild,
    [switch]$SkipTtyd
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
$failed = @()

function Step([string]$name, [scriptblock]$action) {
    Write-Host ""
    Write-Host "== $name ==" -ForegroundColor Cyan
    & $action
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $name (exit $LASTEXITCODE)" -ForegroundColor Red
        $script:failed += $name
    }
}

if (-not $SkipBuild) {
    Step "frontend build" { npm --prefix frontend run build }
}

Step "pytest" { & $Python -m pytest -q }
Step "end-to-end + browser UI" { & $Python -X utf8 scripts\verify_e2e.py }

if (-not $SkipTtyd -and (Test-Path "tools\ttyd\ttyd.exe")) {
    Step "ttyd (ConPTY)" { & $Python -X utf8 scripts\ttyd_check.py }
}

Step "pyinstaller" { powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\pyinstaller\build.ps1 }
Step "packaged binaries" { & $Python -X utf8 scripts\verify_packaged.py }

Write-Host ""
if ($failed.Count -gt 0) {
    Write-Host ("FAILED steps: " + ($failed -join ", ")) -ForegroundColor Red
    exit 1
}
Write-Host "release verification passed" -ForegroundColor Green
Write-Host "reports: artifacts\e2e\report.json, artifacts\ttyd\report.json, artifacts\packaged\report.json"
