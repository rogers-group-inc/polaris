#!/usr/bin/env bash
# deploy/ha/polaris-ha-ssh-wrapper.sh — installed as
# /usr/local/sbin/polaris-ha-ssh-wrapper
#
# Forced command for the peer node's sync key. Install the peer's public key in
# /root/.ssh/authorized_keys as:
#
#   from="<peer-address>",command="/usr/local/sbin/polaris-ha-ssh-wrapper",restrict ssh-ed25519 AAAA... polaris-ha
#
# It permits exactly three things: rsync in the READ direction, `status`, and
# `trigger`. A key that lands anywhere else gets a logged rejection.
#
# Be clear about what this is and is not. It stops a fat-fingered or
# repurposed key from running arbitrary commands, and it stops the sync channel
# from being usable to PUSH files onto a node. It is NOT a privilege boundary
# between the two nodes: read-only root rsync can read /etc/shadow, and the two
# nodes already share .env (the secrets-at-rest key, the session secret, the
# database password) and the nginx private key. They are one trust domain by
# design, so treat the peer key with the same care as a root password.
#
# Keys are installed in BOTH directions, because the roles swap on failover and
# the new replica must be able to read from the new primary.

set -euo pipefail

CMD="${SSH_ORIGINAL_COMMAND:-}"

reject() {
  logger -t polaris-ha -p daemon.warning -- "ssh wrapper rejected command from ${SSH_CLIENT%% *}: ${CMD:-<none>}"
  echo "polaris-ha: command not permitted on this key" >&2
  exit 1
}

case "$CMD" in
  status)
    exec /usr/local/sbin/polaris-ha-role status
    ;;
  trigger)
    exec /usr/local/sbin/polaris-ha-role trigger
    ;;
  "rsync --server --sender "*)
    # --sender means "read from this host". A plain `rsync --server` (no
    # --sender) is the WRITE direction and is refused: nothing should ever be
    # pushed onto a node over this channel.
    exec $CMD
    ;;
  *)
    reject
    ;;
esac
