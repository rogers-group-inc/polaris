#!/usr/bin/env bash
# deploy/ha/etcd-ca.sh — installed as /usr/local/sbin/polaris-etcd-ca
#
# A tiny dedicated certificate authority for the etcd cluster's mutual TLS.
#
# Why its own CA and not the nginx cert or the agent code-signing CA: these
# certificates authenticate three machines to each other on ports 2379/2380,
# nothing else. Keeping them separate means the etcd trust store contains
# exactly three certificates, rotating the public web cert never touches
# replication, and — the practical part — a witness on a public cloud address
# is safe behind client-cert auth without involving the corporate PKI.
#
# Run on the PRIMARY. The CA key never leaves it (back it up to your password
# vault; losing it costs you a re-issue of three certs, nothing more).
#
# Usage:
#   polaris-etcd-ca init                                 create the CA
#   polaris-etcd-ca issue <name> <addr> [extra-san ...]  one member cert
#   polaris-etcd-ca list                                 what exists, with expiry
#
# <name> must match ETCD_NAME for that member (and, on the database nodes, the
# Patroni member name). <addr> is the member's cluster address; add extra SANs
# for a NAT'd public address or a second name the peers might use.

set -euo pipefail

CA_DIR="/etc/polaris/etcd-ca"
CA_KEY="$CA_DIR/ca.key"
CA_CRT="$CA_DIR/ca.crt"
CA_DAYS=3650
CERT_DAYS=1825

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || error "must run as root"
command -v openssl >/dev/null || error "openssl not found"

cmd_init() {
  mkdir -p "$CA_DIR"; chmod 0750 "$CA_DIR"
  if [[ -f "$CA_KEY" ]]; then
    warn "CA already exists at $CA_KEY — keeping it (delete it by hand to start over, then re-issue every member cert)"
    return 0
  fi
  openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  chmod 0600 "$CA_KEY"
  openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days "$CA_DAYS" \
    -subj "/CN=Polaris HA etcd CA" -out "$CA_CRT"
  chmod 0644 "$CA_CRT"
  info "CA created: $CA_CRT (valid ${CA_DAYS}d)"
  warn "Back up $CA_KEY to your password vault. It is not in any Polaris backup."
}

cmd_issue() {
  local name="${1:-}"; local addr="${2:-}"; shift 2 || true
  [[ -n "$name" && -n "$addr" ]] || error "usage: polaris-etcd-ca issue <name> <addr> [extra-san ...]"
  [[ -f "$CA_KEY" ]] || error "no CA yet — run 'polaris-etcd-ca init' first"

  local key="$CA_DIR/$name.key" crt="$CA_DIR/$name.crt" csr; csr=$(mktemp)
  local cnf; cnf=$(mktemp)

  # Build the SAN list. An address that parses as an IPv4 literal goes in as
  # IP:, anything else as DNS: — etcd validates the address it dialled against
  # the SANs, and a DNS entry does not match a connection made to an IP.
  local sans="" n=1
  add_san() {
    local v="$1"
    if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      sans+="IP.$n = $v"$'\n'
    else
      sans+="DNS.$n = $v"$'\n'
    fi
    n=$((n + 1))
  }
  add_san "$addr"
  local extra
  for extra in "$@"; do add_san "$extra"; done
  # Every member also talks to itself over loopback (the reconciler, etcdctl).
  add_san "127.0.0.1"
  add_san "localhost"

  cat > "$cnf" <<EOF
[req]
distinguished_name = dn
req_extensions     = ext
prompt             = no
[dn]
CN = $name
[ext]
basicConstraints = CA:FALSE
keyUsage         = digitalSignature, keyEncipherment
# Both usages on one certificate: an etcd member is a server to its peers and
# a client to them at the same time, and Patroni reuses it to authenticate to
# etcd as a client.
extendedKeyUsage = serverAuth, clientAuth
subjectAltName   = @san
[san]
$sans
EOF

  openssl genrsa -out "$key" 2048 2>/dev/null
  chmod 0600 "$key"
  openssl req -new -key "$key" -out "$csr" -config "$cnf"
  openssl x509 -req -in "$csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$crt" -days "$CERT_DAYS" -sha256 -extensions ext -extfile "$cnf"
  chmod 0644 "$crt"
  rm -f "$csr" "$cnf"

  info "Issued $crt (valid ${CERT_DAYS}d)"
  echo
  echo "Place these three files at /etc/polaris/etcd-ca/ on $name:"
  echo "  ca.crt      (0644 root:root)"
  echo "  $name.crt   (0644 root:root)"
  echo "  $name.key   (0600, readable by etcd and postgres on a database node)"
  echo
  echo "For example:"
  echo "  scp $CA_CRT $crt $key root@$addr:/etc/polaris/etcd-ca/"
}

cmd_list() {
  [[ -d "$CA_DIR" ]] || error "no CA directory at $CA_DIR"
  local f
  for f in "$CA_DIR"/*.crt; do
    [[ -f "$f" ]] || continue
    printf '%-28s %s\n' "$(basename "$f")" \
      "$(openssl x509 -in "$f" -noout -enddate 2>/dev/null | sed 's/notAfter=/expires /')"
  done
}

case "${1:-}" in
  init)  cmd_init ;;
  issue) shift; cmd_issue "$@" ;;
  list)  cmd_list ;;
  *) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
