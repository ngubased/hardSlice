# hardSlice

VPS service: **Decoded Shredstream UDP** → watch SOL MC → fire 100% sells (submit-only).

## Flow

1. On VPS: put wallets in `data/wallets.json` (manual — no keys from LaunchPad)
2. Open UDP for Shredstream (see script below)
3. Local onPoint: vanity mint → `POST /arm` → wait ACK → then submit create/snipes
4. UDP stream updates MC + balances (no RPC on hot path)
5. On target SOL MC: sign with shred blockhash → Jito/Helius `sendBundle`

## Shredstream dashboard

- Product: **Decoded Shred Stream**
- Mode: **UDP**
- Destination: `YOUR_VPS_PUBLIC_IP` + `UDP_PORT` (default `8001`)

### Bootstrap a fresh Ubuntu VPS

```bash
cd ~/hardSlice
chmod +x scripts/setup-ubuntu.sh scripts/setup-ufw-shredstream.sh
sudo ./scripts/setup-ubuntu.sh
# installs Node 22, npm deps, UFW UDP port, buffer tuning
```

Only Node/deps (no firewall):

```bash
sudo SKIP_UFW=1 ./scripts/setup-ubuntu.sh
```

Allow HardSlice HTTP only from your home IP while bootstrapping:

```bash
sudo HTTP_ALLOW_FROM=YOUR.HOME.IP ./scripts/setup-ubuntu.sh
```

### One-shot firewall + buffer setup (already covered by bootstrap)

```bash
chmod +x scripts/setup-ufw-shredstream.sh
# default: UDP 8001 + HTTP 8787 from anywhere (AUTH_TOKEN still required)
sudo ./scripts/setup-ufw-shredstream.sh

# custom UDP port
sudo ./scripts/setup-ufw-shredstream.sh 9001

# optional: lock HTTP API to your home IP only
sudo HTTP_ALLOW_FROM=203.0.113.50 ./scripts/setup-ufw-shredstream.sh 8001
```

The script: allows SSH, opens `UDP_PORT/udp`, opens `HTTP_PORT/tcp` (world by default, or one IP if `HTTP_ALLOW_FROM` is set), enables UFW, and raises `rmem` buffers (Shredstream recommendation).

Also open the same UDP + HTTP ports in any **cloud security group**.

## Run on VPS

```bash
cd hardSlice
cp .env.example .env
# set AUTH_TOKEN, UDP_PORT, HTTP_PORT, HELIUS_*/JITO_*
npm install
npm start
```

### systemd example

```ini
[Unit]
Description=hardSlice
After=network.target

[Service]
WorkingDirectory=/opt/hardSlice
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/opt/hardSlice/.env

[Install]
WantedBy=multi-user.target
```

## HTTP API (Bearer `AUTH_TOKEN`)

| Method | Path | Body |
|--------|------|------|
| GET | `/health` | — |
| GET | `/status` | — |
| POST | `/arm` | `{ "mint","creator","targetSolMc" }` |
| POST | `/disarm` | — |

### Wallets (manual on VPS)

Create `data/wallets.json` on the server yourself — LaunchPad does **not** send secrets:

```json
{
  "wallets": [
    { "address": "...", "secret": "<base58>", "label": "dev" },
    { "address": "...", "secret": "<base58>", "label": "snipe1" }
  ]
}
```

`chmod 600 data/wallets.json`

`targetSolMc` is **SOL** market cap (not USD).

## Env

See `.env.example`. RPC is **cold-start only** (`warmGlobal`). Fire path never reads chain state.
