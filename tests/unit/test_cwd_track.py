import time

import pytest

from tio_server.config import Config
from tio_server.ssh.cwd_track import CwdTracker
from tio_server.ssh.manager import SshManager
from tio_server.ssh.profiles import SshProfileStore
from tio_server.ssh.session import SshSession
from tio_server.transcript import AuditLog, TranscriptRegistry

from test_ssh_session import FakeClient


BEL = b"\x07"
ST = b"\x1b\\"


def test_title_bash_default():
    tracker = CwdTracker("chou.pan")
    assert tracker.feed(b"\x1b]0;chou.pan@vm:/var/log\x07") is True
    assert tracker.cwd == "/var/log"
    assert tracker.feed(b"\x1b]0;chou.pan@vm:~\x07") is True
    assert tracker.cwd == "/home/chou.pan"
    assert tracker.feed(b"\x1b]2;chou.pan@vm:~/src/app\x07") is True
    assert tracker.cwd == "/home/chou.pan/src/app"
    # same directory again: no change
    assert tracker.feed(b"\x1b]0;chou.pan@vm:~/src/app\x07") is False


def test_sequence_split_across_chunks():
    tracker = CwdTracker("root")
    assert tracker.feed(b"output...\x1b]0;root@hos") is False
    assert tracker.feed(b"t:/etc\x07more text") is True
    assert tracker.cwd == "/etc"


def test_lone_esc_carried_to_next_chunk():
    tracker = CwdTracker("root")
    assert tracker.feed(b"noise\x1b") is False
    assert tracker.feed(b"]0;root@h:/srv\x07") is True
    assert tracker.cwd == "/srv"


def test_osc7_bel_and_st_and_percent_encoding():
    tracker = CwdTracker("root")
    assert tracker.feed(b"\x1b]7;file://vm/tmp/my%20dir\x07") is True
    assert tracker.cwd == "/tmp/my dir"
    assert tracker.feed(b"\x1b]7;file://vm/var/lib\x1b\\") is True
    assert tracker.cwd == "/var/lib"


def test_nested_identity_reports_ignored():
    tracker = CwdTracker("root")
    tracker.feed(b"\x1b]0;root@vm:/tmp\x07")
    # nested ssh to another host (or different user): keep this host's cwd
    assert tracker.feed(b"\x1b]0;other@far:/data\x07") is False
    assert tracker.cwd == "/tmp"
    assert tracker.feed(b"\x1b]0;root@far:/data\x07") is False
    assert tracker.cwd == "/tmp"
    # same for OSC 7 from a different host
    tracker.feed(b"\x1b]7;file://vm/tmp\x07")
    assert tracker.feed(b"\x1b]7;file://far/data\x07") is False
    assert tracker.cwd == "/tmp"


def test_other_osc_payloads_ignored():
    tracker = CwdTracker("root")
    # OSC 52 clipboard base64 payload must not be mistaken for a cwd
    assert tracker.feed(b"\x1b]52;c;aGVsbG8=\x07") is False
    # title without the user@host:path shape
    assert tracker.feed(b"\x1b]0;my window title\x07") is False
    assert tracker.cwd is None


def test_noise_never_crashes_and_capped():
    tracker = CwdTracker("root")
    assert tracker.feed(b"\x1b]" + b"A" * 20000) is False  # unterminated sequence
    assert tracker.feed(bytes(range(256)) * 100) is False
    assert tracker.feed(b"\x1b]0;root@vm:/ok\x07") is True
    assert tracker.cwd == "/ok"


@pytest.fixture()
def ssh_bundle(tmp_path):
    cfg = Config()
    cfg.server.data_dir = str(tmp_path / "data")
    cfg.server.log_dir = str(tmp_path / "logs")
    cfg.transcript.directory = str(tmp_path / "data" / "transcripts")
    cfg.security.max_sessions = 4
    profiles = SshProfileStore(tmp_path / "data")
    (tmp_path / "id").write_text("fake-key", encoding="ascii")
    profiles.create(
        {
            "id": "test",
            "name": "Test host",
            "host": "127.0.0.1",
            "username": "root",
            "description": "",
            "auth": "key",
            "key_file": str(tmp_path / "id"),
        }
    )
    transcripts = TranscriptRegistry(cfg)
    audit = AuditLog(cfg.log_dir / "audit")
    manager = SshManager(cfg, profiles, transcripts=transcripts, audit=audit)
    yield manager, profiles
    manager.stop()
    transcripts.close()


def test_session_status_exposes_terminal_cwd(ssh_bundle):
    manager, profiles = ssh_bundle
    client = FakeClient()
    session = SshSession(profiles.get("test"), manager, "ssh-test", client_factory=lambda: client)
    session.connect(password=None)
    assert session.status()["terminal_cwd"] is None

    sub = session.subscribe()
    client.channel.incoming.put(b"\x1b]0;root@test:/var/log\x07root@test:/var/log# ")
    # skip the initial subscription status; wait for the cwd-change broadcast
    deadline = time.time() + 2
    broadcast = None
    while time.time() < deadline:
        event = sub.get(0.1)
        if event and event.get("type") == "status" and event["status"].get("terminal_cwd"):
            broadcast = event["status"]["terminal_cwd"]
            break
    assert broadcast == "/var/log", "cwd change should broadcast a status event"
    assert session.status()["terminal_cwd"] == "/var/log"

    session.close()
