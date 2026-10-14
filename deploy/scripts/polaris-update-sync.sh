#!/usr/bin/env bash
# deploy/scripts/polaris-update-sync.sh — installed root-owned as
# /usr/local/sbin/polaris-update-sync and run ONLY by
# polaris-update-sync.service.
#
# The in-app updater's last step (src/services/updateService.ts →
# restartService): sync the shipped unit files, the nginx GUI helpers, the
# rendered nginx config and the HA artifacts out of /opt/polaris/deploy into
# their root-owned homes, then restart polaris.target. The updater runs as the
# polaris user; the polkit rule (deploy/polkit/49-polaris.rules) lets that user
# START this one unit and restart the polaris units — nothing else.
#
# Business rule 117. Before this file the updater handed systemd-run a shell
# script it built itself, under a polkit grant for EVERY unit, so the polaris
# user could run any command as root, at any moment, with no update at all.
# Now the commands are fixed (this file) and the inputs are checked:
#
#   - polaris-* units and their HA drop-ins may only use the directives the
#     shipped units use; they must run as User=polaris; no Exec line may carry
#     the + or ! prefix (which runs it as root); dependencies may only name
#     polaris, network, database and nginx units.
#   - the sudoers file must parse (visudo -c) and grant only the one helper.
#   - a refused file is NOT installed: the one already in place stays, the
#     refusal is logged (journal + syslog tag polaris-updater), and the rest of
#     the update carries on.
#
#   - root HELPERS — files root executes, or that decide who may (the nginx
#     apply wrapper polaris may sudo, this script, the polkit rule, the HA
#     reconciler and its root unit, the SSH forced command, Patroni's drop-in)
#     — are never installed by this unit. Their content cannot be checked, and
#     the polaris user both writes the tree and may start this unit whenever
#     it likes, so installing them here would be root on demand (rule 117(g),
#     found by the 2026-10-13 re-scan). A changed helper is HELD: listed in
#     /var/lib/polaris-update-sync/pending for the Maintenance tab, and
#     installed only by an administrator running
#     `sudo /usr/local/sbin/polaris-update-sync --apply-helpers`, which shows the diff first.
#
# Lockstep: deploy/update-linux.sh does the same sync when an operator updates
# from a shell.

set -uo pipefail

APP_DIR=/opt/polaris
SRC="$APP_DIR/deploy"
UNIT_DIR=/etc/systemd/system
STAGED_NGINX=/run/polaris-nginx-stage/polaris.conf.from-update

log()    { logger -t polaris-updater -- "$*" 2>/dev/null || true; echo "$*"; }
refuse() { logger -t polaris-updater -p daemon.err -- "REFUSED: $*" 2>/dev/null || true; echo "REFUSED: $*" >&2; }

# ─── Unit-file validation ────────────────────────────────────────────────────

# Directives a shipped polaris-* unit or drop-in may use. Hardening directives
# are welcome — they only take rights away.
ALLOWED_KEYS=" Description Documentation After Before Wants Requires PartOf BindsTo WantedBy
  Type User Group WorkingDirectory Environment EnvironmentFile
  ExecStart ExecStartPre ExecStartPost ExecStop ExecStopPost ExecReload
  Restart RestartSec TimeoutStartSec TimeoutStopSec TimeoutSec KillMode KillSignal
  RemainAfterExit StandardOutput StandardError SyslogIdentifier
  AmbientCapabilities NoNewPrivileges UMask LimitNOFILE ReadWritePaths ReadOnlyPaths InaccessiblePaths
  StartLimitIntervalSec StartLimitBurst SuccessExitStatus "
# One line, single-spaced, so " $key " is a plain substring test.
# shellcheck disable=SC2086
ALLOWED=" $(echo $ALLOWED_KEYS) "
DEP_KEYS=" After Before Wants Requires PartOf BindsTo WantedBy "

