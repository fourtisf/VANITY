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
| `public/index.html` | The whole website (HTML, CSS, app JS), including Connect wallet (header) and Fast mode payment |
| `public/legal.html` | Terms, privacy and refund policy templates |
| `public/addresses.html` | My addresses (served at `/addresses`). With `PAY_TO`: empty until the paying wallet signs in (`/api/history`, signed message), then that wallet's addresses, and **Show private key** opens a key backup locked to the wallet (see "Key backups" in README.md). Without `PAY_TO`: the addresses made in this browser (localStorage), never keys. Balances on request through `/api/balances` |
| `engine/vanity.wgsl` | GPU shader: SHA-512, ed25519, base58 checks. Shared by browser and server |
| `engine/gpu-engine.js` | WebGPU host code. Shared by browser and server |
| `engine/pattern.js` | Pattern parsing and odds. Shared by browser and server |
| `engine/cpu-worker.mjs` | Server CPU fallback: libsodium (optional npm package `sodium-native`), else WebCrypto |
| `scripts/smoke.mjs` | End-to-end check of a running server (`npm run smoke -- <url>`) |
| `scripts/pay-test.mjs` | Fast mode payment check against a fake Solana RPC (`npm run test:pay`) |
| `scripts/browser-test.mjs` | Payment flow in Chromium with fake wallets (`npm run test:browser`, needs Playwright, see the file) |
| `scripts/chain-test.mjs` | Payments sent to a real Solana node, found by the server, checked on chain (`npm run test:chain -- <rpc>`; CI uses a local Agave validator) |
| `scripts/setup-server.sh` | One-command install on an Ubuntu VPS: packages, `.env` questions, pm2, Nginx, HTTPS, smoke test |
| `scripts/build-single.mjs` | Builds `dist/vanity.html`, a one-file offline version without Fast mode |

Do not edit `engine/vanity.wgsl` or the verification code in `engine/gpu-engine.js` and `public/index.html` (`openSealed`, `verify`, `selfTest`). Every key shown to a user is re-derived and checked; that is the safety guarantee.

## Requirements

- Node 20 or newer (uses WebCrypto Ed25519).
- For Fast mode on a GPU: an NVIDIA GPU with driver plus the Vulkan loader (`libvulkan1`). The optional npm package `webgpu` (Dawn) talks to Vulkan.
- Without a GPU, Fast mode runs on CPU threads with the optional npm package `sodium-native` (libsodium, about 32,000 keys/sec per core). If it fails to install, the server uses WebCrypto, about 5x slower. The log line `engine: cpu (N CPU threads, libsodium)` shows which one runs.
- HTTPS on a real domain. Browsers only allow WebGPU and WebCrypto on secure origins.

## Deploy steps (Ubuntu VPS)

Quickest, on an Ubuntu 22.04/24.04 VPS whose domain already points at it (the repo is public, no GitHub key needed):

```bash
git clone https://github.com/fourtisf/VANITY.git /srv/plates/app
cd /srv/plates/app && bash scripts/setup-server.sh      # as root, or with sudo
```

It installs what is missing (Node, pm2, Nginx, certbot), runs the app as its own `plates` user on a free port bound to 127.0.0.1, asks the owner for the wallet, RPC URL, prices, contact, name, country and domain (writing `.env`), adds an Nginx site with API rate limits, gets the HTTPS certificate and runs the smoke test. It leaves other projects on a shared server alone. Running it again pulls the latest code and restarts the app. The manual steps below do the same by hand.

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

With payments on, keep paid jobs and the address history across container rebuilds with a volume: add `-v vanity-data:/data -e PAID_JOBS_FILE=/data/paid-jobs.json -e HISTORY_FILE=/data/history.json`.

## Settings

