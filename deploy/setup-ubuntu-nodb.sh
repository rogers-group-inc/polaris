#!/usr/bin/env bash
# deploy/setup-ubuntu-nodb.sh — Polaris deployment script for Ubuntu / Debian
#                                with a remote/external PostgreSQL database
#
# Run as root:  bash deploy/setup-ubuntu-nodb.sh --db-url "postgresql://user:pass@db-host:5432/polaris"
#
# What this script does:
#   1. Installs Node.js 24, git, and PostgreSQL client tools (no server)
#   2. Creates a dedicated 'polaris' system user
#   3. Clones or copies the application to /opt/polaris
#   4. Configures .env with the provided DATABASE_URL
#   5. Installs dependencies, builds, and runs migrations against the remote database
#   6. Installs and enables a systemd service
#
# Use this script when your PostgreSQL database is hosted externally
# (e.g. AWS RDS, Azure Database for PostgreSQL, a separate DB server).
#
# After running, the app will be available at http://<server-ip>:3000

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
APP_GROUP="polaris"
REPO_URL="https://github.com/rogers-group-inc/polaris.git"
DATABASE_URL=""

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Parse arguments ─────────────────────────────────────────────────────────
PUBLIC_URL=""
MONITOR_REPLICAS=2
PROMETHEUS_IP="127.0.0.1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-url)            DATABASE_URL="$2"; shift 2 ;;
    --app-dir)           APP_DIR="$2"; shift 2 ;;
    --repo-url)          REPO_URL="$2"; shift 2 ;;
    --public-url)        PUBLIC_URL="$2"; shift 2 ;;
    --monitor-replicas)  MONITOR_REPLICAS="$2"; shift 2 ;;
    --prometheus-ip)     PROMETHEUS_IP="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash setup-ubuntu-nodb.sh --db-url \"postgresql://user:pass@host:5432/polaris\" [--public-url https://polaris.example.com]"
      echo ""
      echo "Options:"
      echo "  --db-url            PostgreSQL connection URL (required)"
      echo "  --app-dir           Installation directory (default: /opt/polaris)"
      echo "  --repo-url          Git repository URL"
      echo "  --public-url        https://<hostname>[:<port>]   (default: https://\$(hostname -f))"
      echo "  --monitor-replicas  N                              (default: 2)"
      echo "  --prometheus-ip     <IP>                           (default: 127.0.0.1)"
      exit 0 ;;
    *) error "Unknown option: $1" ;;
  esac
done

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
fi

if [[ -z "$DATABASE_URL" ]]; then
  echo ""
  echo -e "${YELLOW}No --db-url provided. Please enter the PostgreSQL connection URL.${NC}"
  echo -e "Format: postgresql://user:password@host:5432/database"
  echo ""
  read -rp "DATABASE_URL: " DATABASE_URL
  if [[ -z "$DATABASE_URL" ]]; then
    error "DATABASE_URL is required. Use --db-url or enter it when prompted."
  fi
fi

