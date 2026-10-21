"""Transcript (JSONL data log) and audit log with rotation and redaction."""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class Redactor:
    def __init__(self, patterns: Iterable[str] = ()) -> None:
        self._patterns = [re.compile(p) for p in patterns if p]

    def scrub(self, text: str) -> str:
        for pat in self._patterns:
            text = pat.sub("***", text)
        return text

    def scrub_obj(self, obj: Any) -> Any:
        if isinstance(obj, str):
            return self.scrub(obj)
        if isinstance(obj, dict):
            return {k: self.scrub_obj(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.scrub_obj(v) for v in obj]
        return obj


class AuditLog:
    """Append-only JSONL of security-relevant events (one shared file)."""

    def __init__(self, directory: Path, redactor: Redactor | None = None) -> None:
        self.path = Path(directory) / "audit.log"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._redactor = redactor or Redactor()

    def write(self, event: str, **fields: Any) -> None:
        record = {"ts": now_iso(), "event": event, **self._redactor.scrub_obj(fields)}
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8", newline="\n") as fh:
                fh.write(line)

    def tail(self, limit: int = 200) -> list[dict]:
        if not self.path.exists():
            return []
        with self.path.open("r", encoding="utf-8") as fh:
            lines = deque(fh, maxlen=max(1, limit))
        out = []
        for line in lines:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return out


class TranscriptWriter:
    """Rotating JSONL per session: ``<dir>/<session>.jsonl`` (+ ``.1`` … ``.N``)."""

    def __init__(
        self,
        directory: Path,
        session_id: str,
        *,
        max_file_mb: int = 10,
        max_files: int = 5,
        redactor: Redactor | None = None,
        enabled: bool = True,
    ) -> None:
        self.directory = Path(directory)
        self.session_id = session_id
        self.max_bytes = max_file_mb * 1024 * 1024
        self.max_files = max_files
        self.enabled = enabled
        self.redactor = redactor or Redactor()
        self._lock = threading.Lock()
        self._fh = None
        self._size = 0
        if enabled:
            self.directory.mkdir(parents=True, exist_ok=True)
            self._open()

    @property
    def path(self) -> Path:
        return self.directory / f"{self.session_id}.jsonl"

    def _open(self) -> None:
        self._fh = self.path.open("a", encoding="utf-8", newline="\n")
        try:
            self._size = self.path.stat().st_size
        except OSError:
            self._size = 0

    def _rotate(self) -> None:
        assert self._fh is not None
        self._fh.close()
        for index in range(self.max_files - 1, 0, -1):
            src = self.directory / f"{self.session_id}.{index}.jsonl"
            dst = self.directory / f"{self.session_id}.{index + 1}.jsonl"
            if src.exists():
                if dst.exists():
                    dst.unlink()
                src.replace(dst)
        oldest = self.directory / f"{self.session_id}.{self.max_files}.jsonl"
        if oldest.exists():
            oldest.unlink()
        if self.path.exists():
            self.path.replace(self.directory / f"{self.session_id}.1.jsonl")
        self._open()

    def event(self, event: str, **fields: Any) -> None:
        self._write({"ts": now_iso(), "session": self.session_id, "event": event, **fields})

    def data(self, direction: str, offset: int, payload: bytes, source: str) -> None:
        self._write(
            {
                "ts": now_iso(),
                "session": self.session_id,
                "dir": direction,
                "offset": offset,
                "len": len(payload),
                "data_b64": base64.b64encode(payload).decode("ascii"),
                "source": source,
            }
        )

    def _write(self, record: dict[str, Any]) -> None:
        if not self.enabled:
            return
        line = json.dumps(self.redactor.scrub_obj(record), ensure_ascii=False) + "\n"
        payload = line.encode("utf-8")
        with self._lock:
            if self._fh is None:
                return
            if self._size + len(payload) > self.max_bytes:
                self._rotate()
            try:
                self._fh.write(line)
                self._fh.flush()
                self._size += len(payload)
            except OSError:
                # Disk full or file removed: stop writing, never break the serial path.
                self.enabled = False

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    # ------------------------------------------------------------------ read
    def files(self) -> list[Path]:
        if not self.directory.exists():
            return []
        out = [p for p in self.directory.glob(f"{self.session_id}*.jsonl")]
        return sorted(out, key=lambda p: p.stat().st_mtime)

    def tail(self, limit: int = 200) -> list[dict]:
        files = self.files()
        if not files:
            return []
        records: deque[dict] = deque(maxlen=max(1, limit))
        for path in files:
            try:
                with path.open("r", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            records.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue
            except OSError:
                continue
        return list(records)


class TranscriptRegistry:
    """Owns one writer per session and shares redaction settings."""

    def __init__(self, cfg) -> None:  # type: ignore[no-untyped-def]
        self.cfg = cfg
        self.redactor = Redactor(cfg.transcript.redact_patterns)
        self._writers: dict[str, TranscriptWriter] = {}
        self._lock = threading.Lock()

    def writer(self, session_id: str, enabled: bool = True) -> TranscriptWriter:
        with self._lock:
            w = self._writers.get(session_id)
            if w is None:
                w = TranscriptWriter(
                    self.cfg.transcript_dir,
                    session_id,
                    max_file_mb=self.cfg.transcript.max_file_mb,
                    max_files=self.cfg.transcript.max_files,
                    redactor=self.redactor,
                    enabled=enabled and self.cfg.transcript.enabled,
                )
                self._writers[session_id] = w
            return w

    def close(self) -> None:
        with self._lock:
            for w in self._writers.values():
                w.close()
            self._writers.clear()


def file_age_seconds(path: Path) -> float:
    return time.time() - path.stat().st_mtime if path.exists() else 0.0
