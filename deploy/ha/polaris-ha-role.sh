#!/usr/bin/env bash
# deploy/ha/polaris-ha-role.sh — installed as /usr/local/sbin/polaris-ha-role
#
# The one thing that makes the Polaris application follow its database.
#
# Polaris has no leader election: the schedulers are bare intervals on the web
# role, notification delivery has no claim step, and the lockout / rate-limit /
# MFA stores are in-process. Two live web roles mean double polling and
# duplicate alerts. So in the active/standby topology (docs/HA.md) the app must
# run on exactly one node, and the node it runs on is decided by exactly one
# fact: is my local PostgreSQL the Patroni primary?
#
#   primary  -> make sure polaris.target is running
#   replica  -> make sure polaris.target is stopped, then pull the file state
#               that PostgreSQL replication does not carry (the code tree,
#               .env, the nginx leaf cert agents pin, the unit files)
#   unknown  -> do NOTHING. If Patroni's REST API is unreachable we cannot tell
#               a demotion from a monitoring outage, and both possible actions
#               are wrong. /health/ready keeps the load balancer honest
#               meanwhile.
#
# Run from polaris-ha-role.timer (every 60s) and, for immediacy, from Patroni's
# on_start / on_stop / on_role_change callbacks. Both entry points funnel into
# `reconcile`, which is idempotent by construction.
#
# Subcommands:
#   role         print primary|replica|unknown
#   is-primary   exit 0 when primary (guard for cron jobs: `... || exit 0`)
#   reconcile    the timer/callback entry point (start|stop|sync)
#   preflight    check this host could actually serve, without starting it
#   sync         pull file state from the peer (replica only)
#   status       JSON about this node, for the peer and for humans
#   verify       compare this node against the peer and report drift
#   trigger      kick polaris-ha-role.service (used by the callbacks)
#   notify-peer  ask the peer to sync now (used after an update)
#   hold <why>   suspend reconcile (maintenance); release  resumes it
#   catch-up     rebuild this node's code tree from git (DR escape hatch)
#
# Config: /etc/polaris/ha.conf. Marker: /etc/polaris/ha-node.

set -euo pipefail

CONF_FILE="/etc/polaris/ha.conf"
MARKER_FILE="/etc/polaris/ha-node"
RUN_DIR="/run/polaris-ha"
HOLD_FILE="$RUN_DIR/hold"
ROLE_FILE="$RUN_DIR/role"
LAST_SYNC_FILE="$RUN_DIR/last-sync"
SYNC_INPROGRESS_FILE="$RUN_DIR/sync.inprogress"
EXCLUDE_FILE="/etc/polaris/ha-rsync-exclude"
KNOWN_HOSTS="/etc/polaris/ha/known_hosts"

# Defaults; ha.conf overrides.
APP_DIR="/opt/polaris"
APP_USER="polaris"
PATRONI_REST="http://127.0.0.1:8008"
PEER_HOST=""
SYNC_KEY="/etc/polaris/ha/id_ed25519"
RSYNC_BWLIMIT=""

# ─── Logging ─────────────────────────────────────────────────────────────────
# Same shape as deploy/setup-rhel.sh, plus journal lines so `journalctl -t
# polaris-ha` is a full history of every decision this script made.
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; logger -t polaris-ha -p daemon.info  -- "$*" 2>/dev/null || true; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; logger -t polaris-ha -p daemon.warning -- "$*" 2>/dev/null || true; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; logger -t polaris-ha -p daemon.err -- "$*" 2>/dev/null || true; }
die()   { error "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root"
# shellcheck source=/dev/null
[[ -f "$CONF_FILE" ]] && source "$CONF_FILE"
mkdir -p "$RUN_DIR"
chmod 0750 "$RUN_DIR"

SSH_OPTS=(-i "$SYNC_KEY" -o BatchMode=yes -o ConnectTimeout=10
          -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS")

# ─── Role ────────────────────────────────────────────────────────────────────
# Patroni's REST API answers 200 on /primary only while this node holds the
# leader lease, and 503 otherwise. That is the same fact the database itself
# reports through pg_is_in_recovery(), read over a channel that does not need
# database credentials.
ha_role() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$PATRONI_REST/primary" 2>/dev/null || echo "000")
  case "$code" in
    200) echo "primary" ;;
    503) echo "replica" ;;
    *)   echo "unknown" ;;
  esac
}

