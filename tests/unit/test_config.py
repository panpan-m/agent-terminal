import os
import stat
import sys
from pathlib import Path

import pytest

from tio_server.config import (
    Config,
    SessionConfig,
    default_config,
    init_config,
)
from tio_server.errors import ToolFailure


def test_init_creates_config_and_secrets(tmp_path):
    cfg, secrets = init_config(tmp_path)
    assert Path(secrets["config"]).exists()
    assert cfg.auth.admin_password_hash.startswith("$argon2")
    assert cfg.auth.session_secret
    assert (tmp_path / "api-token").exists()
    assert (tmp_path / "bridge-token").exists()
    assert secrets["api_token"] == (tmp_path / "api-token").read_text(encoding="utf-8").strip()
    if sys.platform != "win32":
        mode = stat.S_IMODE(os.stat(tmp_path / "api-token").st_mode)
        assert mode == 0o600


def test_load_roundtrip(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.security.allow_dev_ports = True
    cfg.sessions.append(
        SessionConfig(id="board-a", name="A", port="sim://board-a", baudrate=921600)
    )
    cfg.save()
    loaded = Config.load(cfg.path)
    assert loaded.sessions[0].port == "sim://board-a"
    assert loaded.sessions[0].baudrate == 921600
    assert loaded.server.bind == "127.0.0.1"


def test_duplicate_and_bad_ids(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.sessions = [SessionConfig(id="a", port="sim://a"), SessionConfig(id="a", port="sim://b")]
    cfg.security.allow_dev_ports = True
    with pytest.raises(ToolFailure) as exc:
        cfg.validate()
    assert exc.value.code == "CONFIG_INVALID"
    assert "duplicate" in exc.value.message


def test_port_allowlist(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.security.allow_dev_ports = False
    cfg.sessions = [SessionConfig(id="a", port="sim://a")]
    with pytest.raises(ToolFailure):
        cfg.validate()
    cfg.security.allowed_ports = ["/dev/ttyUSB*", "COM[0-9]*"]
    cfg.sessions = [SessionConfig(id="a", port="COM12")]
    cfg.validate()  # pattern matches COM12
    cfg.sessions = [SessionConfig(id="b", port="/dev/null")]
    with pytest.raises(ToolFailure):
        cfg.validate()


def test_baud_rate_allowlist(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.security.allow_dev_ports = True
    cfg.sessions = [SessionConfig(id="a", port="sim://a", baudrate=123456)]
    with pytest.raises(ToolFailure):
        cfg.validate()
    cfg.security.allowed_baudrates = []
    cfg.validate()
    cfg.sessions[0].baudrate = 9_000_000
    with pytest.raises(ToolFailure):
        cfg.validate()


def test_buffer_and_permission_bounds(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.security.allow_dev_ports = True
    cfg.sessions = [SessionConfig(id="a", port="sim://a", buffer_bytes=1024)]
    with pytest.raises(ToolFailure):
        cfg.validate()
    cfg.sessions[0].buffer_bytes = 8 * 1024 * 1024
    cfg.sessions[0].agent_permissions = ["read", "root"]
    with pytest.raises(ToolFailure):
        cfg.validate()


def test_remote_bind_requires_opt_in(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.server.bind = "0.0.0.0"
    with pytest.raises(ToolFailure) as exc:
        cfg.validate()
    assert "loopback" in exc.value.message
    cfg.security.allow_remote_bind = True
    cfg.validate()


def test_missing_secrets_rejected(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.auth.api_token_hash = ""
    with pytest.raises(ToolFailure):
        cfg.validate()


def test_atomic_save_leaves_no_temp(tmp_path):
    cfg, _ = init_config(tmp_path)
    cfg.save()
    assert not list(tmp_path.glob("*.tmp"))
    assert cfg.path.exists()


def test_defaults_are_loopback_safe():
    cfg = default_config()
    assert cfg.server.bind == "127.0.0.1"
    assert cfg.security.allow_remote_bind is False
    assert cfg.security.allow_dev_ports is False
