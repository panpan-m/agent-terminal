from tio_server.desktop import main


def test_desktop_smoke_starts_server(tmp_path, capsys):
    assert main(["--smoke", "--port", "0", "--data-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "http://127.0.0.1:" in out
    assert (tmp_path / "config.toml").exists()
    assert (tmp_path / "api-token").exists()
