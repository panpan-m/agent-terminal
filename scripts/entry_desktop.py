"""PyInstaller entry point for the desktop window."""

from tio_server.desktop import main

if __name__ == "__main__":
    raise SystemExit(main())
