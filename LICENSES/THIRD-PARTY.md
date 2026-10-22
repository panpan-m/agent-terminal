# Third-party components

`tio-suite` is distributed under **GPL-2.0-or-later** (see `../LICENSE`).

## Bundled in release artifacts

| Component | Version | License | How it is shipped | Obligations |
|---|---|---|---|---|
| `tio` (tio/tio) | upstream, unmodified | GPL-2.0-or-later | optional CLI, not required by the server | if redistributed, provide source |
| Python runtime + dependencies | see `pyproject.toml` / lock | PSF, MIT, BSD, Apache-2.0 | PyInstaller bundle | preserve license texts of bundled wheels |

## Python dependencies

| Package | License |
|---|---|
| FastAPI, Starlette, Uvicorn | BSD-3-Clause |
| pydantic | MIT |
| pyserial | BSD-3-Clause |
| argon2-cffi | MIT |
| httpx | BSD-3-Clause |
| MCP Python SDK | MIT |
| regex | Apache-2.0 |
| tomli-w | MIT |
| paramiko | LGPL-2.1 |

## Notes for distributors

1. The MCP SDK and other wheels embedded by PyInstaller keep their own license
   files inside the bundle; do not strip them.
2. This file is informational, not legal advice. Run a compliance review before
   shipping a commercial build.
