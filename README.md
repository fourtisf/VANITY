# Plates

[getplates.fun](https://getplates.fun): Solana vanity address generator (wallet or token mint) with three engines. The mascot is Plato, a license plate with a face.

| Engine | Where it runs | Who sees the private key | Best for |
|---|---|---|---|
| **Your GPU** | Visitor's graphics card via WebGPU | Nobody but the visitor | Most names, free |
| **Your CPU** | Visitor's processor via Web Workers | Nobody but the visitor | Fallback when WebGPU is off |
| **Fast mode** (cloud GPU) | This server's GPU (or CPU) | The server, for a moment, before sealing | Long names |

Every engine is verified: GPU hits are re-derived with WebCrypto before they are shown, and server results are decrypted and re-derived in the browser, which rejects any key that does not produce the promised address.

## Project layout

```
server.js              Node server: website + /api + job queue
site.js                Site name, contact and links from environment variables, filled into the pages
brand/                 Plato mascot (plato.svg) and the X profile picture and header banner
engine/vanity.wgsl     GPU shader (SHA-512, ed25519, base58 checks), shared by browser and server
engine/gpu-engine.js   WebGPU host code, shared by browser and server
engine/pattern.js      Pattern parsing and odds, shared by browser and server
engine/cpu-worker.mjs  Server CPU fallback (worker_threads; libsodium when installed, else WebCrypto)
public/index.html      The website
public/legal.html      Terms, privacy and refund policy (templates: have them reviewed)
public/addresses.html  My addresses: with payments on, the paying wallet's addresses and key backups after it signs in
public/fonts/          Self-hosted fonts (SIL Open Font License, see LICENSE.txt there)
public/wallets/        Wallet logos for the Connect wallet list
public/og.png          Link preview image
scripts/build-single.mjs  Builds dist/vanity.html, a one-file version without Fast mode
scripts/setup-server.sh   One-command install on an Ubuntu VPS (pm2, Nginx, HTTPS, .env questions)
scripts/smoke.mjs      End-to-end check of a running server (npm run smoke -- <url>)
scripts/pay-test.mjs   Fast mode payment check against a fake Solana RPC (npm run test:pay)
scripts/browser-test.mjs  The payment flow in a real browser with fake wallets (npm run test:browser)
scripts/chain-test.mjs    The payment sent to a real Solana node and found by the server (npm run test:chain -- <rpc>)
.github/workflows/test.yml  Runs all of the above on every push
```

## Run locally

```bash
npm install          # Node 20+; installs the optional 'webgpu' (Dawn, server GPU) and 'sodium-native' (server CPU) packages
npm start            # http://localhost:8080
```

Without a GPU the server falls back to CPU threads by itself and says so in the log. Those use libsodium from the optional `sodium-native` package, about 5x faster than Node's built-in WebCrypto, which is used when the package is missing: the log line reads `engine: cpu (4 CPU threads, libsodium)` or `(…, WebCrypto)`. Even so, 4 CPU cores make about 130,000 keys a second, while one NVIDIA GPU makes millions.

## Deploy on a GPU VPS (recommended)

Shortcut for an Ubuntu 22.04/24.04 VPS: point the domain's A record at the server, then `git clone https://github.com/fourtisf/VANITY.git /srv/plates/app && cd /srv/plates/app && sudo bash scripts/setup-server.sh`. It asks for the wallet, RPC URL, prices, contact and domain, runs the app as its own `plates` user on a free port behind Nginx with HTTPS, and runs the smoke test. It is safe on a server that already hosts other sites, and running it again updates the code. The steps below are the same thing by hand.

Speed comes from the GPU. A plain CPU VPS works, but it is about as fast as a good laptop.

1. Rent a machine with an NVIDIA GPU (for example RunPod, Vast.ai, Lambda, Hetzner GPU). Ubuntu 22.04 or 24.04.
2. Make sure the NVIDIA driver and Vulkan loader are present:
   ```bash
   nvidia-smi
   sudo apt-get install -y libvulkan1 vulkan-tools
   vulkaninfo --summary     # must list the NVIDIA GPU
   ```
3. Install Node 20+ and the app:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   git clone <repo> vanity && cd vanity && npm install
   ```
4. Fill in the settings and start it under a process manager:
   ```bash
   cp .env.example .env && nano .env    # wallet, RPC key, site name, contact (see Settings)
   sudo npm i -g pm2
   pm2 start server.js --name vanity
   pm2 save && pm2 startup
   ```
   The log should say `engine: gpu (nvidia), ~N keys/sec`. If it says the GPU is unavailable, check `vulkaninfo --summary`.
5. Put Nginx with HTTPS in front (WebGPU and WebCrypto require HTTPS on a real domain). The `limit_req` lines keep one visitor from flooding the API:
   ```nginx
   limit_req_zone $binary_remote_addr zone=vanity_api:10m rate=5r/s;
   server {
     server_name getplates.fun www.getplates.fun;
     location /api/ { limit_req zone=vanity_api burst=20 nodelay; limit_req_status 429; proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
     location / { proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
     listen 443 ssl; # managed by certbot
   }
   ```
   `sudo certbot --nginx -d getplates.fun -d www.getplates.fun`. With `TRUST_PROXY=1` the server then sends HSTS on HTTPS requests.

### Docker (RunPod and similar)

```bash
docker build -t solana-vanity .
docker run --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility --env-file .env -p 8080:8080 solana-vanity
```

## Settings (environment variables)

Put them in `.env` (copy `.env.example`); `server.js` reads it on start, and variables set in the environment win. Mainnet is the default cluster.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. Behind Nginx on the same machine use `HOST=127.0.0.1`, so nobody can skip Nginx |
| `ENGINE` | `auto` | `auto`, `gpu` or `cpu` |
| `CPU_THREADS` | all cores | Threads for the CPU fallback |
| `MAX_EXPECTED_SECONDS` | `3600`, or a week with `PAY_TO` | Refuse names whose average search on this server is longer |
| `SLICE_SECONDS` | `20` | With others waiting, a running search hands the engine over this often and rejoins the line, so a long search never holds up short ones |
| `MAX_RUN_SECONDS` | `21600` | Free jobs stop here or at 5× their average, whichever comes first; paid ones at whichever comes last (5× the average finds 99% of them) |
| `MAX_QUEUE` | `25` | Jobs waiting to run at once |
| `MAX_UNPAID` | `50` | Jobs waiting for their payment at once (separate from `MAX_QUEUE`) |
| `PAY_WINDOW_SECONDS` | `900` | How long a job waits for its payment |
| `MAX_JOBS_PER_IP` | `1` | Active jobs per visitor |
| `RESULT_TTL_SECONDS` | `3600` | How long a finished, sealed result is kept in memory |
| `PAID_RESULT_TTL_SECONDS` | `604800` | The same for paid jobs (a week, for long searches) |
| `ABANDON_SECONDS` | `600` | Cancel jobs whose page stopped checking in |
| `TRUST_PROXY` | `0` | Set `1` behind Nginx so per-IP limits use `X-Forwarded-For` |
| `PAY_TO` | empty | Solana address that receives payments. Empty keeps every search free. Set, every search is paid and runs on this server (see `DEVICE_SEARCH`) |
| `DEVICE_SEARCH` | `off` | With `PAY_TO` set, `on` keeps the free search on the visitor's own device next to paid Fast mode |
| `PRICE_SOL` | `0.01` | Price of one Fast mode job |
| `PRICE_SOL_PER_HOUR` | `0.1` | Added per hour of average search time on this server (prices round to 0.0001 SOL) |
| `SOLANA_CLUSTER` | `mainnet` | `mainnet`, `devnet` or `testnet`. Use `devnet` to try payments with free SOL |
| `SOLANA_RPC` | public RPC of the cluster | The public RPC is rate-limited; use a provider URL (Helius, QuickNode, Triton) in production |
| `PAID_JOBS_FILE` | `./paid-jobs.json` | Where paid jobs wait across restarts (no keys or results, see below) |
| `HISTORY_FILE` | `./history.json` | Each paid address with the wallet that paid for it, listed on My addresses once that wallet signs in, plus its key backup (locked to the wallet, see below) |
| `SITE_NAME` | `Plates` | Brand shown in the header, title and link previews |
| `SITE_URL` | from the request | Public address (`https://getplates.fun`), used in link previews |
| `CONTACT_EMAIL` / `CONTACT_TELEGRAM` | empty | Shown in the footer, the legal page and refund messages. Set one before taking payments |
| `OPERATOR_NAME` | `SITE_NAME` | Person or company that runs the site, named in the legal page |
| `JURISDICTION` | empty | Country whose laws govern the terms, for example `Indonesia` |
| `SOURCE_URL` | empty | Link to the public source code, shown in the footer when set |

## How the server keeps keys private

1. The browser creates an RSA-OAEP 3072 key pair and sends only the public half with the job.
2. The server finds the key, encrypts it with a fresh AES-256-GCM key, wraps that with the browser's RSA key, wipes the plaintext, and keeps only the sealed copy in memory.
3. The browser unwraps it, re-derives the address, and rejects anything that does not match.
4. Keys and results live only in memory and expire after `RESULT_TTL_SECONDS`; they are never written to disk. With payments on, a paid job whose result has not reached the browser is saved to `PAID_JOBS_FILE` as its request only (the pattern, the browser's public key and the payment), so a restart runs it again instead of losing it.

The server still sees each key for a moment while sealing it. The website says this plainly and recommends keeping Fast mode off for wallets that will hold real funds.

### Key backups on My addresses

With payments on, My addresses stays empty until the visitor connects the wallet they paid with and signs a one-time sign-in message (`POST /api/history/challenge`, then `POST /api/history`). It then lists that wallet's addresses, and **Show private key** opens a key from its backup:

1. Before paying, the page asks the wallet to sign a fixed "key vault" message naming the site and the wallet. HKDF-SHA-256 over that signature gives an AES-256-GCM key, kept in the page (and in IndexedDB with the job, as a key that cannot be exported), never sent.
2. When the result opens and checks out, the page locks the key with it (the address is the associated data) and leaves the locked copy with the server once (`POST /api/jobs/:id/vault`, accepted only for the paying wallet). It is stored in `HISTORY_FILE` with the address.
3. On My addresses, the wallet signs the same message again. Ed25519 signatures are deterministic, so it derives the same key on any device, opens the copy, and the page checks the key against its address before showing it.

The server stores only the locked copy and cannot open it. A wallet that signs differently each time (some multi-party wallets) could never open its keys, so a second backup whose check value differs from the wallet's first is refused. Signed in, the wallet can add keypair files (backed up the same way), lists and pasted addresses (`POST /api/vault`), give an address without a backup the key saved when it was made (**Add key**: pasted as copied, or its keypair file, checked against the address and locked the same way), and remove an address with its backup (`POST /api/vault/delete`); a sign-in lasts an hour. The vault message warns to sign it only on this site, since anyone with that signature and the stored copies could open the keys.

## Before a public launch

- **Turn on payments.** Without `PAY_TO` anyone can queue a free server job, limited per IP and by `MAX_EXPECTED_SECONDS`. Set `PAY_TO` to your wallet address and every search is a paid server job costing `PRICE_SOL + PRICE_SOL_PER_HOUR × average hours`: the page drops the free search on the visitor's device, and its texts and the legal page say so. `DEVICE_SEARCH=on` keeps the free device search next to paid Fast mode.
- **Say who you are.** Set `SITE_NAME`, `SITE_URL`, `CONTACT_EMAIL` or `CONTACT_TELEGRAM`, `OPERATOR_NAME` and `JURISDICTION`. Have `public/legal.html` checked by someone who knows the law where you operate; it is a starting point, not legal advice.
- **Try it on devnet first.** Start with `SOLANA_CLUSTER=devnet`, switch your wallet to devnet, get free SOL from the faucet, and run one search end to end. Then switch to mainnet with a provider URL in `SOLANA_RPC` and pay for one search yourself. `npm run smoke -- <url>` also checks that the server reaches the RPC.
- **Watch it.** See Monitoring below.
- One server process uses one GPU. For more GPUs, run one process per GPU and split traffic, or add a coordinator.
- The API: `GET /api/status`, `POST /api/jobs`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id`, `GET /api/blockhash` (for transfers the page builds), and with payments on `POST /api/jobs/:id/paid`, `POST /api/jobs/:id/send`, `POST /api/jobs/:id/vault`, `POST /api/history/challenge`, `POST /api/history`, `POST /api/vault` and `POST /api/vault/delete`.

## Connect wallet

The header has a Connect wallet button for every visitor, paid Fast mode or not; it needs nothing from the site owner. It lists the wallets installed in the browser (Wallet Standard) with their logos, plus Phantom, Solflare and Backpack to install or to open the page in on a phone. Once connected, the header shows the wallet and its short address, with Copy address, Change wallet and Disconnect. The same connection pays for Fast mode. A wallet connects only when the visitor picks it; the one used last is listed first. My addresses opens in a new tab, so a key that is not saved yet stays on the result.

## How payments work

1. `POST /api/jobs` returns the job as `unpaid` with a price, a fresh Solana Pay reference key and `PAY_WINDOW_SECONDS` to pay.
2. The visitor presses Connect wallet and picks a wallet. Installed wallets are found through the Wallet Standard and listed with their own logos, whichever wallet it is. Phantom, Solflare and Backpack are also suggested when missing: install links on a computer, and on a phone links that reopen the page inside the wallet app with the search filled in.
3. The page builds one System Program transfer to `PAY_TO` that lists the reference as an extra read-only account, and the wallet signs and sends it. The page reports the signature (`POST /api/jobs/:id/paid`) and the server checks it every 2 seconds. It also looks the reference up on chain every 10 seconds, which finds a payment whose page closed before reporting it.
4. The server accepts a confirmed, successful transaction that lists the reference and raised `PAY_TO`'s balance by at least the price. Each transaction pays for one job only.
5. If the wallet cannot send the transfer itself but can sign it, the page posts the signed transaction to `POST /api/jobs/:id/send`. The server sends it through `SOLANA_RPC` only if it is exactly that job's payment: one signer, one System transfer of at least the price to `PAY_TO` listing the reference, and nothing else but compute budget instructions.
5. The job then joins the queue, which takes turns (`SLICE_SECONDS`). Paid jobs run until they find the address (up to `MAX_RUN_SECONDS` or 5× their average, whichever is longer), keep running if the page closes or loses its connection, and survive a server restart through `PAID_JOBS_FILE`. The page picks the result up when it comes back, within `PAID_RESULT_TTL_SECONDS` of the finish.

There are no automatic refunds. A paid job that fails is logged with the payer and the transaction signature, and the page shows the visitor that transaction and your contact, so you can refund by hand (`grep "hit the time limit\|job failed" ~/.pm2/logs/vanity-out.log`). Unpaid jobs are dropped when their window closes or after `ABANDON_SECONDS` without a check-in, after one last look for the payment.

## Monitoring

- Uptime: point a monitor such as UptimeRobot or Better Stack at `https://your-domain/api/status`; it answers JSON with the engine and queue length.
- Logs: `pm2 install pm2-logrotate` keeps them from filling the disk. Lines worth an alert: `GPU device lost` (the process restarts itself), `payment check failed` or `blockhash failed` (the RPC is down or rate-limiting), `hit the time limit` and `job failed` (refunds).
- Tests: `npm run smoke -- <url>` against the live site after each deploy. GitHub Actions runs the smoke test, the payment test, the browser test, the one-file build, and the real-chain test (payments sent to a local Agave validator) on every push. `npm run test:chain -- https://api.devnet.solana.com` runs the real-chain test on devnet from any machine (set `PAYER_KEYPAIR` to a funded devnet keypair if the faucet refuses).
