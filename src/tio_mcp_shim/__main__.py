"""``agent-mcp``: a stdio MCP server that proxies to agent-terminal's HTTP endpoint.

Agents that only speak stdio MCP can point at this program; it forwards every
JSON-RPC message to ``http(s)://…/mcp`` with the bearer token and streams the
answers back.  It never opens a serial port and caches nothing.

    {"mcpServers": {"tio": {"command": "agent-mcp",
                            "args": ["--url", "http://127.0.0.1:8765/mcp",
                                     "--token-file", "/path/to/api-token"]}}}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import httpx


class Proxy:
    def __init__(self, url: str, token: str, timeout: float = 120.0) -> None:
        self.url = url
        self.token = token
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self.client = httpx.Client(
            timeout=httpx.Timeout(connect=5.0, read=timeout, write=30.0, pool=5.0),
            follow_redirects=True,
        )

    # ------------------------------------------------------------------ headers
    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    # ------------------------------------------------------------------- parsing
    @staticmethod
    def _parse_sse(text: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        data_lines: list[str] = []
        for line in text.splitlines():
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            elif line.strip() == "" and data_lines:
                payload = "\n".join(data_lines)
                data_lines = []
                try:
                    messages.append(json.loads(payload))
                except json.JSONDecodeError:
                    continue
        if data_lines:
            try:
                messages.append(json.loads("\n".join(data_lines)))
            except json.JSONDecodeError:
                pass
        return messages

    # -------------------------------------------------------------------- send
    def _error(self, request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def forward(self, message: dict[str, Any] | list[dict[str, Any]]) -> list[dict[str, Any]]:
        is_request = isinstance(message, dict) and "id" in message and "method" in message
        request_id = message.get("id") if isinstance(message, dict) else None
        try:
            response = self.client.post(self.url, json=message, headers=self._headers())
        except httpx.ConnectError:
            if is_request:
                return [
                    self._error(
                        request_id,
                        -32000,
                        "agent-terminal is not running or not reachable; start it with "
                        "`agent-terminal run --config <path>`",
                    )
                ]
            return []
        except httpx.HTTPError as exc:
            if is_request:
                return [self._error(request_id, -32000, f"transport error: {exc}")]
            return []

        if response.status_code == 401:
            if is_request:
                return [self._error(request_id, -32001, "unauthorized: check the MCP api token")]
            return []
        if response.status_code == 404:
            if is_request:
                return [self._error(request_id, -32601, "method not found on agent-terminal")]
            return []
        if response.status_code in (502, 503, 504) and not response.text.strip():
            # A local proxy/loopback guard answering for a port nobody listens on.
            if is_request:
                return [
                    self._error(
                        request_id,
                        -32000,
                        "agent-terminal is not running or not reachable; start it with "
                        "`agent-terminal run --config <path>`",
                    )
                ]
            return []

        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self.session_id = session_id

        content_type = response.headers.get("content-type", "")
        messages: list[dict[str, Any]] = []
        if "text/event-stream" in content_type:
            messages = self._parse_sse(response.text)
        elif response.text.strip():
            try:
                parsed = response.json()
                messages = parsed if isinstance(parsed, list) else [parsed]
            except json.JSONDecodeError:
                if is_request:
                    return [self._error(request_id, -32700, "invalid JSON from server")]
        elif response.status_code >= 400 and is_request:
            return [self._error(request_id, -32000, f"server returned HTTP {response.status_code}")]

        # Remember the negotiated protocol version for later requests.
        for msg in messages:
            if isinstance(msg, dict) and msg.get("id") == request_id and "result" in msg:
                result = msg["result"]
                if isinstance(result, dict) and result.get("protocolVersion"):
                    self.protocol_version = result["protocolVersion"]
        return messages

    def close(self) -> None:
        if self.session_id:
            try:
                self.client.delete(self.url, headers=self._headers())
            except httpx.HTTPError:
                pass
        self.client.close()


def _default_token_file() -> Path | None:
    from tio_server.platform.paths import default_data_dir

    candidate = default_data_dir() / "api-token"
    return candidate if candidate.exists() else None


def main(argv: list[str] | None = None) -> int:
    # stdout is the MCP transport: force UTF-8 so device text never crashes on a
    # Windows code page (the agent reads UTF-8 JSON lines).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="agent-mcp", description="stdio MCP proxy for agent-terminal")
    parser.add_argument("--url", default="http://127.0.0.1:8765/mcp")
    parser.add_argument("--token-file")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args(argv)

    token = None
    if args.token_file:
        try:
            token = Path(args.token_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            sys.stderr.write(f"agent-mcp: cannot read token file: {exc}\n")
            return 2
    else:
        import os

        token = os.environ.get("AGENT_TERMINAL_TOKEN") or os.environ.get("TIO_SERVER_TOKEN")
        if not token:
            fallback = _default_token_file()
            if fallback is not None:
                token = fallback.read_text(encoding="utf-8").strip()
    if not token:
        sys.stderr.write("agent-mcp: no api token (use --token-file or TIO_SERVER_TOKEN)\n")
        return 2

    proxy = Proxy(args.url, token, timeout=args.timeout)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
                sys.stdout.write(json.dumps(out) + "\n")
                sys.stdout.flush()
                continue
            for response in proxy.forward(message):
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        proxy.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
