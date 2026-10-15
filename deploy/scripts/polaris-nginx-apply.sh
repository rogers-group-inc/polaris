#!/bin/bash
# deploy/scripts/polaris-nginx-apply.sh — privileged wrapper for the polaris OS
# user. Installed at /usr/local/sbin/polaris-nginx-apply by setup-rhel.sh,
# migrate-to-nginx.sh, and auto-synced on every in-app update via
# src/services/updateService.ts.
#
# Granted to polaris through /etc/sudoers.d/polaris-nginx as NOPASSWD on this
# one binary; called from src/services/privilegedSysadmin.ts. This wrapper is
# the ENTIRE attack surface granted to the polaris user — sudoers does not
# restrict subcommand or argument shape, so all validation lives here.
#
# Subcommands accept NO user-supplied file paths. Staged files live at
# hardcoded /run/polaris-nginx-stage/ paths the polaris user writes to before
# sudo-ing this script; we read from those fixed locations only.
#
#   apply-config        — install /run/polaris-nginx-stage/polaris.conf,
#                         check its CONTENT (nginx_conf_ok, below), validate
#                         via `nginx -t`, atomic-rename into place, reload
#                         nginx. Rolls back to the most recent .bak on
#                         `nginx -t` failure.
#
# The content check (business rule 117(m), re-scan F4): `nginx -t` checks
# syntax only, and nginx configuration names files the ROOT master process
# opens (include, root, alias, *_log, ssl_* paths, load_module…). So a config
# polaris hands over is installed only when every directive is one Polaris's
# renderer (src/services/nginxRenderer.ts, deploy/nginx/polaris.conf.template)
# or the shipped deploy/nginx/polaris.conf writes, and every path-bearing one
# names Polaris's own fixed path. polaris-update-sync and the installers use
# the same check by sourcing this file with POLARIS_NGINX_APPLY_LIB=1.
#   rotate-cert         — install /run/polaris-nginx-stage/{cert,key}.pem
#                         (mode 0640 root:nginx, SELinux httpd_sys_content_t),
#                         reload nginx. nginx's graceful-reload semantics keep
#                         old workers serving the old cert if reload fails.
#   reload              — `nginx -t && systemctl reload nginx`
#   verify-listening N  — emit `ss -ltnp` and `ss -lunp` filtered for :N so
#                         the GUI can warn if the firewall is blocking the
#                         new port after a port change.
#
# All ops serialize via flock on /run/polaris-nginx-apply.lock so a concurrent
# updateService nginx-config sync can't interleave with a GUI apply. Each op
# is wrapped in `timeout 30` to bound runtime — `nginx -t` + reload routinely
# complete in < 2s, so anything past 30s is stuck.

set -euo pipefail

STAGE_DIR=/run/polaris-nginx-stage
LIVE_CONF=/etc/nginx/conf.d/polaris.conf
LIVE_CERT=/etc/polaris-nginx/cert.pem
LIVE_KEY=/etc/polaris-nginx/key.pem
LOCK_FILE=/run/polaris-nginx-apply.lock

usage() {
  cat >&2 <<USAGE
Usage: polaris-nginx-apply <subcommand>
  apply-config        install staged nginx config, validate, reload
  rotate-cert         install staged cert+key pair, reload
  reload              nginx -t && systemctl reload nginx
  verify-listening N  show TCP+UDP listeners filtered to port N
USAGE
  exit 64
}

die() { echo "polaris-nginx-apply: $*" >&2; exit 1; }

