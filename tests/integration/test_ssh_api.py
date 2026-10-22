from fastapi.testclient import TestClient

from tio_server.config import init_config
from tio_server.web.app import create_app


def make_app(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    app = create_app(cfg)
    return app, cfg, secrets


def login(client: TestClient, secrets: dict) -> str:
    response = client.post("/api/auth/login", json={"username": "admin", "password": secrets["admin_password"]})
    assert response.status_code == 200, response.text
    return response.json()["csrf"]


def test_ssh_host_crud_and_auth_gate(tmp_path):
    app, _, secrets = make_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.get("/api/ssh/hosts").status_code == 401
        csrf = login(client, secrets)

        body = {
            "name": "Raspberry Pi",
            "host": "192.168.124.23",
            "username": "root",
            "auth": "password",
            "known_hosts": str(tmp_path / "known_hosts"),
        }
        created = client.post("/api/ssh/hosts", json=body, headers={"X-CSRF-Token": csrf})
        assert created.status_code == 201, created.text
        host = created.json()
        assert host["id"] == "raspberry-pi"
        assert "password" not in host

        listed = client.get("/api/ssh/hosts").json()["hosts"]
        assert [item["id"] for item in listed] == ["raspberry-pi"]

        updated = client.put(
            "/api/ssh/hosts/raspberry-pi",
            json={**body, "name": "Pi 5", "port": 2222},
            headers={"X-CSRF-Token": csrf},
        )
        assert updated.status_code == 200
        assert updated.json()["name"] == "Pi 5"
        assert updated.json()["port"] == 2222

        missing_csrf = client.post("/api/ssh/hosts", json=body)
        assert missing_csrf.status_code == 403

        deleted = client.delete("/api/ssh/hosts/raspberry-pi", headers={"X-CSRF-Token": csrf})
        assert deleted.status_code == 200
        assert client.get("/api/ssh/hosts").json()["hosts"] == []


def test_ssh_test_endpoint_is_structured(tmp_path):
    app, _, secrets = make_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        csrf = login(client, secrets)
        created = client.post(
            "/api/ssh/hosts",
            json={
                "id": "closed",
                "name": "Closed port",
                "host": "127.0.0.1",
                "port": 1,
                "username": "root",
                "auth": "password",
                "connect_timeout_s": 1,
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert created.status_code == 201, created.text
        response = client.post("/api/ssh/hosts/closed/test", headers={"X-CSRF-Token": csrf})
        assert response.status_code == 502, response.text
        assert response.json()["error"]["code"] == "SSH_UNREACHABLE"


def test_ssh_connect_failure_is_structured(tmp_path):
    app, _, secrets = make_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        csrf = login(client, secrets)
        created = client.post(
            "/api/ssh/hosts",
            json={
                "id": "closed",
                "name": "Closed port",
                "host": "127.0.0.1",
                "port": 1,
                "username": "root",
                "auth": "password",
                "connect_timeout_s": 1,
            },
            headers={"X-CSRF-Token": csrf},
        )
        assert created.status_code == 201, created.text
        response = client.post(
            "/api/ssh/hosts/closed/connect",
            json={"password": "x", "cols": 80, "rows": 24},
            headers={"X-CSRF-Token": csrf},
        )
        assert response.status_code == 502, response.text
        error = response.json()["error"]
        assert error["code"] == "SSH_UNREACHABLE"
        assert response.status_code != 200
