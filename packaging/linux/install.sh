#!/usr/bin/env bash
# Install a prebuilt tio-suite bundle on Linux (tar.gz from CI).
#
#   sudo ./install.sh /path/to/tio-suite-linux-x86_64
#
# Layout after install:
#   /opt/agent-terminal/{agent-terminal,agent-mcp,_internal/}
#   /etc/agent-terminal/config.toml        seed config (root-owned)
#   /var/lib/agent-terminal/               runtime config, tokens, transcripts
#   /var/log/agent-terminal/               server + audit logs
set -euo pipefail

SRC="${1:?usage: install.sh <bundle-dir>}"
SERVICE_USER="${SERVICE_USER:-tio}"
PREFIX=/opt/agent-terminal

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home /var/lib/agent-terminal --shell /usr/sbin/nologin "$SERVICE_USER"

install -d -m 0755 "$PREFIX" "$PREFIX/bin"
install -m 0755 "$SRC/agent-terminal" "$PREFIX/agent-terminal"
install -m 0755 "$SRC/agent-mcp" "$PREFIX/agent-mcp"
if [ -d "$SRC/_internal" ]; then
  rm -rf "$PREFIX/_internal"
  cp -a "$SRC/_internal" "$PREFIX/_internal"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/agent-terminal
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/log/agent-terminal
install -d -m 0755 /etc/agent-terminal

# Seed config only on first install; never overwrite the runtime config.
if [ ! -f /var/lib/agent-terminal/config.toml ]; then
  if [ -f /etc/agent-terminal/config.toml ]; then
    cp /etc/agent-terminal/config.toml /var/lib/agent-terminal/config.toml
  else
    echo "No config found; generating one (credentials are printed once):"
    "$PREFIX/agent-terminal" init --dir /var/lib/agent-terminal | tee /dev/stderr
  fi
  chown "$SERVICE_USER:$SERVICE_USER" /var/lib/agent-terminal/config.toml
  chmod 0600 /var/lib/agent-terminal/config.toml
fi

usermod -aG dialout "$SERVICE_USER" || true

install -m 0644 "$(dirname "$0")/agent-terminal.service" /etc/systemd/system/agent-terminal.service
systemctl daemon-reload
systemctl enable --now agent-terminal

echo
echo "agent-terminal installed. Admin UI: http://127.0.0.1:8765/"
echo "Credentials were printed on first init, or are stored by your deployment system."
echo "Logs: journalctl -u agent-terminal -f"