# ─── Content check (business rule 117(m)) ────────────────────────────────────
#
# A quote-aware tokenizer (values such as the HSTS and Alt-Svc headers carry a
# quoted ";"). Outside a `map` block every statement's directive must be in
# the allowlist; inside one, entries are key/value pairs and cannot open files.
# Blocks: `server` and `map` at the top level, `location` inside a server.
NGINX_CONF_AWK=$(cat <<'AWK'
function refuse(msg) {
  printf "polaris-nginx-apply: refused config line %d: %s\n", NR, msg > "/dev/stderr"
  failed = 1; exit 1
}
function flush() {
  if (cur != "" || isq) { nt++; tok[nt] = cur; quoted[nt] = isq }
  cur = ""; isq = 0
}
function statement(opener,    name) {
  if (nt == 0) { if (opener) refuse("a block with no directive"); return }
  name = tok[1]
  if (inmap) {
    if (opener) refuse("a block inside map")
    nt = 0; return
  }
  if (quoted[1]) refuse("a quoted directive name")
  if (!(name in allowed)) refuse("directive \"" name "\" is not one Polaris writes")
  if (name == "ssl_certificate" && !(nt == 2 && tok[2] == "/etc/polaris-nginx/cert.pem"))
    refuse("ssl_certificate must be /etc/polaris-nginx/cert.pem")
  if (name == "ssl_certificate_key" && !(nt == 2 && tok[2] == "/etc/polaris-nginx/key.pem"))
    refuse("ssl_certificate_key must be /etc/polaris-nginx/key.pem")
  if (name == "proxy_pass" && !(nt == 2 && tok[2] ~ /^http:\/\/127\.0\.0\.1:[0-9]+(\/[^ \t]*)?$/))
    refuse("proxy_pass must point at 127.0.0.1")
  if (opener) {
    if (name == "server" || name == "map") { if (depth != 0) refuse(name " must be at the top level") }
    else if (name == "location") { if (depth < 1) refuse("location outside a server") }
    else refuse("\"" name "\" cannot open a block")
    depth++
    if (name == "map") { inmap = 1; mapdepth = depth }
  } else if (name == "server" || name == "location" || name == "map") {
    refuse("\"" name "\" without a block")
  }
  nt = 0
}
function closeblock() {
  if (nt != 0) refuse("a statement without its ;")
  if (depth == 0) refuse("an unmatched }")
  if (inmap && depth == mapdepth) inmap = 0
  depth--
}
BEGIN {
  split("server location map listen server_name http2 http3 quic_retry " \
        "ssl_certificate ssl_certificate_key ssl_protocols ssl_ciphers ssl_prefer_server_ciphers " \
        "ssl_session_cache ssl_session_timeout ssl_session_tickets ssl_early_data ssl_stapling ssl_stapling_verify " \
        "server_tokens add_header return proxy_pass proxy_set_header proxy_http_version " \
        "proxy_read_timeout proxy_send_timeout proxy_connect_timeout proxy_request_buffering " \
        "proxy_buffering proxy_hide_header proxy_redirect client_max_body_size allow deny", w, " ")
  for (k in w) allowed[w[k]] = 1
  q = ""; cur = ""; isq = 0; nt = 0; depth = 0; inmap = 0
}
{
  s = $0; n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (q != "") {
      if (c == "\\") { cur = cur substr(s, i, 2); i += 2; continue }
      if (c == q) { q = ""; flush() } else cur = cur c
      i++; continue
    }
    if (c == "#") break
    if (c == "\"" || c == "\047") { flush(); q = c; isq = 1; i++; continue }
    if (c == " " || c == "\t" || c == "\r") { flush(); i++; continue }
    if (c == ";") { flush(); statement(0); i++; continue }
    if (c == "{") { flush(); statement(1); i++; continue }
    if (c == "}") { flush(); closeblock(); i++; continue }
    cur = cur c; i++
  }
  if (q == "") flush(); else cur = cur "\n"
}
END {
  if (failed) exit 1
  if (q != "") refuse("an unterminated quote")
  if (nt != 0) refuse("a statement without its ;")
  if (depth != 0) refuse("unbalanced braces")
}
AWK
)

# nginx_conf_ok <file> — 0 when every directive in <file> is one Polaris
# writes (see above). Prints the refused line on stderr otherwise.
nginx_conf_ok() {
  [ -f "$1" ] && [ ! -L "$1" ] || { echo "polaris-nginx-apply: refused: $1 is not a regular file" >&2; return 1; }
  awk "$NGINX_CONF_AWK" "$1"
}

acquire_lock() {
  # Bind fd 9 to the lock file so flock holds across the rest of the script;
  # the kernel releases it on process exit (success, failure, or signal).
  exec 9>"$LOCK_FILE"
  flock -x -w 30 9 || die "could not acquire $LOCK_FILE within 30s (another apply in progress?)"
}

