#!/usr/bin/env bash
# hardSlice — bootstrap a fresh Ubuntu VPS (DigitalOcean, etc.)
#
# Run as root (or with sudo) from the hardSlice repo directory:
#   cd ~/hardSlice
#   chmod +x scripts/setup-ubuntu.sh
#   sudo ./scripts/setup-ubuntu.sh
#
# Then:
#   cp .env.example .env && nano .env
#   # put data/wallets.json
#   npm start
#
# Optional flags via env:
#   NODE_MAJOR=22          # Node.js major version (default 22 LTS)
#   SKIP_UFW=1             # skip firewall script
#   UDP_PORT=8001          # passed to ufw script
#   HTTP_ALLOW_FROM=x.x.x.x

set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-22}"
UDP_PORT="${UDP_PORT:-8001}"
SKIP_UFW="${SKIP_UFW:-0}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: run as root (sudo ./scripts/setup-ubuntu.sh)" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export DEBIAN_FRONTEND=noninteractive

echo "==> apt update + base packages…"
apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  ufw \
  jq \
  build-essential

echo "==> Installing Node.js ${NODE_MAJOR}.x (NodeSource)…"
if command -v node >/dev/null 2>&1; then
  echo "    existing node: $(node -v) ($(command -v node))"
fi

# Official NodeSource setup (Ubuntu/Debian)
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
apt-get install -y nodejs

echo "    node=$(node -v)  npm=$(npm -v)"

echo "==> npm install (hardSlice deps)…"
npm install --omit=dev

if [[ "$SKIP_UFW" != "1" ]]; then
  echo "==> Firewall + UDP buffers…"
  chmod +x scripts/setup-ufw-shredstream.sh
  HTTP_ALLOW_FROM="${HTTP_ALLOW_FROM:-}" UDP_PORT="$UDP_PORT" \
    ./scripts/setup-ufw-shredstream.sh "$UDP_PORT"
else
  echo "==> Skipping UFW (SKIP_UFW=1)"
fi

echo
echo "Bootstrap done."
echo
echo "Next:"
echo "  1) cp .env.example .env && nano .env"
echo "     - AUTH_TOKEN=…"
echo "     - HELIUS_API_KEY=… (same as onPoint) + HELIUS_USE_SENDER=1"
echo "     - UDP_PORT=${UDP_PORT}  HTTP_PORT=8787"
echo "  2) mkdir -p data && put wallets.json there && chmod 600 data/wallets.json"
echo "  3) npm start"
echo "  4) Shredstream dashboard → Decoded UDP → this server public IP + ${UDP_PORT}"
echo
