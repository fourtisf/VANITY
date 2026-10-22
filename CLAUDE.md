# Plates (getplates.fun): deploy guide for Claude Code

This repo is finished and tested. The job is to deploy it, not to rebuild it. Do not rewrite the engine or the page design.

## What it is

A website that creates Solana wallet or token addresses starting or ending with a chosen word.

- **On-device (default):** the visitor's own GPU (WebGPU) or CPU (Web Workers) grinds keys in the browser. Nothing is sent to the server.
- **Fast mode (optional):** the visitor's browser sends the pattern plus an RSA public key. This server grinds on its GPU, seals the key (RSA-OAEP 3072 + AES-256-GCM), and the browser opens and re-verifies it.

## Files

| Path | Role |
|---|---|
| `server.js` | Node server: serves `public/` and `engine/`, runs the Fast mode job queue (`/api/*`) and payments |
| `site.js` | Site name, contact and links from the environment, filled into `{{NAME}}` placeholders in the pages |
| `public/index.html` | The whole website (HTML, CSS, app JS), including the Connect wallet payment |
| `public/legal.html` | Terms, privacy and refund policy templates |
| `engine/vanity.wgsl` | GPU shader: SHA-512, ed25519, base58 checks. Shared by browser and server |
| `engine/gpu-engine.js` | WebGPU host code. Shared by browser and server |
| `engine/pattern.js` | Pattern parsing and odds. Shared by browser and server |
| `engine/cpu-worker.mjs` | Server CPU fallback |
| `scripts/smoke.mjs` | End-to-end check of a running server (`npm run smoke -- <url>`) |
| `scripts/pay-test.mjs` | Fast mode payment check against a fake Solana RPC (`npm run test:pay`) |
| `scripts/browser-test.mjs` | Payment flow in Chromium with fake wallets (`npm run test:browser`, needs Playwright, see the file) |
| `scripts/setup-server.sh` | One-command install on an Ubuntu VPS: packages, `.env` questions, pm2, Nginx, HTTPS, smoke test |
| `scripts/build-single.mjs` | Builds `dist/vanity.html`, a one-file offline version without Fast mode |

Do not edit `engine/vanity.wgsl` or the verification code in `engine/gpu-engine.js` and `public/index.html` (`openSealed`, `verify`, `selfTest`). Every key shown to a user is re-derived and checked; that is the safety guarantee.

## Requirements

- Node 20 or newer (uses WebCrypto Ed25519).
- For Fast mode on a GPU: an NVIDIA GPU with driver plus the Vulkan loader (`libvulkan1`). The optional npm package `webgpu` (Dawn) talks to Vulkan.
- HTTPS on a real domain. Browsers only allow WebGPU and WebCrypto on secure origins.

## Deploy steps (Ubuntu VPS)

Quickest: on a fresh Ubuntu 22.04/24.04 VPS whose domain already points at it, run `sudo bash scripts/setup-server.sh` from the project folder. It installs Node, pm2, Nginx and certbot, asks the owner for the wallet, RPC URL, prices, contact, name, country and domain (writing `.env`), binds the app to 127.0.0.1 behind Nginx with API rate limits, gets the HTTPS certificate and runs the smoke test. It is safe to run again. The manual steps below do the same by hand.

1. Check the machine:
   ```bash
   node -v || true
   nvidia-smi || echo "no NVIDIA GPU: the server will use CPU threads"
   ```
