"""Frozen entry point for the ``agent-mcp`` stdio shim."""

from tio_mcp_shim.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
