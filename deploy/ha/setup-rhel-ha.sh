#!/usr/bin/env bash
# deploy/ha/setup-rhel-ha.sh — build out Polaris active/standby HA on
# RHEL / Rocky / Alma Linux 9. Read docs/HA.md first; this script is the
# mechanics, that document is the reasoning and the drills.
#
# Run as root, once per node, with --role naming what the node is:
#
#   --role witness    etcd only. Nothing else is installed. Safe on a small
#                     cloud VM or VPS; needs no PostgreSQL and no Polaris.
#   --role standby    every package, user and directory the primary has, plus
#                     Patroni and the reconciler. Does NOT initdb: the standby
#                     is cloned from the primary by Patroni.
#   --role primary    etcd + Patroni + the reconciler on the node that is
#                     already running Polaris. With --adopt it takes the
#                     RUNNING PostgreSQL cluster under Patroni's management,
#                     which stops the database and the app briefly.
#
# Order of operations (docs/HA.md has the full walkthrough):
#   1. polaris-etcd-ca init + issue on the primary; distribute the certs
#   2. this script --role witness   (then start etcd there)
#   3. this script --role primary   (etcd only, no --adopt yet), start etcd
#   4. this script --role standby   (etcd only), start etcd; confirm 3 voters
#   5. this script --role primary --adopt   ← the maintenance window
#   6. start patroni on the standby; it clones from the primary
#
# Arguments:
#   --role primary|standby|witness   (required)
#   --node-name NAME                 this member's name (default: hostname -s)
#   --this-addr ADDR                 this node's cluster address (required)
#   --peer-addr / --peer-name        on a database node: the OTHER database node.
#                                    on the witness: the primary.
#   --witness-addr / --witness-name  the witness member
#   --standby-addr / --standby-name  WITNESS ONLY: the standby database node
#   --extra-san ADDR                 repeatable; extra SAN already in the cert
#   --pg-bin DIR                     default /usr/pgsql-17/bin
#   --pgdata DIR                     default /var/lib/pgsql/17/data
#   --polaris-uid N                  create the polaris user with this uid
#                                    (standby: use the primary's, see below)
#   --tsdb-version V                 pin timescaledb to the primary's version
#   --adopt                          primary only: take the live cluster over
#   --no-epel                        skip EPEL (fping), as setup-rhel.sh
#
# All three etcd members must advertise the same member list by the same member
# names, which is why the names are required rather than guessed.
#
# This script NEVER runs initdb and never creates a database. It refuses
# --role standby if the data directory is non-empty.

set -euo pipefail

