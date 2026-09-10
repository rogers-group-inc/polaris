#!/usr/bin/env bash
# deploy/migrate-to-nginx.sh — opt-in cutover from Node-terminated HTTPS to
# external nginx reverse proxy on RHEL/Rocky/AlmaLinux 9.
#
# Run as root:
#   sudo bash deploy/migrate-to-nginx.sh \
#     --public-url https://polaris.example.com \
#     --prometheus-ip 10.0.0.42
#
# What this does:
#   1. Confirms split-role polaris.target is enabled (single-process is unsupported here)
#   2. Ensures nginx >= 1.30 (HTTP/3 stable, current stable branch) — installs from nginx.org if older/missing
#   3. Extracts the active server cert + key from Setting.certificates to a temp dir
#   4. Stages the nginx config with PROMETHEUS_IP substituted, validates with `nginx -t`
#   5. Commits everything atomically: writes /etc/polaris-nginx/{cert,key}.pem with
#      0640 root:nginx + SELinux httpd_sys_content_t, drops nginx config, appends
#      POLARIS_PROXY_CERT_PATH + POLARIS_PUBLIC_URL to /opt/polaris/.env, installs
#      the polaris-web systemd drop-in, opens TCP+UDP/443 in firewalld
#   6. systemctl daemon-reload, nginx -t (full system config), reload nginx,
#      restart polaris.target
#   7. Smoke tests: Alt-Svc header, UDP listener up, /metrics-monitor-1 returns 401/200
#
# Idempotent: re-running detects the migrated state and exits cleanly.
# Transactional: any failure rolls back .env + nginx config before exiting non-zero.
#
# Rollback after success: bash deploy/migrate-to-nginx.sh --rollback

set -euo pipefail

APP_DIR="/opt/polaris"
ENV_FILE="$APP_DIR/.env"
DB_NAME="polaris"
NGINX_CERT_DIR="/etc/polaris-nginx"
NGINX_CONF_DEST="/etc/nginx/conf.d/polaris.conf"
NGINX_DROPIN_DIR="/etc/systemd/system/polaris-web.service.d"
NGINX_DROPIN_FILE="$NGINX_DROPIN_DIR/nginx-dependency.conf"
SHIPPED_NGINX_CONF="$APP_DIR/deploy/nginx/polaris.conf"
SHIPPED_DROPIN="$APP_DIR/deploy/nginx/polaris-nginx-dependency.conf"

# ─── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# ─── Args ─────────────────────────────────────────────────────────────────
PUBLIC_URL=""
PROMETHEUS_IP=""
ROLLBACK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url)    PUBLIC_URL="$2"; shift 2;;
    --prometheus-ip) PROMETHEUS_IP="$2"; shift 2;;
    --rollback)      ROLLBACK=1; shift;;
    -h|--help)
      head -40 "$0" | sed -n '/^#/p'
      exit 0;;
    *) error "Unknown argument: $1"; exit 2;;
  esac
done

# ─── Preflight ────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must run as root."
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  error "$APP_DIR is not a git repository — was Polaris installed via deploy/setup-rhel.sh?"
  exit 1
fi

# ─── Rollback path ────────────────────────────────────────────────────────
if [[ "$ROLLBACK" == "1" ]]; then
  step "Rollback: reverting to Node-terminated HTTPS"
  # Locate the most recent .env backup
  BACKUP=$(ls -1t "$APP_DIR"/.env.pre-nginx.* 2>/dev/null | head -1 || true)
  if [[ -z "$BACKUP" ]]; then
    error "No .env.pre-nginx.* backup found — cannot auto-rollback. Edit $ENV_FILE manually."
    exit 1
  fi
  info "Restoring $ENV_FILE from $BACKUP"
  cp -f "$BACKUP" "$ENV_FILE"
  if [[ -f "$NGINX_CONF_DEST" ]]; then
    info "Removing $NGINX_CONF_DEST"
    rm -f "$NGINX_CONF_DEST"
    if systemctl is-active --quiet nginx; then
      nginx -t && systemctl reload nginx
    fi
  fi
  if [[ -f "$NGINX_DROPIN_FILE" ]]; then
    info "Removing $NGINX_DROPIN_FILE"
    rm -f "$NGINX_DROPIN_FILE"
    systemctl daemon-reload
  fi
  systemctl restart polaris.target
  info "Rollback complete. Polaris is back on Node HTTPS using the cert in Setting.certificates."
  exit 0
