"""Track the remote shell's current directory from the terminal byte stream.

Two signals, both zero-config friendly:

* OSC 7 shell integration — ``ESC ] 7 ; file://host/path BEL/ST``.  Explicit
  and exact, emitted at each prompt by shells with integration (vte.sh, zsh
  hooks, fish handlers).
* OSC 0/2 window titles — stock bash (Debian/Ubuntu/...) sets the title to
  ``user@host:cwd`` before each prompt, so the path is parsed out of it.

To survive nested ``ssh`` hops (the inner host reports its own title/OSC 7),
the identity (user@host, or OSC 7 host) of the first accepted report is
remembered and later reports from a different identity are ignored.

Sequences are scanned incrementally: an escape sequence split across recv
chunks is reassembled from a small carry buffer.
"""

from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

_MAX_CARRY = 8192
_INTRO = b"\x1b]"
_BEL = b"\x07"
_ST = b"\x1b\\"

# bash default title: "user@host:cwd" (cwd may be "~" or "~/rel" or absolute)
_TITLE_RE = re.compile(r"^(?P<user>[^@\s]+)@(?P<host>[^@\s:]+):(?P<path>.+)$")


class CwdTracker:
    def __init__(self, username: str) -> None:
        self._home = "/root" if username == "root" else f"/home/{username}"
        self._carry = bytearray()
        self._title_identity: tuple[str, str] | None = None
        self._osc7_host: str | None = None
        self.cwd: str | None = None

    def feed(self, data: bytes) -> bool:
        """Ingest stream bytes; True when the tracked cwd changed."""
        self._carry += data
        if len(self._carry) > _MAX_CARRY:
            del self._carry[:-_MAX_CARRY]
        changed = False
        while True:
            intro = self._carry.find(_INTRO)
            if intro < 0:
                # a trailing lone ESC may become an intro with the next chunk
                keep = 1 if self._carry and self._carry[-1] == 0x1B else 0
                del self._carry[: len(self._carry) - keep]
                return changed
            if intro:
                del self._carry[:intro]
            end, terminator = self._find_terminator(self._carry)
            if end < 0:
                if len(self._carry) > _MAX_CARRY:
                    del self._carry[:]  # dead unterminated sequence; rescan
                return changed
            payload = bytes(self._carry[2:end])
            del self._carry[: end + terminator]
            if self._consume(payload):
                changed = True

    @staticmethod
    def _find_terminator(buf: bytearray) -> tuple[int, int]:
        bel = buf.find(_BEL, 2)
        st = buf.find(_ST, 2)
        if bel < 0 and st < 0:
            return -1, 0
        if bel >= 0 and (st < 0 or bel <= st):
            return bel, 1
        return st, 2

    def _consume(self, payload: bytes) -> bool:
        code, sep, rest = payload.decode("utf-8", "replace").partition(";")
        if not sep:
            return False
        if code == "7":
            path = self._from_osc7(rest)
        elif code in ("0", "2"):
            path = self._from_title(rest)
        else:
            return False  # OSC 52 clipboard payloads etc.
        if not path or path == self.cwd:
            return False
        self.cwd = path
        return True

    def _from_osc7(self, uri: str) -> str | None:
        if not uri.startswith("file://"):
            return None
        try:
            parts = urlsplit(uri)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        if self._osc7_host is None:
            self._osc7_host = host
        elif host != self._osc7_host:
            return None  # report from a nested ssh host
        path = unquote(parts.path)
        return path if path.startswith("/") else None

    def _from_title(self, title: str) -> str | None:
        match = _TITLE_RE.match(title.strip())
        if not match:
            return None
        identity = (match.group("user"), match.group("host").lower())
        if self._title_identity is None:
            self._title_identity = identity
        elif identity != self._title_identity:
            return None  # title from a nested ssh / different user
        raw = match.group("path").strip()
        if raw == "~":
            return self._home
        if raw.startswith("~/"):
            raw = self._home + raw[1:]
        if not raw.startswith("/"):
            return None
        return raw.rstrip("/") or "/"
