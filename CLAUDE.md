# Solana Vanity: deploy guide for Claude Code

This repo is finished and tested. The job is to deploy it, not to rebuild it. Do not rewrite the engine or the page design.

## What it is

A website that creates Solana wallet or token addresses starting or ending with a chosen word.

- **On-device (default):** the visitor's own GPU (WebGPU) or CPU (Web Workers) grinds keys in the browser. Nothing is sent to the server.
- **Fast mode (optional):** the visitor's browser sends the pattern plus an RSA public key. This server grinds on its GPU, seals the key (RSA-OAEP 3072 + AES-256-GCM), and the browser opens and re-verifies it.

## Files

| Path | Role |
|---|---|
| `server.js` | Node server: serves `public/` and `engine/`, runs the Fast mode job queue (`/api/*`) |
| `public/index.html` | The whole website (HTML, CSS, app JS) |
| `engine/vanity.wgsl` | GPU shader: SHA-512, ed25519, base58 checks. Shared by browser and server |
| `engine/gpu-engine.js` | WebGPU host code. Shared by browser and server |
| `engine/pattern.js` | Pattern parsing and odds. Shared by browser and server |
| `engine/cpu-worker.mjs` | Server CPU fallback |
| `scripts/smoke.mjs` | End-to-end check of a running server (`npm run smoke -- <url>`) |
| `scripts/build-single.mjs` | Builds `dist/vanity.html`, a one-file offline version without Fast mode |

Do not edit `engine/vanity.wgsl` or the verification code in `engine/gpu-engine.js` and `public/index.html` (`openSealed`, `verify`, `selfTest`). Every key shown to a user is re-derived and checked; that is the safety guarantee.

## Requirements

- Node 20 or newer (uses WebCrypto Ed25519).
- For Fast mode on a GPU: an NVIDIA GPU with driver plus the Vulkan loader (`libvulkan1`). The optional npm package `webgpu` (Dawn) talks to Vulkan.
- HTTPS on a real domain. Browsers only allow WebGPU and WebCrypto on secure origins.

## Deploy steps (Ubuntu VPS)

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
   PORT=8080 TRUST_PROXY=1 MAX_EXPECTED_SECONDS=3600 pm2 start server.js --name vanity
   pm2 save && pm2 startup
   pm2 logs vanity --lines 20   # expect: "engine: gpu (nvidia), ~N keys/sec" on a GPU box
   ```
4. Verify before exposing it:
   ```bash
   npm run smoke -- http://127.0.0.1:8080   # must end with ALL CHECKS PASSED
   ```
5. Nginx + HTTPS (replace the domain):
   ```nginx
   server {
     server_name vanity.example.com;
     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $remote_addr;
     }
   }
   ```
   ```bash
   sudo certbot --nginx -d vanity.example.com
   npm run smoke -- https://vanity.example.com
   ```

### Docker instead of PM2 (RunPod, Vast.ai and similar)

```bash
docker build -t solana-vanity .
docker run -d --restart unless-stopped --gpus all -e NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility -e TRUST_PROXY=1 -p 8080:8080 solana-vanity
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen |
| `ENGINE` | `auto` | `auto`, `gpu` or `cpu` |
| `CPU_THREADS` | all cores | CPU fallback threads |
| `MAX_EXPECTED_SECONDS` | `3600` | Refuse Fast mode words whose average search is longer |
| `MAX_RUN_SECONDS` | `21600` | Hard cap per job (each job also stops at 5x its average) |
| `MAX_QUEUE` | `25` | Jobs waiting at once |
| `MAX_JOBS_PER_IP` | `1` | Active Fast mode jobs per visitor |
| `RESULT_TTL_SECONDS` | `3600` | How long a sealed result stays in memory |
| `ABANDON_SECONDS` | `600` | Cancel jobs whose page stopped checking in |
| `TRUST_PROXY` | `0` | Set `1` behind Nginx so per-IP limits use `X-Forwarded-For` |

## Troubleshooting

- Log says `GPU engine unavailable`: run `vulkaninfo --summary`. No GPU listed means the NVIDIA driver or `libvulkan1` is missing. In Docker, `NVIDIA_DRIVER_CAPABILITIES` must include `graphics`.
- Fast mode toggle not visible on the site: the page could not reach `/api/status`. Check the Nginx proxy.
- Site works but "Your GPU" says not available: the visitor's browser has no WebGPU. It falls back to CPU automatically.

## Before a public launch

- Fast mode has no payment yet. Anyone can queue jobs, limited per IP and by `MAX_EXPECTED_SECONDS`. Add a SOL payment check in `createJob` in `server.js` before queueing, or keep the limit low.
- One server process uses one GPU.
