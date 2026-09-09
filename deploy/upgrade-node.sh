#!/usr/bin/env bash
# deploy/upgrade-node.sh — upgrade the Node.js runtime on an EXISTING Polaris
# install, rebuild against it, and bring the service back.
#
# Run as root:
#   sudo bash deploy/upgrade-node.sh                    # upgrade to Node 24 LTS
#   sudo bash deploy/upgrade-node.sh --dry-run          # print the plan, change nothing
#   sudo bash deploy/upgrade-node.sh --target 22        # Node 22 LTS instead
#   sudo bash deploy/upgrade-node.sh --skip-backup      # no pre-migration pg_dump
#   sudo bash deploy/upgrade-node.sh --pull             # also fast-forward the checkout
#
# Why this exists: the in-app updater CANNOT do this. It runs as the
# unprivileged app user, whose only root grant is the nginx apply wrapper
# (deploy/sudoers.d/polaris-nginx) — installing a system package is deliberately
# outside what the web application may do. Node upgrades are an operator task.
#
# What this does:
#   1. Preflight: root, app dir, app user, systemd units, disk space, and the
#      currently installed Node version (already-satisfied hosts exit cleanly)
#   2. Optional pg_dump backup, because step 6 runs migrations
#   3. Stops polaris.target — the service stays down for the WHOLE window, not
#      just a restart at the end: native modules are compiled against the Node
#      headers present at install time, so node_modules must be rebuilt after
#      the runtime changes
#   4. Replaces the runtime (dnf module reset + enable + install on RHEL,
#      NodeSource on Debian/Ubuntu)
#   5. `npm ci` as the app user — rebuilds every dependency against the new ABI
#   6. `npm run build` then `prisma migrate deploy`
#   7. Starts polaris.target and verifies: unit states, node -v, /health
#
# Idempotent: a host already on a satisfactory Node with a healthy build can be
# re-run safely; it detects that and exits without touching anything.
#
# FAIL-SAFE CONTRACT: `npm ci` deletes node_modules BEFORE it installs, so if
# step 5 fails the host has NO dependencies and cannot boot. In that case this
# script leaves the service STOPPED and says so, rather than starting something
# that will crash-loop. Fix the reported error and re-run.

set -euo pipefail

APP_DIR="${POLARIS_APP_DIR:-/opt/polaris}"
APP_USER="${POLARIS_APP_USER:-polaris}"
ENV_FILE="$APP_DIR/.env"
# Deliberately NOT $APP_DIR/data/backups: the Backups card lists that directory
# and expects Polaris's own (optionally encrypted) format. A plain pg_dump left
# there would show up as something it is not.
BACKUP_DIR="${POLARIS_UPGRADE_BACKUP_DIR:-/var/tmp}"
# Hard floor from the dependency tree: pg-boss declares >=22.12.0 and
# @prisma/streams-local declares >=22. Keep in step with package.json engines.
MIN_MAJOR=22
MIN_MINOR=12

# ─── Colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${CYAN}[STEP]${NC}  $*"; }

# ─── Args ─────────────────────────────────────────────────────────────────
TARGET_MAJOR=24
DRY_RUN=0
SKIP_BACKUP=0
DO_PULL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)      TARGET_MAJOR="$2"; shift 2;;
    --dry-run)     DRY_RUN=1; shift;;
    --skip-backup) SKIP_BACKUP=1; shift;;
    --pull)        DO_PULL=1; shift;;
    -h|--help)     sed -n '/^#/p' "$0" | sed -n '1,40p'; exit 0;;
    *) error "Unknown argument: $1"; exit 2;;
  esac
done

if [[ ! "$TARGET_MAJOR" =~ ^(22|24)$ ]]; then
  error "--target must be 22 or 24 (even-numbered LTS lines only). Got: $TARGET_MAJOR"
  exit 2
fi

run() {
  if [[ $DRY_RUN -eq 1 ]]; then echo -e "         ${YELLOW}would run:${NC} $*"; else eval "$@"; fi
}

# ─── Preflight ────────────────────────────────────────────────────────────
step "Preflight"

