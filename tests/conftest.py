import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from tio_server.config import Config, SessionConfig  # noqa: E402
from tio_server.sessions import SessionManager  # noqa: E402


@pytest.fixture()
def make_config(tmp_path):
    def _make(sessions: list[SessionConfig] | None = None, **security):
        cfg = Config()
        cfg.server.data_dir = str(tmp_path / "data")
        cfg.server.log_dir = str(tmp_path / "logs")
        cfg.server.bind = "127.0.0.1"
        cfg.server.port = 8765
        cfg.transcript.directory = str(tmp_path / "data" / "transcripts")
        cfg.security.allow_dev_ports = True
        for key, value in security.items():
            setattr(cfg.security, key, value)
        cfg.sessions = sessions or [
            SessionConfig(id="board-a", name="Board A", port="sim://board-a", auto_open=False)
        ]
        return cfg

    return _make


@pytest.fixture()
def manager(make_config):
    mgr = SessionManager(make_config(), backend=None)
    yield mgr
    mgr.stop()