dep_name_ok() {
  case "$1" in
    polaris-*.service|polaris.target|network.target|network-online.target|multi-user.target) return 0 ;;
    postgresql*.service|patroni.service|etcd.service|nginx.service) return 0 ;;
  esac
  return 1
}

# unit_ok <file> <kind>   kind: unit (a polaris-*.service), target, dropin
unit_ok() {
  local f="$1" kind="$2" line key val users=0 section=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    if [[ "$line" == *\\ ]]; then refuse "$f: line continuation"; return 1; fi
    if [[ "$line" =~ ^\[(Unit|Service|Install)\]$ ]]; then section="${BASH_REMATCH[1]}"; continue; fi
    if [[ "$line" == \[* ]]; then refuse "$f: section $line"; return 1; fi
    [[ -n "$section" ]] || { refuse "$f: directive outside a section"; return 1; }
    [[ "$line" == *=* ]] || { refuse "$f: not a directive: $line"; return 1; }
    key="${line%%=*}"; key="${key%"${key##*[![:space:]]}"}"
    val="${line#*=}";  val="${val#"${val%%[![:space:]]*}"}"
    if [[ "$ALLOWED" != *" $key "* && ! "$key" =~ ^(Protect|Private|Restrict|Memory|CPU|Lock|SystemCall) ]]; then
      refuse "$f: directive $key is not one a Polaris unit uses"; return 1
    fi
    case "$key" in
      User)
        [[ "$kind" == dropin ]] && { refuse "$f: a drop-in may not set User="; return 1; }
        [[ "$val" == polaris ]] || { refuse "$f: User=$val (must be polaris)"; return 1; }
        users=$((users + 1)) ;;
      Group)
        [[ "$val" == polaris ]] || { refuse "$f: Group=$val (must be polaris)"; return 1; } ;;
      Exec*)
        # systemd's prefixes: @ - : + ! !!. + and ! run the line with full
        # privileges, ignoring User=.
        if [[ "$val" =~ ^[@:-]*[+!] ]]; then refuse "$f: privileged Exec prefix in $key"; return 1; fi ;;
      AmbientCapabilities)
        local c
        for c in $val; do
          # Not "~…": an inverted list grants every capability BUT those named.
          [[ "$c" == CAP_NET_BIND_SERVICE ]] || { refuse "$f: AmbientCapabilities $c"; return 1; }
        done ;;
    esac
    if [[ "$DEP_KEYS" == *" $key "* && -n "$val" ]]; then
      local u
      for u in $val; do dep_name_ok "$u" || { refuse "$f: $key names $u"; return 1; }; done
    fi
    if [[ "$kind" == target && "$key" =~ ^(Exec|User|Group|Environment) ]]; then
      refuse "$f: $key in a target"; return 1
    fi
  done < "$f"
  if [[ "$kind" == unit && $users -ne 1 ]]; then
    refuse "$f: must set User=polaris exactly once"; return 1
  fi
  return 0
}

sudoers_ok() {
  local f="$1" line
  visudo -cqf "$f" >/dev/null 2>&1 || { refuse "$f: visudo -c failed"; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^polaris[[:space:]]+ALL=\(root\)[[:space:]]+NOPASSWD:[[:space:]]+/usr/local/sbin/polaris-nginx-apply([[:space:]].*)?$ ]] \
      || { refuse "$f: grants more than polaris-nginx-apply: $line"; return 1; }
    [[ "$line" == *,* ]] && { refuse "$f: more than one command: $line"; return 1; }
  done < "$f"
  return 0
}

tmpfiles_ok() {
  # The one runtime directory the nginx GUI stages into, owned by polaris.
  local f="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^d[[:space:]]+/run/polaris-nginx-stage[[:space:]]+0[0-7]{3}[[:space:]]+polaris[[:space:]]+polaris[[:space:]]+-$ ]] \
      || { refuse "$f: unexpected tmpfiles entry: $line"; return 1; }
  done < "$f"
  return 0
}