target_state() {
  systemctl show -p ActiveState --value polaris.target 2>/dev/null || echo "unknown"
}

# ─── Preflight ───────────────────────────────────────────────────────────────
# Everything that must be true before this host is allowed to serve. The
# .setup-complete check is the load-bearing one: without that marker the app
# boots its UNAUTHENTICATED first-run wizard, and on a promoted standby that
# wizard would be sitting on the public hostname.
preflight() {
  local ok=0
  [[ -f "$APP_DIR/.setup-complete" ]] || { error "preflight: $APP_DIR/.setup-complete missing — the app would boot the unauthenticated setup wizard"; ok=1; }
  if [[ -f "$APP_DIR/.env" ]]; then
    local v
    for v in DATABASE_URL POLARIS_SECRET_KEY SESSION_SECRET; do
      grep -qE "^${v}=." "$APP_DIR/.env" || { error "preflight: $v missing from .env"; ok=1; }
    done
  else
    error "preflight: $APP_DIR/.env missing"; ok=1
  fi
  [[ -f "$APP_DIR/dist/index.js" ]]            || { error "preflight: no build at $APP_DIR/dist/index.js — run 'polaris-ha-role catch-up'"; ok=1; }
  [[ -d "$APP_DIR/src/generated/prisma" ]]     || { error "preflight: generated Prisma client missing"; ok=1; }
  [[ -x "$APP_DIR/node_modules/.bin/prisma" ]] || { error "preflight: node_modules missing (prisma binary not found)"; ok=1; }
  if compgen -G "$APP_DIR/dist/.rsync-partial*" >/dev/null 2>&1; then
    error "preflight: a partial rsync is present under dist/ — the tree may be mid-transfer"; ok=1
  fi
  [[ -f "$SYNC_INPROGRESS_FILE" ]] && warn "preflight: the last sync did not finish cleanly; the tree may be stale"
  return $ok
}

# ─── Peer ────────────────────────────────────────────────────────────────────
peer_status() {
  [[ -n "$PEER_HOST" ]] || return 1
  ssh "${SSH_OPTS[@]}" "root@$PEER_HOST" status 2>/dev/null
}

json_field() {
  # Deliberately not jq: it is not in the RHEL base install and this script
  # must work on a freshly built node before anyone has added packages.
  local key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" | head -1
}

local_head() {
  sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "unknown"
}

update_state() {
  local f="$APP_DIR/.update-status.json"
  [[ -f "$f" ]] || { echo "idle"; return; }
  json_field state < "$f" || echo "idle"
}

cert_fingerprint() {
  local cert="/etc/polaris-nginx/cert.pem"
  [[ -f "$cert" ]] || { echo "none"; return; }
  openssl x509 -in "$cert" -noout -fingerprint -sha256 2>/dev/null \
    | sed 's/.*=//; s/://g' | tr 'A-Z' 'a-z' || echo "unreadable"
}

cmd_status() {
  local role state
  role=$(ha_role); state=$(target_state)
  cat <<JSON
{
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "role": "$role",
  "targetState": "$state",
  "head": "$(local_head)",
  "updateState": "$(update_state)",
  "node": "$(node -v 2>/dev/null || echo none)",
  "certSha256": "$(cert_fingerprint)",
  "setupComplete": $([[ -f "$APP_DIR/.setup-complete" ]] && echo true || echo false),
  "lastSync": "$(cat "$LAST_SYNC_FILE" 2>/dev/null || echo never)",
  "hold": "$(cat "$HOLD_FILE" 2>/dev/null || echo none)",
  "tsdb": "$(rpm -qa --qf '%{VERSION} ' 'timescaledb-2-postgresql-*' 2>/dev/null | awk '{print $1}' | grep . || echo none)",
  "polarisUid": "$(id -u "$APP_USER" 2>/dev/null || echo none)"
}
JSON
}

