#!/usr/bin/env bash
# deploy/update-linux.sh — Polaris update script for RHEL / Ubuntu / Debian
#
# Run as root:  bash deploy/update-linux.sh
#
# What this script does:
#   1. Records the current version and commit
#   2. Creates a database backup (pg_dump)
#   3. Pulls the latest code from git
#   4. Installs dependencies and rebuilds
#   5. Runs database migrations
#   6. Syncs shipped systemd unit files into /etc/systemd/system/ + daemon-reload
#   7. Restarts the service (polaris.target for split-role, polaris.service for single-process)
#   8. Verifies the service is healthy
#
# Works for BOTH deployment topologies — the script detects which by asking
# systemctl which unit is enabled. Mirrors the in-app updater's auto-sync
# behavior (src/services/updateService.ts) so manual + in-app paths produce
# the same end state.
#
# On failure, offers to rollback to the previous version.

set -euo pipefail

APP_DIR="/opt/polaris"
APP_USER="polaris"
DB_NAME="polaris"
BACKUP_DIR="/opt/polaris/backups"

# Proceed even if the pre-update backup can't be taken. OFF by default: step 5
# runs `prisma migrate deploy`, which is irreversible, so an update with no
# recovery point is the difference between a bad update and an unrecoverable
# one. Mirrors applyUpdate(password, allowWithoutBackup) in
# src/services/updateService.ts — keep the two in lockstep.
ALLOW_WITHOUT_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --allow-without-backup) ALLOW_WITHOUT_BACKUP=1 ;;
    -h|--help)
      echo "Usage: $0 [--allow-without-backup]"
      echo "  --allow-without-backup  Continue when pg_dump is unavailable or the backup fails."
      exit 0
      ;;
    *) echo "[ERROR] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# Phase 3+: single-process polaris.service is no longer supported as a
# production deployment. Every install runs the split-role layout
# (polaris.target + web/monitor@N/discovery/migrate). Fresh installs land
# this layout automatically via deploy/setup-*.sh; pre-Phase-3 installs
# that are still on polaris.service should follow the migration steps in
# docs/INSTALL.md before running this updater.
if ! systemctl is-enabled --quiet polaris.target 2>/dev/null; then
  echo "[ERROR] polaris.target is not enabled. This updater only supports the split-role layout." >&2
  echo "[ERROR] If you're on the legacy single-process polaris.service install, follow docs/INSTALL.md → " >&2
  echo "[ERROR] 'Migrating from single-process polaris.service' before running this script." >&2
  exit 1
fi
SYSTEMD_UNIT="polaris.target"
# journalctl tail subject when verifying / debugging — polaris-web is the HTTP
# face of the group, so its logs are what an operator wants to see on failure.
LOG_UNIT="polaris-web.service"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

# Sync shipped unit files from $APP_DIR/deploy/ into /etc/systemd/system/.
# install-if-missing + overwrite-on-change: a no-op when nothing changed,
# AND a unit shipping for the first time in an update (e.g. polaris-dash)
# lands on upgraded hosts — cmp-only would leave nginx proxying /dash to a
# port nothing listens on. Same shape and same rationale as the in-app
# updater's restartService() (src/services/updateService.ts).
# Returns 0 if it ran daemon-reload, 1 if no files needed syncing.
# Operator customization must live in <unit>.d/*.conf drop-ins — direct
# edits to the main unit file get clobbered here, matching the in-app path.
sync_unit_files() {
  local synced=0
  local units=(
    "$APP_DIR/deploy/polaris-web.service"
    "$APP_DIR/deploy/polaris-monitor@.service"
    "$APP_DIR/deploy/polaris-discovery.service"
    "$APP_DIR/deploy/polaris-dash.service"
    "$APP_DIR/deploy/polaris-migrate.service"
    "$APP_DIR/deploy/polaris.target"
  )
  for f in "${units[@]}"; do
    [[ -f "$f" ]] || continue
    local name target
    name="$(basename "$f")"
    target="/etc/systemd/system/$name"
    if [[ ! -f "$target" ]] || ! cmp -s "$f" "$target"; then
      cp -f "$f" "$target"
      info "Synced unit file: $name"
      synced=$((synced + 1))
    fi
  done
  if [[ $synced -gt 0 ]]; then
    info "Reloading systemd daemon ($synced unit file(s) updated)..."
    systemctl daemon-reload
    return 0
  fi
  return 1
}