# polaris-update-sync.service itself runs as root, so it may hold nothing but
# the fixed ExecStart and inert metadata — no Environment= (LD_PRELOAD), no
# extra Exec lines, no User= games.
self_unit_ok() {
  local f="$1" line key exec=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    [[ "$line" =~ ^\[(Unit|Service)\]$ ]] && continue
    [[ "$line" == *\\ ]] && { refuse "$f: line continuation"; return 1; }
    key="${line%%=*}"
    case "$key" in
      Description|Documentation|Type|TimeoutStartSec|StandardOutput|StandardError|SyslogIdentifier) ;;
      ExecStart)
        [[ "$line" == "ExecStart=/usr/local/sbin/polaris-update-sync" ]] || { refuse "$f: $line"; return 1; }
        exec=$((exec + 1)) ;;
      *) refuse "$f: $key is not allowed in the root update unit"; return 1 ;;
    esac
  done < "$f"
  [[ $exec -eq 1 ]] || { refuse "$f: needs exactly one ExecStart"; return 1; }
  return 0
}

snap_n=0

# take <src> — prints the snapshot's path; fails for a missing, non-regular or
# symlinked source.
take() {
  [[ -e "$1" || -L "$1" ]] || return 1
  snap_n=$((snap_n + 1))
  local dst="$WORK/$snap_n"
  cp -P -- "$1" "$dst" 2>/dev/null || { refuse "$1: could not be read"; return 1; }
  if [[ -L "$dst" || ! -f "$dst" ]]; then
    rm -f "$dst"; refuse "$1: not a regular file (symlink?)"; return 1
  fi
  printf '%s' "$dst"
}

# install_if_changed <src> <dest> <mode> [validator [arg]]
# For files whose CONTENT is checked (units, sudoers, tmpfiles). Returns 0
# only when it installed something.
install_if_changed() {
  local snap
  snap="$(take "$1")" || return 1
  cmp -s "$snap" "$2" 2>/dev/null && return 1
  if [[ -n "${4:-}" ]]; then
    "$4" "$snap" "${5:-}" || { refuse "$1 not installed (validation failed; see above)"; return 1; }
  fi
  install -o root -g root -m "$3" "$snap" "$2"
  log "Synced $2"
  return 0
}

# ─── Root helpers: held for an administrator (business rule 117(g)) ──────────
#
# A root helper is a file root EXECUTES (or a rule that decides who may) whose
# content cannot be checked the way a unit file can: polaris-nginx-apply
# (polaris may sudo it), this script, the polkit rule, and on an HA node the
# reconciler, its root unit + timer, the SSH forced command and Patroni's
# drop-in. They come from /opt/polaris, which the polaris user writes, and
# polaris may start this unit at any moment — so installing them here would
# be root on demand. Instead a changed helper is recorded in $PENDING_FILE
# (the Maintenance tab reads it) and waits for `--apply-helpers`, run by an
# administrator as root, which shows the diff first. The copy of THIS script
# doing that is the installed one under /usr/local/sbin — never the tree's.
PENDING_DIR=/var/lib/polaris-update-sync
PENDING_FILE="$PENDING_DIR/pending"
PENDING=()
APPLIED_UNIT=0
HA_INSTALL=0

