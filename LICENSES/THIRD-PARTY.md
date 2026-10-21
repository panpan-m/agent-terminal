# Third-party components

`tio-suite` is distributed under **GPL-2.0-or-later** (see `../LICENSE`).

## Bundled in release artifacts

| Component | Version | License | How it is shipped | Obligations |
|---|---|---|---|---|
| `ttyd` (tsl0922/ttyd) | 1.7.7 (pinned) | MIT — `MIT-ttyd.txt` | separate `.exe` in `bin/`, launched as a child process | keep copyright + license notice |
| `tio` (tio/tio) | upstream, unmodified | GPL-2.0-or-later | optional CLI, not required by the server | if redistributed, provide source |
| Python runtime + dependencies | see `pyproject.toml` / lock | PSF, MIT, BSD, Apache-2.0 | PyInstaller bundle | preserve license texts of bundled wheels |
| `libwebsockets` (ttyd dependency, static in the official Windows build) | as shipped by ttyd | LGPL-2.1 | inside `ttyd.exe` | provide source/relink route for the LGPL part; the ttyd project publishes both |
| OpenSSL, zlib, libuv, json-c | as shipped by ttyd | Apache-2.0 / zlib / MIT / MIT | inside `ttyd.exe` | notices |

## Python dependencies

| Package | License |
|---|---|
| FastAPI, Starlette, Uvicorn | BSD-3-Clause |
| pydantic | MIT |
| pyserial | BSD-3-Clause |
| argon2-cffi | MIT |
| itsdangerous | BSD-3-Clause |
| httpx | BSD-3-Clause |
| websockets | BSD-3-Clause |
| MCP Python SDK | MIT |
| regex | Apache-2.0 |
| tomli-w | MIT |
| Jinja2 (if present) | BSD-3-Clause |

## Notes for distributors

1. `ttyd` is MIT and is started as a **separate process**, not linked into the
   Python server. Keep `LICENSES/MIT-ttyd.txt` next to the binary.
2. The official `ttyd.win32.exe` build statically links libwebsockets (LGPL).
   If you redistribute that binary you must also make the corresponding source
   available (ttyd upstream publishes both) and keep the ability to relink.
   Using a distribution-provided dynamic ttyd on Linux avoids this.
3. The MCP SDK and other wheels embedded by PyInstaller keep their own license
   files inside the bundle; do not strip them.
4. This file is informational, not legal advice. Run a compliance review before
   shipping a commercial build.
