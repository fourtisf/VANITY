# Solana Vanity

Solana vanity address generator (wallet or token mint) with three engines:

| Engine | Where it runs | Who sees the private key | Best for |
|---|---|---|---|
| **Your GPU** | Visitor's graphics card via WebGPU | Nobody but the visitor | Most names, free |
| **Your CPU** | Visitor's processor via Web Workers | Nobody but the visitor | Fallback when WebGPU is off |
| **Fast mode** (cloud GPU) | This server's GPU (or CPU) | The server, for a moment, before sealing | Long names |

Every engine is verified: GPU hits are re-derived with WebCrypto before they are shown, and server results are decrypted and re-derived in the browser, which rejects any key that does not produce the promised address.

## Project layout

```
server.js              Node server: website + /api + job queue
engine/vanity.wgsl     GPU shader (SHA-512, ed25519, base58 checks), shared by browser and server
engine/gpu-engine.js   WebGPU host code, shared by browser and server
engine/pattern.js      Pattern parsing and odds, shared by browser and server
engine/cpu-worker.mjs  Server CPU fallback (worker_threads)
public/index.html      The website
scripts/build-single.mjs  Builds dist/vanity.html, a one-file version without Fast mode
```

## Run locally

```bash
npm install          # Node 20+; installs the optional 'webgpu' package (Dawn) for the server GPU
npm start            # http://localhost:8080
```

Without a GPU the server falls back to CPU threads by itself and says so in the log.

## Deploy on a GPU VPS (recommended)

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
4. Start it under a process manager:
   ```bash
   sudo npm i -g pm2
   PORT=8080 TRUST_PROXY=1 pm2 start server.js --name vanity
   pm2 save && pm2 startup
   ```
   The log should say `engine: gpu (nvidia), ~N keys/sec`. If it says the GPU is unavailable, check `vulkaninfo --summary`.
5. Put Nginx with HTTPS in front (WebGPU and WebCrypto require HTTPS on a real domain):
   ```nginx
   server {
     server_name vanity.example.com;
     location / { proxy_pass http://127.0.0.1:8080; proxy_set_header X-Forwarded-For $remote_addr; }
     listen 443 ssl; # managed by certbot
   }
   ```
   `sudo certbot --nginx -d vanity.example.com`

### Docker (RunPod and similar)

```bash
docker build -t solana-vanity .
docker run --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility -p 8080:8080 solana-vanity
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen |
| `ENGINE` | `auto` | `auto`, `gpu` or `cpu` |
| `CPU_THREADS` | all cores | Threads for the CPU fallback |
| `MAX_EXPECTED_SECONDS` | `3600` | Refuse names whose average search on this server is longer |
| `MAX_RUN_SECONDS` | `21600` | Hard cap per job (each job also stops at 5× its average) |
| `MAX_QUEUE` | `25` | Jobs waiting at once |
| `MAX_JOBS_PER_IP` | `1` | Active jobs per visitor |
| `RESULT_TTL_SECONDS` | `3600` | How long a finished, sealed result is kept in memory |
| `ABANDON_SECONDS` | `600` | Cancel jobs whose page stopped checking in |
| `TRUST_PROXY` | `0` | Set `1` behind Nginx so per-IP limits use `X-Forwarded-For` |

## How the server keeps keys private

1. The browser creates an RSA-OAEP 3072 key pair and sends only the public half with the job.
2. The server finds the key, encrypts it with a fresh AES-256-GCM key, wraps that with the browser's RSA key, wipes the plaintext, and keeps only the sealed copy in memory.
3. The browser unwraps it, re-derives the address, and rejects anything that does not match.
4. Jobs and results live only in memory and expire after `RESULT_TTL_SECONDS`. Nothing is written to disk.

The server still sees each key for a moment while sealing it. The website says this plainly and recommends keeping Fast mode off for wallets that will hold real funds.

## Before a public launch

- **Payment is not built in.** Right now anyone can queue a server job. Either keep `MAX_EXPECTED_SECONDS` low, or add a SOL payment check in `createJob` (server.js) before the job is queued.
- One server process uses one GPU. For more GPUs, run one process per GPU and split traffic, or add a coordinator.
- The API: `GET /api/status`, `POST /api/jobs`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id`.