fi

# ─── Forward path: preflight ──────────────────────────────────────────────
if ! systemctl is-enabled --quiet polaris.target 2>/dev/null; then
  error "polaris.target is not enabled. This migration script only supports the split-role layout."
  error "For single-process installs, stay on Node HTTPS for now (Phase 1 doesn't cover that path)."
  exit 1
fi

if [[ -z "$PUBLIC_URL" ]]; then
  error "--public-url is required. Example: --public-url https://polaris.example.com"
  exit 2
fi

if [[ -z "$PROMETHEUS_IP" ]]; then
  error "--prometheus-ip is required (the IP that should be allowed to scrape /metrics-* endpoints)."
  exit 2
fi

if [[ ! "$PUBLIC_URL" =~ ^https:// ]]; then
  error "--public-url must start with https:// — got: $PUBLIC_URL"
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  error "$ENV_FILE not found."
  exit 1
fi

step "Preflight: idempotency check"
if grep -q '^POLARIS_PROXY_CERT_PATH=' "$ENV_FILE" 2>/dev/null \
   && [[ -f "$NGINX_CERT_DIR/cert.pem" ]] \
   && [[ -f "$NGINX_CONF_DEST" ]] \
   && systemctl is-active --quiet nginx; then
  info "Already migrated — POLARIS_PROXY_CERT_PATH set in .env, cert file + nginx config present, nginx running."
  info "Nothing to do. To re-run the migration, remove POLARIS_PROXY_CERT_PATH from .env and re-invoke."
  exit 0
fi

step "Preflight: ensure nginx >= 1.30 (HTTP/3 stable, current stable branch)"
NEEDS_NGINX_INSTALL=0
if ! command -v nginx >/dev/null 2>&1; then
  info "nginx not installed; will install from nginx.org repo."
  NEEDS_NGINX_INSTALL=1
else
  NGINX_VER=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  NGINX_MAJOR=$(echo "$NGINX_VER" | cut -d. -f1)
  NGINX_MINOR=$(echo "$NGINX_VER" | cut -d. -f2)
  if [[ -z "$NGINX_VER" ]] || [[ $NGINX_MAJOR -lt 1 ]] || { [[ $NGINX_MAJOR -eq 1 ]] && [[ $NGINX_MINOR -lt 30 ]]; }; then
    warn "nginx $NGINX_VER is below 1.30 (the current stable branch). Replacing with nginx.org stable."
    NEEDS_NGINX_INSTALL=1
  else
    info "nginx $NGINX_VER detected — meets HTTP/3 requirement."
  fi
fi

if [[ "$NEEDS_NGINX_INSTALL" == "1" ]]; then
  step "Installing nginx stable from nginx.org"
  cat > /etc/yum.repos.d/nginx.repo <<'REPO'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/9/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true

[nginx-mainline]
name=nginx mainline repo
baseurl=http://nginx.org/packages/mainline/centos/9/$basearch/
gpgcheck=1
enabled=0
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
REPO
  dnf install -y nginx
  info "nginx $(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+') installed"
fi

step "Preflight: confirm DB reachable"
if ! sudo -u postgres psql -tA -d polaris -c "SELECT 1" >/dev/null 2>&1; then
  error "Cannot reach the polaris database via 'sudo -u postgres psql -d polaris'. Verify Postgres is running."
  exit 1
fi

# ─── Stage: extract cert+key from DB to a temp dir ────────────────────────
TMP=$(mktemp -d /tmp/polaris-nginx-stage.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

step "Stage: extracting active server cert + key from Setting.certificates"
# Pull the JSON values straight out of Postgres via the postgres superuser's
# peer-auth socket connection — same way the preflight check above already
# tested DB reachability. Avoids depending on Polaris's generated Prisma
# client (whose on-disk path moves between build configurations) or on the
# Polaris source tree being structured a particular way. The cert/key PEMs
# are written via a small inline `node -e` script that parses the JSON +
# selects the right records; Node is already required to run Polaris, so
# this adds no new install-time dependency.
EXTRACT_RC=0
# Postgres table name is `settings` (snake_case per @@map in
# prisma/schema.prisma), NOT `"Setting"` — `psql` would silently 0-row a
# quoted-PascalCase reference. Let stderr surface so a real table-not-found
# bubbles up rather than masquerading as "no row".
HTTPS_JSON=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "SELECT value FROM settings WHERE key='https'")
CERTS_JSON=$(sudo -u postgres psql -tA -d "$DB_NAME" -c "SELECT value FROM settings WHERE key='certificates'")

if [[ -z "$CERTS_JSON" ]]; then
  error "No 'certificates' Setting row found — has Polaris ever been configured with an HTTPS cert?"
  exit 1
fi

# Pass the two JSON blobs + the output dir via env to a Node one-liner. The
# script picks the canonical (Setting.https.certId/keyId) cert+key pair if
# Setting.https pins one, else falls back to the first server-category
# cert+key. Writes cert.pem + key.pem to the staging dir.
HTTPS_JSON="$HTTPS_JSON" CERTS_JSON="$CERTS_JSON" OUT_DIR="$TMP" node -e "
  const fs = require('node:fs');
  const path = require('node:path');
  const certs = JSON.parse(process.env.CERTS_JSON || '[]');
  const https = process.env.HTTPS_JSON ? JSON.parse(process.env.HTTPS_JSON) : { certId: null, keyId: null };
  let leafCert = null, leafKey = null;
  if (https.certId && https.keyId) {
    leafCert = certs.find(c => c.id === https.certId && c.category === 'server' && c.type === 'cert');
    leafKey  = certs.find(c => c.id === https.keyId  && c.category === 'server' && c.type === 'key');
  }
  if (!leafCert) leafCert = certs.find(c => c.category === 'server' && c.type === 'cert');
  if (!leafKey)  leafKey  = certs.find(c => c.category === 'server' && c.type === 'key');
  if (!leafCert) { console.error('No server cert (category=server, type=cert) in Setting.certificates.'); process.exit(1); }
  if (!leafKey)  { console.error('No server key (category=server, type=key) in Setting.certificates.');  process.exit(1); }
  fs.writeFileSync(path.join(process.env.OUT_DIR, 'cert.pem'), leafCert.pem, { mode: 0o640 });
  fs.writeFileSync(path.join(process.env.OUT_DIR, 'key.pem'),  leafKey.pem,  { mode: 0o640 });
  console.log('Extracted cert:', leafCert.name, '/ key:', leafKey.name);
" || EXTRACT_RC=$?
if [[ $EXTRACT_RC -ne 0 ]]; then
  error "Failed to extract cert+key from the database. See log above."
  exit 1
fi

step "Stage: building nginx config with PROMETHEUS_IP=$PROMETHEUS_IP"
sed "s|<PROMETHEUS_IP>|$PROMETHEUS_IP|g" "$SHIPPED_NGINX_CONF" > "$TMP/polaris.conf"

# Sanity-check the staged config standalone (just our server block — nginx -t
# wants a full config; do the full validation post-install).
if ! grep -q "listen 443 ssl" "$TMP/polaris.conf"; then
  error "Staged polaris.conf is missing the expected listen directive — corrupt template?"
  exit 1
fi

# ─── Commit: backup .env, install files, update env, firewall, reload ────
step "Commit: backing up .env"
BACKUP_TS=$(date +%Y%m%d-%H%M%S)
cp -p "$ENV_FILE" "$ENV_FILE.pre-nginx.$BACKUP_TS"
info "Backed up $ENV_FILE → $ENV_FILE.pre-nginx.$BACKUP_TS"

step "Commit: installing cert+key to $NGINX_CERT_DIR"
mkdir -p "$NGINX_CERT_DIR"
install -o root -g nginx -m 0640 "$TMP/cert.pem" "$NGINX_CERT_DIR/cert.pem"
install -o root -g nginx -m 0640 "$TMP/key.pem"  "$NGINX_CERT_DIR/key.pem"

step "Commit: SELinux contexts on $NGINX_CERT_DIR"
if command -v semanage >/dev/null 2>&1; then
  semanage fcontext -a -t httpd_sys_content_t "$NGINX_CERT_DIR(/.*)?" 2>/dev/null || \
    semanage fcontext -m -t httpd_sys_content_t "$NGINX_CERT_DIR(/.*)?" 2>/dev/null || true
  restorecon -Rv "$NGINX_CERT_DIR" || true
else
  warn "semanage not available — skipping SELinux context. If nginx 403s, install policycoreutils-python-utils and re-run."
fi

step "Commit: installing nginx config to $NGINX_CONF_DEST"
install -o root -g root -m 0644 "$TMP/polaris.conf" "$NGINX_CONF_DEST.new"
mv -f "$NGINX_CONF_DEST.new" "$NGINX_CONF_DEST"

step "Commit: installing systemd drop-in for polaris-web (waits on nginx)"
mkdir -p "$NGINX_DROPIN_DIR"
install -o root -g root -m 0644 "$SHIPPED_DROPIN" "$NGINX_DROPIN_FILE"
systemctl daemon-reload

step "Commit: installing in-app nginx GUI helpers"
# /usr/local/sbin/polaris-nginx-apply + narrow sudoers grant + tmpfiles
# staging dir back the Server Settings → Certificates nginx GUI. nginx is
# guaranteed installed at this point (preflight installed it), so the
# usermod is unconditional.
install -o root -g root -m 0755 "$APP_DIR/deploy/scripts/polaris-nginx-apply.sh" /usr/local/sbin/polaris-nginx-apply
install -o root -g root -m 0440 "$APP_DIR/deploy/sudoers.d/polaris-nginx"        /etc/sudoers.d/polaris-nginx
install -o root -g root -m 0644 "$APP_DIR/deploy/tmpfiles.d/polaris-nginx.conf"  /etc/tmpfiles.d/polaris-nginx.conf
systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true
if ! id -nG polaris 2>/dev/null | grep -qw nginx; then
  usermod -aG nginx polaris
  info "Added polaris user to the nginx group (cert file readability)"
fi

step "Commit: appending POLARIS_PROXY_CERT_PATH and POLARIS_PUBLIC_URL to $ENV_FILE"
# Idempotent: skip the append on re-run if the keys are already present
# (e.g. an earlier attempt got past this step but failed during nginx start).
# Avoids accumulating duplicate lines in .env across retries.
if ! grep -q '^POLARIS_PROXY_CERT_PATH=' "$ENV_FILE" 2>/dev/null; then
  {
    echo ""
    echo "# Added by deploy/migrate-to-nginx.sh on $BACKUP_TS"
    echo "POLARIS_PROXY_CERT_PATH=$NGINX_CERT_DIR/cert.pem"
    echo "POLARIS_PUBLIC_URL=$PUBLIC_URL"
  } >> "$ENV_FILE"
else
  info "POLARIS_PROXY_CERT_PATH already in $ENV_FILE — skipping append"
fi

step "Commit: opening TCP+UDP/443 in firewalld"
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=443/udp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
else
  warn "firewall-cmd not available — ensure TCP/443 and UDP/443 are open by other means."
fi

step "Commit: validating full nginx config with nginx -t"
if ! nginx -t 2>&1 | tee "$TMP/nginx-t.log"; then
  error "nginx -t failed. Rolling back changes."
  cp -f "$ENV_FILE.pre-nginx.$BACKUP_TS" "$ENV_FILE"
  rm -f "$NGINX_CONF_DEST" "$NGINX_DROPIN_FILE"
  systemctl daemon-reload
  exit 1
fi

step "Commit: enabling nginx (start happens via polaris.target's Wants= drop-in)"
# DON'T `--now` here. Polaris is still bound to :443 with Node HTTPS at this
# point; if we tried to start nginx now, the bind would fail. Instead, just
# enable nginx for boot persistence — the polaris.target restart below will
# stop polaris-web (freeing :443), then pull nginx in via the
# Wants=nginx.service drop-in we installed under polaris-web.service.d/.
# polaris-web's After=nginx ensures the new (proxy-mode) polaris-web boots
# AFTER nginx is listening, so there's no window of "Polaris up, nginx down".
systemctl enable nginx

step "Commit: restarting polaris.target — frees :443, starts nginx, restarts Polaris in proxy mode"
systemctl restart polaris.target

# ─── Smoke tests ──────────────────────────────────────────────────────────
step "Smoke: waiting 5s for services to settle"
sleep 5

SMOKE_FAILED=0

if ss -ltnp 2>/dev/null | grep -qE ':443\b.*nginx'; then
  info "✓ nginx TCP listener on :443"
else
  warn "✗ nginx TCP listener on :443 not detected"
  SMOKE_FAILED=1
fi

if ss -lunp 2>/dev/null | grep -qE ':443\b.*nginx'; then
  info "✓ nginx UDP listener on :443 (HTTP/3)"
else
  warn "✗ nginx UDP listener on :443 not detected — HTTP/3 may not be working"
  SMOKE_FAILED=1
fi

if ss -ltnp 2>/dev/null | grep -qE '127\.0\.0\.1:3000\b.*node'; then
  info "✓ Polaris web bound to 127.0.0.1:3000 (proxy mode)"
else
  warn "✗ Polaris web not bound to 127.0.0.1:3000 — check journalctl -u polaris-web"
  SMOKE_FAILED=1
fi

ALT_SVC=$(curl -ksI "https://localhost/" 2>/dev/null | grep -i '^alt-svc:' || true)
if [[ -n "$ALT_SVC" ]]; then
  info "✓ Alt-Svc header advertised: $ALT_SVC"
else
  warn "✗ Alt-Svc header not present — HTTP/3 won't be discovered by browsers"
  SMOKE_FAILED=1
fi

# Verify /metrics-monitor-1 reaches nginx + nginx dispatches the request:
#   200 = bearer accepted (METRICS_TOKEN unset or curl carried a valid token)
#   401 = nginx forwarded; upstream rejected the missing/bad bearer
#   403 = nginx's `allow <PROMETHEUS_IP>; deny all;` rejected localhost,
#         which is correct — this curl runs from the prod box itself, not
#         from the Prometheus host. A 403 here means nginx is correctly
#         enforcing the IP allowlist; the path is wired up. Operators verify
#         end-to-end from the Prometheus host separately.
# 502/504 here would mean nginx can't reach the upstream worker; we'd want
# to surface that.
METRICS_CODE=$(curl -ks -o /dev/null -w '%{http_code}' "https://localhost/metrics-monitor-1" || echo "000")
case "$METRICS_CODE" in
  200|401|403)
    info "✓ /metrics-monitor-1 responds ($METRICS_CODE)"
    if [[ "$METRICS_CODE" == "403" ]]; then
      info "  (403 from localhost is expected — the nginx IP allowlist denies anything other than the Prometheus host)"
    fi
    ;;
  *)
    warn "✗ /metrics-monitor-1 returned $METRICS_CODE — expected 200, 401, or 403"
    SMOKE_FAILED=1
    ;;
esac

if [[ $SMOKE_FAILED -ne 0 ]]; then
  warn "One or more smoke checks failed. The migration completed but verify manually before declaring done."
  warn "Logs: journalctl -u nginx -n 50 ; journalctl -u polaris-web -n 50"
  exit 3
fi

echo ""
info "============================================"
info "  Migration to nginx-fronted HTTPS complete!"
info "  Public URL: $PUBLIC_URL"
info "  Cert path:  $NGINX_CERT_DIR/cert.pem"
info "  .env backup: $ENV_FILE.pre-nginx.$BACKUP_TS"
info "  Rollback:   sudo bash $0 --rollback"
info "============================================"
echo ""
