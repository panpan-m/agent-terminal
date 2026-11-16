"""The gateway must be the only owner of its data directory.

POSIX gives kernel-level tty exclusivity, Windows does not; this lock makes "one
gateway per data directory" explicit on both, so a second start refuses instead
of silently duplicating ownership of the port and the transcript files.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from tio_server.platform.single_instance import SingleInstanceLock

ROOT = Path(__file__).resolve().parents[2]


def test_second_acquire_in_the_same_process_fails(tmp_path):
    path = tmp_path / "agent-terminal.lock"
    first = SingleInstanceLock(path)
    second = SingleInstanceLock(path)
    assert first.acquire() is True
    try:
        assert second.acquire() is False
    finally:
        first.release()
    # Released: a later instance may take it.
    third = SingleInstanceLock(path)
    assert third.acquire() is True
    third.release()


def test_release_is_idempotent_and_reports_state(tmp_path):
    lock = SingleInstanceLock(tmp_path / "x.lock")
    assert lock.held is False
    lock.release()  # no-op, must not raise
    assert lock.acquire() is True
    assert lock.held is True
    lock.release()
    lock.release()
    assert lock.held is False


def test_holder_pid_is_written(tmp_path):
    import os

    lock = SingleInstanceLock(tmp_path / "y.lock")
    assert lock.acquire() is True
    try:
        assert lock.holder() == str(os.getpid())
    finally:
        lock.release()


def test_context_manager_refuses_a_held_directory(tmp_path):
    path = tmp_path / "z.lock"
    import pytest

    with SingleInstanceLock(path):
        with pytest.raises(RuntimeError):
            with SingleInstanceLock(path):
                pass


def test_lock_works_across_processes(tmp_path):
    """A real second process must be refused, not just a second handle."""
    path = tmp_path / "cross.lock"
    holder = SingleInstanceLock(path)
    assert holder.acquire() is True
    try:
        probe = (
            "import sys; sys.path.insert(0, r'%s');"
            "from tio_server.platform.single_instance import SingleInstanceLock;"
            "lock = SingleInstanceLock(r'%s');"
            "print('ACQUIRED' if lock.acquire() else 'REFUSED')"
            % (str(ROOT / "src"), str(path))
        )
        result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=60)
        assert "REFUSED" in result.stdout, (result.stdout, result.stderr)
    finally:
        holder.release()
