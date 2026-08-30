#!/usr/bin/env bash
#
# Deploys the danofunmi backend on an Ubuntu server: creates the Postgres
# database, installs dependencies, applies migrations, seeds the menu/
# locations/admin user, writes an nginx reverse-proxy config, and
# (re)starts the app under pm2.
#
# LAYOUT — this script is meant to sit BESIDE the deployed codebase, not
# inside it, e.g.:
#
#   /srv/danofunmi/deploy.sh          <- this script
#   /srv/danofunmi/danofunmi-backend/ <- the codebase (a git clone of this
#                                        repo) — package.json, src/,
#                                        prisma/, .env live directly in it
#
# Typical first-time setup on the server:
#   mkdir /srv/danofunmi && cd /srv/danofunmi
#   git clone <this-repo-url> danofunmi-backend
#   cp danofunmi-backend/deploy.sh .   # copy the script OUT beside the clone
#   cp danofunmi-backend/.env.example danofunmi-backend/.env
#   $EDITOR danofunmi-backend/.env     # fill in DATABASE_URL, bank details, etc.
#   ./deploy.sh
#
# The codebase directory is auto-detected: this script looks at its own
# sibling directories for the one containing package.json + prisma/schema.prisma.
# If that's ambiguous (more than one match, or it's not actually a sibling),
# point at it explicitly:
#   CODEBASE_DIR=../danofunmi-backend ./deploy.sh
#
# Re-running (redeploys) works the same way — pull the latest code inside
# the codebase directory first, then re-run this script from beside it.
#
# Environment variables this script reads (all optional):
#   CODEBASE_DIR          Path to the codebase, if it can't be auto-detected.
#   NGINX_SERVER_NAME     Domain for the generated nginx config (default: api.danofunmi.com).
#   SKIP_NGINX=1          Skip writing/reloading the nginx config entirely.
#   SEED_ADMIN_EMAIL      Admin login email (default: admin@danofunmi.com).
#   SEED_ADMIN_PASSWORD   Admin login password (default: a generated one, printed at the end).
#
# Safe to re-run: database/role creation, migrations, and seeding are all
# idempotent, secrets are only generated when missing, and an
# already-running pm2 process is reloaded rather than duplicated.
#
# Prerequisites this script does NOT install for you:
#   - Node.js 18+ and npm
#   - A running local PostgreSQL server (postgresql, postgresql-contrib),
#     with the system `postgres` user reachable via `sudo -u postgres psql`
#     (the standard Ubuntu default)
#   - nginx (install with: sudo apt-get install -y nginx), unless you pass SKIP_NGINX=1
#   - CODEBASE_DIR/.env — copy CODEBASE_DIR/.env.example there and fill in
#     real values (DATABASE_URL, bank details, etc). JWT_SECRET and
#     INTERNAL_API_KEY are generated for you below if left unset or still
#     the placeholder value from .env.example.
#
# sudo: used only for the handful of steps that genuinely need root —
# Postgres role/db creation, a global pm2 install if npm's global prefix
# isn't user-writable, fixing npm cache ownership if a previous run used
# sudo by accident, and writing/reloading the nginx config. Run this as a
# user with sudo rights (passwordless or interactive).
#
# pm2 is installed automatically (npm -g) if missing.

set -euo pipefail

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$1" >&2; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$1" >&2; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="danofunmi-backend"

# ---------------------------------------------------------------------------
log "Locating the backend codebase"

