#!/usr/bin/env bash
# deploy/setup-rhel.sh — Polaris deployment script for RHEL / Rocky / Alma Linux 9
#
# Run as root:  bash deploy/setup-rhel.sh --public-url https://polaris.example.com
#
# What this script does (Phase 3+ — single-process polaris.service no longer
# shipped to production; every fresh install is split-role + nginx-fronted):
#   1. Installs Node.js 24, PostgreSQL 15, Go 1.22+, git, nginx (mainline ≥1.25)
#   2. Creates a dedicated 'polaris' system user + DB + role
#   3. Clones the application to /opt/polaris
#   4. Installs dependencies, builds, runs migrations
#   5. Generates a self-signed TLS cert for the supplied --public-url hostname
#      (operator replaces with a real cert later by swapping the files +
#      `systemctl reload nginx` — no code change needed)
#   6. Drops the polaris.target + polaris-web/-monitor@/-discovery/-migrate
#      systemd units; enables the monitor template at @1..@N (default N=2);
#      installs the polaris-web Wants=nginx drop-in
#   7. Configures nginx with the operator's hostname and Prometheus IP
#      (default 127.0.0.1 — change later via a drop-in if you scrape off-host)
#   8. Sets POLARIS_PROXY_CERT_PATH + POLARIS_PUBLIC_URL in .env
#   9. Opens TCP+UDP/443 in firewalld
#  10. Starts polaris.target — which pulls nginx up first via the drop-in,
#      then starts polaris-web in proxy mode (HTTP-only on 127.0.0.1:3000)
#
# After running, the app is available at the supplied --public-url. Operators
# replace the self-signed cert by overwriting /etc/polaris-nginx/{cert,key}.pem
# and reloading nginx.
#
# Arguments:
#   --public-url        https://<hostname>[:<port>]  (default: https://$(hostname -f))
#   --monitor-replicas  N                            (default: 2)
#   --prometheus-ip     <IP>                         (default: 127.0.0.1)
#   --no-epel           skip enabling EPEL for fping (optional dep, see below)
#
# Local dev (npm run dev with POLARIS_ROLE unset = "all") still works without
# any of this — it's a runtime mode in src/utils/role.ts, separate from
# production deploy artifacts.

set -euo pipefail

# Whether to enable EPEL if fping is not already available (see the fping
# step below). --no-epel turns it off; the repo is never enabled for
# anything else.
INSTALL_EPEL="yes"
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
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── Args ────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)        PUBLIC_URL="$2"; shift 2;;
    --monitor-replicas)  MONITOR_REPLICAS="$2"; shift 2;;
    --prometheus-ip)     PROMETHEUS_IP="$2"; shift 2;;
    --no-epel)           INSTALL_EPEL="no"; shift;;
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

# Pull the hostname out of the URL for the self-signed cert's CN + SAN.
HOSTNAME_FROM_URL=$(echo "$PUBLIC_URL" | sed -E 's|^https://([^:/]+).*|\1|')

info "Starting Polaris deployment on $(hostname)"
info "  Public URL:        $PUBLIC_URL"
info "  Cert hostname:     $HOSTNAME_FROM_URL"
info "  Monitor replicas:  $MONITOR_REPLICAS"
info "  Prometheus IP:     $PROMETHEUS_IP"