[[ $EUID -eq 0 ]] || { error "Must run as root (installing a system package)."; exit 1; }
[[ -d "$APP_DIR" ]] || { error "$APP_DIR does not exist. Set POLARIS_APP_DIR if Polaris lives elsewhere."; exit 1; }
[[ -f "$APP_DIR/package.json" ]] || { error "$APP_DIR has no package.json — is this a Polaris install?"; exit 1; }
id "$APP_USER" &>/dev/null || { error "User '$APP_USER' does not exist. Set POLARIS_APP_USER."; exit 1; }

if ! systemctl list-unit-files 'polaris.target' --no-legend 2>/dev/null | grep -q polaris; then
  error "polaris.target is not installed. This script targets a split-role systemd install."
  exit 1
fi

# Package manager
if command -v dnf &>/dev/null; then
  PKG="dnf"
elif command -v apt-get &>/dev/null; then
  PKG="apt"
else
  error "Neither dnf nor apt-get found. Install Node ${TARGET_MAJOR}.x by hand; this"
  error "script then detects the satisfied floor and only rebuilds."
  exit 1
fi
info "Package manager: $PKG"

# Current Node
CURRENT_NODE="$(node -v 2>/dev/null || echo 'none')"
info "Node currently installed: $CURRENT_NODE"
CUR_MAJOR=0; CUR_MINOR=0
if [[ "$CURRENT_NODE" =~ ^v([0-9]+)\.([0-9]+)\. ]]; then
  CUR_MAJOR="${BASH_REMATCH[1]}"; CUR_MINOR="${BASH_REMATCH[2]}"
fi

node_satisfies_floor() {
  (( CUR_MAJOR > MIN_MAJOR )) && return 0
  (( CUR_MAJOR == MIN_MAJOR && CUR_MINOR >= MIN_MINOR )) && return 0
  return 1
}

NEED_NODE=1
if node_satisfies_floor; then
  info "Node $CURRENT_NODE already meets the >=${MIN_MAJOR}.${MIN_MINOR} floor."
  NEED_NODE=0
else
  warn "Node $CURRENT_NODE is BELOW the >=${MIN_MAJOR}.${MIN_MINOR} floor required by pg-boss and @prisma/streams-local."
fi

# Is the build already current? (dist newer than the newest source file)
BUILD_STALE=1
if [[ -d "$APP_DIR/dist" ]]; then
  NEWEST_SRC="$(find "$APP_DIR/src" -type f -name '*.ts' -newer "$APP_DIR/dist" -print -quit 2>/dev/null || true)"
  [[ -z "$NEWEST_SRC" ]] && BUILD_STALE=0
fi
if [[ $BUILD_STALE -eq 1 ]]; then
  warn "dist/ is missing or older than src/ — a rebuild is needed regardless of Node."
else
  info "dist/ looks current."
fi

if [[ $NEED_NODE -eq 0 && $BUILD_STALE -eq 0 && $DO_PULL -eq 0 ]]; then
  info "Nothing to do: Node meets the floor and the build is current."
  info "Note this check does NOT look for pending database migrations — it avoids"
  info "taking the service down for a host that appears healthy. If you know a"
  info "migration is outstanding, run the in-app updater, or re-run with --pull."
  exit 0
fi

# Disk space — npm ci needs room for a full tree
AVAIL_MB="$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')"
info "Free space on $APP_DIR: ${AVAIL_MB} MB"
if (( AVAIL_MB < 2048 )); then
  error "Less than 2 GB free on $APP_DIR. npm ci needs room for the whole dependency tree; free space first."
  exit 1
fi

echo
info "Plan:"
info "  target Node:      ${TARGET_MAJOR}.x LTS   (install needed: $([[ $NEED_NODE -eq 1 ]] && echo yes || echo no))"
info "  pre-migration backup: $([[ $SKIP_BACKUP -eq 1 ]] && echo skipped || echo yes)"
info "  fast-forward checkout: $([[ $DO_PULL -eq 1 ]] && echo yes || echo no)"
info "  service downtime: from step 3 until step 7"
[[ $DRY_RUN -eq 1 ]] && warn "DRY RUN — nothing below will actually change."