resolve_codebase_dir() {
  if [ -n "${CODEBASE_DIR:-}" ]; then
    CODEBASE_DIR="$(cd "$SCRIPT_DIR" && cd "$CODEBASE_DIR" && pwd)" \
      || fail "CODEBASE_DIR '$CODEBASE_DIR' not found (resolved relative to $SCRIPT_DIR)."
    return
  fi

  local parent_dir
  parent_dir="$(dirname "$SCRIPT_DIR")"

  shopt -s nullglob
  local candidates=() d
  for d in "$parent_dir"/*/; do
    d="${d%/}"
    [ "$d" = "$SCRIPT_DIR" ] && continue
    if [ -f "$d/package.json" ] && [ -f "$d/prisma/schema.prisma" ]; then
      candidates+=("$d")
    fi
  done
  shopt -u nullglob

  case "${#candidates[@]}" in
    1) CODEBASE_DIR="${candidates[0]}" ;;
    0) fail "Couldn't find the backend codebase beside this script (looked in $parent_dir for a sibling directory containing package.json + prisma/schema.prisma). Set CODEBASE_DIR=/path/to/codebase and re-run." ;;
    *) fail "Found multiple possible codebase directories beside this script: ${candidates[*]} — set CODEBASE_DIR=/path/to/codebase to disambiguate." ;;
  esac
}

resolve_codebase_dir
echo "Using codebase: $CODEBASE_DIR" >&2
cd "$CODEBASE_DIR"

# ---------------------------------------------------------------------------
log "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node 18+ (e.g. via NodeSource) and re-run."
command -v npm  >/dev/null 2>&1 || fail "npm not found — should ship with Node.js."
command -v psql >/dev/null 2>&1 || fail "psql not found. Install with: sudo apt-get install -y postgresql-client"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || fail "Node.js 18+ required (found $(node -v))."

install_pm2_if_missing() {
  command -v pm2 >/dev/null 2>&1 && return
  log "pm2 not found — installing globally"
  local prefix
  prefix="$(npm config get prefix)"
  if [ -w "$prefix" ]; then
    npm install -g pm2
  else
    warn "npm's global prefix ($prefix) isn't writable by $(whoami) — using sudo for this one install."
    sudo npm install -g pm2
  fi
}
install_pm2_if_missing

# ---------------------------------------------------------------------------
log "Loading $CODEBASE_DIR/.env"

[ -f .env ] || fail ".env not found in $CODEBASE_DIR. Run: cp .env.example .env — then fill in real values before deploying."

set -a
# shellcheck disable=SC1091
source .env
set +a

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set in .env"

# ---------------------------------------------------------------------------
log "Checking JWT_SECRET / INTERNAL_API_KEY"

generate_secret() { node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"; }

GENERATED_SECRETS=()

# Generates and persists a value into .env when a secret is missing or
# still a placeholder from .env.example — so a redeploy doesn't silently
# rotate secrets that are already live (invalidating sessions / breaking
# the whatsapp-bot's INTERNAL_API_KEY) once they've been set for real.
ensure_secret() {
  local key="$1" current value
  current="${!key:-}"
  case "$current" in
    ""|*change-this*|*change_this*|*CHANGE_ME*|*ChangeMe*)
      value="$(generate_secret)"
      if grep -q "^${key}=" .env; then
        sed -i "s|^${key}=.*|${key}=\"${value}\"|" .env
      else
        printf '\n%s="%s"\n' "$key" "$value" >> .env
      fi
      export "${key}=${value}"
      GENERATED_SECRETS+=("${key}=${value}")
      ;;
  esac
}

ensure_secret JWT_SECRET
ensure_secret INTERNAL_API_KEY

# ---------------------------------------------------------------------------
log "Parsing DATABASE_URL"

eval "$(DATABASE_URL="$DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL);
  const esc = (s) => `"${String(s).replace(/"/g, `\\"`)}"`;
  console.log(`DB_USER=${esc(decodeURIComponent(u.username))}`);
  console.log(`DB_PASS=${esc(decodeURIComponent(u.password))}`);
  console.log(`DB_HOST=${esc(u.hostname)}`);
  console.log(`DB_PORT=${esc(u.port || "5432")}`);
  console.log(`DB_NAME=${esc(u.pathname.replace(/^\//, ""))}`);
')"

[ -n "$DB_NAME" ] || fail "Could not determine a database name from DATABASE_URL."

# ---------------------------------------------------------------------------
log "Step 1/5: creating database (skipped if it already exists)"

if [ "$DB_HOST" = "localhost" ] || [ "$DB_HOST" = "127.0.0.1" ]; then
  role_exists() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; }
  db_exists()   { sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; }

  if role_exists; then
    echo "Role '$DB_USER' already exists — skipping."
  else
    sudo -u postgres psql -c "CREATE ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASS';"
    echo "Created role '$DB_USER'."
  fi

  if db_exists; then
    echo "Database '$DB_NAME' already exists — skipping."
  else
    sudo -u postgres psql -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
    echo "Created database '$DB_NAME'."
  fi
else
  warn "DATABASE_URL points at host '$DB_HOST', not local — skipping database/role creation."
  warn "Make sure '$DB_NAME' already exists on that server before continuing."
fi

# ---------------------------------------------------------------------------
log "Installing dependencies"

# A previous accidental `sudo npm ...` run is the classic cause of npm
# install failing with EACCES on a later, non-sudo run — fix the cache's
# ownership proactively instead of making you chase a cryptic error.
fix_npm_cache_ownership() {
  local cache_dir owner_uid my_uid
  cache_dir="$(npm config get cache)"
  [ -d "$cache_dir" ] || return 0
  my_uid="$(id -u)"
  owner_uid="$(stat -c '%u' "$cache_dir" 2>/dev/null || stat -f '%u' "$cache_dir" 2>/dev/null || echo "$my_uid")"
  if [ "$owner_uid" != "$my_uid" ]; then
    warn "npm cache ($cache_dir) is owned by another user (likely from a previous sudo npm run) — fixing ownership."
    sudo chown -R "$my_uid":"$(id -g)" "$cache_dir"
  fi
}
fix_npm_cache_ownership

if [ -f package-lock.json ]; then
  npm ci || { warn "npm ci failed — retrying with npm install (package-lock.json may be out of date)."; npm install; }
else
  warn "No package-lock.json found — running npm install instead of npm ci."
  npm install
fi

# ---------------------------------------------------------------------------
log "Step 2/5: running migrations"
npx prisma generate
npx prisma migrate deploy

# ---------------------------------------------------------------------------
log "Step 3/5: seeding menu, locations, and admin user"

SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@danofunmi.com}"
GENERATED_PASSWORD=""
if [ -z "${SEED_ADMIN_PASSWORD:-}" ]; then
  # No admin password supplied — generate a strong random one rather than
  # falling back to the well-known ChangeMe123! default from prisma/seed.js.
  GENERATED_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
  SEED_ADMIN_PASSWORD="$GENERATED_PASSWORD"
fi

# seed.js upserts the admin — safe to re-run, and won't overwrite an
# existing admin's password on redeploy.
SEED_ADMIN_EMAIL="$SEED_ADMIN_EMAIL" SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" npm run seed

# ---------------------------------------------------------------------------
log "Step 4/5: starting the app under pm2"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$APP_NAME" --update-env
else
  pm2 start src/index.js --name "$APP_NAME"
fi
pm2 save

# One-time: make pm2 (and this app) survive reboots. Safe to re-run —
# best-effort, doesn't fail the deploy if it doesn't apply.
STARTUP_CMD="$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null | grep '^sudo ' || true)"
if [ -n "$STARTUP_CMD" ]; then
  log "Enabling pm2 startup on boot"
  eval "$STARTUP_CMD"
  pm2 save
fi

# ---------------------------------------------------------------------------
log "Step 5/5: nginx reverse proxy"

NGINX_PORT="${PORT:-4000}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-api.danofunmi.com}"

if [ "${SKIP_NGINX:-0}" = "1" ]; then
  warn "SKIP_NGINX=1 — skipping nginx config."
else
  command -v nginx >/dev/null 2>&1 || fail "nginx not found. Install with: sudo apt-get install -y nginx — or re-run with SKIP_NGINX=1."

  NGINX_CONF="/etc/nginx/sites-available/$APP_NAME"
  TMP_CONF="$(mktemp)"
  # client_max_body_size covers the largest multer upload limit (receipts,
  # 8MB) with headroom, so nginx doesn't 413 uploads the app would accept.
  cat > "$TMP_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $NGINX_SERVER_NAME;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:$NGINX_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  sudo cp "$TMP_CONF" "$NGINX_CONF"
  rm -f "$TMP_CONF"
  sudo ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$APP_NAME"

  sudo nginx -t || fail "nginx config test failed — check $NGINX_CONF"
  sudo systemctl reload nginx
  log "nginx is proxying $NGINX_SERVER_NAME -> 127.0.0.1:$NGINX_PORT"
  echo "HTTP only for now — once DNS for $NGINX_SERVER_NAME points here, add HTTPS with:" >&2
  echo "  sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d $NGINX_SERVER_NAME" >&2
fi

# ---------------------------------------------------------------------------
log "Deploy complete"
echo "App '$APP_NAME' is running under pm2 on port $NGINX_PORT."
echo "  pm2 status              — check it's running"
echo "  pm2 logs $APP_NAME       — tail logs"

if [ "${#GENERATED_SECRETS[@]}" -gt 0 ] || [ -n "$GENERATED_PASSWORD" ]; then
  echo
  echo "=============================================================="
  echo " Generated secrets — save these now, they will not be shown again:"
  for entry in "${GENERATED_SECRETS[@]}"; do
    echo "   ${entry%%=*}: ${entry#*=}"
  done
  if [ -n "$GENERATED_PASSWORD" ]; then
    echo "   Admin email:    $SEED_ADMIN_EMAIL"
    echo "   Admin password: $GENERATED_PASSWORD"
  fi
  echo "=============================================================="
fi