# ─── 1. Install Node.js 24 (LTS) ─────────────────────────────────────────────
# 22.12 is the hard floor (pg-boss declares >=22.12.0, @prisma/streams-local
# >=22), so v20 is no longer merely old — it is below what the dependency tree
# supports, and it went EOL in April 2026. RHEL 9 AppStream carries a nodejs:24
# module stream, so this stays on vendor-packaged Node.
#
# An existing v22 install is accepted rather than forced up: it satisfies the
# floor and is supported until ~April 2027. v20 and below are replaced.
if command -v node &>/dev/null && [[ "$(node -v)" == v24* || "$(node -v)" == v22* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 24..."
  # `module reset` first: enabling a second stream on a host already pinned to
  # nodejs:20 fails with "cannot enable multiple streams" otherwise.
  dnf module reset -y nodejs
  dnf module enable -y nodejs:24
  dnf install -y nodejs npm
  info "Node.js $(node -v) installed"
fi

# ─── 1b. Install Go 1.22+ ────────────────────────────────────────────────────
# Required by the Polaris Agent build feature (Server Settings → Maintenance
# → Polaris Agent → Build). The agent's go.mod pins go 1.22 as the minimum;
# RHEL 9's default golang AppStream module ships 1.21.x which is too old,
# so pull from the go-toolset module instead.
if command -v go &>/dev/null && go version | grep -qE 'go1\.(2[2-9]|[3-9][0-9])'; then
  info "Go $(go version | awk '{print $3}') already installed"
else
  info "Installing Go (go-toolset)..."
  dnf module enable -y go-toolset
  dnf install -y golang
  info "Go $(go version | awk '{print $3}') installed"
fi

# ─── 1c. Install nginx mainline (HTTP/3 ≥ 1.25 required) ─────────────────────
# RHEL 9's AppStream nginx is too old for HTTP/3, so always pull mainline from
# nginx.org. The repo file pins enabled=1 so unattended `dnf upgrade` keeps
# the mainline version instead of replacing with AppStream.
if command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | grep -qE '1\.(2[5-9]|[3-9][0-9])'; then
  info "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') already installed"
else
  info "Installing nginx mainline from nginx.org..."
  cat > /etc/yum.repos.d/nginx.repo <<'REPO'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/9/$basearch/
gpgcheck=1
enabled=0
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true

[nginx-mainline]
name=nginx mainline repo
baseurl=http://nginx.org/packages/mainline/centos/9/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
REPO
  dnf install -y nginx
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
# Optional on purpose: fping lives in EPEL on RHEL, and adding a third-party
# repo to an enterprise host is the operator's decision, not this script's.
# Pass --no-epel to skip that step — the plain `dnf install` is still tried
# first, in case a local mirror already carries it. Never fatal.
#
# The packaged binary carries cap_net_raw=ep as a file capability, so the
# unprivileged polaris service user can run it with no sudo wiring.
if command -v fping &>/dev/null; then
  info "fping already installed ($(fping -v 2>&1 | head -1))"
elif dnf install -y fping &>/dev/null; then
  info "fping installed"
elif [[ "$INSTALL_EPEL" == "yes" ]] \
     && dnf install -y epel-release &>/dev/null \
     && dnf install -y fping &>/dev/null; then
  info "fping installed (enabled the EPEL repository to do it)"
else
  warn "fping not installed — packet loss is still measured, but via one ping"
  warn "  process per host. On a large fleet Polaris stretches the loss sweep"
  warn "  interval to suit. To fix later:  dnf install -y epel-release fping"
fi

# ─── 2. Install PostgreSQL 15 (PGDG, not AppStream) ─────────────────────────
# PGDG rather than RHEL's AppStream module, and the reason is load-bearing
# rather than preference: the TimescaleDB package requires `postgresql15-server`,
# a PGDG package name. AppStream has no package by that name at all, so an
# AppStream install can never gain the extension every sample table wants.
#
# What this block used to do was worse than it looked. It ran
# `dnf install -y postgresql-server postgresql` with no module enabled, then
# `postgresql-setup --initdb`. Verified against the RHEL 9.5 DVD:
#
#   * the AppStream `postgresql` module declares NO default stream (its defaults
#     document lists profiles for 15 and 16 and nothing else), so the modular
#     packages stay hidden until a stream is explicitly enabled;
#   * the non-modular default in AppStream is `postgresql-server-13.16-1.el9`.
#
# So a fresh install got **PostgreSQL 13** -- two majors below the 15 Polaris
# states as its minimum, incapable of TimescaleDB, and producing an unversioned
# `postgresql.service` while the units this same script installs declare
# `Requires=postgresql-15.service`. It could not satisfy its own units and it
# was not even installing the right major. docs/INSTALL.md documented the PGDG
# path all along.
PG_MAJOR=15
PG_SERVICE="postgresql-${PG_MAJOR}"
PG_BINDIR="/usr/pgsql-${PG_MAJOR}/bin"
PG_DATADIR="/var/lib/pgsql/${PG_MAJOR}/data"

if [[ -x "$PG_BINDIR/psql" ]]; then
  info "PostgreSQL ${PG_MAJOR} (PGDG) already installed"
else
  info "Installing PostgreSQL ${PG_MAJOR} from PGDG..."
  dnf install -y "https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
  # Without this the AppStream module's packages shadow PGDG's.
  dnf -qy module disable postgresql
  dnf install -y "postgresql${PG_MAJOR}" "postgresql${PG_MAJOR}-server" "postgresql${PG_MAJOR}-contrib"
  info "PostgreSQL ${PG_MAJOR} installed"
fi

# Polaris spawns `psql` and `pg_dump` by BARE NAME for backup and restore
# (src/services/backupService.ts), so they have to be on the service's PATH.
# PGDG handles that itself: its packages register /usr/bin/psql and
# /usr/bin/pg_dump through `alternatives`, pointing at the installed major's
# bindir. Verified in a systemd container on AlmaLinux 9 (RHEL-compatible):
# `pg_dump` resolves to /usr/pgsql-15/bin/pg_dump via
# /etc/alternatives/pgsql-pg_dump and dumps a live database with no help.
#
# So this only CHECKS the link. Do NOT symlink these into /usr/local/bin --
# an earlier version of this script did, on the false assumption that PGDG put
# nothing on PATH. /usr/local/bin PRECEDES /usr/bin, so a hardcoded link there
# silently shadows the alternatives entry and would keep resolving to 15 after
# an operator moved to a newer major side by side
# (`alternatives --set pgsql-psql /usr/pgsql-NN/bin/psql`). Side-by-side majors
# are one of the reasons PGDG was chosen over AppStream, so shadowing them
# would defeat the point -- and it would fail the way that costs most, with
# backups quietly using the old client while everything looked fine.
#
# Presence is not enough — check the MAJOR. On 2026-09-09 prod's /usr/bin/pg_dump
# passed `command -v` and `alternatives --display` said it pointed at 15, but the
# file on disk was a regular binary owned by the AppStream 13 package (a leftover
# of the pre-PGDG version of this script), and pg_dump refuses a server newer
# than itself. Only `--version` tells the truth. Polaris itself now resolves
# /usr/pgsql-${PG_MAJOR}/bin/<tool> directly (src/utils/pgClientTools.ts), but
# deploy/update-linux.sh's fallback path and every human at a shell get PATH.
for _pgtool in psql pg_dump; do
  if ! command -v "$_pgtool" >/dev/null 2>&1; then
    warn "$_pgtool is not on PATH after installing PostgreSQL ${PG_MAJOR}."
    warn "  Polaris spawns it by name for backup/restore, so BACKUPS WILL FAIL until this is fixed."
    warn "  Diagnose with: alternatives --display pgsql-${_pgtool}"
    continue
  fi
  _pgtool_path=$(command -v "$_pgtool")
  _pgtool_major=$("$_pgtool_path" --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  if [[ -n "$_pgtool_major" && "$_pgtool_major" -lt "$PG_MAJOR" ]]; then
    warn "$_pgtool on PATH is PostgreSQL ${_pgtool_major}, not ${PG_MAJOR}: ${_pgtool_path} is probably RHEL's AppStream package"
    warn "  shadowing PGDG's alternatives link (check: rpm -qf ${_pgtool_path}). pg_dump refuses a server newer than itself,"
    warn "  so backups taken by name WILL FAIL. Fix: dnf remove postgresql postgresql-server (the unversioned packages),"
    warn "  then: alternatives --auto pgsql-${_pgtool}  and confirm with: ${_pgtool} --version"
  fi
done

# Idempotent: postgresql-N-setup refuses to run over an existing PGDATA, and
# re-running this script on a live host must not be a destructive act.
if [[ ! -s "$PG_DATADIR/PG_VERSION" ]]; then
  info "Initializing PGDATA at $PG_DATADIR..."
  "$PG_BINDIR/postgresql-${PG_MAJOR}-setup" initdb
else
  info "PGDATA already initialized at $PG_DATADIR"
fi

# ─── 2b. Install git ────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  info "Git already installed"
else
  info "Installing git..."
  dnf install -y git
  info "Git installed"
fi

# Enable and start PostgreSQL
systemctl enable --now "$PG_SERVICE"
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
# The in-app Build button writes to $APP_DIR/data/agents/<version>/ and
# uses $APP_DIR/.cache/go-build as Go's build cache (HOME=$APP_DIR for the
# build subprocess). Create both upfront with the right ownership so the
# first click doesn't crash trying to mkdir under root-owned ancestors.
mkdir -p "$APP_DIR/data/agents" "$APP_DIR/.cache/go-build"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/data/agents" "$APP_DIR/.cache"

# ─── 3c. Java 17 + jsign (agent code signing — optional at runtime) ─────────
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
  info "Installing Java 17 (headless, for agent code signing)..."
  dnf install -y java-17-openjdk-headless || \
    info "WARNING: Java install failed — agent code signing stays unavailable until Java is installed manually"
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
pushd /tmp >/dev/null
sudo -u postgres "$PG_BINDIR/psql" -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres "$PG_BINDIR/psql" -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"

sudo -u postgres "$PG_BINDIR/psql" -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres "$PG_BINDIR/psql" -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

# pg-boss (queue runtime for monitor cadences at scale) lives in its own
# `pgboss` schema. Make sure the polaris role owns it so pg-boss can create
# its tables and the workers can boot. Idempotent — safe to re-run.
sudo -u postgres "$PG_BINDIR/psql" -d "$DB_NAME" <<SQL
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
PG_HBA=$(sudo -u postgres "$PG_BINDIR/psql" -tc "SHOW hba_file;" | tr -d ' ')
if ! grep -q "$DB_USER" "$PG_HBA" 2>/dev/null; then
  warn "Adding md5 auth entry for '$DB_USER' to pg_hba.conf"
  sed -i "/^# TYPE/a local   $DB_NAME   $DB_USER   md5\nhost    $DB_NAME   $DB_USER   127.0.0.1/32   md5\nhost    $DB_NAME   $DB_USER   ::1/128        md5" "$PG_HBA"
  systemctl reload "$PG_SERVICE"
fi
popd >/dev/null

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

# ─── 6. Generate self-signed TLS cert ────────────────────────────────────────
# nginx serves this; agents pin its SHA-256. Operators replace by overwriting
# /etc/polaris-nginx/{cert,key}.pem with their real cert + `nginx -s reload`.
# 10-year self-signed gives plenty of runway for the operator to bring a real
# CA cert in via the cert-pin rotation flow (Server Settings → Maintenance).
mkdir -p "$CERT_DIR"
if [[ -f "$CERT_DIR/cert.pem" && -f "$CERT_DIR/key.pem" ]]; then
  info "Cert already present at $CERT_DIR — skipping generation"
else
  info "Generating self-signed cert for $HOSTNAME_FROM_URL..."
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$CERT_DIR/key.pem" \
    -out    "$CERT_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=$HOSTNAME_FROM_URL" \
    -addext "subjectAltName=DNS:$HOSTNAME_FROM_URL" \
    >/dev/null 2>&1
  info "Cert generated"
fi
# 0640 root:nginx so the nginx worker (running as user nginx) can read but
# nothing else on the box can. Group `nginx` is created by the nginx RPM.
chown root:nginx "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"
chmod 0640        "$CERT_DIR/cert.pem" "$CERT_DIR/key.pem"

# SELinux: nginx must be allowed to read /etc/polaris-nginx/. semanage +
# restorecon is the persistent path (survives relabels); plain chcon is
# volatile. Skip silently if policycoreutils-python-utils isn't installed.
if command -v semanage >/dev/null 2>&1; then
  semanage fcontext -a -t httpd_sys_content_t "$CERT_DIR(/.*)?" 2>/dev/null || \
    semanage fcontext -m -t httpd_sys_content_t "$CERT_DIR(/.*)?" 2>/dev/null || true
  restorecon -Rv "$CERT_DIR" >/dev/null || true
fi

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

# Reverse-proxy (nginx) front-end — Phase 1+. Polaris listens HTTP-only on
# 127.0.0.1:3000; nginx terminates TLS on 443 using the cert at
# POLARIS_PROXY_CERT_PATH. POLARIS_PUBLIC_URL is required in this mode.
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
      echo "# Added by setup-rhel.sh — reverse-proxy front-end (Phase 1+)"
      echo "POLARIS_PROXY_CERT_PATH=${CERT_DIR}/cert.pem"
      echo "POLARIS_PUBLIC_URL=${PUBLIC_URL}"
    } >> "$APP_DIR/.env"
  fi
  if ! grep -q '^POLARIS_MONITOR_REPLICAS=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-rhel.sh — split-role replica count (Capacity Advisor input)"
      echo "POLARIS_MONITOR_REPLICAS=${MONITOR_REPLICAS}"
    } >> "$APP_DIR/.env"
  fi
  # Installs that predate secrets-at-rest have no key, so device + integration
  # credentials sit in the clear in Postgres (and in every pg_dump). Mint one
  # here; the backfillSecretEncryption job seals the existing rows on next boot.
  if ! grep -q '^POLARIS_SECRET_KEY=' "$APP_DIR/.env"; then
    {
      echo ""
      echo "# Added by setup-rhel.sh — encryption key for secrets stored in the database"
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

# Only seed on first deploy (skip if users table already has rows)
HAS_USERS=$(cd /tmp && sudo -u postgres "$PG_BINDIR/psql" -tc "SELECT count(*) FROM ${DB_NAME}.public.users" 2>/dev/null | tr -d ' ') || HAS_USERS=""
if [[ "$HAS_USERS" == "" || "$HAS_USERS" == "0" ]]; then
  info "Seeding default admin (skipped in production — use the first-run wizard or restore from backup)..."
  sudo -u "$APP_USER" node --env-file=.env --import tsx/esm prisma/seed.ts || true
else
  info "Database already seeded ($HAS_USERS users) — skipping"
fi

# ─── 9. Install split-role systemd units + nginx-dependency drop-in ─────────
info "Installing split-role systemd units (polaris-migrate, polaris-web, polaris-monitor@, polaris-discovery, polaris-dash, polaris.target)..."
cp "$APP_DIR/deploy/polaris-migrate.service"    /etc/systemd/system/polaris-migrate.service
cp "$APP_DIR/deploy/polaris-web.service"        /etc/systemd/system/polaris-web.service
cp "$APP_DIR/deploy/polaris-monitor@.service"   /etc/systemd/system/polaris-monitor@.service
cp "$APP_DIR/deploy/polaris-discovery.service"  /etc/systemd/system/polaris-discovery.service
cp "$APP_DIR/deploy/polaris-dash.service"       /etc/systemd/system/polaris-dash.service
cp "$APP_DIR/deploy/polaris.target"             /etc/systemd/system/polaris.target

info "Installing polaris-web's Wants=nginx drop-in..."
mkdir -p "$NGINX_DROPIN_DIR"
cp "$APP_DIR/deploy/nginx/polaris-nginx-dependency.conf" "$NGINX_DROPIN_DIR/nginx-dependency.conf"

systemctl daemon-reload

# ─── 10. Configure nginx ────────────────────────────────────────────────────
info "Installing nginx config (server_name=$HOSTNAME_FROM_URL, prometheus_ip=$PROMETHEUS_IP)..."
# The shipped polaris.conf hardcodes polaris.example.com as the
# server_name and <PROMETHEUS_IP> as the allowlist placeholder. Substitute
# both for this install's values. Operators can replace later by editing the
# drop-in at /etc/nginx/conf.d/polaris-local.conf (don't edit polaris.conf
# directly — the in-app updater syncs it on every release).
sed "s|polaris\\.example\\.com|$HOSTNAME_FROM_URL|g; s|<PROMETHEUS_IP>|$PROMETHEUS_IP|g" \
  "$APP_DIR/deploy/nginx/polaris.conf" > "$NGINX_CONF_DEST"

info "Validating nginx config..."
nginx -t

# ─── 10b. Install in-app nginx GUI helpers ──────────────────────────────────
# /usr/local/sbin/polaris-nginx-apply + narrow sudoers grant + tmpfiles
# staging dir back the Server Settings → Certificates nginx GUI.
# Existing installs picking this up via in-app update get the same wiring
# through updateService.ts's sync block, but we land it eagerly here so
# fresh installs work out of the box without an extra restart cycle.
info "Installing in-app nginx GUI helpers (idempotent)..."
install -o root -g root -m 0755 "$APP_DIR/deploy/scripts/polaris-nginx-apply.sh" /usr/local/sbin/polaris-nginx-apply
install -o root -g root -m 0440 "$APP_DIR/deploy/sudoers.d/polaris-nginx"        /etc/sudoers.d/polaris-nginx
install -o root -g root -m 0644 "$APP_DIR/deploy/tmpfiles.d/polaris-nginx.conf"  /etc/tmpfiles.d/polaris-nginx.conf
systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true
if ! id -nG "$APP_USER" 2>/dev/null | grep -qw nginx; then
  usermod -aG nginx "$APP_USER"
  info "Added $APP_USER to the nginx group (cert file readability)"
fi

# The in-app updater restarts the whole process group, not just its own
# process: the web role migrates the database, so monitor and discovery must
# not keep running the previous release against the new schema. That group
# restart needs a polkit grant for the polaris user. Without it the updater
# quietly falls back to restarting only the web process, and the update looks
# like it worked. Documented in docs/INSTALL.md since the split-role layout
# shipped, and installed by no script until now.
if [[ -f "$APP_DIR/deploy/polkit/49-polaris.rules" ]]; then
  mkdir -p /etc/polkit-1/rules.d
  install -o root -g root -m 0644 "$APP_DIR/deploy/polkit/49-polaris.rules" /etc/polkit-1/rules.d/49-polaris.rules
  info "Installed the polkit rule for the in-app updater group restart"
else
  warn "deploy/polkit/49-polaris.rules not found — the in-app updater will only be able to restart the web role"
fi

# ─── 11. Firewall ───────────────────────────────────────────────────────────
if command -v firewall-cmd &>/dev/null; then
  info "Opening TCP+UDP/443 in firewalld..."
  firewall-cmd --permanent --add-port=443/tcp >/dev/null
  firewall-cmd --permanent --add-port=443/udp >/dev/null
  firewall-cmd --reload >/dev/null
fi

# ─── 12. Enable + start services ────────────────────────────────────────────
info "Enabling polaris-monitor@1..@$MONITOR_REPLICAS, polaris-discovery, polaris.target, nginx..."
for ((i=1; i<=MONITOR_REPLICAS; i++)); do
  systemctl enable "polaris-monitor@$i.service" >/dev/null
done
systemctl enable polaris-web.service >/dev/null
systemctl enable polaris-discovery.service >/dev/null
systemctl enable polaris-dash.service >/dev/null
systemctl enable polaris-migrate.service >/dev/null
systemctl enable polaris.target >/dev/null
# Don't `--now` nginx; polaris.target's start pulls it in via the Wants= drop-in.
systemctl enable nginx >/dev/null

info "Starting polaris.target (this brings up nginx first, then polaris-web + workers)..."
systemctl start polaris.target

# ─── 13. Smoke checks ──────────────────────────────────────────────────────
info "Waiting 5s for services to settle..."
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
  warn "  journalctl -u nginx -n 50"
  warn "  journalctl -u polaris-web -n 50"
fi
echo ""
warn "Self-signed cert in use. Replace with your real CA cert by:"
warn "  1. Copy your cert + key to $CERT_DIR/cert.pem and $CERT_DIR/key.pem"
warn "  2. chown root:nginx + chmod 0640 on both files"
warn "  3. Stage the new pin in Server Settings → Maintenance → Polaris Agent → Cert pin rotation"
warn "  4. systemctl reload nginx"
warn "  5. Wait for agents to heartbeat, then retire the old pin"
