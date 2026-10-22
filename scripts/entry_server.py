"""Frozen entry point for the ``agent-terminal`` executable."""

import multiprocessing
import sys

from tio_server.cli import main

if __name__ == "__main__":
    # Console code pages are not UTF-8 on Windows; never crash on output.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    multiprocessing.freeze_support()
    raise SystemExit(main())
