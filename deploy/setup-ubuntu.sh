#!/usr/bin/env bash
# deploy/setup-ubuntu.sh — Polaris deployment script for Ubuntu / Debian
#
# Run as root:  bash deploy/setup-ubuntu.sh --public-url https://polaris.example.com
#
# What this script does (Phase 3+ — single-process polaris.service no longer
# shipped to production; every fresh install is split-role + nginx-fronted):
#   1. Installs Node.js 24, PostgreSQL 17, Go 1.26+, nginx (stable ≥1.30)
#   2. Creates a dedicated 'polaris' system user + DB + role
#   3. Clones the application to /opt/polaris
#   4. Installs dependencies, builds, runs migrations
#   5. Generates a self-signed TLS cert for the supplied --public-url hostname
#   6. Installs split-role systemd units + nginx-dependency drop-in;
#      enables polaris-monitor@1..@N (default N=2)
#   7. Configures nginx with the operator's hostname + Prometheus IP
#   8. Sets POLARIS_PROXY_CERT_PATH + POLARIS_PUBLIC_URL in .env
#   9. Opens 443/tcp + 443/udp in ufw (if installed)
#  10. Starts polaris.target — which pulls nginx up first via the drop-in
#
# Arguments:
#   --public-url        https://<hostname>[:<port>]  (default: https://$(hostname -f))
#   --monitor-replicas  N                            (default: 2)
#   --prometheus-ip     <IP>                         (default: 127.0.0.1)
#
# Local dev (npm run dev with POLARIS_ROLE unset = "all") still works without
# any of this — it's a runtime mode in src/utils/role.ts, separate from
# production deploy artifacts.

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
APP_GROUP="polaris"
DB_NAME="polaris"
DB_USER="polaris"
DB_PASS="polaris"
REPO_URL="https://github.com/rogers-group-inc/polaris.git"
CERT_DIR="/etc/polaris-nginx"
NGINX_CONF_DEST="/etc/nginx/conf.d/polaris.conf"
NGINX_DROPIN_DIR="/etc/systemd/system/polaris-web.service.d"

# Defaults — overridable via CLI flags below.
PUBLIC_URL=""
MONITOR_REPLICAS=2
PROMETHEUS_IP="127.0.0.1"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)        PUBLIC_URL="$2"; shift 2;;
    --monitor-replicas)  MONITOR_REPLICAS="$2"; shift 2;;
    --prometheus-ip)     PROMETHEUS_IP="$2"; shift 2;;
    -h|--help)
      head -40 "$0" | sed -n '/^#/p'
      exit 0;;
    *) error "Unknown argument: $1";;
  esac
done

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
fi

if [[ -z "$PUBLIC_URL" ]]; then
  PUBLIC_URL="https://$(hostname -f)"
  warn "No --public-url supplied; defaulting to $PUBLIC_URL"
fi

