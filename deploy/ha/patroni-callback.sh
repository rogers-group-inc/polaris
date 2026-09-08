#!/usr/bin/env bash
# deploy/ha/patroni-callback.sh — installed as
# /usr/local/sbin/polaris-patroni-callback
#
# Patroni invokes this on on_start / on_stop / on_role_change so the
# application follows a role change in seconds instead of waiting for the 60s
# reconcile timer. Wired up in patroni.yml under postgresql.callbacks.
#
# Patroni calls callbacks as:  <script> <action> <role> <scope>
#
# The role argument is deliberately IGNORED. Its vocabulary changed between
# Patroni versions ("master" in 3.x, "primary" in 4.x, plus "replica" and
# "standby_leader"), and a callback that pattern-matched on it would silently
# stop working after a package upgrade. The reconciler re-derives the role from
# Patroni's own REST API instead, which is version-stable.
#
# This script only TRIGGERS the reconcile: Patroni runs callbacks
# asynchronously and kills a still-running callback of the same kind when a new
# event arrives, so doing the multi-minute rsync inline would leave a
# half-copied tree behind. Handing it to a systemd oneshot unit also gets
# single-instance serialization for free.
#
# Runs as the postgres OS user; the sudo grant it needs is exactly one
# subcommand (see deploy/ha/sudoers.d/polaris-ha).

set -euo pipefail

logger -t polaris-ha -p daemon.info -- "patroni callback: action=${1:-?} role=${2:-?} scope=${3:-?} -> triggering reconcile"

exec sudo -n /usr/local/sbin/polaris-ha-role trigger