root_helper() {   # root_helper <src> <dest> <mode> [validator [arg]]
  local snap sum
  snap="$(take "$1")" || return 0
  cmp -s "$snap" "$2" 2>/dev/null && return 0
  sum="$(sha256sum "$snap" | cut -d' ' -f1)"
  if [[ -n "${4:-}" ]] && ! "$4" "$snap" "${5:-}"; then
    refuse "$1 not offered (validation failed; see above)"; return 0
  fi
  if [[ "$MODE" == sync ]]; then
    PENDING+=("$2 $sum")
    logger -t polaris-updater -p daemon.warning -- "HELD root helper $2 (sha256 $sum): run 'sudo /usr/local/sbin/polaris-update-sync --apply-helpers' to review and install it" 2>/dev/null || true
    echo "HELD: $2 changed; run 'sudo /usr/local/sbin/polaris-update-sync --apply-helpers'"
    return 0
  fi
  echo
  echo "=== $2"
  if [[ -f "$2" ]]; then diff -u "$2" "$snap" | head -n 400; else echo "(not installed yet)"; head -n 200 "$snap"; fi
  local yes=$ASSUME_YES ans=""
  if [[ $yes -eq 0 ]]; then
    read -r -p "Install $2? [y/N] " ans </dev/tty || ans=""
    [[ "$ans" == [yY]* ]] && yes=1
  fi
  if [[ $yes -eq 1 ]]; then
    install -o root -g root -m "$3" "$snap" "$2"
    log "Installed root helper $2 (sha256 $sum), approved by root"
    [[ "$2" == "$UNIT_DIR"/* ]] && APPLIED_UNIT=1
  else
    PENDING+=("$2 $sum")
    echo "Left $2 as it is."
  fi
}

# The polaris-ha sudoers entry: whatever visudo accepts, shown and asked about
# like any root helper (its grant is reviewed by the administrator, not here).
visudo_ok() {
  visudo -cqf "$1" >/dev/null 2>&1 || { refuse "$1: visudo -c failed"; return 1; }
}

root_helpers() {
  root_helper "$SRC/scripts/polaris-nginx-apply.sh" /usr/local/sbin/polaris-nginx-apply 0755
  root_helper "$SRC/scripts/polaris-update-sync.sh" /usr/local/sbin/polaris-update-sync 0755
  # The manual updater runs as root, so the copy an administrator runs is a
  # root helper too (business rule 117(n)): deploy/update-linux.sh in the tree
  # hands over to this reviewed copy. Offered on every host.
  root_helper "$SRC/update-linux.sh" /usr/local/sbin/polaris-update-linux 0755
  [[ -d /etc/polkit-1/rules.d ]] && root_helper "$SRC/polkit/49-polaris.rules" /etc/polkit-1/rules.d/49-polaris.rules 0644
  if [[ -f /etc/polaris/ha-node || $HA_INSTALL -eq 1 ]]; then
    # Refresh-only-if-present on an HA node's sync / --apply-helpers:
    # setup-rhel-ha.sh decides which a node gets. Under `--install --ha` —
    # run BY setup-rhel-ha.sh on a database node — each is offered even when
    # missing. polaris-ha-setup (the reviewed copy of setup-rhel-ha.sh) is
    # offered on every HA node.
    local pair src dst mode check
    for pair in \
      "ha/polaris-ha-role.sh|/usr/local/sbin/polaris-ha-role|0755|" \
      "ha/polaris-ha-ssh-wrapper.sh|/usr/local/sbin/polaris-ha-ssh-wrapper|0755|" \
      "ha/polaris-ha-role.service|$UNIT_DIR/polaris-ha-role.service|0644|" \
      "ha/polaris-ha-role.timer|$UNIT_DIR/polaris-ha-role.timer|0644|" \
      "ha/patroni.service.d/10-polaris.conf|$UNIT_DIR/patroni.service.d/10-polaris.conf|0644|" \
      "ha/patroni-callback.sh|/usr/local/sbin/polaris-patroni-callback|0755|" \
      "ha/sudoers.d/polaris-ha|/etc/sudoers.d/polaris-ha|0440|visudo_ok" \
      "ha/ha-rsync-exclude|/etc/polaris/ha-rsync-exclude|0644|" \
      "ha/setup-rhel-ha.sh|/usr/local/sbin/polaris-ha-setup|0755|"; do
      IFS='|' read -r src dst mode check <<< "$pair"
      if [[ $HA_INSTALL -eq 1 || -f "$dst" || "$dst" == /usr/local/sbin/polaris-ha-setup ]]; then
        [[ $HA_INSTALL -eq 1 ]] && install -d -o root -g root -m 0755 "$(dirname "$dst")"
        if [[ -n "$check" ]]; then root_helper "$SRC/$src" "$dst" "$mode" "$check"; else root_helper "$SRC/$src" "$dst" "$mode"; fi
      fi
    done
  fi
}

write_pending() {
  install -d -o root -g root -m 0755 "$PENDING_DIR"
  if [[ ${#PENDING[@]} -eq 0 ]]; then
    rm -f "$PENDING_FILE"
    return 0
  fi
  local tmp="$PENDING_DIR/.pending.$$"
  { echo "# Root helpers changed in /opt/polaris and NOT installed (business rule 117(g))."
    echo "# Review and install: sudo /usr/local/sbin/polaris-update-sync --apply-helpers"
    printf '%s\n' "${PENDING[@]}"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$PENDING_FILE"
}

# ─── Content-checked files (shared by the sync and --install modes) ──────────

# nginx GUI helpers' sudoers + tmpfiles entries (content-checked).
sync_nginx_gui_files() {
  install_if_changed "$SRC/sudoers.d/polaris-nginx" /etc/sudoers.d/polaris-nginx 0440 sudoers_ok || true
  if install_if_changed "$SRC/tmpfiles.d/polaris-nginx.conf" /etc/tmpfiles.d/polaris-nginx.conf 0644 tmpfiles_ok; then
    systemd-tmpfiles --create /etc/tmpfiles.d/polaris-nginx.conf >/dev/null 2>&1 || true
  fi
  if getent group nginx >/dev/null 2>&1 && ! id -nG polaris 2>/dev/null | grep -qw nginx; then
    usermod -aG nginx polaris && log "Added polaris user to nginx group (cert file readability)"
  fi
}

# The app units and their HA drop-ins (content-checked).
sync_unit_files() {
  local name snap target kind pgunit u
  # install-if-missing, not just overwrite-on-change: a unit that ships for the
  # first time in an update must land on upgraded hosts too.
  for name in polaris-web.service polaris-monitor@.service polaris-discovery.service \
              polaris-dash.service polaris-migrate.service polaris.target; do
    snap="$(take "$SRC/$name")" || continue
    target="$UNIT_DIR/$name"
    if [[ -f "$target" ]] && cmp -s "$snap" "$target"; then continue; fi
    kind=unit; [[ "$name" == *.target ]] && kind=target
    unit_ok "$snap" "$kind" || { refuse "$SRC/$name not installed (validation failed; see above)"; continue; }
    # Carry an installed unit's local-PostgreSQL dependency into a drop-in
    # before overwriting it (units shipped before 2026-09-09 named it inline).
    # Never on an HA node: 10-ha.conf resets After=/Requires= to patroni.
    # Lockstep: deploy/update-linux.sh preserve_postgres_dependency().
    if [[ -f "$target" && ! -f "$UNIT_DIR/$name.d/20-postgres.conf" && ! -f /etc/polaris/ha-node && ! -f "$UNIT_DIR/$name.d/10-ha.conf" ]]; then
      pgunit="$(sed -nE 's/^Requires=.*\b(postgresql[^[:space:]]*)\.service.*/\1/p' "$target" | head -1)"
      if [[ -n "$pgunit" && "$pgunit" =~ ^postgresql[A-Za-z0-9@._-]*$ ]]; then
        mkdir -p "$UNIT_DIR/$name.d"
        printf '[Unit]\nAfter=%s.service\nRequires=%s.service\n' "$pgunit" "$pgunit" > "$UNIT_DIR/$name.d/20-postgres.conf"
        log "Preserved $name's PostgreSQL dependency ($pgunit.service) as a drop-in"
      fi
    fi
    install -o root -g root -m 0644 "$snap" "$target"
    log "Synced unit file: $name (edits to the main unit file are clobbered; use $name.d/*.conf drop-ins)"
  done

  # The app units' HA drop-ins run as polaris and are content-checked, so they
  # still sync; the root-run HA files are root helpers (above).
  if [[ -f /etc/polaris/ha-node ]]; then
    for u in polaris-web polaris-monitor@ polaris-discovery polaris-dash polaris-migrate; do
      [[ -f "$UNIT_DIR/$u.service.d/10-ha.conf" ]] || continue
      install_if_changed "$SRC/ha/dropins/$u.service.d/10-ha.conf" "$UNIT_DIR/$u.service.d/10-ha.conf" 0644 unit_ok dropin || true
    done
  fi
}

# Tests source this file for the validators alone (tests/unit/securityPhase8.test.ts).
# shellcheck disable=SC2317
[[ "${POLARIS_UPDATE_SYNC_LIB:-0}" == 1 ]] && return 0

# ─── Mode ────────────────────────────────────────────────────────────────────
#
#   (no arguments)        what polaris-update-sync.service runs: the in-app
#                         updater's sync + group restart. Root helpers that
#                         changed are HELD, never installed (rule 117(g)).
#   --apply-helpers       run by an administrator, as root, from a shell: show
#                         each held helper's diff against the installed copy
#                         and install the ones confirmed. Nothing restarts.
#   --apply-helpers --yes the same without asking — for configuration
#                         management, or an administrator who passed --yes to
#                         deploy/update-linux.sh (which otherwise asks).
#   --install [--yes]     run by the installers (deploy/setup-*.sh) when they
#                         re-run on an EXISTING install (business rule 117(k)):
#                         the content-checked files (units, their drop-ins,
#                         sudoers, tmpfiles, this unit) sync with validation,
#                         then every root helper is shown and asked about as
#                         --apply-helpers does. Nothing restarts. The tree an
#                         installer just `git pull`ed as polaris is the same
#                         polaris-writable tree the updater reads, so it gets
#                         the same review rather than a root `cp`.
MODE=sync
ASSUME_YES=0
HA_INSTALL=0
for a in "$@"; do
  case "$a" in
    --apply-helpers) MODE=apply ;;
    --install) MODE=install ;;
    --ha) HA_INSTALL=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "usage: polaris-update-sync [--apply-helpers [--yes] | --install [--ha] [--yes]]" >&2; exit 2 ;;
  esac