if [[ ! "$PUBLIC_URL" =~ ^https:// ]]; then
  error "--public-url must start with https://, got: $PUBLIC_URL"
fi

HOSTNAME_FROM_URL=$(echo "$PUBLIC_URL" | sed -E 's|^https://([^:/]+).*|\1|')

info "Starting Polaris deployment on $(hostname)"
info "  Public URL:        $PUBLIC_URL"
info "  Cert hostname:     $HOSTNAME_FROM_URL"
info "  Monitor replicas:  $MONITOR_REPLICAS"
info "  Prometheus IP:     $PROMETHEUS_IP"

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

# Phase 3+: Polaris no longer binds privileged ports — nginx terminates TLS
# on 443 and proxies HTTP-only to 127.0.0.1:3000. No setcap on node needed.

# ─── 1b. Install Go 1.26+ ────────────────────────────────────────────────────
# Required by the Polaris Agent build feature (Server Settings → Maintenance
# → Polaris Agent → Build). NEITHER Ubuntu LTS can satisfy the 1.26 floor from
# the archive — 24.04 ships golang-go 1.22 and 22.04 ships 1.18 — so on a
# supported release the snap branch below is the one that runs. The apt attempt
# stays because it is cheap, it is correct on a newer Debian, and the version
# re-check after it is what decides.
if command -v go &>/dev/null && go version | grep -qE 'go1\.(2[6-9]|[3-9][0-9])'; then
  info "Go $(go version | awk '{print $3}') already installed"
else
  info "Installing Go..."
  if apt-get install -y golang-go && go version | grep -qE 'go1\.(2[6-9]|[3-9][0-9])'; then
    info "Go $(go version | awk '{print $3}') installed via apt"
  else
    info "Default apt golang-go is too old (<1.26); installing via snap..."
    snap install --classic --channel=1.26/stable go
    info "Go $(go version | awk '{print $3}') installed via snap"
  fi
fi

# ─── 1c. Install nginx stable (HTTP/3 ≥ 1.30 required) ─────────────────────
# Ubuntu/Debian's default nginx is too old for HTTP/3; pull the STABLE branch from
# nginx.org's official Debian/Ubuntu repo.
if command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | grep -qE '1\.(3[0-9]|[4-9][0-9])'; then
  info "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') already installed"
else
  info "Installing nginx stable from nginx.org..."
  apt-get install -y curl gnupg2 ca-certificates lsb-release ubuntu-keyring 2>/dev/null || \
    apt-get install -y curl gnupg2 ca-certificates lsb-release debian-archive-keyring
  curl https://nginx.org/keys/nginx_signing.key | gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg
  # Detect Ubuntu vs Debian
  if [[ -f /etc/lsb-release ]] && grep -q DISTRIB_ID=Ubuntu /etc/lsb-release; then
    NGINX_DISTRO=ubuntu
  else
    NGINX_DISTRO=debian
  fi
  CODENAME=$(lsb_release -cs)
  echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/${NGINX_DISTRO} ${CODENAME} nginx" \
    > /etc/apt/sources.list.d/nginx.list
  # Pin nginx.org over distro nginx (prevents unattended upgrades from
  # replacing the nginx.org build with the older distro version).
  cat > /etc/apt/preferences.d/99nginx <<'PREF'
Package: *
Pin: origin nginx.org
Pin: release o=nginx
Pin-Priority: 900
PREF
  apt-get update -qq
  apt-get install -y nginx
  info "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') installed"
fi

# ─── 1d. Install fping (OPTIONAL — ICMP batching) ──────────────────
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

# ─── 2. Install PostgreSQL 17 (PGDG, not the distro metapackage) ─────────────
# This used to be `apt-get install -y postgresql postgresql-contrib` — the
# distro metapackage, whose major is whatever the release froze on: PostgreSQL
# 14 on Ubuntu 22.04 and 16 on 24.04. Neither is the major every other site
# here names, 14 is BELOW the stated minimum, and there is no number in the
# package name for the pin check to disagree with, so the drift was invisible.
# Same shape as the RHEL AppStream bug fixed on 2026-09-09, one archive along.
#
# PGDG also matters for the extension: the TimescaleDB package depends on
# `postgresql-17` by name, and the distro metapackage cannot satisfy it.
PG_MAJOR=17
if [[ -x "/usr/lib/postgresql/${PG_MAJOR}/bin/psql" ]]; then
  info "PostgreSQL ${PG_MAJOR} (PGDG) already installed"
else
  info "Installing PostgreSQL ${PG_MAJOR} from PGDG..."
  # lsb-release explicitly: the codename below comes from it, and the only
  # other place that installs it is the nginx block, which is skipped entirely
  # on a host that already has nginx.
  apt-get install -y curl ca-certificates gnupg lsb-release
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  # No postgresql-contrib-<major> here: Debian packaging folded contrib into
  # postgresql-<major> at PostgreSQL 10, and PGDG only still publishes the
  # split package for 9.x. Asking for it fails the install outright.
  apt-get install -y "postgresql-${PG_MAJOR}"
  info "PostgreSQL ${PG_MAJOR} installed"
fi

# Enable and start PostgreSQL. Debian's postgresql.service is a wrapper that
# starts every configured cluster; the per-cluster unit is postgresql@N-main.
systemctl enable --now postgresql
info "PostgreSQL is running"

# ─── 3. Create system user ───────────────────────────────────────────────────
if id "$APP_USER" &>/dev/null; then
  info "User '$APP_USER' already exists"
else
  info "Creating system user '$APP_USER'..."
  useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
  info "User '$APP_USER' created"
fi

# ─── 3b. Bootstrap Polaris Agent build directories ──────────────────────────
# In-app Build writes to $APP_DIR/data/agents/<version>/ and uses
# $APP_DIR/.cache/go-build as Go's build cache (HOME=$APP_DIR for the
# build subprocess). Create both with the right ownership upfront.
mkdir -p "$APP_DIR/data/agents" "$APP_DIR/.cache/go-build"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/data/agents" "$APP_DIR/.cache"

# ─── 3c. Java 25 + jsign (agent code signing — optional at runtime) ─────────
# Used by the agent code-signing feature (Integrations → Polaris Agents →
# Code signing): when internal-CA code signing is configured, the in-app agent
# build signs the two Windows binaries via jsign (a Java CLI). The feature is
# opt-in — missing Java/jsign only disables signing and the UI names exactly
# what's missing — so failures here warn instead of aborting the install.
JSIGN_VERSION="7.5"
JSIGN_SHA256="602a51c3545a6dc4fb99bd2ea7152b26d1345916d0c93ddfbd5936cb735af91c"
if command -v java &>/dev/null; then
  info "Java already installed"
else
  info "Installing Java 25 (headless, for agent code signing)..."
  # openjdk-25-jre-headless by NAME, not default-jre-headless. The distro
  # default is Java 17 on Ubuntu 22.04 and Java 21 on 24.04, so
  # `default-jre-headless` made two supported Polaris hosts sign agent binaries
  # with different JDK majors -- and neither matched what the Dockerfile, the
  # RHEL script and both Windows scripts pin. There is no version in
  # `default-jre-headless` for check:versions to compare, so the drift was
  # invisible to the pin check as well as to the operator.
  # 25 is available on jammy and noble alike (and on Debian trixie), so the
  # fallback below should never fire on a supported release.
  # Fall back to the distro default rather than leaving the host with no JVM:
  # signing with the wrong major beats not signing at all, and the log says
  # which happened.
  if apt-get install -y openjdk-25-jre-headless; then
    info "Java 25 (openjdk-25-jre-headless) installed"
  elif apt-get install -y default-jre-headless; then
    info "WARNING: openjdk-25-jre-headless unavailable on this release — installed default-jre-headless ($(java -version 2>&1 | head -1)). Agent signing will use this JVM; pin 25 if signatures must match other hosts."
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

# ─── 4. Create database and role ─────────────────────────────────────────────
info "Setting up PostgreSQL database..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

# pg-boss (queue runtime for monitor cadences at scale) lives in its own
# `pgboss` schema. Make sure the polaris role owns it so pg-boss can create
# its tables and the workers can boot. Idempotent — safe to re-run.
sudo -u postgres psql -d "$DB_NAME" <<SQL
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO $DB_USER;
GRANT ALL ON SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO $DB_USER;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO $DB_USER;
SQL

info "Database '$DB_NAME' ready"

# Ensure pg_hba.conf allows password auth for the polaris user
PG_HBA=$(sudo -u postgres psql -tc "SHOW hba_file;" | tr -d ' ')
if ! grep -q "$DB_USER" "$PG_HBA" 2>/dev/null; then
  warn "Adding md5 auth entry for '$DB_USER' to pg_hba.conf"
  sed -i "/^# TYPE/a local   $DB_NAME   $DB_USER   md5\nhost    $DB_NAME   $DB_USER   127.0.0.1/32   md5\nhost    $DB_NAME   $DB_USER   ::1/128        md5" "$PG_HBA"
  systemctl reload postgresql
fi

# ─── 5. Deploy application ───────────────────────────────────────────────────
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

# ─── 5b. Generate self-signed TLS cert ───────────────────────────────────────
mkdir -p "$CERT_DIR"
if [[ -f "$CERT_DIR/cert.pem" && -f "$CERT_DIR/key.pem" ]]; then
  info "Cert already present at $CERT_DIR — skipping generation"
else
  info "Generating self-signed cert for $HOSTNAME_FROM_URL..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=$HOSTNAME_FROM_URL" \
    -addext "subjectAltName=DNS:$HOSTNAME_FROM_URL" \
    >/dev/null 2>&1
fi
# nginx on Debian/Ubuntu runs as www-data by default; the nginx.org RPM
# uses `nginx` user. Detect which exists and use that group.
NGINX_GROUP=$(getent group nginx >/dev/null && echo nginx || echo www-data)
chown "root:$NGINX_GROUP" "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"
chmod 0640                 "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"

# ─── 6. Configure environment ────────────────────────────────────────────────
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
  info "Creating .env from template..."
  SESSION_SECRET=$(openssl rand -base64 32)
  POLARIS_SECRET_KEY=$(openssl rand -hex 32)
  cat > "$APP_DIR/.env" <<ENVFILE
# Database
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}

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

# Reverse-proxy (nginx) front-end — Polaris listens HTTP-only on
# 127.0.0.1:3000; nginx terminates TLS on 443.
POLARIS_PROXY_CERT_PATH=${CERT_DIR}/cert.pem
POLARIS_PUBLIC_URL=${PUBLIC_URL}

# Split-role replica count — the web role reads this so the Capacity Advisor
# sizes pools + max_connections correctly across the (web + N monitor +
# discovery) process group. Must match the number of polaris-monitor@N units
# enabled below; raise if you scale monitor replicas later.
POLARIS_MONITOR_REPLICAS=${MONITOR_REPLICAS}
# Extra CA bundle for Node's TLS (see .env.example for the full rationale).
# Detected from this host's trust store at install time. Add your internal root
# to the OS store (update-ca-trust / update-ca-certificates) and it is picked
# up from here — this points at the bundle, it does not import anything itself.
NODE_EXTRA_CA_CERTS=${NODE_CA_BUNDLE}
ENVFILE
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  info ".env created with generated SESSION_SECRET + POLARIS_SECRET_KEY + proxy-mode env vars"
else
  info ".env already exists — appending proxy-mode + replica + secret-key env vars if missing"
  if ! grep -q '^POLARIS_PROXY_CERT_PATH=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-ubuntu.sh — reverse-proxy front-end"
      echo "POLARIS_PROXY_CERT_PATH=${CERT_DIR}/cert.pem"
      echo "POLARIS_PUBLIC_URL=${PUBLIC_URL}"
    } >> "$APP_DIR/.env"
  fi
  if ! grep -q '^POLARIS_MONITOR_REPLICAS=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-ubuntu.sh — split-role replica count (Capacity Advisor input)"
      echo "POLARIS_MONITOR_REPLICAS=${MONITOR_REPLICAS}"
    } >> "$APP_DIR/.env"
  fi
  # Installs that predate secrets-at-rest have no key, so device + integration
  # credentials sit in the clear in Postgres (and in every pg_dump). Mint one
  # here; the backfillSecretEncryption job seals the existing rows on next boot.
  if ! grep -q '^POLARIS_SECRET_KEY=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-ubuntu.sh — encryption key for secrets stored in the database"
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

