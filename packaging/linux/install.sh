#!/usr/bin/env bash
# Install a prebuilt tio-suite bundle on Linux (tar.gz from CI).
#
#   sudo ./install.sh /path/to/tio-suite-linux-x86_64
#
# Layout after install:
#   /opt/tio-server/{tio-server,tio-mcp,_internal/}
#   /etc/tio-server/config.toml        seed config (root-owned)
#   /var/lib/tio-server/               runtime config, tokens, transcripts
#   /var/log/tio-server/               server + audit logs
set -euo pipefail

SRC="${1:?usage: install.sh <bundle-dir>}"
SERVICE_USER="${SERVICE_USER:-tio}"
PREFIX=/opt/tio-server

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home /var/lib/tio-server --shell /usr/sbin/nologin "$SERVICE_USER"

install -d -m 0755 "$PREFIX" "$PREFIX/bin"
install -m 0755 "$SRC/tio-server" "$PREFIX/tio-server"
install -m 0755 "$SRC/tio-mcp" "$PREFIX/tio-mcp"
if [ -d "$SRC/_internal" ]; then
  rm -rf "$PREFIX/_internal"
  cp -a "$SRC/_internal" "$PREFIX/_internal"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/tio-server
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/log/tio-server
install -d -m 0755 /etc/tio-server

# Seed config only on first install; never overwrite the runtime config.
if [ ! -f /var/lib/tio-server/config.toml ]; then
  if [ -f /etc/tio-server/config.toml ]; then
    cp /etc/tio-server/config.toml /var/lib/tio-server/config.toml
  else
    echo "No config found; generating one (credentials are printed once):"
    "$PREFIX/tio-server" init --dir /var/lib/tio-server | tee /dev/stderr
  fi
  chown "$SERVICE_USER:$SERVICE_USER" /var/lib/tio-server/config.toml
  chmod 0600 /var/lib/tio-server/config.toml
fi

usermod -aG dialout "$SERVICE_USER" || true

install -m 0644 "$(dirname "$0")/tio-server.service" /etc/systemd/system/tio-server.service
systemctl daemon-reload
systemctl enable --now tio-server

echo
echo "tio-server installed. Admin UI: http://127.0.0.1:8765/"
echo "Credentials were printed on first init, or are stored by your deployment system."
echo "Logs: journalctl -u tio-server -f"
