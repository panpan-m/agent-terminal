"""Encrypted, optional SSH credential storage.

Secrets are encrypted with a per-install Fernet key (``ssh-secrets.key``) and
stored as opaque tokens in ``ssh-secrets.json``.  The API never returns a secret;
the UI only learns which fields are saved.  This is convenience storage, not a
hardware vault: anyone who can read the data directory can also read the key.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

SECRET_FIELDS = ("password", "passphrase", "jump_password", "jump_passphrase")


class SshSecretStore:
    def __init__(self, data_dir: Path | str) -> None:
        self.data_dir = Path(data_dir)
        self.key_path = self.data_dir / "ssh-secrets.key"
        self.path = self.data_dir / "ssh-secrets.json"
        self._lock = threading.RLock()
        self._fernet = Fernet(self._load_or_create_key())

    def _load_or_create_key(self) -> bytes:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if self.key_path.exists():
            return self.key_path.read_bytes().strip()
        key = Fernet.generate_key()
        fd, tmp_name = tempfile.mkstemp(prefix=".ssh-secrets-key-", dir=str(self.data_dir))
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(key)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, self.key_path)
            try:
                os.chmod(self.key_path, 0o600)
            except OSError:
                pass
        finally:
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
        return key

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _save(self, data: dict[str, str]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=".ssh-secrets-", suffix=".json", dir=str(self.data_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        finally:
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass

    def get(self, host_id: str) -> dict[str, str]:
        with self._lock:
            token = self._load().get(host_id)
            if not token:
                return {}
            try:
                payload = json.loads(self._fernet.decrypt(token.encode("ascii")))
            except (InvalidToken, ValueError, TypeError):
                return {}
            if not isinstance(payload, dict):
                return {}
            return {key: str(value) for key, value in payload.items() if key in SECRET_FIELDS and value}

    def fields(self, host_id: str) -> list[str]:
        return sorted(self.get(host_id))

    def save(self, host_id: str, values: dict[str, Any]) -> list[str]:
        clean = {key: str(value) for key, value in values.items() if key in SECRET_FIELDS and value}
        if not clean:
            return self.fields(host_id)
        with self._lock:
            data = self._load()
            merged = self.get(host_id)
            merged.update(clean)
            data[host_id] = self._fernet.encrypt(json.dumps(merged, ensure_ascii=False).encode()).decode("ascii")
            self._save(data)
        return sorted(merged)

    def clear(self, host_id: str) -> bool:
        with self._lock:
            data = self._load()
            if host_id not in data:
                return False
            del data[host_id]
            self._save(data)
            return True