# ─── Run the reviewed, installed copy (business rule 117(n)) ─────────────────
#
# Root runs this file. Its copy under /opt/polaris lives in the polaris
# account's tree, so root running THAT copy runs whatever the account last put
# in it — no check written inside it can help, because the check is in the
# same file. The copy an administrator should run is /usr/local/sbin/polaris-ha-setup,
# root-owned and installed only through `polaris-update-sync --apply-helpers`
# (or --install), which shows its diff first like every root helper. A copy
# found anywhere else hands over to it when it is present and trusted;
# otherwise it warns. POLARIS_HA_SETUP_FROM_TREE=1 skips the hand-over (for example to
# run a newer tree copy you have read yourself).
_SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
_INSTALLED_SELF=/usr/local/sbin/polaris-ha-setup
if [[ "$_SELF" != "$_INSTALLED_SELF" && "${POLARIS_HA_SETUP_FROM_TREE:-0}" != 1 ]]; then
  if [[ -f "$_INSTALLED_SELF" && ! -L "$_INSTALLED_SELF" && "$(stat -c '%u' "$_INSTALLED_SELF" 2>/dev/null)" == 0 ]] \
     && (( (8#$(stat -c '%a' "$_INSTALLED_SELF") & 8#022) == 0 )); then
    echo "[INFO]  Running the reviewed, installed copy: $_INSTALLED_SELF"
    exec "$_INSTALLED_SELF" "$@"
  fi
  case "$_SELF" in
    /opt/polaris/*)
      echo "[WARN]  setup-rhel-ha.sh is running from $_SELF — a directory the polaris account can write." >&2
      echo "[WARN]  Install the reviewed copy (sudo /usr/local/sbin/polaris-update-sync --apply-helpers) and run /usr/local/sbin/polaris-ha-setup from now on." >&2
      ;;
  esac
fi

ROLE=""
NODE_NAME="$(hostname -s 2>/dev/null || hostname)"
THIS_ADDR=""
PEER_ADDR=""
PEER_NAME=""
WITNESS_ADDR=""
WITNESS_NAME=""
STANDBY_NAME_ARG=""
STANDBY_ADDR_ARG=""
EXTRA_SANS=()
# The PostgreSQL major this node provisions for Patroni. It MUST match the
# primary's: a replica cannot replay WAL from a different major.
PG_MAJOR=17
PG_BIN="/usr/pgsql-${PG_MAJOR}/bin"
PGDATA="/var/lib/pgsql/${PG_MAJOR}/data"
POLARIS_UID=""
TSDB_VERSION=""
ADOPT=0
INSTALL_EPEL="yes"

APP_DIR="/opt/polaris"
APP_USER="polaris"
APP_GROUP="polaris"
CERT_DIR="/etc/polaris-nginx"
HA_DIR="/etc/polaris"
CA_DIR="/etc/polaris/etcd-ca"
PG_TLS_DIR="/etc/polaris/pg-tls"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The installed copy (/usr/local/sbin/polaris-ha-setup) reads its templates
# and HA files from the tree.
[[ "$SRC_DIR" == /usr/local/sbin ]] && SRC_DIR="$APP_DIR/deploy/ha"

# ─── Where the HA files come from (business rule 117(n)) ─────────────────────
#
# Root installs what this script ships beside it. That is safe from a copy the
# polaris account cannot write — a fresh root clone on a new standby or
# witness, even at /opt/polaris before the account owns it — and not from the
# account's own tree, which is where this script lives on the primary and on
# any re-run. "Untrusted" therefore means: the polaris account owns the
# source directory, its parent, or the install directory it sits in. From an untrusted source the
# root files (reconciler, SSH wrapper, Patroni callback and drop-in, the
# polaris-ha sudoers entry, the rsync exclude list, polkit, the update helper,
# the app units' HA drop-ins) go through the INSTALLED polaris-update-sync
# `--install --ha` — validated, each one's diff shown and asked about
# (POLARIS_YES=1 answers yes) — and the templates are read as polaris. Only
# the review happens here: a tree copy of THIS script could have been edited
# itself, which is why the copy to run is the installed polaris-ha-setup, or
# one from a root-owned clone (docs/HA.md).
src_untrusted() {
  local real app polaris_uid d
  polaris_uid="$(id -u "$APP_USER" 2>/dev/null || true)"
  [[ -n "$polaris_uid" ]] || return 1   # no polaris account yet: nothing it could have written
  real="$(readlink -f "$SRC_DIR")"
  app="$(readlink -f "$APP_DIR" 2>/dev/null || echo "$APP_DIR")"
  for d in "$real" "$(dirname "$real")"; do
    [[ "$(stat -c '%u' "$d" 2>/dev/null)" == "$polaris_uid" ]] && return 0
  done
  if [[ "$real" == "$app"/* && "$(stat -c '%u' "$app" 2>/dev/null)" == "$polaris_uid" ]]; then
    return 0
  fi
  return 1
}
SRC_TRUSTED=1
src_untrusted && SRC_TRUSTED=0
HA_REVIEWED=0
SYNC_HELPER=/usr/local/sbin/polaris-update-sync

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# node_ok — an installed Node that meets the project floor: 24+, or 22.12+
# (package.json engines ">=22.12.0"; Prisma's preinstall refuses anything
# older, so an accepted v22.4 failed `npm ci` halfway through the install —
# found on a RHEL 9.5 VM, whose DVD carries 22.4). Lockstep with engines.node.
node_ok() {
  local v
  v="$(node -v 2>/dev/null)" || return 1
  [[ "$v" =~ ^v([0-9]+)\.([0-9]+) ]] || return 1
  (( BASH_REMATCH[1] >= 24 || (BASH_REMATCH[1] == 22 && BASH_REMATCH[2] >= 12) ))
}
step()  { echo -e "${CYAN}[STEP]${NC}  $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)          ROLE="$2"; shift 2;;
    --node-name)     NODE_NAME="$2"; shift 2;;
    --this-addr)     THIS_ADDR="$2"; shift 2;;
    --peer-addr)     PEER_ADDR="$2"; shift 2;;
    --peer-name)     PEER_NAME="$2"; shift 2;;
    --witness-addr)  WITNESS_ADDR="$2"; shift 2;;
    --witness-name)  WITNESS_NAME="$2"; shift 2;;
    --standby-addr)  STANDBY_ADDR_ARG="$2"; shift 2;;
    --standby-name)  STANDBY_NAME_ARG="$2"; shift 2;;
    --extra-san)     EXTRA_SANS+=("$2"); shift 2;;
    --pg-bin)        PG_BIN="$2"; shift 2;;
    --pgdata)        PGDATA="$2"; shift 2;;
    --polaris-uid)   POLARIS_UID="$2"; shift 2;;
    --tsdb-version)  TSDB_VERSION="$2"; shift 2;;
    --adopt)         ADOPT=1; shift;;
    --no-epel)       INSTALL_EPEL="no"; shift;;
    -h|--help)       sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) error "Unknown argument: $1";;
  esac
done

[[ $EUID -eq 0 ]] || error "must run as root"
case "$ROLE" in
  primary|standby|witness) ;;
  *) error "--role must be primary, standby or witness";;
esac
[[ -n "$THIS_ADDR" ]] || error "--this-addr is required"
[[ -n "$WITNESS_ADDR" ]] || error "--witness-addr is required (etcd needs three members)"
[[ -n "$PEER_ADDR" ]] || error "--peer-addr is required (every etcd member advertises all three)"
[[ -n "$PEER_NAME" ]] || error "--peer-name is required: etcd matches members by name, and a guessed name is a cluster that never forms"
[[ -n "$WITNESS_NAME" ]] || error "--witness-name is required (same reason as --peer-name)"

# The etcd member list is identical on all three hosts, so resolve it from this
# node's point of view once, here, rather than in three places below.
case "$ROLE" in
  primary)
    PRIMARY_NAME="$NODE_NAME"; PRIMARY_ADDR="$THIS_ADDR"
    STANDBY_NAME="$PEER_NAME"; STANDBY_ADDR="$PEER_ADDR" ;;
  standby)
    STANDBY_NAME="$NODE_NAME"; STANDBY_ADDR="$THIS_ADDR"
    PRIMARY_NAME="$PEER_NAME"; PRIMARY_ADDR="$PEER_ADDR" ;;
  witness)
    # On the witness, --this-addr is the witness and the two flags name the
    # database nodes; which of them is currently primary is irrelevant here.
    WITNESS_NAME="$NODE_NAME"; WITNESS_ADDR="$THIS_ADDR"
    PRIMARY_NAME="$PEER_NAME"; PRIMARY_ADDR="$PEER_ADDR"
    STANDBY_NAME="$STANDBY_NAME_ARG"; STANDBY_ADDR="$STANDBY_ADDR_ARG"
    [[ -n "$STANDBY_NAME" && -n "$STANDBY_ADDR" ]] \
      || error "on a witness, pass --peer-name/--peer-addr for the primary AND --standby-name/--standby-addr for the standby"
    PEER_ADDR="" ;;
esac

# Refuse before installing anything, not after: the standby is CLONED from
# the primary by Patroni, so an existing cluster here is a different database
# that happens to share a name. Discovering that after a package install is
# tidier than discovering it after Patroni has been pointed at it.
if [[ "$ROLE" == "standby" && -s "$PGDATA/PG_VERSION" ]]; then
  error "refusing to continue: $PGDATA already holds a PostgreSQL cluster. The standby must be cloned from the primary — move the directory aside and re-run."
fi

info "Polaris HA setup on $(hostname -f 2>/dev/null || hostname)"
info "  role:          $ROLE"
info "  member name:   $NODE_NAME"
info "  this address:  $THIS_ADDR"
[[ -n "$PEER_ADDR" ]] && info "  peer address:  $PEER_ADDR"
info "  witness:       $WITNESS_ADDR"

# ─── Shared helpers ──────────────────────────────────────────────────────────

require_certs() {
  local n="$1"
  for f in "$CA_DIR/ca.crt" "$CA_DIR/$n.crt" "$CA_DIR/$n.key"; do
    [[ -f "$f" ]] || error "missing $f — run 'polaris-etcd-ca issue $n $THIS_ADDR' on the primary and copy the three files here"
  done
  chmod 0644 "$CA_DIR/ca.crt" "$CA_DIR/$n.crt"
  chmod 0640 "$CA_DIR/$n.key"
  # etcd reads the key as its own user; on a database node Patroni (postgres)
  # reads the same pair to authenticate as an etcd client.
  if getent group etcd >/dev/null 2>&1; then
    chown root:etcd "$CA_DIR/$n.key"
  fi
  if [[ "$ROLE" != "witness" ]] && getent passwd postgres >/dev/null 2>&1; then
    # A second copy rather than a group juggle: two readers, two files, no
    # shared group that also grants access to anything else.
    install -o postgres -g postgres -m 0600 "$CA_DIR/$n.key" "$CA_DIR/$n.postgres.key"
  fi
}

# ha_root_file <mode> <src> <dest> — install a root-owned HA file. From an
# untrusted source it is NOT copied here: ha_review_root_files has already
# offered it through the installed update helper (rule 117(n)).
ha_root_file() {
  [[ $SRC_TRUSTED -eq 1 ]] || return 0
  install -o root -g root -m "$1" "$2" "$3"
}

# On a database node whose source is untrusted, hand every HA root file to the
# installed polaris-update-sync --install --ha, once, before anything needs
# them. It reads /opt/polaris/deploy, so an untrusted copy elsewhere is refused.
ha_review_root_files() {
  [[ $SRC_TRUSTED -eq 1 || $HA_REVIEWED -eq 1 ]] && return 0
  [[ "$(readlink -f "$SRC_DIR")" == "$(readlink -f "$APP_DIR")/deploy/ha" ]] \
    || error "$SRC_DIR is writable by the $APP_USER account and is not $APP_DIR/deploy/ha. Run this script from a root-owned clone (docs/HA.md)."
  if ! { [[ -f "$SYNC_HELPER" && ! -L "$SYNC_HELPER" && "$(stat -c '%u' "$SYNC_HELPER")" == 0 ]] \
         && (( (8#$(stat -c '%a' "$SYNC_HELPER") & 8#022) == 0 )) && grep -q -- '--ha' "$SYNC_HELPER"; }; then
    error "Running from $SRC_DIR (the $APP_USER account's tree) needs the installed, reviewed $SYNC_HELPER with --install --ha, and this host has none. Run this script from a root-owned clone instead (docs/HA.md), or apply the held helpers first: sudo /usr/local/sbin/polaris-update-sync --apply-helpers"
  fi
  info "HA files come from $APP_DIR (the $APP_USER account's tree): reviewing them through $SYNC_HELPER --install --ha (business rule 117(n))"
  "$SYNC_HELPER" --install --ha ${POLARIS_YES:+--yes} || warn "$SYNC_HELPER --install --ha reported a problem; see above"
  HA_REVIEWED=1
}

render() {
  # render <src> <dest> — substitute the {{PLACEHOLDER}} set. Deliberately
  # sed and not envsubst: no extra package, and unreplaced placeholders stay
  # visible in the output instead of silently becoming empty strings. A
  # template in an untrusted source is read as the polaris account, so a link
  # planted there reaches only what that account can read (rule 117(n)).
  local src="$1" dest="$2"
  if [[ $SRC_TRUSTED -eq 1 ]]; then cat -- "$src"; else sudo -u "$APP_USER" cat -- "$src"; fi | \
  sed -e "s|{{NODE_NAME}}|$NODE_NAME|g" \
      -e "s|{{THIS_ADDR}}|$THIS_ADDR|g" \
      -e "s|{{PEER_ADDR}}|$PEER_ADDR|g" \
      -e "s|{{WITNESS_ADDR}}|$WITNESS_ADDR|g" \
      -e "s|{{INITIAL_CLUSTER}}|$INITIAL_CLUSTER|g" \
      -e "s|{{CLUSTER_TOKEN}}|$CLUSTER_TOKEN|g" \
      -e "s|{{PG_BIN}}|$PG_BIN|g" \
      -e "s|{{PGDATA}}|$PGDATA|g" \
      -e "s|{{NOFAILOVER}}|$NOFAILOVER|g" \
      -e "s|{{WAL_KEEP}}|$WAL_KEEP|g" \
      -e "s|{{SUPERUSER_PASSWORD}}|$SUPERUSER_PASSWORD|g" \
      -e "s|{{REPLICATOR_PASSWORD}}|$REPLICATOR_PASSWORD|g" \
      -e "s|{{REWIND_PASSWORD}}|$REWIND_PASSWORD|g" \
      -e "s|{{PG_SSLMODE}}|${PG_SSLMODE:-require}|g" \
      -e "s|{{PG_SSLROOTCERT}}|${PG_SSLROOTCERT:-$PG_TLS_DIR/ca.crt.not-verifying}|g" \
      -e "s|{{RESTAPI_PASSWORD}}|$RESTAPI_PASSWORD|g" \
      -e "s|{{MAX_CONNECTIONS}}|$MAX_CONNECTIONS|g" \
      -e "s|{{SHARED_BUFFERS}}|$SHARED_BUFFERS|g" \
      -e "s|{{EFFECTIVE_CACHE_SIZE}}|$EFFECTIVE_CACHE_SIZE|g" \
      -e "s|{{WORK_MEM}}|$WORK_MEM|g" \
      -e "s|{{MAINTENANCE_WORK_MEM}}|$MAINTENANCE_WORK_MEM|g" \
      -e "s|{{MAX_WORKER_PROCESSES}}|$MAX_WORKER_PROCESSES|g" \
      -e "s|{{MAX_LOCKS_PER_TRANSACTION}}|$MAX_LOCKS_PER_TRANSACTION|g" \
      > "$dest"
  if grep -q '{{' "$dest"; then
    warn "unreplaced placeholders remain in $dest:"
    grep -o '{{[A-Z_]*}}' "$dest" | sort -u | sed 's/^/    /'
  fi
}

firewall_rule() {
  # firewall_rule <port> <proto> [source-address...]
  local port="$1" proto="$2"; shift 2
  command -v firewall-cmd >/dev/null 2>&1 || { warn "firewalld not present; open $port/$proto yourself"; return 0; }
  if [[ $# -eq 0 ]]; then
    firewall-cmd --permanent --add-port="$port/$proto" >/dev/null
  else
    local src
    for src in "$@"; do
      firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$src port port=$port protocol=$proto accept" >/dev/null 2>&1 \
        || warn "could not add rich rule for $src:$port/$proto (is it an IPv4 literal?)"
    done
  fi
}

# ─── etcd (all roles) ────────────────────────────────────────────────────────

install_etcd() {
  step "etcd"
  if ! command -v etcd >/dev/null 2>&1 && ! rpm -q etcd >/dev/null 2>&1; then
    info "installing etcd from the PGDG extras repo"
    dnf install -y 'dnf-command(config-manager)' >/dev/null 2>&1 || true
    if ! dnf --enablerepo=pgdg-rhel9-extras install -y etcd; then
      error "could not install etcd. Add the PGDG repo first (docs/INSTALL.md), or install etcd another way and re-run."
    fi
  else
    info "etcd already installed ($(etcd --version 2>/dev/null | head -1))"
  fi

  require_certs "$NODE_NAME"

  # Every member must advertise the SAME three-member list, by the same names.
  # etcd matches members by name, so a guessed name is a cluster that will not
  # form — hence --peer-name / --witness-name are required for a database node.
  INITIAL_CLUSTER="$PRIMARY_NAME=https://$PRIMARY_ADDR:2380,$STANDBY_NAME=https://$STANDBY_ADDR:2380,$WITNESS_NAME=https://$WITNESS_ADDR:2380"
  info "etcd cluster: $INITIAL_CLUSTER"

  local etcd_conf="/etc/etcd/etcd.conf"
  local unit_env
  unit_env=$(systemctl cat etcd 2>/dev/null | sed -n 's/^EnvironmentFile=-\{0,1\}//p' | head -1)
  [[ -n "$unit_env" ]] && etcd_conf="$unit_env"
  mkdir -p "$(dirname "$etcd_conf")" /var/lib/etcd
  [[ -f "$etcd_conf" ]] && cp -p "$etcd_conf" "$etcd_conf.bak.$(date +%s)"
  render "$SRC_DIR/etcd.conf.example" "$etcd_conf"
  chmod 0644 "$etcd_conf"
  chown -R etcd:etcd /var/lib/etcd 2>/dev/null || true
  info "wrote $etcd_conf"

  firewall_rule 2379 tcp "$PRIMARY_ADDR" "$STANDBY_ADDR" "$WITNESS_ADDR"
  firewall_rule 2380 tcp "$PRIMARY_ADDR" "$STANDBY_ADDR" "$WITNESS_ADDR"
  command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true

  systemctl enable etcd >/dev/null 2>&1 || true
  info "etcd enabled but NOT started — start the members in order: witness, primary, standby"
  info "  systemctl start etcd"
  info "  etcdctl --cacert $CA_DIR/ca.crt --cert $CA_DIR/$NODE_NAME.crt --key $CA_DIR/$NODE_NAME.key member list"
}

# ─── Chrony (all roles) ──────────────────────────────────────────────────────

ensure_time_sync() {
  step "time sync"
  # etcd elections and the heartbeat freshness window both compare timestamps
  # across hosts. Skew of tens of seconds turns into spurious failovers and a
  # boot guard that misjudges a stamp's age.
  if ! rpm -q chrony >/dev/null 2>&1; then
    dnf install -y chrony >/dev/null 2>&1 || warn "could not install chrony — ensure the clock is synced another way"
  fi
  systemctl enable --now chronyd >/dev/null 2>&1 || warn "chronyd did not start"
  chronyc tracking 2>/dev/null | sed -n '1,3p' | sed 's/^/    /' || true
}

# ─── Standby host preparation ────────────────────────────────────────────────

prepare_standby_host() {
  step "standby host packages and users"
  warn "LOCKSTEP: this function mirrors the package/user/directory half of"
  warn "deploy/setup-rhel.sh. When that script gains a dependency, add it here."

  if node_ok; then
    info "Node.js $(node -v) already installed"
  else
    # Same stream as setup-rhel.sh 1 (the standby must run what the primary runs).
    dnf module reset -y nodejs && dnf module enable -y nodejs:24 && dnf install -y nodejs npm \
      || error "could not install Node 24 (no Node 24 module stream in this host's AppStream?) — install Node 24, or 22.12+, and re-run"
    info "Node.js $(node -v) installed"
  fi

  if command -v go >/dev/null 2>&1 && go version | grep -qE 'go1\.(2[2-9]|[3-9][0-9])'; then
    info "Go $(go version | awk '{print $3}') already installed"
  else
    # RHEL 9 ships go-toolset as a plain package — no module stream (see setup-rhel.sh 1b).
    dnf install -y go-toolset || warn "could not install go-toolset (only the agent build needs Go 1.26+)"
  fi

  dnf install -y git rsync openssl >/dev/null

  # nginx stable, same repo pin as setup-rhel.sh (HTTP/3 needs >= 1.30).
  if ! rpm -q nginx >/dev/null 2>&1; then
    cat > /etc/yum.repos.d/nginx.repo <<'REPO'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/9/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
REPO
    dnf install -y nginx
  fi
  info "nginx $(nginx -v 2>&1 | sed 's/.*\///')"

  if ! command -v fping >/dev/null 2>&1; then
    if ! dnf install -y fping >/dev/null 2>&1; then
      if [[ "$INSTALL_EPEL" == "yes" ]]; then
        dnf install -y epel-release >/dev/null 2>&1 && dnf install -y fping >/dev/null 2>&1 || warn "fping unavailable (optional; batched ICMP falls back to system ping)"
      else
        warn "fping not installed and --no-epel given (optional dependency)"
      fi
    fi
  fi

  # traceroute: the tracer for path checks run from this server
  # (utils/serverTraceroute.ts). BaseOS; optional, never fatal.
  if ! command -v traceroute >/dev/null 2>&1; then
    dnf install -y traceroute >/dev/null 2>&1 || warn "traceroute unavailable (optional; server-run path checks fall back to tracepath)"
  fi

  # PostgreSQL from PGDG, matching docs/INSTALL.md — and NO initdb. Patroni
  # clones this node from the primary; an initialised cluster here would be a
  # different database with the same name.
  if ! rpm -q "postgresql${PG_MAJOR}-server" >/dev/null 2>&1; then
    dnf install -y "https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm" >/dev/null 2>&1 || true
    dnf -qy module disable postgresql >/dev/null 2>&1 || true
    dnf install -y "postgresql${PG_MAJOR}" "postgresql${PG_MAJOR}-server" "postgresql${PG_MAJOR}-contrib"
  fi
  info "PostgreSQL $("$PG_BIN/pg_config" --version 2>/dev/null || echo '(pg_config not found)')"
  # The stock unit must never start PostgreSQL on an HA node: Patroni owns it.
  systemctl disable "postgresql-${PG_MAJOR}" >/dev/null 2>&1 || true
  systemctl mask "postgresql-${PG_MAJOR}" >/dev/null 2>&1 || true
  info "postgresql-${PG_MAJOR}.service masked (Patroni starts PostgreSQL)"

  if [[ -n "$TSDB_VERSION" ]]; then
    step "TimescaleDB $TSDB_VERSION"
    if ! rpm -q timescaledb-2-postgresql-${PG_MAJOR} >/dev/null 2>&1; then
      cat > /etc/yum.repos.d/timescale_timescaledb.repo <<'REPO'
[timescale_timescaledb]
name=timescale_timescaledb
baseurl=https://packagecloud.io/timescale/timescaledb/el/9/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=https://packagecloud.io/timescale/timescaledb/gpgkey
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
REPO
      dnf install -y "timescaledb-2-postgresql-${PG_MAJOR}-$TSDB_VERSION" \
        || dnf install -y timescaledb-2-postgresql-${PG_MAJOR} \
        || warn "TimescaleDB install failed — the standby MUST match the primary's version before it can replay its WAL"
    fi
    # The loaded library must match the catalogue version on both nodes, so
    # pin it: an unattended dnf upgrade on one node only is a broken failover.
    dnf install -y python3-dnf-plugin-versionlock >/dev/null 2>&1 || true
    dnf versionlock add timescaledb-2-postgresql-${PG_MAJOR} timescaledb-2-loader-postgresql-${PG_MAJOR} >/dev/null 2>&1 \
      || warn "could not versionlock timescaledb — upgrade both nodes together by hand"
    info "TimescaleDB $(rpm -q --qf '%{VERSION}' timescaledb-2-postgresql-${PG_MAJOR} 2>/dev/null) installed and pinned"
  else
    warn "no --tsdb-version given. If the primary has TimescaleDB, this node needs the SAME version"
    warn "before it can replay the primary's WAL. Check with: rpm -q timescaledb-2-postgresql-${PG_MAJOR}"
  fi

  # The polaris user, ideally with the primary's uid. rsync maps ownership by
  # name so a mismatch is survivable, but matching uids keep the synced tree,
  # ProtectSystem=strict and the git checkout boringly identical.
  if id "$APP_USER" >/dev/null 2>&1; then
    info "user $APP_USER exists (uid $(id -u "$APP_USER"))"
    if [[ -n "$POLARIS_UID" && "$(id -u "$APP_USER")" != "$POLARIS_UID" ]]; then
      warn "uid mismatch: here $(id -u "$APP_USER"), primary $POLARIS_UID (tolerable; rsync maps by name)"
    fi
  else
    if [[ -n "$POLARIS_UID" ]]; then
      groupadd -g "$POLARIS_UID" "$APP_GROUP" 2>/dev/null || groupadd "$APP_GROUP"
      useradd --system --uid "$POLARIS_UID" --gid "$APP_GROUP" --shell /bin/false \
              --home-dir "$APP_DIR" --create-home "$APP_USER"
    else
      warn "no --polaris-uid given; run 'id -u polaris' on the primary and pass it for identical uids"
      useradd --system --shell /bin/false --home-dir "$APP_DIR" --create-home "$APP_USER"
    fi
    info "created $APP_USER (uid $(id -u "$APP_USER"))"
  fi

  # Empty directories the sync fills. Creating them with the right owner and
  # SELinux context now avoids a first-sync that lands unreadable files.
  mkdir -p "$APP_DIR/data/agents" "$APP_DIR/data/backups" "$APP_DIR/public/uploads" "$CERT_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
  chmod 0755 "$APP_DIR"
  if command -v semanage >/dev/null 2>&1; then
    semanage fcontext -a -t httpd_sys_content_t "$CERT_DIR(/.*)?" >/dev/null 2>&1 || true
    restorecon -R "$CERT_DIR" >/dev/null 2>&1 || true
    # udp/443 (QUIC) and nginx → :3000, as setup-rhel.sh: without them the
    # promoted standby's nginx refuses the Polaris server block, then 502s.
    semanage port -a -t http_port_t -p udp 443 >/dev/null 2>&1 || \
      semanage port -m -t http_port_t -p udp 443 >/dev/null 2>&1 || true
  fi
  command -v setsebool >/dev/null 2>&1 && { setsebool -P httpd_can_network_connect 1 || warn "setsebool httpd_can_network_connect failed: nginx will 502"; }
  getent group nginx >/dev/null 2>&1 && usermod -aG nginx "$APP_USER"
  systemctl enable nginx >/dev/null 2>&1 || true

  # node must be able to bind 443 only if nginx is absent; harmless either way
  # and matches what update-linux.sh does.
  setcap cap_net_bind_service=+ep "$(command -v node)" 2>/dev/null || true

  firewall_rule 443 tcp
  firewall_rule 443 udp
  command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true
  info "opened 443/tcp+udp (the load balancer health-checks this node even while it is standby)"
}

# ─── Patroni ─────────────────────────────────────────────────────────────────

generate_pg_tls() {
  mkdir -p "$PG_TLS_DIR"
  if [[ ! -f "$PG_TLS_DIR/server.key" ]]; then
    # Replication is hostssl; PGDG ships no server certificate. Business rule
    # 117: use this member's etcd certificate — issued by the cluster's own CA,
    # serverAuth, SAN = this node's cluster address — so the peer can VERIFY
    # who it streams the database from, not merely encrypt to whoever answers.
    if [[ -f "$CA_DIR/ca.crt" && -f "$CA_DIR/$NODE_NAME.crt" && -f "$CA_DIR/$NODE_NAME.key" ]]; then
      install -m 0644 "$CA_DIR/$NODE_NAME.crt" "$PG_TLS_DIR/server.crt"
      install -m 0600 "$CA_DIR/$NODE_NAME.key" "$PG_TLS_DIR/server.key"
      install -m 0644 "$CA_DIR/ca.crt" "$PG_TLS_DIR/ca.crt"
    else
      openssl req -new -x509 -days 3650 -nodes -text \
        -subj "/CN=$NODE_NAME" -addext "subjectAltName=DNS:$NODE_NAME,IP:$THIS_ADDR" \
        -out "$PG_TLS_DIR/server.crt" -keyout "$PG_TLS_DIR/server.key" 2>/dev/null
      warn "no etcd member certificate for $NODE_NAME — PostgreSQL got a self-signed certificate, so replication is encrypted but NOT verified"
    fi
  fi
  chmod 0600 "$PG_TLS_DIR/server.key"
  chown postgres:postgres "$PG_TLS_DIR/server.key" "$PG_TLS_DIR/server.crt"
  [[ -f "$PG_TLS_DIR/ca.crt" ]] && chown postgres:postgres "$PG_TLS_DIR/ca.crt"
  pg_tls_client_mode
  info "PostgreSQL TLS material in $PG_TLS_DIR (replication sslmode=$PG_SSLMODE)"
}

pg_tls_client_mode() {
  # How Patroni's replication and rewind connections check the peer's server
  # certificate. verify-full needs CA-issued certificates on BOTH nodes. This
  # node's are known; the peer's are probed when it is already listening — an
  # existing cluster whose primary still serves the old self-signed
  # certificate keeps working (encrypted, unverified) until the operator opts
  # in (docs/HA.md → "Verify the replication certificate").
  PG_SSLMODE=require
  # A path that does not exist: with sslmode=require libpq verifies against
  # sslrootcert whenever that file exists, which would refuse a self-signed peer.
  PG_SSLROOTCERT="$PG_TLS_DIR/ca.crt.not-verifying"
  [[ -f "$PG_TLS_DIR/ca.crt" ]] || return 0
  if [[ -n "${PEER_ADDR:-}" ]] && timeout 5 bash -c "</dev/tcp/$PEER_ADDR/5432" 2>/dev/null; then
    if ! openssl s_client -starttls postgres -connect "$PEER_ADDR:5432" -CAfile "$PG_TLS_DIR/ca.crt" \
         -verify_ip "$PEER_ADDR" -verify_return_error </dev/null >/dev/null 2>&1; then
      warn "the peer at $PEER_ADDR:5432 does not present a certificate from this cluster's CA — replication stays encrypted but UNVERIFIED (docs/HA.md → \"Verify the replication certificate\")"
      return 0
    fi
  fi
  PG_SSLMODE=verify-full
  PG_SSLROOTCERT="$PG_TLS_DIR/ca.crt"
}

pg_setting() {
  # One setting as the server currently reports it. Empty output means "could
  # not ask", which the caller turns into a conservative default plus a warning.
  sudo -u postgres psql -tAc "SELECT current_setting('$1')" 2>/dev/null | tr -d '[:space:]'
}

read_primary_settings() {
  # Capture what Patroni is about to take ownership of. Skipping this is what
  # silently reverts a tuned max_connections to Patroni's default of 100 and
  # drops the application's pg_hba entry.
  local v
  v=$(pg_setting max_connections);           MAX_CONNECTIONS="${v:-100}"
  v=$(pg_setting shared_buffers);            SHARED_BUFFERS="${v:-128MB}"
  v=$(pg_setting effective_cache_size);      EFFECTIVE_CACHE_SIZE="${v:-4GB}"
  v=$(pg_setting work_mem);                  WORK_MEM="${v:-4MB}"
  v=$(pg_setting maintenance_work_mem);      MAINTENANCE_WORK_MEM="${v:-64MB}"
  v=$(pg_setting max_worker_processes);      MAX_WORKER_PROCESSES="${v:-8}"
  v=$(pg_setting max_locks_per_transaction); MAX_LOCKS_PER_TRANSACTION="${v:-64}"
  if [[ -z "$(pg_setting max_connections)" ]]; then
    warn "could not query the running PostgreSQL — the values below are DEFAULTS, not this cluster's."
    warn "Fix the connection or edit /etc/patroni/patroni.yml by hand before starting patroni."
  fi
  echo
  step "Settings Patroni will take ownership of on this node"
  echo "  max_connections            $MAX_CONNECTIONS"
  echo "  shared_buffers             $SHARED_BUFFERS"
  echo "  effective_cache_size       $EFFECTIVE_CACHE_SIZE"
  echo "  work_mem                   $WORK_MEM"
  echo "  maintenance_work_mem       $MAINTENANCE_WORK_MEM"
  echo "  max_worker_processes       $MAX_WORKER_PROCESSES"
  echo "  max_locks_per_transaction  $MAX_LOCKS_PER_TRANSACTION"
  echo
  step "Every other non-default setting on this cluster — check the rendered patroni.yml carries what matters"
  sudo -u postgres psql -c "SELECT name, setting, source FROM pg_settings WHERE source NOT IN ('default','override') ORDER BY name;" 2>/dev/null || warn "could not read pg_settings"
  echo
  step "pg_hba.conf as it stands (Patroni REGENERATES this file from patroni.yml)"
  local hba; hba=$(sudo -u postgres psql -tAc "SHOW hba_file" 2>/dev/null | tr -d '[:space:]')
  [[ -f "$hba" ]] && grep -vE '^\s*(#|$)' "$hba" | sed 's/^/    /' || warn "could not read pg_hba.conf"
  echo
  step "pg_rewind prerequisites"
  "$PG_BIN/pg_controldata" "$PGDATA" 2>/dev/null | grep -iE 'checksum|wal_log_hints' | sed 's/^/    /' \
    || warn "could not run pg_controldata on $PGDATA"
  echo "    (Data page checksums OFF and wal_log_hints off => pg_rewind cannot run."
  echo "     patroni.yml sets wal_log_hints=on, which takes effect at the restart below.)"
  echo
}

install_patroni() {
  ha_review_root_files
  step "Patroni"
  if ! command -v patroni >/dev/null 2>&1; then
    dnf install -y patroni patroni-etcd || error "could not install patroni / patroni-etcd from PGDG"
  fi
  info "patroni $(patroni --version 2>/dev/null | awk '{print $2}')"

  require_certs "$NODE_NAME"
  generate_pg_tls

  # Secrets. On the standby these MUST match the primary; the operator pastes
  # them in, or copies /etc/polaris/ha-secrets.env across.
  local secrets="$HA_DIR/ha-secrets.env"
  if [[ -f "$secrets" ]]; then
    # shellcheck source=/dev/null
    source "$secrets"
    info "reusing credentials from $secrets"
  else
    SUPERUSER_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
    REPLICATOR_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
    REWIND_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
    RESTAPI_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
    CLUSTER_TOKEN="$(openssl rand -hex 16)"
    mkdir -p "$HA_DIR"; chmod 0700 "$HA_DIR"
    cat > "$secrets" <<EOF
# Polaris HA credentials. IDENTICAL on both database nodes — copy this file to
# the other node before running this script there, and keep a copy in your
# password vault. Not included in any Polaris backup.
SUPERUSER_PASSWORD='$SUPERUSER_PASSWORD'
REPLICATOR_PASSWORD='$REPLICATOR_PASSWORD'
REWIND_PASSWORD='$REWIND_PASSWORD'
RESTAPI_PASSWORD='$RESTAPI_PASSWORD'
CLUSTER_TOKEN='$CLUSTER_TOKEN'
EOF
    chmod 0600 "$secrets"
    warn "generated new credentials in $secrets — copy it to the peer node and to your vault"
  fi

  # The standby must not be able to win an election until a human has watched
  # a switchover work.
  if [[ "$ROLE" == "standby" ]]; then NOFAILOVER="true"; else NOFAILOVER="false"; fi

  # Slot ceiling: default to a quarter of the PGDATA filesystem, floor 4GB.
  # docs/HA.md explains sizing it from the measured WAL rate instead.
  if [[ -z "${WAL_KEEP:-}" ]]; then
    local avail_gb
    avail_gb=$(df -BG --output=avail "$(dirname "$PGDATA")" 2>/dev/null | tail -1 | tr -dc '0-9')
    if [[ -n "$avail_gb" && "$avail_gb" -gt 16 ]]; then
      WAL_KEEP="$((avail_gb / 4))GB"
    else
      WAL_KEEP="4GB"
    fi
  fi
  info "max_slot_wal_keep_size = $WAL_KEEP (review against the WAL rate, docs/HA.md)"

  if [[ "$ROLE" == "primary" && "$ADOPT" -eq 1 ]]; then
    read_primary_settings
  else
    : "${MAX_CONNECTIONS:=100}" "${SHARED_BUFFERS:=128MB}" "${EFFECTIVE_CACHE_SIZE:=4GB}"
    : "${WORK_MEM:=4MB}" "${MAINTENANCE_WORK_MEM:=64MB}" "${MAX_WORKER_PROCESSES:=8}"
    : "${MAX_LOCKS_PER_TRANSACTION:=64}"
    [[ "$ROLE" == "standby" ]] && warn "Copy the PostgreSQL parameters from the primary's /etc/patroni/patroni.yml into this node's before starting patroni — they must be identical."
  fi

  mkdir -p /etc/patroni
  [[ -f /etc/patroni/patroni.yml ]] && cp -p /etc/patroni/patroni.yml "/etc/patroni/patroni.yml.bak.$(date +%s)"
  render "$SRC_DIR/patroni.yml.example" /etc/patroni/patroni.yml
  chown postgres:postgres /etc/patroni/patroni.yml
  chmod 0600 /etc/patroni/patroni.yml
  info "wrote /etc/patroni/patroni.yml"

  ha_root_file 0755 "$SRC_DIR/patroni-callback.sh" /usr/local/sbin/polaris-patroni-callback
  ha_root_file 0440 "$SRC_DIR/sudoers.d/polaris-ha" /etc/sudoers.d/polaris-ha
  if [[ $SRC_TRUSTED -eq 1 ]]; then
    visudo -cf /etc/sudoers.d/polaris-ha >/dev/null || error "the polaris-ha sudoers file did not validate"
  fi
  mkdir -p /etc/systemd/system/patroni.service.d
  ha_root_file 0644 "$SRC_DIR/patroni.service.d/10-polaris.conf" /etc/systemd/system/patroni.service.d/10-polaris.conf

  # Watchdog: the only real fencing in a two-node cluster.
  echo softdog > /etc/modules-load.d/softdog.conf
  modprobe softdog 2>/dev/null || warn "could not load softdog now (it will load at boot); patroni will warn until then"
  if [[ -e /dev/watchdog ]]; then
    cat > /etc/udev/rules.d/99-polaris-watchdog.rules <<'RULE'
# Patroni runs as postgres and must be able to pet the watchdog.
KERNEL=="watchdog", OWNER="postgres", MODE="0600"
RULE
    udevadm control --reload-rules >/dev/null 2>&1 || true
    udevadm trigger /dev/watchdog >/dev/null 2>&1 || chown postgres /dev/watchdog 2>/dev/null || true
    info "watchdog fencing enabled (/dev/watchdog owned by postgres)"
  else
    warn "/dev/watchdog absent — set watchdog.mode to 'off' in patroni.yml or fix softdog, or patroni will refuse to start"
  fi

  firewall_rule 5432 tcp "$PEER_ADDR"
  firewall_rule 8008 tcp "$PEER_ADDR" "$THIS_ADDR"
  command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true

  systemctl daemon-reload
  info "Patroni configured but NOT started"
}

# ─── Reconciler ──────────────────────────────────────────────────────────────

install_ha_watcher() {
  step "HA reconciler"
  mkdir -p "$HA_DIR/ha"; chmod 0700 "$HA_DIR/ha"

  ha_root_file 0755 "$SRC_DIR/polaris-ha-role.sh" /usr/local/sbin/polaris-ha-role
  ha_root_file 0755 "$SRC_DIR/polaris-ha-ssh-wrapper.sh" /usr/local/sbin/polaris-ha-ssh-wrapper
  ha_root_file 0644 "$SRC_DIR/ha-rsync-exclude" "$HA_DIR/ha-rsync-exclude"
  ha_root_file 0644 "$SRC_DIR/polaris-ha-role.service" /etc/systemd/system/polaris-ha-role.service
  ha_root_file 0644 "$SRC_DIR/polaris-ha-role.timer" /etc/systemd/system/polaris-ha-role.timer
  # The reviewed copy of this script, for every later run (rule 117(n)).
  ha_root_file 0755 "$SRC_DIR/setup-rhel-ha.sh" /usr/local/sbin/polaris-ha-setup

  cat > "$HA_DIR/ha.conf" <<EOF
# Polaris HA reconciler configuration. See docs/HA.md.
PEER_HOST='$PEER_ADDR'
PATRONI_REST='http://127.0.0.1:8008'
APP_DIR='$APP_DIR'
APP_USER='$APP_USER'
SYNC_KEY='$HA_DIR/ha/id_ed25519'
# Cap the file-state sync so a standby rebuild cannot saturate the WAN link
# that replication also needs. Empty = unlimited. Example: RSYNC_BWLIMIT='20M'
RSYNC_BWLIMIT=''
EOF
  chmod 0600 "$HA_DIR/ha.conf"

  # Marker: what makes update-linux.sh and the in-app updater behave as HA.
  cat > "$MARKER_FILE_PATH" <<EOF
# This host is a Polaris HA node (docs/HA.md).
# Presence of this file makes the updaters require Patroni primary status,
# refresh the HA files installed outside /opt/polaris (the reconciler script,
# its unit and timer, and the systemd drop-ins), and notify the peer
# afterwards; it also tells the reconciler it owns polaris.target.
role=$ROLE
node=$NODE_NAME
configured=$(date -Is)
EOF

  if [[ ! -f "$HA_DIR/ha/id_ed25519" ]]; then
    ssh-keygen -t ed25519 -N "" -C "polaris-ha $NODE_NAME" -f "$HA_DIR/ha/id_ed25519" >/dev/null
    info "generated the sync key $HA_DIR/ha/id_ed25519"
  fi
  touch "$HA_DIR/ha/known_hosts"; chmod 0600 "$HA_DIR/ha/known_hosts"
  # Business rule 117: the peer's host key is pinned on purpose, not on first
  # use. Show THIS node's fingerprints so the operator can confirm them when
  # running `polaris-ha-role pin-peer` on the peer.
  info "This node's SSH host key fingerprints (confirm these on the peer with 'polaris-ha-role pin-peer'):"
  for _hk in /etc/ssh/ssh_host_*_key.pub; do
    [[ -f "$_hk" ]] && echo "    $(ssh-keygen -lf "$_hk" 2>/dev/null | awk '{print $2, $NF}')"
  done

  # The polkit rule the in-app updater's group restart needs. Documented since
  # the split-role layout shipped and installed by no script until now.
  # Business rule 117: it covers starting polaris-update-sync.service (the
  # fixed root helper below) and restarting the polaris units — nothing else.
  mkdir -p /etc/polkit-1/rules.d
  ha_root_file 0644 "$SRC_DIR/../polkit/49-polaris.rules" /etc/polkit-1/rules.d/49-polaris.rules
  ha_root_file 0755 "$SRC_DIR/../scripts/polaris-update-sync.sh" /usr/local/sbin/polaris-update-sync
  ha_root_file 0644 "$SRC_DIR/../polaris-update-sync.service" /etc/systemd/system/polaris-update-sync.service
  info "installed the polkit rule and the in-app updater's root helper"

  # Drop-ins: repoint the units at Patroni and add the primary guard.
  local d unit
  for d in "$SRC_DIR"/dropins/*.service.d; do
    [[ -d "$d" ]] || continue
    unit="$(basename "$d")"
    mkdir -p "/etc/systemd/system/$unit"
    ha_root_file 0644 "$d/10-ha.conf" "/etc/systemd/system/$unit/10-ha.conf"
    # A stock (non-HA) install writes 20-postgres.conf with the local
    # PostgreSQL unit in it. Drop-ins apply in LEXICAL order, so that file
    # would re-add the dependency after 10-ha.conf's reset cleared it — the
    # exact failure the reset exists to prevent. Patroni owns PostgreSQL here.
    rm -f "/etc/systemd/system/$unit/20-postgres.conf"
  done
  info "installed the HA drop-ins for all five Polaris units"

  # The reconciler owns when the app starts. An enabled target would start it
  # at boot before Patroni has decided anything.
  systemctl disable polaris.target >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl enable --now polaris-ha-role.timer >/dev/null 2>&1 || warn "could not enable polaris-ha-role.timer"

  # Prove the reset worked. A leftover reference would mean the app could pull
  # the masked stock unit in, or fail to start with a confusing message.
  # Matches any stock PostgreSQL unit name, not one major: the local major is a
  # host fact and moves, and a check that only knew "15" would go quiet on a
  # host running 17 while the dependency was still there.
  if systemctl show -p Requires -p After polaris-web.service 2>/dev/null | grep -qE 'postgresql[^[:space:]]*\.service'; then
    warn "polaris-web.service still references a stock postgresql unit — check the drop-in ordering in /etc/systemd/system/polaris-web.service.d/ (10-ha.conf must sort first, and 20-postgres.conf must not exist)"
  else
    info "verified: no Polaris unit depends on a stock postgresql unit any more"
  fi

  echo
  info "Install this node's public key on the PEER, in root's authorized_keys:"
  echo
  echo "  from=\"$THIS_ADDR\",command=\"/usr/local/sbin/polaris-ha-ssh-wrapper\",restrict $(cat "$HA_DIR/ha/id_ed25519.pub")"
  echo
}

# ─── Adoption ────────────────────────────────────────────────────────────────

adopt_primary() {
  step "Adopting the running PostgreSQL cluster under Patroni"
  warn "This stops Polaris and PostgreSQL on this host. Expect a few minutes of downtime."
  echo
  echo "Rollback, if adoption goes wrong (full steps in docs/HA.md):"
  echo "  systemctl stop patroni"
  echo "  systemctl unmask postgresql-${PG_MAJOR} && systemctl enable postgresql-${PG_MAJOR}"
  echo "  cd $PGDATA && mv postgresql.base.conf postgresql.conf   # if Patroni renamed it"
  echo "  cp $PGDATA/pg_hba.conf.polaris-pre-ha $PGDATA/pg_hba.conf"
  echo "  rm -f /etc/systemd/system/polaris-*.service.d/10-ha.conf && systemctl daemon-reload"
  echo "  systemctl enable --now postgresql-${PG_MAJOR} && systemctl enable --now polaris.target"
  echo
  read -r -p "Type ADOPT to continue: " confirm
  [[ "$confirm" == "ADOPT" ]] || error "aborted at the confirmation prompt"

  # Keep a copy of what Patroni is about to regenerate.
  cp -p "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.polaris-pre-ha" 2>/dev/null || true
  cp -p "$PGDATA/postgresql.conf" "$PGDATA/postgresql.conf.polaris-pre-ha" 2>/dev/null || true
  info "saved pre-adoption copies of pg_hba.conf and postgresql.conf beside PGDATA"

  info "stopping polaris.target"
  systemctl stop polaris.target || warn "polaris.target stop returned non-zero"

  info "stopping and masking postgresql-${PG_MAJOR}.service"
  systemctl stop "postgresql-${PG_MAJOR}" || warn "postgresql-${PG_MAJOR} stop returned non-zero"
  systemctl disable "postgresql-${PG_MAJOR}" >/dev/null 2>&1 || true
  systemctl mask "postgresql-${PG_MAJOR}" >/dev/null 2>&1 || true

  info "starting patroni (it will start PostgreSQL and take the leader lease)"
  systemctl enable --now patroni

  local i
  for i in $(seq 1 60); do
    if { curl -sfk --max-time 3 -o /dev/null https://127.0.0.1:8008/primary 2>/dev/null || curl -sf --max-time 3 -o /dev/null http://127.0.0.1:8008/primary 2>/dev/null; }; then
      info "Patroni reports this node as primary"
      break
    fi
    sleep 2
    [[ "$i" -eq 60 ]] && error "Patroni did not become primary in 120s — check: journalctl -u patroni -n 100"
  done

  # Patroni only creates these roles when it initialises a cluster, and this
  # cluster already existed.
  step "creating the replication and rewind roles"
  # shellcheck source=/dev/null
  source "$HA_DIR/ha-secrets.env"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPLICATOR_PASSWORD';
  ELSE
    ALTER ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPLICATOR_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rewind_user') THEN
    CREATE ROLE rewind_user WITH LOGIN PASSWORD '$REWIND_PASSWORD';
  ELSE
    ALTER ROLE rewind_user WITH LOGIN PASSWORD '$REWIND_PASSWORD';
  END IF;
END \$\$;
-- pg_rewind needs these specific functions, not superuser.
GRANT EXECUTE ON FUNCTION pg_ls_dir(text, boolean, boolean) TO rewind_user;
GRANT EXECUTE ON FUNCTION pg_stat_file(text, boolean) TO rewind_user;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO rewind_user;
GRANT EXECUTE ON FUNCTION pg_read_binary_file(text, bigint, bigint, boolean) TO rewind_user;
SQL
  info "replication roles ready"

  info "handing the app back to the reconciler"
  /usr/local/sbin/polaris-ha-role reconcile || warn "reconcile returned non-zero — check 'polaris-ha-role preflight'"
}

# ─── Main ────────────────────────────────────────────────────────────────────

MARKER_FILE_PATH="$HA_DIR/ha-node"
mkdir -p "$HA_DIR"; chmod 0755 "$HA_DIR"

ensure_time_sync
install_etcd

case "$ROLE" in
  witness)
    echo
    info "Witness configured. It runs etcd and nothing else."
    info "Next: systemctl start etcd   (start the witness FIRST, then the two database nodes)"
    ;;
  standby)
    prepare_standby_host
    install_patroni
    install_ha_watcher
    echo
    info "Standby prepared. Next:"
    info "  1. copy $HA_DIR/ha-secrets.env from the primary (the credentials must match)"
    info "  2. copy the PostgreSQL parameters from the primary's /etc/patroni/patroni.yml"
    info "  3. install this node's key on the primary (printed above), and the primary's key here"
    info "  4. systemctl start etcd   then   etcdctl ... member list   (expect 3 members)"
    info "  5. systemctl enable --now patroni   (clones from the primary; watch: patronictl -c /etc/patroni/patroni.yml list)"
    info "  6. polaris-ha-role verify"
    ;;
  primary)
    install_patroni
    install_ha_watcher
    if [[ "$ADOPT" -eq 1 ]]; then
      adopt_primary
      echo
      info "Adoption complete. Verify:"
      info "  patronictl -c /etc/patroni/patroni.yml list"
      info "  polaris-ha-role role          # expect: primary"
      info "  systemctl is-enabled polaris.target   # expect: disabled"
      info "  curl -sk https://localhost/health/ready   # expect: 200 ready"
    else
      echo
      info "Primary prepared but NOT adopted — PostgreSQL and Polaris are untouched and still running."
      info "Re-run with --adopt inside a maintenance window when you are ready."
    fi
    ;;
esac

echo
info "Done. docs/HA.md has the walkthrough, the drills and the failure modes."
