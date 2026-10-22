# Register and start the agent-terminal Windows service using sc.exe.
# Called by the Inno Setup installer, and usable by hand:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
param(
    [string]$InstallDir = $PSScriptRoot,
    [string]$DataDir = "$env:ProgramData\agent-terminal",
    [string]$ServiceName = "agent-terminal"
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $InstallDir "agent-terminal.exe"
$config = Join-Path $DataDir "config.toml"

if (-not (Test-Path $exe)) { throw "agent-terminal.exe not found at $exe" }
if (-not (Test-Path $config)) { throw "config not found at $config (run: agent-terminal init --dir `"$DataDir`")" }

# sc.exe wants the whole command line as one binPath argument.
$binPath = '"{0}" run --config "{1}"' -f $exe, $config

& sc.exe stop $ServiceName 2>$null | Out-Null
& sc.exe delete $ServiceName 2>$null | Out-Null
Start-Sleep -Milliseconds 500

& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "agent-terminal terminal gateway" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc create failed" }

& sc.exe description $ServiceName "Single-owner serial port gateway with MCP and web UI" | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
& sc.exe start $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "service failed to start; see $DataDir\logs\server.log" }

Write-Host "Service '$ServiceName' installed and started."
