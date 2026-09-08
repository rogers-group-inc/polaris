# Active/standby high availability

Two RHEL 9 hosts in two datacenters behind one public name, PostgreSQL managed
by Patroni over a three-member etcd, the application following its database.
The operator-facing walkthrough, failure modes and drills are
[docs/HA.md](../../../../docs/HA.md); this entry is what a future session needs
to know before touching the surface.

Everything lives in `deploy/ha/` plus three code touch points:
`src/utils/readinessCheck.ts`, `src/services/haHeartbeatService.ts` +
`src/jobs/activeInstanceHeartbeat.ts`, and one line each in
`src/services/updateService.ts` and `deploy/update-linux.sh`.

## The design in one paragraph

Patroni + etcd elect one PostgreSQL primary (async streaming replication, RPO =
lag). `polaris-ha-role` asks the local Patroni REST API whether this node is the
primary and starts or stops `polaris.target` accordingly; on a replica it also
rsyncs the file state PostgreSQL does not carry. `polaris.target` is **disabled
on both nodes** — the reconciler owns when it starts. `GET /health/ready` is
what the load balancer monitors.

## Facts that bite

- **The standby's app is stopped, and that is not a preference.** Polaris has
  no leader election (bare-interval schedulers on the web role, no claim step in
  `deliverNotifications`, in-memory lockout / rate-limit / MFA stores). Two live
  web roles double every poll and duplicate every alert. Nothing here is
  fixable by configuration; four layers make it impossible instead — see
  docs/HA.md §5. **Do not "improve" any of them without reading that section.**
- **Every unit's `Requires=postgresql-15.service` must be redirected, not
  edited.** Patroni owns PostgreSQL and the stock unit is masked. The redirect
  lives in `deploy/ha/dropins/<unit>.service.d/10-ha.conf` precisely because
  the updater overwrites the main unit files (`cp -f` from `deploy/`) and leaves
  `.d/*.conf` alone. The `10-` prefix matters: an empty `After=`/`Requires=`
  assignment resets entries parsed EARLIER, so these must sort before
  `nginx-dependency.conf`.
- **The primary guard is `ExecStartPre` on `polaris-migrate` and
  `polaris-web`.** Every other unit `Requires=` the migrate one-shot, so the
  group cannot start on a replica however it was started. If you add a sixth
  unit, give it the same drop-in.
- **The nginx leaf certificate must be byte-identical on both nodes.** Agents
  pin that exact leaf by SHA-256 with chain validation disabled
  (`agent/internal/pinned/tls.go`), so a different valid certificate breaks the
  whole fleet. The sync copies `/etc/polaris-nginx/` and `verify` compares
  fingerprints.
- **`.env` is synced, not copied once.** The GUI rewrites it (token
  generation), and `POLARIS_SECRET_KEY` / `SESSION_SECRET` must match or every
  stored credential silently decrypts to `""` and every cookie is invalidated.
  Genuinely host-specific overrides go in `/etc/polaris/local.env`, which the
  drop-ins load after `.env`.
- **`.setup-complete` is load-bearing.** Without it the app boots the
  unauthenticated first-run wizard — on a promoted standby, on the public
  hostname. It is inside the sync, and `polaris-ha-role preflight` refuses to
  start the app without it.
- **`polaris.target` must stay disabled.** `reconcile` re-disables it every
  tick if something enabled it, because an enabled target starts the app at boot
  before Patroni has decided anything.
- **The updater runs on the active node only.** It calls
  `polaris-ha-role notify-peer` at the end (in the `systemd-run` script in
  `restartService`), and `deploy/update-linux.sh` does the same — **lockstep,
  two places**, like the unit-file sync. `update-linux.sh` additionally refuses
  to run on a replica and takes `/run/polaris-ha/hold` so the reconciler cannot
  restart the group mid-migration.
- **`unknown` is a real role.** When Patroni REST is unreachable the reconciler
  does NOTHING: it cannot distinguish a demotion from a monitoring outage, and
  both actions would be wrong. Do not "fix" this by defaulting to stop.
- **Only `/health/ready` may check the database.** `/health` must keep checking
  nothing — the setup wizard polls it before a database exists. Readiness uses
  its own 1-connection pool so a saturated Prisma pool cannot flap a site out.
- **etcd is mutually authenticated TLS** from a CA that exists only for this
  cluster (`deploy/ha/etcd-ca.sh` → `/etc/polaris/etcd-ca/`). That is what makes
  a witness on a public cloud address defensible. Relocating the witness means
  issuing one new certificate.
- **TimescaleDB versions must match** on both nodes (loaded library vs
  catalogue). The setup script `versionlock`s the packages; the upgrade order is
  in docs/HA.md §8.
- **`maximum_lag_on_failover` is set to 256 MiB, not the 1 MiB default.** At the
  default, Polaris's continuous sample writes plus TimescaleDB chunk compression
  routinely leave the standby "too far behind" to be promoted, which converts an
  automatic failover into a phone call.
- **The witness placement decides which outage is automatic.** Third site is
  recommended; standby-DC placement means a standby-site or WAN loss demotes a
  healthy primary. Matrix and recovery runbook in docs/HA.md §3 and §11.

## Lockstep register (add to `cross-cutting-deployment.md` when you touch these)

| Change | Also update |
|---|---|
| a package/user/directory in `deploy/setup-rhel.sh` | `prepare_standby_host` in `deploy/ha/setup-rhel-ha.sh` |
| the notify-peer hook | both `updateService.ts` `restartService` and `deploy/update-linux.sh` |
| a new shipped systemd unit | a matching `deploy/ha/dropins/<unit>.service.d/10-ha.conf` |
| what lives under `/opt/polaris` at runtime | `deploy/ha/ha-rsync-exclude` (default is SYNCED) |
| the heartbeat window or interval | `haHeartbeatService.test.ts` assertions + docs/HA.md §5 |
| `/health/ready` semantics | the load-balancer monitor spec in docs/HA.md §7 |

## Not supported

Windows and Docker installs, external/managed PostgreSQL (`-nodb`), PgBouncer in
front of the local database, NAT between etcd members, mixed OS majors, more
than one standby.
