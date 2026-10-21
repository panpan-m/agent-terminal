# Build the Windows executables with PyInstaller.
#
#   pwsh -File packaging/pyinstaller/build.ps1
#
# Produces:
#   dist/tio-server/tio-server.exe      (onedir, serves the SPA from its bundle)
#   dist/tio-mcp.exe                    (onefile stdio shim)
#   dist/tio-web-bridge.exe             (onefile ttyd bridge)
param(
    [string]$Python = ".venv\Scripts\python.exe",
    [string]$Venv = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

if ($Venv -ne "") { $Python = Join-Path $Venv "Scripts\python.exe" }
if (-not (Test-Path $Python)) { throw "python not found: $Python" }

Write-Host "== requiring a built frontend =="
if (-not (Test-Path "src\tio_server\web\static\index.html")) {
    throw "frontend not built; run: npm --prefix frontend ci; npm --prefix frontend run build"
}

$common = @(
    "--noconfirm", "--clean",
    "--paths", "src",
    "--collect-submodules", "mcp.server",
    "--collect-submodules", "mcp.shared",
    "--hidden-import", "mcp.types",
    "--hidden-import", "mcp.server.mcpserver",
    "--hidden-import", "mcp.server.transport_security",
    "--collect-all", "uvicorn",
    "--collect-all", "fastapi",
    "--collect-all", "starlette",
    "--collect-all", "pydantic",
    "--collect-all", "websockets",
    "--hidden-import", "serial.tools.list_ports",
    "--hidden-import", "serial.tools.list_ports_windows",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--hidden-import", "uvicorn.protocols.websockets.auto",
    "--hidden-import", "uvicorn.lifespan.on"
)

Write-Host "== tio-server (onedir) =="
& $Python -m PyInstaller @common --onedir --name tio-server `
    --add-data "src\tio_server\web\static;tio_server\web\static" `
    --collect-submodules "tio_server" `
    scripts\entry_server.py
if ($LASTEXITCODE -ne 0) { throw "server build failed" }

Write-Host "== tio-mcp (onefile) =="
& $Python -m PyInstaller @common --onefile --name tio-mcp `
    --paths "src" --collect-submodules "tio_server" --collect-submodules "tio_mcp_shim" `
    scripts\entry_shim.py
if ($LASTEXITCODE -ne 0) { throw "shim build failed" }

Write-Host "== tio-web-bridge (onefile) =="
& $Python -m PyInstaller @common --onefile --name tio-web-bridge `
    --paths "src" --collect-submodules "tio_web_bridge" `
    scripts\entry_bridge.py
if ($LASTEXITCODE -ne 0) { throw "bridge build failed" }

Write-Host "== smoke test =="
& "dist\tio-server\tio-server.exe" doctor | Out-Host
& "dist\tio-mcp.exe" --help | Out-Host
& "dist\tio-web-bridge.exe" --help | Out-Host

Write-Host "Built: dist\tio-server\tio-server.exe, dist\tio-mcp.exe, dist\tio-web-bridge.exe"
