"""``tio-server`` command line: init, run, check-config, doctor."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import Config, init_config
from .errors import ToolFailure
from .platform.paths import default_data_dir, find_ttyd
from .serial import make_backend


def _cmd_init(args: argparse.Namespace) -> int:
    data_dir = Path(args.dir).expanduser() if args.dir else default_data_dir()
    try:
        cfg, secrets = init_config(data_dir, force=args.force)
    except ToolFailure as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1
    if args.ttyd:
        cfg.ttyd.enabled = True
        cfg.ttyd.binary = args.ttyd
        cfg.save()
        print(f"Browser terminal enabled with ttyd at {args.ttyd}")
    print(f"Created {secrets['config']}")
    print("Store these secrets now; they are not shown again:")
    print(f"  admin user      : {cfg.auth.admin_username}")
    print(f"  admin password  : {secrets['admin_password']}")
    print(f"  MCP api token   : {secrets['api_token']}   (also in {cfg.api_token_file})")
    print(f"  bridge token    : {secrets['bridge_token']}   (also in {cfg.bridge_token_file})")
    print(f"  ttyd operator   : {secrets['ttyd_control_password']}")
    if args.credentials_out:
        from .auth import write_secret_file

        out = Path(args.credentials_out).expanduser()
        write_secret_file(out, json.dumps(secrets, indent=2))
        print(f"\nOne-time credentials also written to {out} (delete it after first login).")
    print()
    print("Next:")
    print(f"  tio-server run --config \"{secrets['config']}\"")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    import uvicorn

    from .web.app import create_app

    path = Path(args.config).expanduser()
    try:
        cfg = Config.load(path)
    except ToolFailure as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 2
    app = create_app(cfg)
    host = args.host or cfg.server.bind
    port = args.port or cfg.server.port
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=cfg.server.log_level,
        access_log=False,
        log_config=None,
    )
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    try:
        cfg = Config.load(Path(args.config).expanduser())
    except ToolFailure as exc:
        print(json.dumps(exc.to_dict(), indent=2))
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "config_version": cfg.config_version,
                "bind": cfg.server.bind,
                "port": cfg.server.port,
                "sessions": [
                    {"id": s.id, "port": s.port, "baudrate": s.baudrate, "auto_open": s.auto_open}
                    for s in cfg.sessions
                ],
            },
            indent=2,
        )
    )
    return 0


def _cmd_ports(args: argparse.Namespace) -> int:
    backend = make_backend()
    print(json.dumps([p.to_dict() for p in backend.list_ports()], indent=2))
    return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    from .web.ttyd_supervisor import TtydSupervisor

    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "", *, required: bool = False) -> None:
        checks.append({"check": name, "ok": ok, "required": required, "detail": detail})

    check("python", sys.version_info >= (3, 11), sys.version.split()[0], required=True)
    for module in ("fastapi", "uvicorn", "serial", "argon2", "mcp", "websockets", "regex"):
        try:
            mod = __import__(module)
            check(f"import {module}", True, getattr(mod, "__version__", ""), required=True)
        except Exception as exc:  # pragma: no cover
            check(f"import {module}", False, str(exc), required=True)

    backend = make_backend()
    try:
        ports = backend.list_ports()
        check("serial enumeration", True, f"{len(ports)} port(s): " + ", ".join(p.port for p in ports))
    except Exception as exc:  # pragma: no cover
        check("serial enumeration", False, str(exc))

    ttyd = find_ttyd(None)
    check("ttyd binary", bool(ttyd), ttyd or "not found (browser terminal will be unavailable)")

    if args.config:
        try:
            cfg = Config.load(Path(args.config).expanduser())
            check("config", True, str(cfg.path))
            ty = TtydSupervisor(cfg, _null_audit())
            check("ttyd version", bool(ty.version()), ty.version() or "unknown")
        except ToolFailure as exc:
            check("config", False, exc.message, required=True)

    failed = [c for c in checks if c["required"] and not c["ok"]]
    print(json.dumps({"ok": not failed, "checks": checks}, indent=2, ensure_ascii=False))
    return 0 if not failed else 1


class _null_audit:
    def write(self, *args, **kwargs):  # pragma: no cover
        pass


def _cmd_version(args: argparse.Namespace) -> int:
    print(json.dumps({"version": __version__, "python": sys.version.split()[0]}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tio-server", description="Shared serial-port gateway")
    parser.add_argument("--version", action="version", version=f"tio-server {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create config + secrets in a data directory")
    p_init.add_argument("--dir", help="data directory (default: platform path)")
    p_init.add_argument("--force", action="store_true", help="overwrite an existing config")
    p_init.add_argument(
        "--credentials-out",
        help="also write the one-time secrets to this file (used by installers)",
    )
    p_init.add_argument("--ttyd", help="path to ttyd(.exe): enables the browser terminal")
    p_init.set_defaults(func=_cmd_init)

    p_run = sub.add_parser("run", help="run the server")
    p_run.add_argument("--config", required=True)
    p_run.add_argument("--host")
    p_run.add_argument("--port", type=int)
    p_run.set_defaults(func=_cmd_run)

    p_check = sub.add_parser("check-config", help="validate a config file")
    p_check.add_argument("--config", required=True)
    p_check.set_defaults(func=_cmd_check)

    p_ports = sub.add_parser("ports", help="list serial ports as JSON")
    p_ports.set_defaults(func=_cmd_ports)

    p_doctor = sub.add_parser("doctor", help="environment diagnostics")
    p_doctor.add_argument("--config")
    p_doctor.set_defaults(func=_cmd_doctor)

    p_version = sub.add_parser("version", help="print version")
    p_version.set_defaults(func=_cmd_version)
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