Put them in `.env` (copy `.env.example`); `server.js` reads it on start, and variables set in the environment win. Mainnet is the default cluster.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. Behind Nginx on the same machine use `HOST=127.0.0.1` (the setup script does), so nobody can skip Nginx |
| `ENGINE` | `auto` | `auto`, `gpu` or `cpu` |
| `CPU_THREADS` | all cores | CPU fallback threads |
| `MAX_EXPECTED_SECONDS` | `3600`, or a week with `PAY_TO` | Refuse words whose average search is longer |
| `MAX_RUN_SECONDS` | `21600` | Free jobs stop here or at 5x their average, whichever comes first; paid ones at whichever comes last |
| `SLICE_SECONDS` | `20` | With other searches waiting, a running one hands the engine over this often and goes to the back of the line, so long searches never hold up short ones |
| `MAX_QUEUE` | `25` | Jobs waiting to run at once |
| `MAX_UNPAID` | `50` | Jobs waiting for their payment at once (separate from `MAX_QUEUE`) |
| `PAY_WINDOW_SECONDS` | `900` | How long a job waits for its payment |
| `MAX_JOBS_PER_IP` | `1` | Active Fast mode jobs per visitor |
| `RESULT_TTL_SECONDS` | `3600` | How long a sealed result stays in memory |
| `PAID_RESULT_TTL_SECONDS` | `604800` | The same for paid jobs (a week, for long searches) |
| `ABANDON_SECONDS` | `600` | Cancel jobs whose page stopped checking in |
| `TRUST_PROXY` | `0` | Set `1` behind Nginx so per-IP limits use `X-Forwarded-For` |
| `PAY_TO` | empty | Solana address that receives payments. Empty keeps every search free. Set, every search is paid and runs on this server (see `DEVICE_SEARCH`) |
| `DEVICE_SEARCH` | `off` | With `PAY_TO` set, `on` keeps the free search on the visitor's own device next to paid Fast mode. Without `PAY_TO` the device search is always on |
| `PRICE_SOL` | `0.01` | Price of one Fast mode job |
| `PRICE_SOL_PER_HOUR` | `0.1` | Added per hour of average search time on this server (prices round to 0.0001 SOL) |
| `SOLANA_CLUSTER` | `mainnet` | `mainnet`, `devnet` or `testnet`. Use `devnet` to try payments with free SOL |
| `SOLANA_RPC` | public RPC of the cluster | The public RPC is rate-limited; use a provider URL (Helius, QuickNode, Triton) in production |
| `PAID_JOBS_FILE` | `./paid-jobs.json` | Where paid jobs wait across restarts (no keys or results, see below) |
| `HISTORY_FILE` | `./history.json` | Paid addresses with the wallet that paid, for My addresses, with key backups the server cannot open (locked with the wallet's signature). Back it up |
| `SITE_NAME` | `Plates` | Brand in the header, title and link previews |
| `SITE_URL` | from the request | Public address, used in link previews |
| `CONTACT_EMAIL` / `CONTACT_TELEGRAM` | empty | Footer, legal page and refund messages. The server warns at startup if payments are on without one |
| `OPERATOR_NAME` | `SITE_NAME` | Who runs the site, named in the legal page |
| `JURISDICTION` | empty | Country whose laws govern the terms |
| `SOURCE_URL` | empty | Public source code link in the footer |
| `X_URL` | `https://x.com/platesfun` | X account in the header, under the headline and in the footer; `off` hides it |
| `TOKEN_CA` | empty | Token contract address under the headline and in the footer; empty shows "CA: Coming soon" |

## Troubleshooting

- A visitor's payment fails: the pay box shows the wallet's own reason (cancelled, not enough SOL, or its message), and the page checks the wallet's balance before asking it to pay. Wallets that cannot send the payment themselves but can sign it (some report only `[object Object]`) are covered: the page has the server send the signed payment through `POST /api/jobs/:id/send`, which accepts only that job's exact payment. The log then says `payment sent for the wallet`.
- Log says `payment check failed` or `blockhash failed`: the server cannot use `SOLANA_RPC`. The public RPC rate-limits busy sites; use a provider URL.
- Log says `no GPU driver (Vulkan) on this machine, using CPU threads`: normal on a server without a GPU. With `ENGINE=auto` the server only tries the GPU when a Vulkan driver is installed, so Dawn's `vkCreateInstance: Found no drivers` warnings no longer fill the error log.
- Log says `GPU engine unavailable`: run `vulkaninfo --summary`. No GPU listed means the NVIDIA driver or `libvulkan1` is missing. In Docker, `NVIDIA_DRIVER_CAPABILITIES` must include `graphics`.
- Fast mode toggle not visible on the site: the page could not reach `/api/status`. Check the Nginx proxy.
- Connect wallet is in the header for every visitor and needs no `PAY_TO`; it hides only when the page cannot reach the server (`/api/status`), as in the offline one-file build.
- Connect wallet lists no installed wallet: the visitor has no Solana wallet extension, or it does not support the Wallet Standard. Phantom, Solflare and Backpack are still offered to install, or to open the page in their app on a phone.
- Link previews show `http://` addresses: set `SITE_URL`, or pass `X-Forwarded-Proto` from Nginx with `TRUST_PROXY=1`.
- Site works but "Your GPU" says not available: the visitor's browser has no WebGPU. It falls back to CPU automatically.

## Before a public launch

- Fast mode is free until `PAY_TO` is set. With it, the page offers only paid searches on this server (no free device search unless `DEVICE_SEARCH=on`; its texts and the legal page switch to match), and every job waits as `unpaid` until a Connect wallet payment of the price to `PAY_TO` confirms on chain (see "How payments work" in README.md). Ask the owner for the wallet address, prices, brand, contact, operator name and country; never make one up.
- `public/legal.html` is a template. The owner must have it reviewed before launch.
- Test payments on devnet first: `SOLANA_CLUSTER=devnet`, a devnet wallet with faucet SOL, one real search. Then switch to mainnet with a paid RPC in `SOLANA_RPC`.
- No automatic refunds. Paid jobs that fail are logged with payer and signature; grep the log for `hit the time limit` and `job failed`. The visitor sees the transaction and the contact.
- Monitoring: an uptime check on `/api/status`, `pm2-logrotate`, and alerts on `GPU device lost`, `payment check failed`, `blockhash failed`.
- One server process uses one GPU.
