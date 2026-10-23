#!/usr/bin/env bash
# Build the Linux executables with PyInstaller (mirror of build.ps1).
#
#   packaging/pyinstaller/build.sh          # uses "python" from PATH
#   PYTHON=.venv/bin/python packaging/pyinstaller/build.sh
#
# Produces:
#   dist/agent-terminal/agent-terminal      (onedir, serves the SPA from its bundle)
#   dist/agent-mcp                          (onefile stdio shim)
#   dist/tio-suite-linux-<arch>.tar.gz      (bundle layout packaging/linux/install.sh expects)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
python="${PYTHON:-python}"

echo "== requiring a built frontend =="
if [ ! -f src/tio_server/web/static/index.html ]; then
    echo "frontend not built; run: npm --prefix frontend ci; npm --prefix frontend run build" >&2
    exit 1
fi

common=(
    --noconfirm --clean
    --paths src
    --collect-submodules mcp.server
    --collect-submodules mcp.shared
    --hidden-import mcp.types
    --hidden-import mcp.server.mcpserver
    --hidden-import mcp.server.transport_security
    --collect-all uvicorn
    --collect-all fastapi
    --collect-all starlette
    --collect-all pydantic
    --collect-all websockets
    --hidden-import serial.tools.list_ports
    --hidden-import serial.tools.list_ports_posix
    --hidden-import uvicorn.logging
    --hidden-import uvicorn.loops.auto
    --hidden-import uvicorn.protocols.http.auto
    --hidden-import uvicorn.protocols.websockets.auto
    --hidden-import uvicorn.lifespan.on
)

echo "== agent-terminal (onedir) =="
"$python" -m PyInstaller "${common[@]}" --onedir --name agent-terminal \
    --add-data "src/tio_server/web/static:tio_server/web/static" \
    --collect-submodules tio_server \
    scripts/entry_server.py

echo "== agent-mcp (onefile) =="
"$python" -m PyInstaller "${common[@]}" --onefile --name agent-mcp \
    --collect-submodules tio_server --collect-submodules tio_mcp_shim \
    scripts/entry_shim.py

echo "== smoke test =="
./dist/agent-terminal/agent-terminal doctor
./dist/agent-mcp --help

echo "== bundle for install.sh =="
arch="$(uname -m)"
stage="dist/tio-suite-linux-$arch"
rm -rf "$stage"
mkdir -p "$stage"
cp dist/agent-terminal/agent-terminal "$stage/agent-terminal"
cp -a dist/agent-terminal/_internal "$stage/_internal"
cp dist/agent-mcp "$stage/agent-mcp"
cp packaging/linux/install.sh packaging/linux/agent-terminal.service "$stage/"
rm -f "$stage.tar.gz"
tar -C dist -czf "$stage.tar.gz" "$(basename "$stage")"

echo "Built: $stage.tar.gz (agent-terminal, agent-mcp, _internal/, install.sh)"