# Sync the shipped nginx config from $APP_DIR/deploy/nginx/polaris.conf to
# /etc/nginx/conf.d/polaris.conf when proxy mode is active. Mirrors the
# in-app updater's behavior in src/services/updateService.ts so manual + in-
# app paths land the same end state. cmp-only-overwrite — no-op when the
# shipped config is identical to what's installed. If `nginx -t` fails on
# the staged config we LOG and skip the reload rather than fail the whole
# update — existing nginx keeps running with the prior config. Operator
# notices via journalctl -t polaris-updater.
#
# Returns 0 if a reload happened, 1 if no change OR proxy mode is off OR
# nginx -t failed. set -e tolerated via `|| true` at call sites.
sync_nginx_config() {
  # Detect proxy mode from .env — same env-var Polaris reads at boot.
  if ! grep -q '^POLARIS_PROXY_CERT_PATH=' "$APP_DIR/.env" 2>/dev/null; then
    return 1  # not in proxy mode; nothing to do
  fi
  local src="$APP_DIR/deploy/nginx/polaris.conf"
  local target="/etc/nginx/conf.d/polaris.conf"
  if [[ ! -f "$src" ]]; then
    return 1  # shipped config not present in this checkout (older release?)
  fi
  if [[ ! -f "$target" ]]; then
    warn "Proxy mode is on but $target is missing — was migrate-to-nginx.sh ever run?"
    return 1
  fi
  if cmp -s "$src" "$target"; then
    return 1  # no change
  fi
  info "Shipped nginx config differs from $target — staging update"
  # Stage to a sibling file, validate the WHOLE system nginx config including
  # this staged file, then atomically rename into place. If validation fails,
  # leave the running nginx config untouched.
  local stage="$target.new"
  cp -f "$src" "$stage"
  # Temporarily swap the target with the stage to run `nginx -t` against the
  # candidate. We can't have both files in /etc/nginx/conf.d at once (would
  # double-bind 443). Backup the current, install the candidate, validate,
  # then either commit (reload) or revert.
  local backup="$target.bak.$(date +%s)"
  cp -p "$target" "$backup"
  mv -f "$stage" "$target"
  if nginx -t >/dev/null 2>&1; then
    info "nginx -t passed — reloading nginx"
    rm -f "$backup"
    systemctl reload nginx
    return 0
  else
    warn "nginx -t FAILED on staged config — reverting to previous nginx config"
    mv -f "$backup" "$target"
    nginx -t >&2 || true  # surface the error to journalctl
    return 1
  fi
}

# ─── Preflight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root"
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  error "$APP_DIR is not a git repository — was the app installed with the setup script?"
  exit 1
fi

cd "$APP_DIR"

info "Managing $SYSTEMD_UNIT (split-role layout)"

# ─── 1. Record current version ──────────────────────────────────────────────
step "1/9  Recording current version..."

OLD_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
OLD_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

info "Current version: v${OLD_VERSION} (${OLD_COMMIT})"

# ─── 2. Pre-update database backup ──────────────────────────────────────────
step "2/9  Creating pre-update database backup..."

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="${BACKUP_DIR}/polaris-pre-update-${OLD_VERSION}-$(date +%Y%m%d-%H%M%S).sql.gz"

backup_unavailable() {
  # Same contract as the in-app updater: abort unless the operator explicitly
  # accepted the risk. A missing backup must never be a silent warning that
  # scrolls past on the way into an irreversible migration.
  if [[ "$ALLOW_WITHOUT_BACKUP" -eq 1 ]]; then
    warn "$1 — continuing anyway (--allow-without-backup)."
    BACKUP_FILE=""
    return 0
  fi
  echo "[ERROR] $1" >&2
  echo "[ERROR] Refusing to update without a recovery point: step 5 runs 'prisma migrate deploy', which cannot be rolled back." >&2
  echo "[ERROR] Install the PostgreSQL client tools (or fix the backup), then re-run." >&2
  echo "[ERROR] To proceed anyway, re-run with --allow-without-backup." >&2
  exit 1
}

if command -v pg_dump &>/dev/null; then
  if sudo -u postgres pg_dump --clean --if-exists "$DB_NAME" | gzip > "$BACKUP_FILE"; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    info "Backup created: $BACKUP_FILE ($BACKUP_SIZE)"
  else
    rm -f "$BACKUP_FILE"
    backup_unavailable "pg_dump failed"
  fi
else
  backup_unavailable "pg_dump not found"
fi

# ─── 3. Pull latest code ────────────────────────────────────────────────────
step "3/9  Pulling latest code..."