# ─── 7. Install dependencies & build ─────────────────────────────────────────
info "Installing dependencies..."
sudo -u "$APP_USER" npm ci --include=dev

info "Building TypeScript..."
# `npm run build` (not bare tsc) so scripts/copy-build-assets.mjs runs and the
# bundled std MIB .txt files land in dist/services/stdMibs/ — without them the
# SNMP Walk tab's standard MIBs (LLDP-MIB etc.) report "not installed".
sudo -u "$APP_USER" npm run build

info "Running database migrations..."
sudo -u "$APP_USER" npx prisma migrate deploy

# Only seed on first deploy (skip if users table already has rows)
HAS_USERS=$(sudo -u postgres psql -tc "SELECT count(*) FROM ${DB_NAME}.public.users" 2>/dev/null | tr -d ' ')
if [[ "$HAS_USERS" == "" || "$HAS_USERS" == "0" ]]; then
  info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
  sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts || true
else
  info "Database already seeded ($HAS_USERS users) — skipping"
fi

# ─── 8. Install split-role systemd units ────────────────────────────────────
info "Installing split-role systemd units (polaris-migrate, polaris-web, polaris-monitor@, polaris-discovery, polaris-dash, polaris.target)..."
cp "$APP_DIR/deploy/polaris-migrate.service"    /etc/systemd/system/polaris-migrate.service
cp "$APP_DIR/deploy/polaris-web.service"        /etc/systemd/system/polaris-web.service
cp "$APP_DIR/deploy/polaris-monitor@.service"   /etc/systemd/system/polaris-monitor@.service
cp "$APP_DIR/deploy/polaris-discovery.service"  /etc/systemd/system/polaris-discovery.service
cp "$APP_DIR/deploy/polaris-dash.service"       /etc/systemd/system/polaris-dash.service
cp "$APP_DIR/deploy/polaris.target"             /etc/systemd/system/polaris.target

