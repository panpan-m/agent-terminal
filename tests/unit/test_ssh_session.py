import socket
import threading
import time
from queue import Queue

import pytest

from tio_server.config import Config
from tio_server.ssh.manager import SshManager
from tio_server.ssh.profiles import SshHost, SshProfileStore
from tio_server.ssh.session import SshSession
from tio_server.transcript import AuditLog, TranscriptRegistry


class FakeKey:
    def asbytes(self):
        return b"test-host-key"

    def get_name(self):
        return "ssh-ed25519"


class FakeTransport:
    remote_version = "SSH-2.0-test"
    local_cipher = "aes128-ctr"
    local_mac = "hmac-sha2-256"

    def get_remote_server_key(self):
        return FakeKey()


class FakeChannel:
    def __init__(self):
        self.incoming: Queue[bytes] = Queue()
        self.sent: list[bytes] = []
        self.sizes: list[tuple[int, int]] = []
        self.closed = False

    def settimeout(self, timeout):
        pass

    def recv(self, size):
        try:
            return self.incoming.get(timeout=0.05)
        except Exception:
            raise socket.timeout()

    def sendall(self, data):
        self.sent.append(bytes(data))

    def resize_pty(self, width, height):
        self.sizes.append((width, height))

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self):
        self.channel = FakeChannel()
        self.transport = FakeTransport()
        self.closed = False
        self.connect_kwargs = None

    def load_system_host_keys(self):
        pass

    def load_host_keys(self, path):
        pass

    def set_missing_host_key_policy(self, policy):
        pass

    def connect(self, **kwargs):
        self.connect_kwargs = kwargs

    def get_transport(self):
        return self.transport

    def invoke_shell(self, **kwargs):
        self.channel.sizes.append((kwargs["width"], kwargs["height"]))
        return self.channel

    def exec_command(self, command, timeout=None):
        raise AssertionError("not used")

    def close(self):
        self.closed = True


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
            "auth": "key",
            "key_file": str(tmp_path / "id"),
        }
    )
    transcripts = TranscriptRegistry(cfg)
    audit = AuditLog(cfg.log_dir / "audit")
    manager = SshManager(cfg, profiles, transcripts=transcripts, audit=audit)
    yield manager, profiles, transcripts, audit
    manager.stop()
    transcripts.close()


def test_session_connect_read_write_resize_and_close(ssh_bundle):
    manager, profiles, _transcripts, _audit = ssh_bundle
    host = profiles.get("test")
    client = FakeClient()
    session = SshSession(host, manager, "ssh-test", client_factory=lambda: client)
    session.connect(password=None, cols=100, rows=30)

    assert session.state.value == "open"
    assert session.status()["cipher"] == "aes128-ctr"
    assert session.status()["host_key_fingerprint"].startswith("SHA256:")
    assert client.channel.sizes[0] == (100, 30)
    assert client.connect_kwargs["key_filename"].endswith("id")

    sub = session.subscribe()
    client.channel.incoming.put(b"root@test:~# ")
    deadline = time.time() + 2
    while time.time() < deadline:
        event = sub.get(0.1)
        if event and event.get("type") == "rx":
            break
    assert event["type"] == "rx"
    assert session.read().data == b"root@test:~# "

    assert session.write_bytes(b"uname\n") == 6
    assert client.channel.sent == [b"uname\n"]
    session.resize(120, 40)
    assert client.channel.sizes[-1] == (120, 40)

    session.close()
    assert client.closed
    assert session.state.value == "closed"


def test_manager_refuses_unknown_host(ssh_bundle):
    manager, _profiles, _transcripts, _audit = ssh_bundle
    with pytest.raises(Exception) as exc:
        manager.connect("missing")
    assert getattr(exc.value, "code", None) == "NOT_FOUND"


def test_agent_auth_uses_the_ssh_agent(ssh_bundle):
    manager, profiles, _transcripts, _audit = ssh_bundle
    profiles.create(
        {
            "id": "agent-host",
            "name": "Agent host",
            "host": "127.0.0.1",
            "username": "root",
            "auth": "agent",
        }
    )
    client = FakeClient()
    session = SshSession(profiles.get("agent-host"), manager, "ssh-agent", client_factory=lambda: client)
    session.connect(cols=80, rows=24)
    assert client.connect_kwargs["allow_agent"] is True
    assert "key_filename" not in client.connect_kwargs
    session.close()