require_regular_file() {
  local path=$1
  [ -f "$path" ]   || die "missing staged file: $path"
  [ -s "$path" ]   || die "staged file is empty: $path"
  [ ! -L "$path" ] || die "staged file must not be a symlink: $path"
}

do_apply_config() {
  require_regular_file "$STAGE_DIR/polaris.conf"
  acquire_lock

  if [ -f "$LIVE_CONF" ]; then
    cp -p "$LIVE_CONF" "$LIVE_CONF.bak.$(date +%s)"
  fi

  install -o root -g root -m 0644 "$STAGE_DIR/polaris.conf" "$LIVE_CONF.new"
  # Checked on root's own copy, so what is checked is what is installed.
  if ! nginx_conf_ok "$LIVE_CONF.new"; then
    rm -f "$LIVE_CONF.new" "$STAGE_DIR/polaris.conf"
    exit 1
  fi
  mv -f "$LIVE_CONF.new" "$LIVE_CONF"
  rm -f "$STAGE_DIR/polaris.conf"

  if ! timeout 30 nginx -t >/tmp/polaris-nginx-t.log 2>&1; then
    local latest_bak
    latest_bak=$(ls -1t "$LIVE_CONF.bak."* 2>/dev/null | head -1 || true)
    if [ -n "$latest_bak" ]; then
      cp -f "$latest_bak" "$LIVE_CONF"
      echo "nginx -t failed; reverted live config to $latest_bak" >&2
    fi
    cat /tmp/polaris-nginx-t.log >&2
    exit 1
  fi

  timeout 30 systemctl reload nginx
  echo "ok: nginx config applied + reloaded"
}

do_rotate_cert() {
  require_regular_file "$STAGE_DIR/cert.pem"
  require_regular_file "$STAGE_DIR/key.pem"
  acquire_lock

  if [ -f "$LIVE_CERT" ] && [ -f "$LIVE_KEY" ]; then
    local ts; ts=$(date +%s)
    cp -p "$LIVE_CERT" "$LIVE_CERT.bak.$ts"
    cp -p "$LIVE_KEY"  "$LIVE_KEY.bak.$ts"
  fi

  install -o root -g nginx -m 0640 "$STAGE_DIR/cert.pem" "$LIVE_CERT.new"
  install -o root -g nginx -m 0640 "$STAGE_DIR/key.pem"  "$LIVE_KEY.new"
  mv -f "$LIVE_CERT.new" "$LIVE_CERT"
  mv -f "$LIVE_KEY.new"  "$LIVE_KEY"
  rm -f "$STAGE_DIR/cert.pem" "$STAGE_DIR/key.pem"

  if command -v restorecon >/dev/null 2>&1; then
    restorecon "$LIVE_CERT" "$LIVE_KEY" >/dev/null 2>&1 || true
  fi

  if ! timeout 30 systemctl reload nginx; then
    echo "systemctl reload nginx failed; old workers may still be serving old cert" >&2
    journalctl -u nginx -n 20 --no-pager >&2 || true
    exit 1
  fi
  echo "ok: cert rotated + nginx reloaded"
}

do_reload() {
  acquire_lock
  if ! timeout 30 nginx -t >/tmp/polaris-nginx-t.log 2>&1; then
    cat /tmp/polaris-nginx-t.log >&2
    exit 1
  fi
  timeout 30 systemctl reload nginx
  echo "ok: nginx reloaded"
}

do_verify_listening() {
  local port=${1:-}
  [[ "$port" =~ ^[0-9]+$ ]] || die "verify-listening requires a numeric port"
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "port out of range: $port"
  fi
  echo "# TCP listeners on :$port"
  ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p { print }' || true
  echo "# UDP listeners on :$port"
  ss -lunp 2>/dev/null | awk -v p=":$port" '$4 ~ p { print }' || true
}

# polaris-update-sync and the installers source this file for nginx_conf_ok alone.
# shellcheck disable=SC2317
[ "${POLARIS_NGINX_APPLY_LIB:-0}" = 1 ] && return 0

[ $# -ge 1 ] || usage
subcommand=$1
shift

case "$subcommand" in
  apply-config)     do_apply_config ;;
  rotate-cert)      do_rotate_cert ;;
  reload)           do_reload ;;
  verify-listening) do_verify_listening "$@" ;;
  *)                usage ;;
esac
