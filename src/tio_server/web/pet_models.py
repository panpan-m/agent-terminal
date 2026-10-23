"""Desktop-pet VRM models: user uploads stored under the data dir.

Each upload lives in ``<data_dir>/pet-models/`` as ``<id>.vrm`` plus a
``<id>.json`` sidecar holding the display name and creation time, so the list
rebuilds itself from disk even if a sidecar goes missing. The bundled default
model ships inside the web UI assets and is not managed here.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..errors import INVALID_ARGUMENT, NOT_FOUND, ToolFailure
from ..transcript import now_iso

MAX_MODEL_BYTES = 64 * 1024 * 1024  # 64 MiB
GLB_MAGIC = b"glTF"
_ID_RE = re.compile(r"^[a-z0-9]{8,16}$")


def _bad(message: str, **details: Any) -> ToolFailure:
    return ToolFailure(INVALID_ARGUMENT, message, details)


@dataclass(slots=True)
class PetModel:
    id: str
    name: str
    size: int
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "size": self.size,
            "created_at": self.created_at,
        }


class PetModelStore:
    """Thread-safe store for uploaded .vrm files with atomic writes."""

    def __init__(self, data_dir: Path | str) -> None:
        self.data_dir = Path(data_dir)
        self.dir = self.data_dir / "pet-models"
        self._lock = threading.RLock()

    # ------------------------------------------------------------------- helpers
    def _model_path(self, model_id: str) -> Path:
        if not _ID_RE.fullmatch(model_id):
            raise ToolFailure(NOT_FOUND, f"unknown pet model: {model_id}", {"model_id": model_id})
        return self.dir / f"{model_id}.vrm"

    def _read(self, model_id: str) -> PetModel:
        path = self._model_path(model_id)
        if not path.is_file():
            raise ToolFailure(NOT_FOUND, f"unknown pet model: {model_id}", {"model_id": model_id})
        sidecar = path.with_suffix(".json")
        name = f"{model_id}.vrm"
        created_at = now_iso()
        try:
            meta = json.loads(sidecar.read_text(encoding="utf-8"))
            if isinstance(meta, dict):
                name = str(meta.get("name") or name)[:255]
                created_at = str(meta.get("created_at") or created_at)
        except (OSError, json.JSONDecodeError):
            pass
        return PetModel(id=model_id, name=name, size=path.stat().st_size, created_at=created_at)

    # ----------------------------------------------------------------------- api
    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            if not self.dir.is_dir():
                return []
            models = []
            for path in self.dir.glob("*.vrm"):
                try:
                    models.append(self._read(path.stem))
                except ToolFailure:
                    continue
            models.sort(key=lambda model: (model.created_at, model.id))
            return [model.to_dict() for model in models]

    def save(self, name: str, data: bytes) -> dict[str, Any]:
        if len(data) > MAX_MODEL_BYTES:
            raise _bad(f"model larger than {MAX_MODEL_BYTES // (1024 * 1024)} MiB")
        if not data.startswith(GLB_MAGIC):
            raise _bad("file is not a VRM model (missing glTF header)")
        clean_name = (name or "").strip().replace("\\", "/").split("/")[-1][:255] or "model.vrm"
        if not clean_name.lower().endswith(".vrm"):
            raise _bad("model file must end with .vrm")
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            model_id = secrets.token_hex(6)
            while (self.dir / f"{model_id}.vrm").exists():
                model_id = secrets.token_hex(6)
            payload = json.dumps(
                {"name": clean_name, "created_at": now_iso()},
                ensure_ascii=False,
                indent=2,
            )
            for file_suffix, blob in ((".vrm", data), (".json", payload.encode("utf-8"))):
                fd, tmp_name = tempfile.mkstemp(prefix=f".{model_id}-", suffix=file_suffix, dir=str(self.dir))
                try:
                    with os.fdopen(fd, "wb") as fh:
                        fh.write(blob)
                        fh.flush()
                        os.fsync(fh.fileno())
                    os.replace(tmp_name, self.dir / f"{model_id}{file_suffix}")
                finally:
                    if os.path.exists(tmp_name):
                        try:
                            os.unlink(tmp_name)
                        except OSError:
                            pass
            return self._read(model_id).to_dict()

    def get(self, model_id: str) -> PetModel:
        with self._lock:
            return self._read(model_id)

    def path(self, model_id: str) -> Path:
        with self._lock:
            model = self._read(model_id)
            return self.dir / f"{model.id}.vrm"

    def delete(self, model_id: str) -> None:
        with self._lock:
            path = self._model_path(model_id)
            if not path.is_file():
                raise ToolFailure(NOT_FOUND, f"unknown pet model: {model_id}", {"model_id": model_id})
            os.unlink(path)
            sidecar = path.with_suffix(".json")
            if sidecar.is_file():
                try:
                    os.unlink(sidecar)
                except OSError:
                    pass