# ─── Sync ────────────────────────────────────────────────────────────────────
# What PostgreSQL replication does NOT carry. Sourced from the peer's INSTALLED
# files rather than from its deploy/ directory, so this script never becomes a
# third copy of the unit-file list that the updater and update-linux.sh already
# have to keep in lockstep.
#
# --delay-updates + --partial-dir mean an interrupted transfer leaves the
# previous consistent tree in place: only the final rename phase is exposed to
# a failover, instead of the whole copy.
do_sync() {
  [[ -n "$PEER_HOST" ]] || { warn "sync: no PEER_HOST configured"; return 1; }

  local status peer_role peer_update head_before head_after
  status=$(peer_status) || { info "sync: peer unreachable; will retry next cycle"; return 1; }
  peer_role=$(printf '%s' "$status" | json_field role)
  peer_update=$(printf '%s' "$status" | json_field updateState)

  if [[ "$peer_role" != "primary" ]]; then
    info "sync: peer is not primary (role=$peer_role) — nothing authoritative to pull"
    return 0
  fi
  # Pulling mid-update copies a half-built tree: npm ci has replaced
  # node_modules but the build has not finished, or migrate has not run.
  case "$peer_update" in
    applying|restarting|pulling)
      info "sync: peer is mid-update (state=$peer_update) — skipping this cycle"
      return 0 ;;
  esac

  local peer_node
  peer_node=$(printf '%s' "$status" | json_field node)
  if [[ -n "$peer_node" && "$peer_node" != "$(node -v 2>/dev/null)" ]]; then
    warn "sync: Node version differs (peer $peer_node, here $(node -v 2>/dev/null)) — native modules may not load after a failover"
  fi

  head_before=$(printf '%s' "$status" | json_field head)
  : > "$SYNC_INPROGRESS_FILE"

  local rsync_common=(-aH --delay-updates --partial-dir=.rsync-partial
                      -e "ssh $(printf '%s ' "${SSH_OPTS[@]}")")
  [[ -n "$RSYNC_BWLIMIT" ]] && rsync_common+=("--bwlimit=$RSYNC_BWLIMIT")

  # 1. The application tree. --delete so a file the peer deleted goes away
  #    here too; the exclude file keeps per-host state and the backup
  #    directories out of it.
  rsync "${rsync_common[@]}" --delete --delete-delay \
    --exclude-from="$EXCLUDE_FILE" \
    "root@$PEER_HOST:$APP_DIR/" "$APP_DIR/" \
    || { warn "sync: app tree rsync failed"; rm -f "$SYNC_INPROGRESS_FILE"; return 1; }

  # 2. Backups — copied, never mirrored. --delete here would destroy this
  #    node's own pre-update backups the first time roles swapped, which is
  #    exactly when someone needs them.
  local d
  for d in "$APP_DIR/data/backups" "$APP_DIR/backups"; do
    rsync "${rsync_common[@]}" "root@$PEER_HOST:$d/" "$d/" 2>/dev/null || true
  done

  # 3. The TLS leaf every enrolled agent pins by SHA-256, plus the nginx
  #    config. A standby serving a different leaf is rejected by every agent
  #    on the wire, so this is not cosmetic.
  local nginx_changed=""
  nginx_changed+=$(rsync "${rsync_common[@]}" -i --delete \
    "root@$PEER_HOST:/etc/polaris-nginx/" /etc/polaris-nginx/ 2>/dev/null || true)
  nginx_changed+=$(rsync "${rsync_common[@]}" -i \
    "root@$PEER_HOST:/etc/nginx/conf.d/polaris.conf" /etc/nginx/conf.d/polaris.conf 2>/dev/null || true)
  if [[ -n "$nginx_changed" ]]; then
    # rsync does not restore SELinux contexts; without this nginx cannot read
    # the cert it was just handed.
    restorecon -R /etc/polaris-nginx /etc/nginx/conf.d >/dev/null 2>&1 || true
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && info "sync: nginx cert/config updated and reloaded"
    else
      warn "sync: nginx -t failed on the synced config — NOT reloading"
    fi
  fi

  # 4. Unit files (including drop-in directories) and the privileged helpers.
  local units_changed
  units_changed=$(rsync "${rsync_common[@]}" -i --delete \
    --include='polaris-*' --include='polaris.target' --exclude='*' \
    "root@$PEER_HOST:/etc/systemd/system/" /etc/systemd/system/ 2>/dev/null || true)
  local f
  for f in /etc/polkit-1/rules.d/49-polaris.rules /etc/sudoers.d/polaris-nginx \
           /etc/tmpfiles.d/polaris-nginx.conf /usr/local/sbin/polaris-nginx-apply; do
    rsync "${rsync_common[@]}" "root@$PEER_HOST:$f" "$f" 2>/dev/null || true
  done
  [[ -n "$units_changed" ]] && { systemctl daemon-reload; info "sync: unit files updated"; }

  # If the peer moved while we copied, one more pass settles it. Bounded at a
  # single retry: an update in progress is handled by the skip above.
  head_after=$(peer_status | json_field head 2>/dev/null || echo "$head_before")
  if [[ -n "$head_before" && "$head_before" != "$head_after" ]]; then
    info "sync: peer HEAD moved during the pass ($head_before -> $head_after); re-syncing the app tree"
    rsync "${rsync_common[@]}" --delete --delete-delay \
      --exclude-from="$EXCLUDE_FILE" \
      "root@$PEER_HOST:$APP_DIR/" "$APP_DIR/" || warn "sync: re-sync failed"
  fi

  rm -f "$SYNC_INPROGRESS_FILE"
  date -Is > "$LAST_SYNC_FILE"
  info "sync: complete (peer HEAD $head_after)"
}