# Ubuntu/Debian's PostgreSQL service is just `postgresql` (the wrapper over
# postgresql@<major>-main), not the versioned unit RHEL/PGDG uses. The shipped
# units name NO PostgreSQL unit at all, so this is a drop-in rather than the
# in-place rewrite it used to be — and that rewrite was load-bearing and wrong:
# every update overwrites the main unit files verbatim, so the RHEL name came
# straight back and the host was left requiring a unit Debian does not have.
# Drop-ins survive both sync paths. Reference: deploy/dropins/20-postgres.conf.example.
info "Installing the PostgreSQL dependency drop-in (postgresql.service)..."
for unit in polaris-migrate polaris-web polaris-monitor@ polaris-discovery polaris-dash; do
  mkdir -p "/etc/systemd/system/${unit}.service.d"
  cat > "/etc/systemd/system/${unit}.service.d/20-postgres.conf" <<'DROPIN'
# Written by deploy/setup-ubuntu.sh. Survives updates — the main unit file
# does not. postgresql.service is Debian's wrapper over postgresql@<major>-main.
[Unit]
After=postgresql.service
Requires=postgresql.service
DROPIN
done

info "Installing polaris-web's Wants=nginx drop-in..."
mkdir -p "$NGINX_DROPIN_DIR"
cp "$APP_DIR/deploy/nginx/polaris-nginx-dependency.conf" "$NGINX_DROPIN_DIR/nginx-dependency.conf"