# Point origin at POLARIS_UPDATE_REPO before fetching, if it's set. Mirrors
# ensureUpdateRemote() in src/services/updateService.ts: when set, the var
# overrides whatever origin was cloned from; when UNSET, leave the existing
# origin untouched (update from wherever the install was cloned). Idempotent —
# only rewrites when the URL differs.
ENV_REPO=""
if [[ -f "$APP_DIR/.env" ]]; then
  ENV_REPO=$(grep -E '^[[:space:]]*POLARIS_UPDATE_REPO=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- | tr -d "\"' \t\r" || true)
fi
if [[ -n "$ENV_REPO" ]]; then
  CURRENT_REPO=$(sudo -u "$APP_USER" git remote get-url origin 2>/dev/null || echo "")
  if [[ "$CURRENT_REPO" != "$ENV_REPO" ]]; then
    info "Repointing origin remote (POLARIS_UPDATE_REPO): ${CURRENT_REPO:-<none>} -> $ENV_REPO"
    sudo -u "$APP_USER" git remote set-url origin "$ENV_REPO" 2>/dev/null \
      || sudo -u "$APP_USER" git remote add origin "$ENV_REPO"
  fi
fi

sudo -u "$APP_USER" git fetch --all --prune
sudo -u "$APP_USER" git pull --ff-only

NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
NEW_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  info "Already up to date — v${OLD_VERSION} (${OLD_COMMIT})"
  # Clean up the backup since no update occurred
  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    rm -f "$BACKUP_FILE"
    info "Removed unnecessary backup"
  fi
  exit 0
fi

info "Updating: v${OLD_VERSION} (${OLD_COMMIT}) → v${NEW_VERSION} (${NEW_COMMIT})"

# ─── Rollback function ──────────────────────────────────────────────────────
rollback() {
  echo ""
  error "Update failed at: $1"
  warn "Rolling back to v${OLD_VERSION} (${OLD_COMMIT})..."
  echo ""

  cd "$APP_DIR"
  sudo -u "$APP_USER" git checkout "$OLD_COMMIT" -- . 2>/dev/null || sudo -u "$APP_USER" git reset --hard "$OLD_COMMIT"
  sudo -u "$APP_USER" npm ci --production=false 2>/dev/null
  # Regenerate Prisma client + wipe stale dist so the rolled-back process
  # comes up with a client matching the rolled-back schema. Same rationale
  # as the forward-update path below; both are documented in
  # cross-cutting/schema-migrations-and-prisma-client-lifecycle in the polaris-change-impact skill.
  sudo -u "$APP_USER" npx prisma generate 2>/dev/null
  sudo -u "$APP_USER" rm -rf "$APP_DIR/dist" 2>/dev/null
  # `npm run build` (not bare tsc) so the post-tsc asset copy runs and the
  # rolled-back dist/ regains its non-.ts runtime assets: the bundled std MIB
  # .txt files and the platform end-of-life dataset under src/data/.
  sudo -u "$APP_USER" npm run build 2>/dev/null

  # Restore database if migration failed and we have a backup
  if [[ "$1" == *"migration"* && -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    warn "Restoring database from backup..."
    gunzip -c "$BACKUP_FILE" | sudo -u postgres psql --single-transaction -d "$DB_NAME" 2>/dev/null
    info "Database restored from backup"
  fi

  # The git reset above restored deploy/*.service to OLD_COMMIT content. If
  # we'd synced new unit files mid-update they may still be live in
  # /etc/systemd/system/ — sync the now-rolled-back deploy/ files back into
  # place so systemd reflects the rolled-back code/units pair.
  sync_unit_files || true
  sync_nginx_config || true

  systemctl restart "$SYSTEMD_UNIT" 2>/dev/null
  info "Rolled back to v${OLD_VERSION} (${OLD_COMMIT})"
  info "Service restarted with previous version"

  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    info "Database backup retained at: $BACKUP_FILE"
  fi

  exit 1
}

# ─── 4. Install dependencies ────────────────────────────────────────────────
step "4/9  Installing dependencies..."

# Ensure Node.js can bind to privileged ports (80, 443) without root
setcap cap_net_bind_service=+ep "$(which node)" 2>/dev/null || true

sudo -u "$APP_USER" npm ci --production=false || rollback "npm ci"

# Check for security vulnerabilities
AUDIT_OUTPUT=$(sudo -u "$APP_USER" npm audit --production 2>/dev/null || true)
if echo "$AUDIT_OUTPUT" | grep -qiE "critical|high"; then
  warn "npm audit found high/critical vulnerabilities:"
  echo "$AUDIT_OUTPUT" | grep -iE "critical|high" | head -5
  echo ""
fi

# ─── 5. Generate Prisma client ──────────────────────────────────────────────
# Explicit step — don't rely on `npm ci`'s postinstall having fired. A
# partially-failed `npm ci` (transient mirror blip, future --ignore-scripts,
# etc.) leaves the generated client stale; then step 7's `migrate deploy`
# drops columns the running client still selects, and every Asset read/write
# crashes with `column "<name>" does not exist`. See
# cross-cutting/schema-migrations-and-prisma-client-lifecycle in the polaris-change-impact skill.
step "5/9  Generating Prisma client..."

sudo -u "$APP_USER" npx prisma generate || rollback "prisma generate"

# ─── 6. Build TypeScript ────────────────────────────────────────────────────
# Clean dist/ first so stale compiled JS from a previous build (e.g.
# generated-client files Prisma renamed between versions) can't shadow the
# fresh tsc output. tsc itself is non-destructive: without this, a file
# that exists in dist/ but no longer in src/ lingers forever.
step "6/9  Building TypeScript..."

sudo -u "$APP_USER" rm -rf "$APP_DIR/dist" || rollback "dist cleanup"
# `npm run build` (not bare tsc) so scripts/copy-build-assets.mjs runs after
# the compile and mirrors every non-.ts runtime asset into dist/ — tsc alone
# won't emit them. The std MIB .txt files (std SNMP-walks fail without them)
# and the platform end-of-life dataset under src/data/ (the Platform Lifecycle
# card renders empty without it) both ride this copy.
sudo -u "$APP_USER" npm run build || rollback "TypeScript build"

info "Build successful — stopping service for migration"

# ─── 7. Migrate ─────────────────────────────────────────────────────────────
step "7/9  Running database migrations..."

systemctl stop "$SYSTEMD_UNIT"

sudo -u "$APP_USER" npx prisma migrate deploy || rollback "database migration"

info "Migrations complete"

# ─── 8. Sync systemd unit files + daemon-reload ──────────────────────────────
# A Polaris update that ships unit-file changes (new Environment= on a worker
# role, new hardening directive, etc.) only lands the new content in
# $APP_DIR/deploy/ — /etc/systemd/system/ still holds whatever the operator
# cp'd at install time. Without this step the restart below would cycle the
# group against the OLD unit definitions and silently lose the change. cmp-
# only-overwrite means no-op on updates that don't touch unit files. Same
# behavior as the in-app updater (src/services/updateService.ts) — manual +
# in-app paths produce the same end state.
step "8/9  Syncing systemd unit files..."

sync_unit_files || info "No unit file changes to sync"

# Sync the shipped nginx config in proxy mode. Runs BEFORE the polaris.target
# restart so any new location blocks / proxy_set_header changes are live in
# nginx by the time Polaris comes back up — avoids a brief window of 404s if
# the new build expects a new nginx behavior.
sync_nginx_config || info "No nginx config changes to sync (or not in proxy mode)"

# Now restart the service with the synced units + new code.
info "Starting $SYSTEMD_UNIT..."
systemctl start "$SYSTEMD_UNIT"

# ─── 9. Verify ──────────────────────────────────────────────────────────────
step "9/9  Verifying service health..."

sleep 3

if systemctl is-active --quiet "$SYSTEMD_UNIT"; then
  info "Service is running"
else
  warn "Service may not have started — checking logs..."
  journalctl -u "$LOG_UNIT" --no-pager -n 10
  rollback "service startup"
fi

# Optional: HTTP health check
HEALTH_OK=false
for i in 1 2 3; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT:-3000}/api/v1/server-settings/branding" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "302" || "$HTTP_CODE" == "401" ]]; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

if $HEALTH_OK; then
  info "HTTP health check passed"
else
  warn "HTTP health check returned $HTTP_CODE — the service is running but may not be fully ready"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
info "============================================"
info "  Update complete!"
info "  Version: v${OLD_VERSION} → v${NEW_VERSION}"
info "  Commit:  ${OLD_COMMIT} → ${NEW_COMMIT}"
if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
  info "  Backup:  $BACKUP_FILE"
fi
info "  Logs:    journalctl -u $LOG_UNIT -f"
info "============================================"
echo ""

# Clean up old backups (keep last 10)
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/polaris-pre-update-*.sql.gz 2>/dev/null | wc -l)
if [[ "$BACKUP_COUNT" -gt 10 ]]; then
  REMOVE_COUNT=$((BACKUP_COUNT - 10))
  ls -1t "$BACKUP_DIR"/polaris-pre-update-*.sql.gz | tail -n "$REMOVE_COUNT" | xargs rm -f
  info "Cleaned up $REMOVE_COUNT old pre-update backup(s)"
fi