# ─── Reconcile ───────────────────────────────────────────────────────────────
cmd_reconcile() {
  if [[ -f "$HOLD_FILE" ]]; then
    info "reconcile: on hold ($(cat "$HOLD_FILE")) — taking no action"
    exit 0
  fi

  # The reconciler owns starting the group. An enabled target would also start
  # it at boot, before Patroni has decided anything — on the standby that is a
  # second live app. Self-heal rather than trusting nobody ever ran `enable`.
  if systemctl is-enabled --quiet polaris.target 2>/dev/null; then
    warn "reconcile: polaris.target was enabled; disabling (HA owns when it starts)"
    systemctl disable polaris.target >/dev/null 2>&1 || true
  fi

  local role state
  role=$(ha_role)
  state=$(target_state)
  echo "$role" > "$ROLE_FILE"

  case "$role" in
    primary)
      if ! preflight; then
        error "reconcile: primary but preflight failed — NOT starting the app"
        exit 1
      fi
      case "$state" in
        active|activating|deactivating|reloading)
          : ;;  # already up, or systemd is mid-transition — leave it alone
        *)
          info "reconcile: this node is primary — starting polaris.target"
          systemctl start --no-block polaris.target ;;
      esac
      ;;
    replica)
      case "$state" in
        inactive|failed|"")
          : ;;
        *)
          info "reconcile: this node is a replica — stopping polaris.target"
          # Not --no-block: the write buffers flush on SIGTERM, and the stop
          # must be finished before we overwrite the tree underneath it.
          systemctl stop polaris.target || warn "reconcile: stop returned non-zero"
          ;;
      esac
      do_sync || true
      ;;
    unknown)
      warn "reconcile: Patroni REST unreachable at $PATRONI_REST — taking no action (cannot tell a demotion from a monitoring outage)"
      ;;
  esac
}

