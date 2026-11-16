"""The rate limit must cover every door to the wire, not just the MCP tools.

`security.rate_limit_per_second` lives on the session manager, but it used to be
checked only inside the MCP tool handlers, so the same writes through the admin
API (and the console WebSocket) were unlimited.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tio_server.config import SessionConfig, init_config
from tio_server.web.app import create_app


def _client(tmp_path, rate: int = 2):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.security.rate_limit_per_second = rate
    cfg.sessions = [
        # shared control so the operator path is allowed at all
        SessionConfig(id="board", port="sim://board-a", auto_open=True, control="shared")
    ]
    app = create_app(cfg)
    return app, secrets


def test_admin_write_path_is_rate_limited(tmp_path):
    app, _ = _client(tmp_path, rate=2)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        codes = []
        for _ in range(5):
            response = client.post("/api/sessions/board/write", json={"text": "x"})
            codes.append(response.status_code)
        assert 429 in codes, codes
        limited = [c for c in codes if c == 429]
        assert len(limited) >= 2, codes
        # The window is one second, so the exact split depends on timing, but the
        # first two must have succeeded and the limiter must appear.
        assert codes[0] == 200, codes
    app.state.manager.stop()


def test_admin_command_path_is_rate_limited(tmp_path):
    app, _ = _client(tmp_path, rate=2)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        codes = []
        for _ in range(5):
            response = client.post(
                "/api/sessions/board/command",
                json={"command": "ping", "timeout_ms": 100},
            )
            codes.append(response.status_code)
        assert 429 in codes, codes
    app.state.manager.stop()


def test_rate_limited_error_carries_the_stable_code(tmp_path):
    app, _ = _client(tmp_path, rate=1)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.post("/api/sessions/board/write", json={"text": "x"}).status_code == 200
        blocked = client.post("/api/sessions/board/write", json={"text": "x"})
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "RATE_LIMITED"
    app.state.manager.stop()
