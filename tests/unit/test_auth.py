from tio_server.auth import AuthManager, hash_secret, verify_secret


def make_auth(**overrides) -> AuthManager:
    options = dict(
        api_token_hash=hash_secret("token-abc"),
    )
    options.update(overrides)
    return AuthManager(**options)


def test_password_hash_and_verify():
    hashed = hash_secret("hunter2")
    assert hashed != "hunter2"
    assert verify_secret(hashed, "hunter2") is True
    assert verify_secret(hashed, "wrong") is False
    assert verify_secret("", "hunter2") is False


def test_api_token():
    auth = make_auth()
    assert auth.check_api_token("token-abc") is True
    assert auth.check_api_token("token-xyz") is False
    assert auth.check_api_token(None) is False


def test_origin_allowlist():
    auth = make_auth()
    auth.allowed_origins = {"http://127.0.0.1:8765"}
    assert auth.origin_allowed(None) is True
    assert auth.origin_allowed("http://127.0.0.1:8765") is True
    assert auth.origin_allowed("http://127.0.0.1:8765/") is True
    assert auth.origin_allowed("http://evil.example") is False
