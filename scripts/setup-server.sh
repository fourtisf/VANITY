#!/usr/bin/env bash
# Puts Plates live on an Ubuntu 22.04/24.04 server: system packages, the app under pm2, Nginx, HTTPS with
# Let's Encrypt, then the smoke test. Run it from the project folder:
#
#   sudo bash scripts/setup-server.sh
#
# Running it again updates the site: it pulls the latest code, keeps .env, the Nginx site and the certificate,
# restarts the app and re-runs the checks. It is careful on a server shared with other projects: the app runs
# as its own user, takes a free port, and Node, Nginx and certbot are only installed when missing.
# DRY_RUN=1 prints the system commands instead of running them (used to test the script).
set -euo pipefail
# Everything sits in one { } block that bash reads in full before running, so the `git pull` in step 2 can
# rewrite this file safely.
{
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The app runs as its own user: the one who called sudo, or "plates" when logged in as root. It cannot touch
# other projects on the server, and they cannot read its .env.
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then APP_USER=$SUDO_USER; else APP_USER=plates; fi
ENV_FILE="$APP_DIR/.env"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/plates}"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ -n "${DRY_RUN:-}" ]; then echo "+ $*"; else "$@"; fi; }
ask()  { local a; read -r -p "$1${2:+ [$2]}: " a || true; printf '%s' "${a:-${2:-}}"; }
as_user() { run sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }
port_free() { ! ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
install_node() { if [ -n "${DRY_RUN:-}" ]; then echo "+ install Node 22 from NodeSource"; else curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; fi; }
# Writes KEY=VALUE into .env, replacing the line if it is there; values may hold any character.
set_env() { K="$1" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k "=")==1 {print k "=" v; d=1; next} {print} END{if(!d) print k "=" v}' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; }
get_env() { awk -F= -v k="$1" '$1==k {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE"; }
is_address() { node -e 'const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";let n=0n,l=0;const s=process.argv[1]||"";for(const c of s){const d=A.indexOf(c);if(d<0)process.exit(1);n=n*58n+BigInt(d)}while(n>0n){n>>=8n;l++}for(const c of s){if(c!=="1")break;l++}process.exit(l===32?0:1)' "$1"; }

if [ -z "${DRY_RUN:-}" ]; then
  [ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash scripts/setup-server.sh"
  [ -d /run/systemd/system ] || die "this machine has no systemd (RunPod, Vast.ai and other containers). Use the Docker steps in CLAUDE.md instead."
fi
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu. On other systems follow the deploy steps in CLAUDE.md."
case "$APP_DIR" in /root/*) die "the project is inside /root, which the app user cannot read. Move it first:
  mkdir -p /srv/plates && mv '$APP_DIR' /srv/plates/app && cd /srv/plates/app && bash scripts/setup-server.sh";; esac

say "1/7 System packages"
need=()
for p in ca-certificates curl gnupg git nginx dnsutils; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
command -v certbot >/dev/null || need+=(certbot python3-certbot-nginx)
if [ ${#need[@]} -gt 0 ]; then run apt-get update -y; run apt-get install -y "${need[@]}"; else echo "Nginx, certbot, git and curl are already installed."; fi
if ! command -v node >/dev/null; then
  install_node
elif [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  warn "Node $(node -v) is installed and other apps on this server may rely on it. Plates needs Node 20 or newer."
  [ "$(ask "Upgrade Node to 22 for the whole server? type yes or no" no)" = yes ] || die "stopped without touching Node. Install Node 20+ (or answer yes) and run this script again."
  install_node
fi
if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU found: adding the Vulkan loader for the GPU engine"
  run apt-get install -y libvulkan1 vulkan-tools
else
  warn "No NVIDIA GPU found. Fast mode will run on CPU threads (slower, but it works)."
fi
command -v pm2 >/dev/null || run npm install -g pm2
if ! id "$APP_USER" >/dev/null 2>&1; then run useradd --system --home-dir "/srv/$APP_USER" --shell /bin/bash "$APP_USER"; fi
# pm2 and npm keep their files in the user's home, which `git clone` may have created as root.
home=$(getent passwd "$APP_USER" | cut -d: -f6 || true); home=${home:-/srv/$APP_USER}
run mkdir -p "$home"
run chown "$APP_USER": "$home"
run chown -R "$APP_USER": "$APP_DIR"

say "2/7 Latest code and dependencies"
if [ -d "$APP_DIR/.git" ]; then as_user "git pull --ff-only" || warn "could not pull the latest code; carrying on with the copy that is here"; fi
as_user "npm install --omit=dev --no-audit --no-fund"

say "3/7 Settings (.env)"
if [ -f "$ENV_FILE" ]; then
  echo "Keeping the existing $ENV_FILE. To change it: nano $ENV_FILE, then run this script again."
else
  # Answers go into a draft that becomes .env only once all of them are in, so stopping halfway leaves nothing.
  final_env=$ENV_FILE; ENV_FILE="$final_env.draft"
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  trap 'rm -f "$ENV_FILE"' EXIT
  # Another project may already listen on 8080; take the first free port from there.
  p=8080; while ! port_free "$p"; do p=$((p + 1)); done
  [ "$p" = 8080 ] || warn "port 8080 is taken by another app on this server, so Plates will use port $p"
  set_env PORT "$p"
  [ -t 0 ] || [ -n "${DRY_RUN:-}" ] || die "run this script in a terminal: it asks a few questions"
  echo "Answer a few questions. Press Enter to accept the value in [brackets]."
  while :; do
    cluster=$(ask "Network: mainnet for real SOL, devnet for free test SOL" mainnet)
    case "$cluster" in mainnet|mainet|main|m) cluster=mainnet; break;; devnet|dev|d) cluster=devnet; break;; esac
    warn "type mainnet or devnet"
  done
  echo
  echo "Fast mode is the paid option: a customer pays SOL before their search runs on this server."
  echo "Give the PUBLIC address of the wallet that should receive that money (Phantom: click your account name to copy it)."
  echo "Never paste a private key or seed phrase here. Press Enter to keep Fast mode free and take no payments."
  while :; do
    pay_to=$(ask "Wallet address that receives the payments" "")
    [ -z "$pay_to" ] && break
    is_address "$pay_to" && break
    warn "that is not a Solana address (44 characters like 7xKq...). Copy it from Phantom or Solflare."
  done
  rpc="" price=0.01 per_hour=0.1
  if [ -n "$pay_to" ]; then
    rpc=$(ask "RPC URL with your key from Helius or QuickNode (Enter = Solana's public RPC, rate-limited)" "")
    [ "$cluster" = mainnet ] && [ -z "$rpc" ] && warn "public mainnet RPC: fine to start, but get a free Helius key before you get busy"
    price=$(ask "Price per Fast mode search in SOL" "0.01")
    per_hour=$(ask "Extra SOL per hour of average search time" "0.1")
  else
    warn "no wallet given: Fast mode stays free. To charge later, put your address in PAY_TO in $final_env and run this script again."
  fi
  while :; do
    email=$(ask "Contact email for customers (Enter to skip)" "")
    telegram=$(ask "Contact Telegram username without @ (Enter to skip)" "")
    [ -n "$email$telegram" ] || [ -z "$pay_to" ] && break
    warn "give at least one: paying customers need a way to reach you for refunds"
  done
  operator=$(ask "Your name or company, shown on the legal page" "Plates")
  country=$(ask "Country whose laws govern the terms" "Indonesia")
  domain=$(ask "Domain" "getplates.fun")
  set_env SOLANA_CLUSTER "$cluster"
  set_env PAY_TO "$pay_to"
  set_env SOLANA_RPC "$rpc"
  set_env PRICE_SOL "$price"
  set_env PRICE_SOL_PER_HOUR "$per_hour"
  set_env CONTACT_EMAIL "$email"
  set_env CONTACT_TELEGRAM "$telegram"
  set_env OPERATOR_NAME "$operator"
  set_env JURISDICTION "$country"
  set_env SITE_URL "https://$domain"
  mv "$ENV_FILE" "$final_env"; ENV_FILE=$final_env
  trap - EXIT
fi
# Only Nginx may reach the app: on 0.0.0.0 anyone could skip HTTPS and fake X-Forwarded-For past the per-visitor limits.
set_env HOST 127.0.0.1
set_env TRUST_PROXY 1
PORT=$(get_env PORT); PORT=${PORT:-8080}
chmod 600 "$ENV_FILE"
run chown "$APP_USER": "$ENV_FILE"
domain=$(get_env SITE_URL | sed -E 's#^https?://##; s#/.*$##')
[ -n "$domain" ] || die "SITE_URL is empty in $ENV_FILE"

say "4/7 Start the app (pm2)"
as_user "pm2 describe vanity >/dev/null 2>&1 && pm2 restart vanity --update-env || pm2 start server.js --name vanity"
as_user "pm2 save"
run env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$home" >/dev/null
as_user "pm2 module:list 2>/dev/null | grep -q pm2-logrotate || pm2 install pm2-logrotate"
if [ -z "${DRY_RUN:-}" ]; then
  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null || die "the app did not start. Look at: pm2 logs vanity --lines 50"
  as_user "pm2 logs vanity --lines 8 --nostream"
fi

say "5/7 Nginx for $domain"
if [ -f "$NGINX_SITE" ]; then
  echo "Keeping the existing $NGINX_SITE (certbot adds its HTTPS lines to it)."
else
  cat > "$NGINX_SITE" <<NGINX
# Plates: written by scripts/setup-server.sh. certbot adds the HTTPS server to this file.
limit_req_zone \$binary_remote_addr zone=plates_api:10m rate=5r/s;
server {
  listen 80;
  server_name $domain www.$domain;
  client_max_body_size 64k;
  location /api/ {
    limit_req zone=plates_api burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINX
fi
run ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/plates
run nginx -t
run systemctl reload nginx
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then run ufw allow 'Nginx Full'; fi

say "6/7 HTTPS certificate"
ip=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || true)
names=()
for n in "$domain" "www.$domain"; do
  a=$(dig +short A "$n" 2>/dev/null | tail -n 1 || true)
  if [ -n "$ip" ] && [ "$a" = "$ip" ]; then names+=(-d "$n"); else warn "$n points to '${a:-nothing}', this server is '${ip:-unknown}'"; fi
done
https=0
if [ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
  echo "The certificate for $domain is already there; certbot renews it by itself."
  https=1
elif [ ${#names[@]} -eq 0 ]; then
  warn "No DNS record points here yet. At your domain registrar add an A record: @ -> ${ip:-the IP of this server} (and www -> the same), wait a few minutes, then run this script again."
else
  le_email=$(get_env CONTACT_EMAIL)
  [ -n "$le_email" ] || le_email=$(ask "Email for Let's Encrypt certificate notices")
  run certbot --nginx "${names[@]}" --non-interactive --agree-tos -m "$le_email" --redirect && https=1
fi

say "7/7 Checks"
if [ "$https" = 1 ]; then
  as_user "npm run smoke -- https://$domain" || warn "the smoke test failed: read the message above, then: pm2 logs vanity --lines 50"
else
  as_user "npm run smoke -- http://127.0.0.1:$PORT" || warn "the smoke test failed: read the message above, then: pm2 logs vanity --lines 50"
fi

cluster=$(get_env SOLANA_CLUSTER)
say "Done"
if [ "$https" = 1 ]; then echo "Your site: https://$domain"; else echo "The app runs; HTTPS waits for DNS (step 6)."; fi
pay_to=$(get_env PAY_TO)
if [ -n "$pay_to" ]; then echo "Network: ${cluster:-mainnet}. Fast mode payments go to $pay_to."; else echo "Fast mode is free (no PAY_TO in .env)."; fi
echo "Logs: sudo -u $APP_USER -H pm2 logs vanity    After editing .env or to update the code: sudo bash scripts/setup-server.sh"
if [ -z "$pay_to" ]; then
  echo "To start charging for Fast mode: put your wallet address in PAY_TO in $ENV_FILE, then run this script again."
elif [ "$cluster" = devnet ]; then
  echo "To go live: switch your wallet to devnet, pay for one search, check it works, then set SOLANA_CLUSTER=mainnet in .env and run: pm2 restart vanity"
else
  echo "Before telling anyone: pay for one short Fast mode search with your own wallet and check the SOL arrives and the address is delivered."
fi
exit 0
}
