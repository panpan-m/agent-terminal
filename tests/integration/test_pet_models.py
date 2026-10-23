from fastapi.testclient import TestClient

from tio_server.config import init_config
from tio_server.web.app import create_app

VRM_BYTES = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 128


def make_app(tmp_path):
    cfg, secrets = init_config(tmp_path / "data")
    cfg.security.allow_dev_ports = True
    cfg.sessions = []
    app = create_app(cfg)
    return app, secrets


def test_pet_model_upload_list_download_delete(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        assert client.get("/api/pet/models").json() == {"models": []}

        created = client.post(
            "/api/pet/models",
            files={"file": ("my-avatar.vrm", VRM_BYTES, "application/octet-stream")},
        )
        assert created.status_code == 201, created.text
        entry = created.json()
        assert entry["name"] == "my-avatar.vrm"
        assert entry["size"] == len(VRM_BYTES)
        model_id = entry["id"]

        listed = client.get("/api/pet/models").json()["models"]
        assert [item["id"] for item in listed] == [model_id]

        downloaded = client.get(f"/api/pet/models/{model_id}/file")
        assert downloaded.status_code == 200
        assert downloaded.content == VRM_BYTES
        assert downloaded.headers["content-type"].startswith("model/gltf-binary")

        assert client.delete(f"/api/pet/models/{model_id}").status_code == 200
        assert client.get("/api/pet/models").json()["models"] == []
        assert client.get(f"/api/pet/models/{model_id}/file").status_code == 404
        assert client.delete(f"/api/pet/models/{model_id}").status_code == 404


def test_pet_model_upload_rejects_invalid_files(tmp_path):
    app, _ = make_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        not_vrm = client.post(
            "/api/pet/models",
            files={"file": ("avatar.vrm", b"definitely-not-a-vrm" * 8, "application/octet-stream")},
        )
        assert not_vrm.status_code == 400

        wrong_ext = client.post(
            "/api/pet/models",
            files={"file": ("avatar.png", VRM_BYTES, "application/octet-stream")},
        )
        assert wrong_ext.status_code == 400

        assert client.get("/api/pet/models").json()["models"] == []