done
#   --install --ha        run by deploy/ha/setup-rhel-ha.sh on a database node
#                         whose tree it cannot trust (business rule 117(n)):
#                         also offers every HA root file even where it is not
#                         installed yet, and lays down the app units' HA
#                         drop-ins (content-checked).
if [[ $HA_INSTALL -eq 1 && "$MODE" != install ]]; then
  echo "polaris-update-sync: --ha goes with --install" >&2; exit 2
fi
if [[ "$MODE" != sync && "$(id -u)" -ne 0 ]]; then
  echo "polaris-update-sync --$MODE must run as root (sudo)." >&2; exit 1
fi

# Every input comes from a tree the polaris user can write, so it is first
# copied — never following a symlink — into a root-only working directory,
# and everything after (the comparison, the validation, the install) reads
# that copy. A symlink to /etc/shadow, or a file swapped between the check and
# the copy, gets nowhere: what is validated is exactly what is installed.
WORK="$(mktemp -d /run/polaris-update-sync.XXXXXX)"
chmod 0700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
if [[ "$MODE" == install ]]; then
  # An installer re-run on an existing install (business rule 117(k)).
  sync_nginx_gui_files
  sync_unit_files
  # polaris-web's Wants=nginx drop-in, which only the installers lay down.
  install -d -o root -g root -m 0755 "$UNIT_DIR/polaris-web.service.d"
  install_if_changed "$SRC/nginx/polaris-nginx-dependency.conf" "$UNIT_DIR/polaris-web.service.d/nginx-dependency.conf" 0644 unit_ok dropin || true
  install_if_changed "$SRC/polaris-update-sync.service" "$UNIT_DIR/polaris-update-sync.service" 0644 self_unit_ok || true
  if [[ $HA_INSTALL -eq 1 ]]; then
    for u in polaris-web polaris-monitor@ polaris-discovery polaris-dash polaris-migrate; do
      install -d -o root -g root -m 0755 "$UNIT_DIR/$u.service.d"
      install_if_changed "$SRC/ha/dropins/$u.service.d/10-ha.conf" "$UNIT_DIR/$u.service.d/10-ha.conf" 0644 unit_ok dropin || true
    done
  fi
  install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
  root_helpers
  write_pending
  systemctl daemon-reload
  if [[ ${#PENDING[@]} -eq 0 ]]; then
    echo "All root helpers match /opt/polaris."
  else
    echo "${#PENDING[@]} root helper(s) left as they are; review them later with: sudo /usr/local/sbin/polaris-update-sync --apply-helpers"
  fi
  exit 0
fi
if [[ "$MODE" == apply ]]; then
  root_helpers
  write_pending
  [[ $APPLIED_UNIT -eq 1 ]] && systemctl daemon-reload
  if [[ ${#PENDING[@]} -eq 0 ]]; then
    echo "All root helpers match /opt/polaris."
  else
    echo "${#PENDING[@]} root helper(s) still held; re-run to review them."
  fi
  exit 0
fi

# ─── 1. nginx GUI helpers ────────────────────────────────────────────────────

sync_nginx_gui_files

# ─── 2. The rendered nginx config (proxy mode, staged by the updater) ────────

if [[ -e "$STAGED_NGINX" || -L "$STAGED_NGINX" ]]; then
  # The content check (business rule 117(m)) lives in the INSTALLED nginx
  # helper; sourced, never the tree's copy. An installed helper too old to
  # have it means the config waits until the held helpers are applied.
  if staged="$(take "$STAGED_NGINX")" && ! (POLARIS_NGINX_APPLY_LIB=1 . /usr/local/sbin/polaris-nginx-apply && declare -F nginx_conf_ok >/dev/null && nginx_conf_ok "$staged"); then
    refuse "$STAGED_NGINX not installed (content check failed, or the installed polaris-nginx-apply predates it: run sudo /usr/local/sbin/polaris-update-sync --apply-helpers)"
    staged=""
  fi
  if [[ -n "${staged:-}" ]]; then
    cp -p /etc/nginx/conf.d/polaris.conf "/etc/nginx/conf.d/polaris.conf.bak.$(date +%s)" 2>/dev/null || true
    install -o root -g root -m 0644 "$staged" /etc/nginx/conf.d/polaris.conf.new
    mv -f /etc/nginx/conf.d/polaris.conf.new /etc/nginx/conf.d/polaris.conf
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && log "Synced nginx config from rendered template and reloaded"
    else
      log "ERROR: nginx -t failed on rendered config; reverting"
      latest_bak=$(ls -1t /etc/nginx/conf.d/polaris.conf.bak.* 2>/dev/null | head -1)
      [[ -n "$latest_bak" ]] && cp -f "$latest_bak" /etc/nginx/conf.d/polaris.conf
    fi
  fi
  rm -f "$STAGED_NGINX"
fi

# ─── 3. Unit files ───────────────────────────────────────────────────────────

sync_unit_files

# ─── 4. Root helpers — held, not installed ───────────────────────────────────

root_helpers
write_pending

# ─── 5. Restart the group ────────────────────────────────────────────────────

systemctl daemon-reload
systemctl restart polaris.target
log "Restarted polaris.target"

# HA: poke the standby to pull the new tree now rather than on its timer.
if [[ -f /etc/polaris/ha-node && -x /usr/local/sbin/polaris-ha-role ]]; then
  /usr/local/sbin/polaris-ha-role notify-peer || log "HA: notify-peer failed; the standby will sync on its own timer"
fi

# ─── 6. This unit itself, for the NEXT update ────────────────────────────────

# Its content is fully checked (the fixed ExecStart and inert metadata only),
# so unlike the helpers it may sync here. Last, so it never alters this run.
install_if_changed "$SRC/polaris-update-sync.service" "$UNIT_DIR/polaris-update-sync.service" 0644 self_unit_ok && systemctl daemon-reload
exit 0