# ─── 1. Backup ────────────────────────────────────────────────────────────
step "1/7 Pre-migration database backup"
if [[ $SKIP_BACKUP -eq 1 ]]; then
  warn "Skipped by --skip-backup. Step 6 runs migrations; you are accepting that risk."
elif ! command -v pg_dump &>/dev/null; then
  warn "pg_dump not found — skipping backup. Install postgresql client tools for this step."
else
  # DATABASE_URL is read from .env and never echoed.
  DB_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
  if [[ -z "$DB_URL" ]]; then
    warn "No DATABASE_URL in $ENV_FILE — skipping backup."
  else
    BACKUP_FILE="$BACKUP_DIR/polaris-pre-node${TARGET_MAJOR}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
    run "mkdir -p '$BACKUP_DIR'"
    info "Writing $BACKUP_FILE"
    if [[ $DRY_RUN -eq 0 ]]; then
      if DB_URL="$DB_URL" bash -c 'pg_dump "$DB_URL"' | gzip > "$BACKUP_FILE"; then
        chown "$APP_USER":"$APP_USER" "$BACKUP_FILE" 2>/dev/null || true
        info "Backup written ($(du -h "$BACKUP_FILE" | cut -f1))"
      else
        rm -f "$BACKUP_FILE"
        error "pg_dump failed. Fix it, or re-run with --skip-backup to proceed without one."
        exit 1
      fi
    fi
  fi
fi

# ─── 2. Optional fast-forward ─────────────────────────────────────────────
step "2/7 Checkout"
if [[ $DO_PULL -eq 1 ]]; then
  info "Fast-forwarding $APP_DIR"
  run "sudo -u '$APP_USER' git -C '$APP_DIR' fetch --all --tags --prune"
  run "sudo -u '$APP_USER' git -C '$APP_DIR' pull --ff-only"
else
  info "Leaving the checkout as-is (pass --pull to fast-forward it first)."
fi
if [[ $DRY_RUN -eq 0 ]]; then
  info "HEAD: $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

# ─── 3. Stop the service ──────────────────────────────────────────────────
step "3/7 Stopping polaris.target"
warn "Polaris is going DOWN now and stays down until step 7."
run "systemctl stop polaris.target"
if [[ $DRY_RUN -eq 0 ]]; then
  sleep 2
  systemctl is-active --quiet polaris.target && { error "polaris.target is still active."; exit 1; }
  info "Stopped."
fi

# ─── 4. Replace the runtime ───────────────────────────────────────────────
step "4/7 Node runtime"
if [[ $NEED_NODE -eq 0 ]]; then
  info "Already satisfies the floor — leaving the runtime alone."
elif [[ "$PKG" == "dnf" ]]; then
  # `module reset` first: a host pinned to nodejs:20 refuses a second stream
  # with "cannot enable multiple streams", which is exactly the host that
  # needs this upgrade.
  if ! dnf module list nodejs 2>/dev/null | grep -qE "^nodejs\s+${TARGET_MAJOR}\b"; then
    error "No nodejs:${TARGET_MAJOR} module stream on this host. Available:"
    dnf module list nodejs 2>/dev/null | grep -E '^nodejs' >&2 || true
    error "Pick an available stream with --target, or install from NodeSource by hand."
    exit 1
  fi
  run "dnf module reset -y nodejs"
  run "dnf module enable -y nodejs:${TARGET_MAJOR}"
  run "dnf install -y nodejs npm"
else
  run "apt-get install -y ca-certificates curl gnupg"
  run "mkdir -p /etc/apt/keyrings"
  run "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
  run "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${TARGET_MAJOR}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run "apt-get update -qq"
  run "apt-get install -y nodejs"
fi

if [[ $DRY_RUN -eq 0 && $NEED_NODE -eq 1 ]]; then
  NEW_NODE="$(node -v 2>/dev/null || echo none)"
  info "Node is now: $NEW_NODE"
  [[ "$NEW_NODE" =~ ^v${TARGET_MAJOR}\. ]] || { error "Expected v${TARGET_MAJOR}.x but got $NEW_NODE. Stopping — service left down."; exit 1; }