# ─── Verify ──────────────────────────────────────────────────────────────────
# The acceptance check after building the standby, and the thing to run after
# every update: it names the drift that would break a failover instead of
# leaving it to be discovered during one.
cmd_verify() {
  local status rc=0
  status=$(peer_status) || die "verify: peer unreachable ($PEER_HOST)"
  local pr; pr=$(printf '%s' "$status" | json_field role)
  echo "peer role:        $pr"
  echo "this role:        $(ha_role)"

  compare() {
    local label="$1" mine="$2" theirs="$3" fatal="${4:-yes}"
    if [[ "$mine" == "$theirs" ]]; then
      printf '  %-18s %s (match)\n' "$label" "$mine"
    else
      printf '  %-18s here=%s peer=%s  <-- DRIFT\n' "$label" "$mine" "$theirs"
      [[ "$fatal" == "yes" ]] && rc=1
    fi
  }

  echo "parity:"
  # The cert is the one that breaks the fleet silently: every enrolled agent
  # pins this exact leaf, and chain validation is disabled on their side.
  compare "cert sha256"  "$(cert_fingerprint)" "$(printf '%s' "$status" | json_field certSha256)"
  compare "git HEAD"     "$(local_head)"       "$(printf '%s' "$status" | json_field head)"
  compare "node"         "$(node -v 2>/dev/null || echo none)" "$(printf '%s' "$status" | json_field node)"
  compare "polaris uid"  "$(id -u "$APP_USER" 2>/dev/null || echo none)" "$(printf '%s' "$status" | json_field polarisUid)"
  compare "timescaledb"  "$(rpm -qa --qf '%{VERSION} ' 'timescaledb-2-postgresql-*' 2>/dev/null | awk '{print $1}' | grep . || echo none)" "$(printf '%s' "$status" | json_field tsdb)"

  echo "local readiness:"
  if preflight; then echo "  preflight          OK"; else echo "  preflight          FAILED"; rc=1; fi
  echo "  last sync          $(cat "$LAST_SYNC_FILE" 2>/dev/null || echo never)"

  [[ $rc -eq 0 ]] && info "verify: this node could take over" || error "verify: drift found — fix before trusting a failover"
  return $rc
}

# ─── Catch-up ────────────────────────────────────────────────────────────────
# Emergency only, and documented as such: rebuild this node's tree from git
# when it was promoted while behind a destructive migration. Mirrors steps 3-6
# of deploy/update-linux.sh. Needs the git remote to be reachable.
cmd_catch_up() {
  local ref="${1:-}"
  info "catch-up: rebuilding $APP_DIR from git${ref:+ at $ref}"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --all --tags --prune
  if [[ -n "$ref" ]]; then
    sudo -u "$APP_USER" git -C "$APP_DIR" checkout --detach "$ref"
  else
    sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
  fi
  sudo -u "$APP_USER" npm --prefix "$APP_DIR" ci --production=false
  sudo -u "$APP_USER" npx --prefix "$APP_DIR" prisma generate
  rm -rf "$APP_DIR/dist"
  sudo -u "$APP_USER" npm --prefix "$APP_DIR" run build
  info "catch-up: done — HEAD is now $(local_head)"
}

# ─── Dispatch ────────────────────────────────────────────────────────────────
case "${1:-}" in
  role)        ha_role ;;
  is-primary)  [[ "$(ha_role)" == "primary" ]] ;;
  reconcile)   cmd_reconcile ;;
  preflight)   preflight && info "preflight: OK" ;;
  sync)        do_sync ;;
  status)      cmd_status ;;
  verify)      cmd_verify ;;
  trigger)     systemctl start --no-block polaris-ha-role.service ;;
  notify-peer)
    [[ -n "$PEER_HOST" ]] || die "notify-peer: no PEER_HOST configured"
    ssh "${SSH_OPTS[@]}" "root@$PEER_HOST" trigger ;;
  hold)
    shift
    mkdir -p "$RUN_DIR"
    echo "${*:-manual} $(date -Is)" > "$HOLD_FILE"
    info "hold: reconcile suspended ($(cat "$HOLD_FILE"))" ;;
  release)
    rm -f "$HOLD_FILE"
    info "release: reconcile resumed" ;;
  catch-up)    shift; cmd_catch_up "${1:-}" ;;
  ""|-h|--help)
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) die "unknown subcommand: $1 (try --help)" ;;
esac
