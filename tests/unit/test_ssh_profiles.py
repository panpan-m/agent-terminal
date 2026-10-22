import json

import pytest

from tio_server.errors import ToolFailure
from tio_server.ssh import SshProfileStore


def test_create_list_update_delete(tmp_path):
    store = SshProfileStore(tmp_path)
    created = store.create(
        {
            "name": "Raspberry Pi",
            "host": "192.168.124.23",
            "username": "root",
            "auth": "key",
            "key_file": "C:/keys/id_ed25519",
            "known_hosts": "C:/keys/known_hosts",
        }
    )
    assert created["id"] == "raspberry-pi"
    assert created["port"] == 22
    assert "password" not in created
    assert "passphrase" not in created

    path = tmp_path / "ssh_hosts.json"
    assert path.exists()
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == 1
    assert payload["hosts"][0]["host"] == "192.168.124.23"

    listed = store.list()
    assert [host["id"] for host in listed] == ["raspberry-pi"]

    updated = store.update("raspberry-pi", {"name": "Pi 5", "port": 2222})
    assert updated["name"] == "Pi 5"
    assert updated["port"] == 2222
    assert updated["created_at"] == created["created_at"]
    assert updated["updated_at"] >= created["updated_at"]

    reloaded = SshProfileStore(tmp_path)
    assert reloaded.get("raspberry-pi").port == 2222

    store.delete("raspberry-pi")
    assert store.list() == []
    with pytest.raises(ToolFailure) as exc:
        store.get("raspberry-pi")
    assert exc.value.code == "NOT_FOUND"


def test_create_validates_host_and_auth(tmp_path):
    store = SshProfileStore(tmp_path)
    with pytest.raises(ToolFailure) as exc:
        store.create({"name": "bad", "host": "http://example", "username": "root"})
    assert exc.value.code == "INVALID_ARGUMENT"

    with pytest.raises(ToolFailure) as exc:
        store.create({"name": "bad", "host": "example", "username": "root", "auth": "key"})
    assert exc.value.code == "INVALID_ARGUMENT"

    with pytest.raises(ToolFailure) as exc:
        store.create({"name": "bad", "host": "example", "username": "root", "port": 0})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_duplicate_id_is_conflict(tmp_path):
    store = SshProfileStore(tmp_path)
    body = {"id": "pi", "name": "Pi", "host": "pi.local", "username": "root"}
    store.create(body)
    with pytest.raises(ToolFailure) as exc:
        store.create(body)
    assert exc.value.code == "CONFLICT"
