import time

from tio_server.auth import AuthManager, hash_secret, verify_secret


def make_auth(**overrides) -> AuthManager:
    options = dict(
        session_secret="x" * 40,
        admin_username="admin",
        admin_password_hash=hash_secret("secret"),
        api_token_hash=hash_secret("token-abc"),
        session_ttl_hours=1,
        bridge_token="bridge-123",
    )
    options.update(overrides)
    return AuthManager(**options)


def test_password_hash_and_verify():
    hashed = hash_secret("hunter2")
    assert hashed != "hunter2"
    assert verify_secret(hashed, "hunter2") is True
    assert verify_secret(hashed, "wrong") is False
    assert verify_secret("", "hunter2") is False


def test_login_and_cookie_roundtrip():
    auth = make_auth()
    assert auth.check_password("admin", "secret") is True
    assert auth.check_password("admin", "nope") is False
    assert auth.check_password("other", "secret") is False
    rec = auth.create_session("admin", "127.0.0.1")
    cookie = auth.sign_cookie(rec.sid)
    sid = auth.read_cookie(cookie)
    assert sid == rec.sid
    assert auth.get_session(sid).username == "admin"
    assert auth.read_cookie("garbage") is None


def test_session_expiry():
    auth = make_auth(session_ttl_hours=1)
    rec = auth.create_session("admin")
    rec.expires = time.time() - 1
    assert auth.get_session(rec.sid) is None


def test_csrf_token_unique_per_session():
    auth = make_auth()
    a = auth.create_session("admin")
    b = auth.create_session("admin")
    assert a.csrf != b.csrf
    assert a.sid != b.sid


def test_api_and_bridge_tokens():
    auth = make_auth()
    assert auth.check_api_token("token-abc") is True
    assert auth.check_api_token("token-xyz") is False
    assert auth.check_api_token(None) is False
    assert auth.check_bridge_token("bridge-123") is True
    assert auth.check_bridge_token("nope") is False


def test_origin_allowlist():
    auth = make_auth()
    auth.allowed_origins = {"http://127.0.0.1:8765"}
    assert auth.origin_allowed(None) is True
    assert auth.origin_allowed("http://127.0.0.1:8765") is True
    assert auth.origin_allowed("http://evil.example") is False


def test_login_limiter():
    auth = make_auth()
    auth.limiter.limit = 3
    for _ in range(3):
        assert auth.limiter.allow("1.2.3.4") is True
        auth.limiter.record_failure("1.2.3.4")
    assert auth.limiter.allow("1.2.3.4") is False
    assert auth.limiter.allow("5.6.7.8") is True
    auth.limiter.reset("1.2.3.4")
    assert auth.limiter.allow("1.2.3.4") is True
