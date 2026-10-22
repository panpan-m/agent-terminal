from tio_server.ssh.importers import parse_ssh_config


def test_parse_ssh_config(tmp_path):
    config = tmp_path / "config"
    config.write_text(
        "\n".join(
            [
                "Host pi",
                "  HostName 192.168.124.23",
                "  User root",
                "  Port 2222",
                "  IdentityFile ~/.ssh/id_ed25519",
                "",
                "Host db",
                "  HostName db.internal",
                "",
                "Host *",
                "  User ignored",
            ]
        ),
        encoding="utf-8",
    )
    hosts = parse_ssh_config(config)
    assert [host["id"] for host in hosts] == ["pi", "db"]
    assert hosts[0]["host"] == "192.168.124.23"
    assert hosts[0]["port"] == 2222
    assert hosts[0]["username"] == "root"
    assert hosts[0]["auth"] == "key"
    assert hosts[1]["port"] == 22
    assert hosts[1]["auth"] == "password"


def test_missing_config_is_empty(tmp_path):
    assert parse_ssh_config(tmp_path / "missing") == []
