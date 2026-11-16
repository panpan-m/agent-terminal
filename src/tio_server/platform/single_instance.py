"""Advisory single-instance lock for the gateway process.

POSIX enforces exclusive access to a tty (``flock`` + ``TIOCEXCL``), so two
gateways cannot both own ``/dev/ttyUSB0``.  Windows relies on the serial driver
refusing a second ``open``, which is a convention rather than a guarantee, and
neither platform stops a second instance from starting and then fighting over the
admin port and the transcripts.

One lock file in the data directory makes "one gateway per data directory"
explicit on both platforms.  It is advisory: a process that ignores it can still
run.  What it guarantees is that the normal startup path refuses instead of
silently duplicating ownership.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Where the locked byte lives.  It must not overlap the pid text: Windows denies
#: *reads* of a byte range another handle holds a lock on, so locking byte 0
#: would make the diagnostic pid unreadable.
_LOCK_OFFSET = 1023


class SingleInstanceLock:
    """Byte-range lock on ``<data-dir>/agent-terminal.lock``."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._fh = None

    @property
    def held(self) -> bool:
        return self._fh is not None

    def acquire(self) -> bool:
        """Take the lock, or return ``False`` if another process holds it."""
        if self._fh is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            handle.seek(_LOCK_OFFSET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        # The pid is diagnostic only; the lock itself is what excludes.  It is
        # written by overwriting in place (padded to the previous length) rather
        # than truncating: on Windows, truncating a byte range that this handle
        # holds a lock on fails with a lock violation.
        try:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            payload = f"{os.getpid()}\n".encode("ascii")
            if size > len(payload):
                payload = payload.ljust(size, b" ")
            handle.seek(0)
            handle.write(payload)
            handle.flush()
        except OSError:  # pragma: no cover - a read-only mount still holds the lock
            pass
        self._fh = handle
        return True

    def release(self) -> None:
        handle, self._fh = self._fh, None
        if handle is None:
            return
        try:
            handle.seek(_LOCK_OFFSET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:  # pragma: no cover - closing the handle releases anyway
            pass
        finally:
            handle.close()

    def holder(self) -> str | None:
        """Best-effort pid of the current holder (may be stale or absent)."""
        try:
            text = self.path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return text or None

    def __enter__(self) -> "SingleInstanceLock":
        if not self.acquire():
            raise RuntimeError(f"data directory is already owned: {self.path.parent}")
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()