fi

# ─── 5. Rebuild dependencies ──────────────────────────────────────────────
step "5/7 npm ci (rebuilds native modules against the new ABI)"
warn "This deletes node_modules first. If it fails, the host has NO dependencies and MUST NOT be started."
info "No timeout here — a cold npm cache can take several minutes. Let it finish."
# -H sets HOME so the app user's npm cache is actually used; without it npm
# falls back to a cold cache and downloads the whole tree every time.
if [[ $DRY_RUN -eq 1 ]]; then
  echo -e "         ${YELLOW}would run:${NC} sudo -u $APP_USER -H npm ci --production=false  (in $APP_DIR)"
elif ! sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --production=false"; then
  error "npm ci FAILED."
  error "node_modules is now empty or incomplete. Polaris is stopped and MUST STAY stopped."
  error "Fix the error above, then re-run this script (it will resume from a clean state)."
  exit 1
fi
info "Dependencies installed."

# ─── 6. Build + migrate ───────────────────────────────────────────────────
step "6/7 Build and migrate"
# Clean dist/ so files deleted from src/ don't linger as stale compiled JS.
run "rm -rf '$APP_DIR/dist'"
if [[ $DRY_RUN -eq 1 ]]; then
  echo -e "         ${YELLOW}would run:${NC} sudo -u $APP_USER -H npm run build"
  echo -e "         ${YELLOW}would run:${NC} sudo -u $APP_USER -H npx prisma migrate deploy"
else
  if ! sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm run build"; then
    error "Build failed. Polaris is stopped; fix the error and re-run."
    exit 1
  fi
  info "Build complete."
  if ! sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npx prisma migrate deploy"; then
    error "Migrations failed. Polaris is stopped."
    [[ $SKIP_BACKUP -eq 0 ]] && error "A pre-migration backup was written to $BACKUP_DIR if you need to roll back."
    exit 1
  fi
  info "Migrations applied."
fi

# ─── 7. Start and verify ──────────────────────────────────────────────────
step "7/7 Starting polaris.target"
run "systemctl daemon-reload"
run "systemctl start polaris.target"

if [[ $DRY_RUN -eq 1 ]]; then
  echo; info "DRY RUN complete — nothing was changed."
  exit 0
fi

sleep 5
echo
info "Unit states:"
systemctl --no-pager --no-legend list-units 'polaris*' | sed 's/^/         /' || true

FAILED_UNITS="$(systemctl --no-pager --no-legend --state=failed list-units 'polaris*' | awk '{print $1}' || true)"
if [[ -n "$FAILED_UNITS" ]]; then
  error "These units failed to start:"
  echo "$FAILED_UNITS" | sed 's/^/         /' >&2
  error "Logs:  journalctl -u polaris-web -n 80 --no-pager"
  exit 1
fi

# /health is bearer-token protected; any HTTP response proves the listener is up.
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
PORT="${PORT:-3000}"
if command -v curl &>/dev/null; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${PORT}/health" || echo 000)"
  if [[ "$CODE" == "000" ]]; then
    warn "No HTTP response on 127.0.0.1:${PORT}/health — check journalctl -u polaris-web."
  else
    info "Web listener responding on :${PORT} (HTTP $CODE)"
  fi
fi

echo
info "───────────────────────────────────────────────────────────"
info " Done."
info "   Node:  ${CURRENT_NODE} → $(node -v)"
info "   HEAD:  $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
info "   Version: $(sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && node -e \"console.log(require('./package.json').version)\"" 2>/dev/null || echo unknown)"
info "───────────────────────────────────────────────────────────"
info " Check next:"
info "   - Server Settings → Maintenance: no EBADENGINE warnings on the next update"
info "   - Server Settings → Maintenance → Database → Monitor queue (pg-boss was"
info "     the package demanding Node >=22.12; confirm it still comes up)"
info "   - Sign in via Azure SAML once, to exercise the SSO path"
echo
