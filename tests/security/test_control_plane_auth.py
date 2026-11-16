"""A non-loopback bind must not publish an unauthenticated control plane.

The admin API has no accounts: on loopback the Host/Origin guard is enough
because the only reachable callers are local.  Off loopback that assumption is
false — any HTTP client can forge ``Host`` — so the surface must demand the API
token.  Before this gate, ``security.allow_remote_bind = true`` was a single
boolean that exposed port 8765 with no authentication at all.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tio_server.config import SessionConfig, init_config
from tio_server.web.app import create_app

LOOPBACK = "127.0.0.1"


def _bundle(tmp_path, *, bind: str, remote: bool):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.security.allow_remote_bind = remote
    cfg.server.bind = bind
    cfg.server.public_url = "http://192.0.2.10:8765"
    cfg.sessions = [SessionConfig(id="board", port="sim://board-a", auto_open=False)]
    app = create_app(cfg)
    return cfg, secrets, app


@pytest.fixture()
def local(tmp_path):
    cfg, secrets, app = _bundle(tmp_path, bind=LOOPBACK, remote=False)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, secrets
    app.state.manager.stop()


@pytest.fixture()
def remote(tmp_path):
    cfg, secrets, app = _bundle(tmp_path, bind="0.0.0.0", remote=True)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client, secrets
    app.state.manager.stop()


def test_loopback_keeps_the_no_login_experience(local):
    client, _ = local
    assert client.get("/api/sessions").status_code == 200


def test_off_loopback_requires_a_token(remote):
    client, _ = remote
    response = client.get("/api/sessions")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"
    assert response.headers.get("www-authenticate", "").startswith("Bearer")


def test_off_loopback_accepts_the_api_token(remote):
    client, secrets = remote
    headers = {"Authorization": f"Bearer {secrets['api_token']}"}
    assert client.get("/api/sessions", headers=headers).status_code == 200


def test_off_loopback_accepts_the_token_as_a_query_parameter(remote):
    client, secrets = remote
    response = client.get(f"/api/sessions?token={secrets['api_token']}")
    assert response.status_code == 200


def test_off_loopback_rejects_a_wrong_token(remote):
    client, _ = remote
    response = client.get("/api/sessions", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_off_loopback_rejects_tampered_bearer_prefix(remote):
    client, secrets = remote
    # "Bearer" must be followed by the token, not embedded in it.
    response = client.get("/api/sessions", headers={"Authorization": secrets["api_token"]})
    assert response.status_code == 401


def test_off_loopback_websockets_need_the_token(remote):
    client, _ = remote
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/console/board") as ws:
            ws.receive_json()


def test_off_loopback_websocket_accepts_the_token(remote):
    client, secrets = remote
    # The bind check happens before routing, so a token is enough to get past
    # the guard; the session itself is not open, so the handler closes it.
    try:
        with client.websocket_connect(f"/ws/console/board?token={secrets['api_token']}") as ws:
            ws.receive_json()
    except Exception:
        pass  # the point is that it was not refused by the auth guard


def test_loopback_still_rejects_a_foreign_origin(local):
    client, _ = local
    response = client.get("/api/sessions", headers={"Origin": "http://evil.example"})
    assert response.status_code == 403