2. Install Node 22 if missing, plus the Vulkan loader on GPU machines:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   sudo apt-get install -y libvulkan1 vulkan-tools && vulkaninfo --summary   # GPU machines only; must list the NVIDIA GPU
   ```
3. Install and start:
   ```bash
   npm install
   sudo npm i -g pm2
   cp .env.example .env   # then fill in PAY_TO, SOLANA_RPC, SITE_NAME, SITE_URL, contact, OPERATOR_NAME, JURISDICTION with the owner's values
   pm2 start server.js --name vanity
   pm2 install pm2-logrotate
   pm2 save && pm2 startup
   pm2 logs vanity --lines 20   # expect: "engine: gpu (nvidia), ~N keys/sec" on a GPU box
   ```
4. Verify before exposing it:
   ```bash
   npm run smoke -- http://127.0.0.1:8080   # must end with ALL CHECKS PASSED
   npm run test:pay                         # must end with ALL PAYMENT CHECKS PASSED
   ```
5. Nginx + HTTPS (replace the domain):
   ```nginx
   limit_req_zone $binary_remote_addr zone=vanity_api:10m rate=5r/s;
   server {
     server_name getplates.fun www.getplates.fun;
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
     location /api/ {
       limit_req zone=vanity_api burst=20 nodelay;
       limit_req_status 429;
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```
   ```bash
   sudo certbot --nginx -d getplates.fun -d www.getplates.fun
   npm run smoke -- https://getplates.fun
   ```

### Docker instead of PM2 (RunPod, Vast.ai and similar)

```bash
docker build -t solana-vanity .
docker run -d --restart unless-stopped --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility --env-file .env -p 8080:8080 solana-vanity
```

With payments on, keep paid jobs across container rebuilds with a volume: add `-v vanity-data:/data -e PAID_JOBS_FILE=/data/paid-jobs.json`.

## Settings

Put them in `.env` (copy `.env.example`); `server.js` reads it on start, and variables set in the environment win. Mainnet is the default cluster.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. Behind Nginx on the same machine use `HOST=127.0.0.1` (the setup script does), so nobody can skip Nginx |
| `ENGINE` | `auto` | `auto`, `gpu` or `cpu` |
| `CPU_THREADS` | all cores | CPU fallback threads |
| `MAX_EXPECTED_SECONDS` | `3600` | Refuse Fast mode words whose average search is longer |
| `MAX_RUN_SECONDS` | `21600` | Hard cap per job. Free jobs also stop at 5x their average; paid ones run to this cap |
| `MAX_QUEUE` | `25` | Jobs waiting to run at once |
| `MAX_UNPAID` | `50` | Jobs waiting for their payment at once (separate from `MAX_QUEUE`) |
| `PAY_WINDOW_SECONDS` | `900` | How long a job waits for its payment |
| `MAX_JOBS_PER_IP` | `1` | Active Fast mode jobs per visitor |
| `RESULT_TTL_SECONDS` | `3600` | How long a sealed result stays in memory |
| `PAID_RESULT_TTL_SECONDS` | `86400` | The same for paid jobs |
| `ABANDON_SECONDS` | `600` | Cancel jobs whose page stopped checking in |
| `TRUST_PROXY` | `0` | Set `1` behind Nginx so per-IP limits use `X-Forwarded-For` |
| `PAY_TO` | empty | Solana address that receives Fast mode payments. Empty keeps Fast mode free |
| `PRICE_SOL` | `0.01` | Price of one Fast mode job |
| `PRICE_SOL_PER_HOUR` | `0.1` | Added per hour of average search time on this server (prices round to 0.0001 SOL) |
| `SOLANA_CLUSTER` | `mainnet` | `mainnet`, `devnet` or `testnet`. Use `devnet` to try payments with free SOL |
| `SOLANA_RPC` | public RPC of the cluster | The public RPC is rate-limited; use a provider URL (Helius, QuickNode, Triton) in production |
| `PAID_JOBS_FILE` | `./paid-jobs.json` | Where paid jobs wait across restarts (no keys or results, see below) |
| `SITE_NAME` | `Plates` | Brand in the header, title and link previews |
| `SITE_URL` | from the request | Public address, used in link previews |
| `CONTACT_EMAIL` / `CONTACT_TELEGRAM` | empty | Footer, legal page and refund messages. The server warns at startup if payments are on without one |
| `OPERATOR_NAME` | `SITE_NAME` | Who runs the site, named in the legal page |
| `JURISDICTION` | empty | Country whose laws govern the terms |
| `SOURCE_URL` | empty | Public source code link in the footer |

## Troubleshooting

- Log says `payment check failed` or `blockhash failed`: the server cannot use `SOLANA_RPC`. The public RPC rate-limits busy sites; use a provider URL.
- Log says `GPU engine unavailable`: run `vulkaninfo --summary`. No GPU listed means the NVIDIA driver or `libvulkan1` is missing. In Docker, `NVIDIA_DRIVER_CAPABILITIES` must include `graphics`.
- Fast mode toggle not visible on the site: the page could not reach `/api/status`. Check the Nginx proxy.
- Connect wallet lists no installed wallet: the visitor has no Solana wallet extension, or it does not support the Wallet Standard. Phantom, Solflare and Backpack are still offered to install, or to open the page in their app on a phone.
- Link previews show `http://` addresses: set `SITE_URL`, or pass `X-Forwarded-Proto` from Nginx with `TRUST_PROXY=1`.
- Site works but "Your GPU" says not available: the visitor's browser has no WebGPU. It falls back to CPU automatically.

## Before a public launch

- Fast mode is free until `PAY_TO` is set. With it, every job waits as `unpaid` until a Connect wallet payment of the price to `PAY_TO` confirms on chain (see "How payments work" in README.md). Ask the owner for the wallet address, prices, brand, contact, operator name and country; never make one up.
- `public/legal.html` is a template. The owner must have it reviewed before launch.
- Test payments on devnet first: `SOLANA_CLUSTER=devnet`, a devnet wallet with faucet SOL, one real search. Then switch to mainnet with a paid RPC in `SOLANA_RPC`.
- No automatic refunds. Paid jobs that fail are logged with payer and signature; grep the log for `hit the time limit` and `job failed`. The visitor sees the transaction and the contact.
- Monitoring: an uptime check on `/api/status`, `pm2-logrotate`, and alerts on `GPU device lost`, `payment check failed`, `blockhash failed`.
- One server process uses one GPU.
