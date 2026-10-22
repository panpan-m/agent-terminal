# Build the Windows desktop window (WebView2) with PyInstaller.
#
#   pwsh -File packaging/pyinstaller/build_desktop.ps1
#
# Produces dist/agent-desktop/agent-desktop.exe.  The installer is built separately
# with packaging/windows/agent-desktop.iss.
param(
    [string]$Python = ".venv\Scripts\python.exe",
    [string]$Venv = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

if ($Venv -ne "") { $Python = Join-Path $Venv "Scripts\python.exe" }
if (-not (Test-Path $Python)) { throw "python not found: $Python" }
if (-not (Test-Path "src\tio_server\web\static\index.html")) {
    throw "frontend not built; run: npm --prefix frontend ci; npm --prefix frontend run build"
}

Write-Host "== agent-desktop (onedir, windowed) =="
& $Python -m PyInstaller --noconfirm --clean --windowed --onedir --name agent-desktop `
    --icon "packaging\windows\agent-terminal.ico" `
    --paths src `
    --collect-all webview `
    --collect-all pythonnet `
    --collect-all clr_loader `
    --add-data "src\tio_server\web\static;tio_server\web\static" `
    --collect-submodules tio_server `
    scripts\entry_desktop.py
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }

Write-Host "== smoke test =="
$smokeDir = Join-Path $env:TEMP ("agent-desktop-smoke-" + [guid]::NewGuid().ToString("N"))
$proc = Start-Process -FilePath "dist\agent-desktop\agent-desktop.exe" `
    -ArgumentList @("--smoke", "--port", "0", "--data-dir", $smokeDir) -PassThru -Wait
if ($proc.ExitCode -ne 0) { throw "desktop smoke test failed (exit $($proc.ExitCode))" }
Remove-Item $smokeDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Built: dist\agent-desktop\agent-desktop.exe"
