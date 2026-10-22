from tio_server.ssh.secrets import SshSecretStore


def test_secrets_are_encrypted_and_clearable(tmp_path):
    store = SshSecretStore(tmp_path)
    store.save("pi", {"password": "s3cret", "jump_password": "jump-pass"})
    assert store.fields("pi") == ["jump_password", "password"]
    assert store.get("pi")["password"] == "s3cret"

    raw = (tmp_path / "ssh-secrets.json").read_text(encoding="utf-8")
    assert "s3cret" not in raw
    assert "jump-pass" not in raw
    assert (tmp_path / "ssh-secrets.key").exists()

    reloaded = SshSecretStore(tmp_path)
    assert reloaded.get("pi")["jump_password"] == "jump-pass"

    assert store.clear("pi") is True
    assert store.get("pi") == {}
    assert reloaded.get("pi") == {}
