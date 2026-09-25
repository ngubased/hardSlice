#!/usr/bin/env bash
# hardSlice — open firewall + tune UDP buffers so Shredstream can push.
#
# Usage (on the VPS, as a user with sudo):
#   chmod +x scripts/setup-ufw-shredstream.sh
#   ./scripts/setup-ufw-shredstream.sh
#   ./scripts/setup-ufw-shredstream.sh 8001
#   HTTP_PORT=8787 HTTP_ALLOW_FROM=203.0.113.50 ./scripts/setup-ufw-shredstream.sh 8001
#
# Then put that public IP + UDP port in the Shredstream dashboard (Decoded + UDP).

set -euo pipefail

UDP_PORT="${1:-${UDP_PORT:-8001}}"
HTTP_PORT="${HTTP_PORT:-8787}"
# Optional: only allow HardSlice HTTP API from your home/office IP (recommended).
# Leave empty to skip opening HTTP in UFW (API stays closed to the world).
HTTP_ALLOW_FROM="${HTTP_ALLOW_FROM:-}"

if [[ ! "$UDP_PORT" =~ ^[0-9]+$ ]] || (( UDP_PORT < 1024 || UDP_PORT > 65535 )); then
  echo "error: UDP port must be 1024–65535 (got: $UDP_PORT)" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

echo "==> Detecting public IPv4 (for Shredstream destination)…"
PUBLIC_IP="$(curl -4 -fsS --max-time 8 ifconfig.me 2>/dev/null || true)"
if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -z "$PUBLIC_IP" ]]; then
  echo "warn: could not detect public IP — check manually with: curl -4 ifconfig.me"
else
  echo "    public IPv4: $PUBLIC_IP"
fi

echo "==> Installing / ensuring ufw…"
if ! command -v ufw >/dev/null 2>&1; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y ufw
fi

# Never lock yourself out: allow SSH before enabling.
echo "==> Allowing SSH (22/tcp)…"
$SUDO ufw allow OpenSSH 2>/dev/null || $SUDO ufw allow 22/tcp

echo "==> Allowing Shredstream UDP inbound on ${UDP_PORT}/udp…"
$SUDO ufw allow "${UDP_PORT}/udp" comment "hardSlice shredstream decoded UDP"

if [[ -n "$HTTP_ALLOW_FROM" ]]; then
  echo "==> Allowing HardSlice HTTP ${HTTP_PORT}/tcp from ${HTTP_ALLOW_FROM} only…"
  $SUDO ufw allow from "$HTTP_ALLOW_FROM" to any port "$HTTP_PORT" proto tcp comment "hardSlice control API"
else
  echo "==> Skipping HTTP ${HTTP_PORT}/tcp in UFW (not opened to the world)."
  echo "    Tip: HTTP_ALLOW_FROM=YOUR_HOME_IP $0 ${UDP_PORT}"
fi

echo "==> Enabling UFW (if not already)…"
$SUDO ufw --force enable
$SUDO ufw status verbose | sed 's/^/    /'

# Shredstream docs: raise receive buffers so bursts are not dropped by the kernel.
echo "==> Tuning UDP receive buffers (sysctl)…"
SYSCTL_FILE="/etc/sysctl.d/99-hardslice-shredstream.conf"
$SUDO tee "$SYSCTL_FILE" >/dev/null <<EOF
# hardSlice / Shredstream Decoded UDP
net.core.rmem_max = 268435456
net.core.rmem_default = 268435456
net.core.netdev_max_backlog = 50000
EOF
$SUDO sysctl --system >/dev/null
echo "    net.core.rmem_max=$(sysctl -n net.core.rmem_max)"

echo
echo "Done. Next:"
echo "  1) Shredstream dashboard → Decoded Shred Stream → UDP"
echo "     Destination IP:   ${PUBLIC_IP:-<your public IPv4>}"
echo "     Destination port: ${UDP_PORT}"
echo "  2) Also open ${UDP_PORT}/udp in your cloud security group (AWS/GCP/DO/Hetzner) if any."
echo "  3) Start hardSlice with UDP_PORT=${UDP_PORT} (binds 0.0.0.0 — required)."
echo "  4) Confirm packets:  sudo tcpdump -n -i any udp port ${UDP_PORT} -c 5"
echo
