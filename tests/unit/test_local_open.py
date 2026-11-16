import time
from pathlib import Path

import pytest

from tio_server.errors import ToolFailure
from tio_server.ssh import local_open as local_open_module
from tio_server.ssh.local_open import LocalOpenManager, _safe_name


class FakeAudit:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def write(self, event: str, **fields) -> None:
        self.events.append((event, fields))


class FakeSession:
    session_id = "ssh-host-abc123"

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.fetched: list[str] = []
        self.puts: list[tuple[str, bytes]] = []
        self.put_error: Exception | None = None

    @staticmethod
    def _remote_path(path: str) -> str:
        return path

    def sftp_stat(self, path: str) -> dict:
        if path not in self.files:
            raise ToolFailure("NOT_FOUND", "no such file")
        return {"size": len(self.files[path]), "is_dir": False}

    def sftp_fetch(self, path: str, local_path: str) -> int:
        self.fetched.append(path)
        Path(local_path).write_bytes(self.files[path])
        return len(self.files[path])

    def sftp_put(self, local_path: str, path: str) -> int:
        if self.put_error is not None:
            raise self.put_error
        data = Path(local_path).read_bytes()
        self.puts.append((path, data))
        self.files[path] = data
        return len(data)


@pytest.fixture()
def fast_watch(monkeypatch, tmp_path):
    monkeypatch.setattr(local_open_module, "POLL_SECONDS", 0.05)
    monkeypatch.setattr(local_open_module, "SETTLE_SECONDS", 0.1)
    launched: list[str] = []
    monkeypatch.setattr(LocalOpenManager, "_launch", staticmethod(lambda path: launched.append(str(path))))
    return launched


def make_manager(tmp_path) -> tuple[LocalOpenManager, FakeAudit]:
    audit = FakeAudit()
    return LocalOpenManager(audit=audit, root=tmp_path / "open"), audit


def test_open_downloads_and_launches(tmp_path, fast_watch):
    session = FakeSession({"/tmp/notes.txt": b"hello"})
    manager, audit = make_manager(tmp_path)
    try:
        result = manager.open_remote(session, "/tmp/notes.txt")
        assert result["reused"] is False
        assert result["bytes"] == 5
        assert result["local"].endswith("notes.txt")
        assert Path(result["local"]).read_bytes() == b"hello"
        assert fast_watch == [result["local"]]
        assert audit.events[0][0] == "ssh.sftp_open_local"
    finally:
        manager.stop()


def test_open_rejects_directories_and_oversized(tmp_path, fast_watch):
    manager, _ = make_manager(tmp_path)
    try:
        big = FakeSession({"/big.bin": b"x" * (local_open_module.MAX_OPEN_BYTES + 1)})

        class DirSession(FakeSession):
            def sftp_stat(self, path):
                return {"size": 0, "is_dir": True}

        with pytest.raises(ToolFailure):
            manager.open_remote(DirSession({}), "/work")
        with pytest.raises(ToolFailure):
            manager.open_remote(big, "/big.bin")
        assert fast_watch == []
    finally:
        manager.stop()


def test_reopen_reuses_local_copy(tmp_path, fast_watch):
    session = FakeSession({"/tmp/a.log": b"v1"})
    manager, _ = make_manager(tmp_path)
    try:
        first = manager.open_remote(session, "/tmp/a.log")
        Path(first["local"]).write_bytes(b"v1 + local edits")  # unsaved local change
        second = manager.open_remote(session, "/tmp/a.log")
        assert second["reused"] is True
        assert second["local"] == first["local"]
        assert session.fetched == ["/tmp/a.log"]  # no re-download: edits survive
    finally:
        manager.stop()


def test_save_settles_and_uploads_back(tmp_path, fast_watch):
    session = FakeSession({"/tmp/report.txt": b"original"})
    manager, audit = make_manager(tmp_path)
    try:
        result = manager.open_remote(session, "/tmp/report.txt")
        Path(result["local"]).write_bytes(b"edited content, longer than before")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not session.puts:
            time.sleep(0.02)
        assert session.puts == [("/tmp/report.txt", b"edited content, longer than before")]
        assert session.files["/tmp/report.txt"] == b"edited content, longer than before"
        saves = [event for event in audit.events if event[0] == "ssh.sftp_local_save"]
        assert saves and saves[0][1]["bytes"] == len(b"edited content, longer than before")
    finally:
        manager.stop()


def test_repeated_upload_failures_drop_tracking(tmp_path, fast_watch, monkeypatch):
    monkeypatch.setattr(local_open_module, "MAX_UPLOAD_FAILURES", 2)
    session = FakeSession({"/tmp/x.conf": b"cfg"})
    manager, audit = make_manager(tmp_path)
    try:
        result = manager.open_remote(session, "/tmp/x.conf")
        session.put_error = ToolFailure("DISCONNECTED", "gone")
        Path(result["local"]).write_bytes(b"cfg changed")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(e[0] == "ssh.sftp_local_save_dropped" for e in audit.events):
            time.sleep(0.02)
        drops = [event for event in audit.events if event[0] == "ssh.sftp_local_save_dropped"]
        assert drops and "upload failed" in drops[0][1]["reason"]
        assert Path(result["local"]).exists()  # local copy kept for manual recovery
    finally:
        manager.stop()


def test_local_file_removal_drops_tracking(tmp_path, fast_watch):
    session = FakeSession({"/tmp/gone.txt": b"bye"})
    manager, audit = make_manager(tmp_path)
    try:
        result = manager.open_remote(session, "/tmp/gone.txt")
        Path(result["local"]).unlink()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(e[0] == "ssh.sftp_local_save_dropped" for e in audit.events):
            time.sleep(0.02)
        drops = [event for event in audit.events if event[0] == "ssh.sftp_local_save_dropped"]
        assert drops and drops[0][1]["reason"] == "local file removed"
    finally:
        manager.stop()


def test_safe_name():
    assert _safe_name("report.pdf") == "report.pdf"
    assert _safe_name('we<ird>:na|me?"x"\x01.txt') == "we_ird__na_me__x__.txt"
    assert _safe_name("trailing.  ") == "trailing"
    assert _safe_name("   ") == "file"
    long_name = "a" * 200 + ".tar.gz"
    trimmed = _safe_name(long_name)
    assert len(trimmed) == 120
    assert trimmed.endswith(".gz")  # the OS association only needs the final suffix