# Validate URL format
if [[ ! "$DATABASE_URL" =~ ^postgres(ql)?:// ]]; then
  error "Invalid DATABASE_URL — must start with postgresql:// or postgres://"
fi

info "Starting Polaris deployment on $(hostname) (remote database mode)"

# Ensure apt is up to date
info "Updating package lists..."
apt-get update -qq

# ─── 1. Install Node.js 24 (LTS) ─────────────────────────────────────────────
# 22.12 is the hard floor (pg-boss declares >=22.12.0, @prisma/streams-local
# >=22) and v20 went EOL in April 2026. An existing v22 is accepted; v20 and
# below are replaced.
if command -v node &>/dev/null && [[ "$(node -v)" == v24* || "$(node -v)" == v22* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 24 via NodeSource..."
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y nodejs
  info "Node.js $(node -v) installed"
fi

# Allow Node.js to bind to privileged ports (80, 443) without root
info "Granting Node.js low-port binding capability..."
setcap cap_net_bind_service=+ep "$(which node)"

# ─── 1b. Install Go 1.22+ ────────────────────────────────────────────────────
# Required by the Polaris Agent build feature. Ubuntu 24.04 ships golang-go
# 1.22 in main; 22.04 ships 1.18 which is too old — fall back to snap.
if command -v go &>/dev/null && go version | grep -qE 'go1\.(2[2-9]|[3-9][0-9])'; then
  info "Go $(go version | awk '{print $3}') already installed"
else
  info "Installing Go..."
  if apt-get install -y golang-go && go version | grep -qE 'go1\.(2[2-9]|[3-9][0-9])'; then
    info "Go $(go version | awk '{print $3}') installed via apt"
  else
    info "Default apt golang-go is too old (<1.22); installing via snap..."
    snap install --classic --channel=1.22/stable go
    info "Go $(go version | awk '{print $3}') installed via snap"
  fi
fi

# ─── 1c. Install fping (OPTIONAL — ICMP batching) ──────────────────
# Polaris batches two ICMP cadences through fping: the packet-loss sweep (a
# burst of echoes at every monitored asset each cycle) and the ICMP status
# probe that decides whether a device is down. fping reaches up to 500 hosts
# from ONE process; without it both fall back to one `ping` per host, which is
# CORRECT and gives the same verdicts, but forks per host and cannot hold a 60s
# sweep cadence on a large fleet (the interval is floored automatically to
# whatever the host can finish).
#
# In the standard Debian/Ubuntu archive, so no extra repo is needed — but the
# install is still best-effort and never fatal, because a missing fping costs
# throughput rather than correctness. The packaged binary carries cap_net_raw
# as a file capability, so the unprivileged polaris user can run it with no
# sudo wiring.
if command -v fping &>/dev/null; then
  info "fping already installed ($(fping -v 2>&1 | head -1))"
elif apt-get install -y fping &>/dev/null; then
  info "fping installed"
else
  warn "fping not installed — packet loss is still measured, but via one ping"
  warn "  process per host. On a large fleet Polaris stretches the loss sweep"
  warn "  interval to suit. To fix later:  apt-get install -y fping"
fi

# ─── 2. Install git ──────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  info "Git already installed"
else
  info "Installing git..."
  apt-get install -y git
  info "Git installed"
fi

# ─── 3. Install PostgreSQL client tools (for pg_dump backups) ────────────────
if command -v pg_dump &>/dev/null; then
  info "PostgreSQL client tools already installed"
else
  info "Installing PostgreSQL client tools..."
  apt-get install -y postgresql-client
  info "PostgreSQL client tools installed"
fi

# ─── 4. Create system user ───────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  info "User '$APP_USER' already exists"
else
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
  info "User '$APP_USER' created"
fi

# ─── 4b. Bootstrap Polaris Agent build directories ──────────────────────────
mkdir -p "$APP_DIR/data/agents" "$APP_DIR/.cache/go-build"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/data/agents" "$APP_DIR/.cache"

# ─── 4c. Java 17 + jsign (agent code signing — optional at runtime) ─────────
# Used by the agent code-signing feature (Integrations → Polaris Agents →
# Code signing): when internal-CA code signing is configured, the in-app agent
# build signs the two Windows binaries via jsign (a Java CLI). The feature is
# opt-in — missing Java/jsign only disables signing and the UI names exactly
# what's missing — so failures here warn instead of aborting the install.
JSIGN_VERSION="7.4"
JSIGN_SHA256="2abf2ade9ea322acc2d60c24794eadc465ff9380938fca4c932d09e0b25f1c28"
if command -v java &>/dev/null; then
  info "Java already installed"
else
  info "Installing Java 17 (headless, for agent code signing)..."
  # openjdk-17-jre-headless by NAME, not default-jre-headless. The distro
  # default is Java 17 on Ubuntu 22.04 and Java 21 on 24.04, so
  # `default-jre-headless` made two supported Polaris hosts sign agent binaries
  # with different JDK majors -- and only one of them matched the 17 that the
  # Dockerfile, the RHEL script and both Windows scripts all pin. There is no
  # version in `default-jre-headless` for check:versions to compare, so the
  # drift was invisible to the pin check as well as to the operator.
  # Fall back to the distro default rather than leaving the host with no JVM:
  # signing with the wrong major beats not signing at all, and the log says
  # which happened.
  if apt-get install -y openjdk-17-jre-headless; then
    info "Java 17 (openjdk-17-jre-headless) installed"
  elif apt-get install -y default-jre-headless; then
    info "WARNING: openjdk-17-jre-headless unavailable on this release — installed default-jre-headless ($(java -version 2>&1 | head -1)). Agent signing will use this JVM; pin 17 if signatures must match other hosts."
  else
    info "WARNING: Java install failed — agent code signing stays unavailable until Java is installed manually"
  fi
fi
if [ -f "$APP_DIR/tools/jsign.jar" ]; then
  info "jsign already present at $APP_DIR/tools/jsign.jar"
else
  info "Downloading jsign ${JSIGN_VERSION} (signs Windows agent binaries)..."
  mkdir -p "$APP_DIR/tools"
  if curl -fsSL -o "$APP_DIR/tools/jsign.jar.tmp" \
       "https://github.com/ebourg/jsign/releases/download/${JSIGN_VERSION}/jsign-${JSIGN_VERSION}.jar" \
     && echo "${JSIGN_SHA256}  $APP_DIR/tools/jsign.jar.tmp" | sha256sum -c --status -; then
    mv "$APP_DIR/tools/jsign.jar.tmp" "$APP_DIR/tools/jsign.jar"
    info "jsign ${JSIGN_VERSION} installed to $APP_DIR/tools/jsign.jar"
  else
    rm -f "$APP_DIR/tools/jsign.jar.tmp"
    info "WARNING: jsign download failed or checksum mismatch — agent code signing stays unavailable until installed manually"
  fi
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/tools" 2>/dev/null || true
fi

# ─── 5. Test database connectivity ──────────────────────────────────────────
info "Testing database connectivity..."
if command -v psql &>/dev/null; then
  if psql "$DATABASE_URL" -c "SELECT 1" &>/dev/null; then
    info "Database connection successful"
    # pg-boss (queue runtime for monitor cadences at scale) lives in its own
    # `pgboss` schema. Try to create it as the connecting role; if the role
    # doesn't have CREATE on the database, surface what the DBA needs to run.
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X <<'SQL' &>/dev/null
CREATE SCHEMA IF NOT EXISTS pgboss;
SQL
    then
      info "pg-boss schema present"
    else
      warn "Could not pre-create the pgboss schema as the connecting role."
      warn "Have your DBA run the following on the polaris database, replacing \$DB_USER with the role the app connects as:"
      cat <<'GRANTS'
  CREATE SCHEMA IF NOT EXISTS pgboss;
  ALTER SCHEMA pgboss OWNER TO $DB_USER;
  GRANT ALL ON SCHEMA pgboss TO $DB_USER;
  GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO $DB_USER;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO $DB_USER;
  GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO $DB_USER;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO $DB_USER;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO $DB_USER;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO $DB_USER;
GRANTS
      warn "Without these grants Polaris will fall back to in-process cursor mode (suitable for small/medium fleets only)."
    fi
  else
    warn "Could not connect to database — check your DATABASE_URL. Continuing anyway (the database may not be ready yet)."
    warn "Once the DB is reachable, your DBA needs to grant the polaris role ownership of the pgboss schema for the queue runtime — see docs/INSTALL.md."
  fi
fi

# ─── 6. Deploy application ───────────────────────────────────────────────────
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing installation..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull --ff-only
else
  info "Cloning repository to $APP_DIR..."
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
fi

cd "$APP_DIR"

# ─── 7. Configure environment ────────────────────────────────────────────────
# Node ignores the OS trust store, so on a network that re-signs HTTPS with an
# internal CA every npm call fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY while
# the code-pull step in the same script succeeds (that path goes through
# OpenSSL, which DOES read the system store). Point Node at the system bundle
# so the app's outbound calls and the in-app updater's `npm ci` both trust
# whatever this host trusts. NODE_EXTRA_CA_CERTS *extends* Node's built-in
# roots rather than replacing them, so setting it is harmless on a network that
# does not intercept.
NODE_CA_BUNDLE=""
for _candidate in /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem /etc/ssl/certs/ca-certificates.crt; do
  if [[ -f "$_candidate" ]]; then NODE_CA_BUNDLE="$_candidate"; break; fi
done
if [[ ! -f "$APP_DIR/.env" ]]; then
  info "Creating .env..."
  SESSION_SECRET=$(openssl rand -base64 32)
  POLARIS_SECRET_KEY=$(openssl rand -hex 32)
  cat > "$APP_DIR/.env" <<ENVFILE
# Database (remote)
DATABASE_URL=${DATABASE_URL}

# App
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Auth
SESSION_SECRET=${SESSION_SECRET}

# Encryption key for secrets stored in the database (SNMP communities, WinRM/SSH
# passwords + private keys, FortiManager/FortiGate API tokens, the Entra client
# secret, vCenter credentials, delivery-channel secrets). Without it those
# values are stored as PLAINTEXT, and therefore appear in plaintext in every
# pg_dump. KEEP A COPY OFF THIS HOST: sealed secrets cannot be recovered
# without this key, and a backup restored onto a host with a different key
# needs its device + integration secrets re-entered.
POLARIS_SECRET_KEY=${POLARIS_SECRET_KEY}
# Extra CA bundle for Node's TLS (see .env.example for the full rationale).
# Detected from this host's trust store at install time. Add your internal root
# to the OS store (update-ca-trust / update-ca-certificates) and it is picked
# up from here — this points at the bundle, it does not import anything itself.
NODE_EXTRA_CA_CERTS=${NODE_CA_BUNDLE}
ENVFILE
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env created with remote DATABASE_URL"
else
  info ".env already exists — skipping"
  warn "Verify DATABASE_URL in $APP_DIR/.env points to the correct remote database"
  # Installs that predate secrets-at-rest have no key, so device + integration
  # credentials sit in the clear in Postgres (and in every pg_dump). Mint one
  # here; the backfillSecretEncryption job seals the existing rows on next boot.
  if ! grep -q '^POLARIS_SECRET_KEY=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-ubuntu-nodb.sh — encryption key for secrets stored in the database"
      echo "# (SNMP communities, WinRM/SSH passwords + private keys, FortiManager/FortiGate"
      echo "# API tokens, the Entra client secret, vCenter credentials, delivery-channel"
      echo "# secrets). KEEP A COPY OFF THIS HOST: sealed secrets cannot be recovered"
      echo "# without this key, and a backup restored onto a host with a different key"
      echo "# needs its device + integration secrets re-entered."
      echo "POLARIS_SECRET_KEY=$(openssl rand -hex 32)"
    } >> "$APP_DIR/.env"
    warn "Generated POLARIS_SECRET_KEY — back it up somewhere other than this host before the next backup"
  fi
fi

# ─── 8. Install dependencies & build ─────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" npm ci --include=dev

info "Building TypeScript..."
# `npm run build` (not bare tsc) so scripts/copy-build-assets.mjs runs and the
# bundled std MIB .txt files land in dist/services/stdMibs/ — without them the
# SNMP Walk tab's standard MIBs (LLDP-MIB etc.) report "not installed".
sudo -u "$APP_USER" npm run build

info "Running database migrations..."
sudo -u "$APP_USER" npx prisma migrate deploy

# Seed on first deploy — check via the app's own database connection
HAS_USERS=$(sudo -u "$APP_USER" node --env-file=.env -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.user.count().then(c => { console.log(c); p.\$disconnect(); }).catch(() => { console.log(0); p.\$disconnect(); });
" 2>/dev/null || echo "0")
HAS_USERS=$(echo "$HAS_USERS" | tr -d '[:space:]')
if [[ "$HAS_USERS" == "" || "$HAS_USERS" == "0" ]]; then
  info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
  sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts || true
else
  info "Database already seeded ($HAS_USERS users) — skipping"
fi

# ─── 9. Install nginx mainline + self-signed cert + split-role units ────────
# Same as setup-ubuntu.sh from here — see that script's comments for the
# rationale on each step. Duplicated rather than sourced so operators can
# run setup-ubuntu-nodb.sh standalone from a fresh git clone.
PUBLIC_URL="${PUBLIC_URL:-https://$(hostname -f)}"
MONITOR_REPLICAS="${MONITOR_REPLICAS:-2}"
PROMETHEUS_IP="${PROMETHEUS_IP:-127.0.0.1}"
HOSTNAME_FROM_URL=$(echo "$PUBLIC_URL" | sed -E 's|^https?://([^:/]+).*|\1|')
CERT_DIR="/etc/polaris-nginx"
NGINX_CONF_DEST="/etc/nginx/conf.d/polaris.conf"
NGINX_DROPIN_DIR="/etc/systemd/system/polaris-web.service.d"

info "Public URL:        $PUBLIC_URL"
info "Cert hostname:     $HOSTNAME_FROM_URL"
info "Monitor replicas:  $MONITOR_REPLICAS"

# Install nginx mainline (HTTP/3 ≥ 1.25)
if command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | grep -qE '1\.(2[5-9]|[3-9][0-9])'; then
  info "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') already installed"
else
  info "Installing nginx mainline from nginx.org..."
  apt-get install -y curl gnupg2 ca-certificates lsb-release ubuntu-keyring 2>/dev/null || \
    apt-get install -y curl gnupg2 ca-certificates lsb-release debian-archive-keyring
  curl https://nginx.org/keys/nginx_signing.key | gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg
  if [[ -f /etc/lsb-release ]] && grep -q DISTRIB_ID=Ubuntu /etc/lsb-release; then
    NGINX_DISTRO=ubuntu
  else
    NGINX_DISTRO=debian
  fi
  CODENAME=$(lsb_release -cs)
  echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/mainline/${NGINX_DISTRO} ${CODENAME} nginx" \
    > /etc/apt/sources.list.d/nginx.list
  cat > /etc/apt/preferences.d/99nginx <<'PREF'
Package: *
Pin: origin nginx.org
Pin: release o=nginx
Pin-Priority: 900
PREF
  apt-get update -qq
  apt-get install -y nginx
fi

# Self-signed cert
mkdir -p "$CERT_DIR"
if [[ ! -f "$CERT_DIR/cert.pem" || ! -f "$CERT_DIR/key.pem" ]]; then
  info "Generating self-signed cert for $HOSTNAME_FROM_URL..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=$HOSTNAME_FROM_URL" \
    -addext "subjectAltName=DNS:$HOSTNAME_FROM_URL" \
    >/dev/null 2>&1
fi
NGINX_GROUP=$(getent group nginx >/dev/null && echo nginx || echo www-data)
chown "root:$NGINX_GROUP" "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"
chmod 0640                 "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"

# Append proxy-mode env vars if not already in .env
if ! grep -q '^POLARIS_PROXY_CERT_PATH=' "$APP_DIR/.env"; then
  {
    echo ""
    echo "# Added by setup-ubuntu-nodb.sh — reverse-proxy front-end"
    echo "POLARIS_PROXY_CERT_PATH=${CERT_DIR}/cert.pem"
    echo "POLARIS_PUBLIC_URL=${PUBLIC_URL}"
  } >> "$APP_DIR/.env"
fi
# Capacity Advisor input: replica count drives pool + max_connections sizing
# across the (web + N monitor + discovery) process group.
if ! grep -q '^POLARIS_MONITOR_REPLICAS=' "$APP_DIR/.env"; then
  {
    echo ""
    echo "# Added by setup-ubuntu-nodb.sh — split-role replica count (Capacity Advisor input)"
    echo "POLARIS_MONITOR_REPLICAS=${MONITOR_REPLICAS}"
  } >> "$APP_DIR/.env"
fi

# Install split-role units. DB is remote so strip postgres deps from all four.
info "Installing split-role systemd units..."
cp "$APP_DIR/deploy/polaris-migrate.service"    /etc/systemd/system/polaris-migrate.service
cp "$APP_DIR/deploy/polaris-web.service"        /etc/systemd/system/polaris-web.service
cp "$APP_DIR/deploy/polaris-monitor@.service"   /etc/systemd/system/polaris-monitor@.service
cp "$APP_DIR/deploy/polaris-discovery.service"  /etc/systemd/system/polaris-discovery.service
cp "$APP_DIR/deploy/polaris-dash.service"       /etc/systemd/system/polaris-dash.service
cp "$APP_DIR/deploy/polaris.target"             /etc/systemd/system/polaris.target

for unit in polaris-migrate polaris-web polaris-monitor@ polaris-discovery polaris-dash; do
  sed -i -E "s/(After=.*)postgresql-15\\.service\\s*/\\1/" "/etc/systemd/system/${unit}.service"
  sed -i "/^Requires=postgresql-15\\.service\\s*$/d"        "/etc/systemd/system/${unit}.service"
done

mkdir -p "$NGINX_DROPIN_DIR"
cp "$APP_DIR/deploy/nginx/polaris-nginx-dependency.conf" "$NGINX_DROPIN_DIR/nginx-dependency.conf"

systemctl daemon-reload

info "Installing nginx config..."
sed "s|polaris\\.example\\.com|$HOSTNAME_FROM_URL|g; s|<PROMETHEUS_IP>|$PROMETHEUS_IP|g" \
  "$APP_DIR/deploy/nginx/polaris.conf" > "$NGINX_CONF_DEST"
nginx -t

# In-app nginx GUI helpers (wrapper + sudoers + tmpfiles + group membership).
info "Installing in-app nginx GUI helpers (idempotent)..."
install -o root -g root -m 0755 "$APP_DIR/deploy/scripts/polaris-nginx-apply.sh" /usr/local/sbin/polaris-nginx-apply
install -o root -g root -m 0440 "$APP_DIR/deploy/sudoers.d/polaris-nginx"        /etc/sudoers.d/polaris-nginx
install -o root -g root -m 0644 "$APP_DIR/deploy/tmpfiles.d/polaris-nginx.conf"  /etc/tmpfiles.d/polaris-nginx.conf
systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true
NGINX_GROUP=$(stat -c '%G' /etc/polaris-nginx/cert.pem 2>/dev/null || true)
if [[ -n "$NGINX_GROUP" ]] && ! id -nG "$APP_USER" 2>/dev/null | grep -qw "$NGINX_GROUP"; then
  usermod -aG "$NGINX_GROUP" "$APP_USER"
  info "Added $APP_USER to the $NGINX_GROUP group (cert file readability)"
fi

# ─── 10. Firewall ────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  info "Opening TCP+UDP/443 in ufw..."
  ufw allow 443/tcp
  ufw allow 443/udp
  if ufw status | grep -q "Status: active"; then
    info "UFW is active — rule applied"
  else
    warn "UFW is installed but inactive — rule saved but not enforced"
  fi
fi

# Enable + start
for ((i=1; i<=MONITOR_REPLICAS; i++)); do
  systemctl enable "polaris-monitor@$i.service" >/dev/null
done
systemctl enable polaris-web.service polaris-discovery.service polaris-dash.service polaris-migrate.service polaris.target nginx >/dev/null
info "Starting polaris.target..."
systemctl start polaris.target

sleep 5
if systemctl is-active --quiet polaris-web.service; then
  info "polaris-web is running"
else
  warn "polaris-web may not have started — check: journalctl -u polaris-web -f"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Polaris deployment complete!"
info "  Mode:          Remote database, nginx-fronted (split-role)"
info "  URL:           $PUBLIC_URL"
info "  Cert path:     $CERT_DIR/cert.pem  (self-signed; replace with real CA cert later)"
info "  Monitor units: polaris-monitor@1..@$MONITOR_REPLICAS"
info "  Logs:          journalctl -u polaris-web -f"
info "============================================"
echo ""
warn "Self-signed cert in use. Replace before exposing publicly."