systemctl daemon-reload

# ─── 9. Configure nginx ─────────────────────────────────────────────────────
info "Installing nginx config (server_name=$HOSTNAME_FROM_URL, prometheus_ip=$PROMETHEUS_IP)..."
sed "s|polaris\\.example\\.com|$HOSTNAME_FROM_URL|g; s|<PROMETHEUS_IP>|$PROMETHEUS_IP|g" \
  "$APP_DIR/deploy/nginx/polaris.conf" > "$NGINX_CONF_DEST"
nginx -t

# ─── 9b. Install in-app nginx GUI helpers ───────────────────────────────────
info "Installing in-app nginx GUI helpers (idempotent)..."
install -o root -g root -m 0755 "$APP_DIR/deploy/scripts/polaris-nginx-apply.sh" /usr/local/sbin/polaris-nginx-apply
install -o root -g root -m 0440 "$APP_DIR/deploy/sudoers.d/polaris-nginx"        /etc/sudoers.d/polaris-nginx
install -o root -g root -m 0644 "$APP_DIR/deploy/tmpfiles.d/polaris-nginx.conf"  /etc/tmpfiles.d/polaris-nginx.conf
systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true
# Ubuntu's nginx package uses the `www-data` group (not `nginx`). Detect
# whichever group owns /etc/polaris-nginx/cert.pem at install time and add
# polaris to it.
NGINX_GROUP=$(stat -c '%G' /etc/polaris-nginx/cert.pem 2>/dev/null || true)
if [[ -n "$NGINX_GROUP" ]] && ! id -nG "$APP_USER" 2>/dev/null | grep -qw "$NGINX_GROUP"; then
  usermod -aG "$NGINX_GROUP" "$APP_USER"
  info "Added $APP_USER to the $NGINX_GROUP group (cert file readability)"
fi

# ─── 10. Firewall ───────────────────────────────────────────────────────────
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

# ─── 11. Enable + start services ────────────────────────────────────────────
info "Enabling polaris-monitor@1..@$MONITOR_REPLICAS, polaris-discovery, polaris.target, nginx..."
for ((i=1; i<=MONITOR_REPLICAS; i++)); do
  systemctl enable "polaris-monitor@$i.service" >/dev/null
done
systemctl enable polaris-web.service polaris-discovery.service polaris-dash.service polaris-migrate.service polaris.target >/dev/null
systemctl enable nginx >/dev/null

info "Starting polaris.target (brings up nginx first, then polaris-web + workers)..."
systemctl start polaris.target

# ─── 12. Smoke checks ───────────────────────────────────────────────────────
sleep 5
SMOKE_FAILED=0
if ss -ltnp 2>/dev/null | grep -qE ':443.*nginx'; then
  info "✓ nginx TCP listener on :443"
else
  warn "✗ nginx TCP listener on :443 not detected"
  SMOKE_FAILED=1
fi
if ss -lunp 2>/dev/null | grep -qE ':443.*nginx'; then
  info "✓ nginx UDP listener on :443 (HTTP/3)"
else
  warn "✗ nginx UDP listener on :443 not detected"
  SMOKE_FAILED=1
fi
if ss -ltnp 2>/dev/null | grep -qE '127\\.0\\.0\\.1:3000.*node'; then
  info "✓ Polaris web bound to 127.0.0.1:3000 (proxy mode)"
else
  warn "✗ Polaris web not bound to 127.0.0.1:3000 — check journalctl -u polaris-web"
  SMOKE_FAILED=1
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Polaris deployment complete!"
info "  URL:           $PUBLIC_URL"
info "  Cert path:     $CERT_DIR/cert.pem  (self-signed; replace with real CA cert later)"
info "  Monitor units: polaris-monitor@1..@$MONITOR_REPLICAS"
info "  Logs:          journalctl -u polaris-web -f"
info "  Status:        systemctl status polaris.target"
info "============================================"
if [[ $SMOKE_FAILED -ne 0 ]]; then
  echo ""
  warn "One or more smoke checks failed. Verify manually before declaring done."
fi
echo ""
warn "Self-signed cert in use. Replace before exposing publicly."
