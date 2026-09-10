# High availability — active/standby across two datacenters

Polaris runs on one host. This document turns that into two hosts in two
datacenters, where the second takes over automatically when the first is lost,
behind a single public name your global load balancer already steers.

Read it end to end before you touch production. The mechanics are scripts; the
parts that matter are the decisions, the failure modes, and the drills.

> **A human must review this plan against your own network and change-control
> process before you run any of it.** It stops and restarts the production
> database. Coordinate with IT.

---

## 1. What this design is

```
DC-A (active)                            DC-B (standby)
┌────────────────────────────┐           ┌────────────────────────────┐
│ nginx :443  (same cert)    │◄── GSLB ──►│ nginx :443  (same cert)   │
│ polaris.target   RUNNING   │           │ polaris.target   STOPPED   │
│ PostgreSQL 17    primary   │──stream──►│ PostgreSQL 17    replica   │
│ Patroni :8008              │◄─────────►│ Patroni :8008              │
│ etcd member 1              │           │ etcd member 2              │
│ polaris-ha-role (60s)      │◄── rsync ─│ polaris-ha-role (60s)      │
└────────────────────────────┘           └────────────────────────────┘
                    ▲                          ▲
                    └────── etcd member 3 ─────┘
                        witness (see §3)
```

Three things decide everything:

1. **Patroni + etcd** own PostgreSQL. Exactly one node holds a leader lease in
   etcd and runs a writable primary. Replication is **asynchronous**: commits
   never wait for the WAN.
2. **The application follows the database.** `polaris-ha-role` asks the local
   Patroni whether this node is the primary and starts or stops
   `polaris.target` accordingly. `polaris.target` is **disabled** on both
   nodes; the reconciler owns when it starts.
3. **Your load balancer follows readiness.** `GET /health/ready` returns 200
   only on a writable primary, 503 otherwise, so a demoted node leaves the pool
   on its own.

### Why the standby's application must stay stopped

Polaris has no leader election. The schedulers are plain intervals on the web
role, notification delivery has no claim step, and the login lockout,
rate-limit and pending-MFA stores live in process memory. Two live web roles
would poll every device twice, fire every alert twice, and race each other's
writes to `Asset.monitorStatus`. There is no configuration that makes a second
instance safe, so the design makes it impossible instead (§5).

---

## 2. What you get, and what it costs

| | |
|---|---|
| **RPO** (data loss) | Replication lag at the moment of failure. Normally well under a second. |
| **RTO** (downtime) | Roughly 1.5 to 3 minutes: lease expiry (30s) + promote (~10s) + app start (20-40s) + your monitor's detection + DNS TTL. |
| **Automatic** | Loss of the primary host, or of the primary datacenter (subject to witness placement, §3). |
| **Manual** | Anything the witness placement leaves without a quorum, and every planned move (use `patronictl switchover`). |

### What is lost in a failover

Be specific about this with whoever asks:

- **Up to 2 seconds of buffered samples.** The sample and probe-patch buffers
  flush every 2s and on SIGTERM. A clean stop loses nothing; a power cut loses
  the unflushed window.
- **Agent samples generated during the gap.** Agents retry the connection
  forever but do not queue samples, so what they produced while nobody was
  listening is gone.
- **In-memory security counters.** Login lockouts, rate-limit counters and
  half-finished MFA challenges reset. A user mid-login retries; a locked-out
  attacker gets a fresh budget.
- **Possibly one duplicate alert email.** For a few seconds after a demote the
  old app can still read a pending delivery, send it, and fail to mark it sent.
  The new primary then sends it again. Bounded and harmless, but expect it.
- **Nothing else.** Sessions, audit events, monitor state, consecutive-miss
  counters, discovery runs, backups history and every secret live in
  PostgreSQL, so they replicate. Users stay logged in.

### What must be true about the network

| Requirement | Value | Why |
|---|---|---|
| Node-to-node round trip | **under 100 ms** (works to ~250 ms) | etcd's election timeout is 2.5s; elections churn on a slow link. |
| Bandwidth | sustain your WAL rate with ~3x headroom | Measure it (§4). Sample writes are continuous and TimescaleDB compression rewrites whole chunks. |
| Ports between the two DB nodes | 5432, 8008, 22 | replication, Patroni REST, file sync |
| Ports among all three etcd members | 2379, 2380 | client and peer, mutual TLS |
| Public | 443/tcp+udp on both | your load balancer probes the standby too |
| Clock | chrony on all three | etcd elections and the heartbeat window compare timestamps across hosts |

### Hardware

- **Standby: the same class as the primary.** After a failover it carries the
  whole fleet alone. Match CPU and RAM; size the database volume at the
  primary's current size plus `max_slot_wal_keep_size` plus 30% growth; the app
  volume per the table in `docs/INSTALL.md`. Same OS major, same Node major,
  same PostgreSQL and TimescaleDB versions — `polaris-ha-role verify` checks
  the ones it can see.
- **Witness: 1 vCPU, 1 GB RAM, ~10 GB SSD**, any Linux. etcd is sensitive to
  disk fsync latency, so avoid spinning disks and throttled burst storage. It
  should run nothing else.

### Not supported in this release

Windows and Docker installs; external or managed PostgreSQL (the `-nodb`
install path); PgBouncer in front of the local database; NAT between etcd
members; mixed OS majors; more than one standby.

---

## 3. Choosing where the witness lives

The witness is a third **voting** etcd member. It holds only Patroni's cluster
state: the leader key, member addresses, and the dynamic PostgreSQL parameters.
No database data, no application secrets. Two nodes cannot form a quorum of
three by themselves, which is the whole point — the witness is what decides
which node may hold the lease when the two cannot see each other.

Its location decides which failures are automatic:

| Witness at | Primary host dies | Primary DC dark | Standby DC dark / WAN cut |
|---|---|---|---|
| **Third site** (cloud VM, VPS) — recommended | automatic | automatic | no effect |
| Standby DC | automatic | automatic | **primary demotes itself: full outage** until §11 recovery |
| Primary DC | automatic | **manual** `patronictl failover` | no effect |

`failsafe_mode: true` softens one case only: when etcd is unreachable but every
Patroni member still answers over REST and confirms it will not promote, the
primary keeps running. It does **not** help when the standby itself is the
unreachable member.

A witness on a public address is safe here because **all etcd traffic is
mutually authenticated TLS** from a CA that exists only for this cluster
(`polaris-etcd-ca`). Still firewall 2379 and 2380 to the two node addresses,
put it behind the provider's network security group or a VPN if you have one,
and run nothing else on it.

On RHEL-family hosts, `setup-rhel-ha.sh --role witness` installs etcd from the
PGDG extras repo and nothing else. On another distribution, install the
upstream etcd binary, use the rendered `etcd.conf`, and take the unit from
`deploy/ha/etcd.service.example`.

### Addressing: three planes, never mixed

| Plane | Used by | Where it comes from |
|---|---|---|
| **Public URL** (`POLARIS_PUBLIC_URL`) | browsers, agents, the load balancer, e-mail links, nginx `server_name` | unchanged, identical on both nodes, **never used between nodes** |
| **Cluster address**, one per node | etcd, Patroni REST, PostgreSQL `listen_addresses`, `pg_hba`, rsync | you choose per node: private IP, or an FQDN both peers resolve |
| **Extra SANs** | that node's etcd certificate | optional: a NAT'd address, a second NIC, a split-horizon name |

The two datacenters are usually routed to each other privately, so the cluster
addresses are normally private IPs even though the public name is global.

---

## 4. Before you start: verify and measure

Run all of this on the existing production host. Nothing here changes anything.

```bash
# PostgreSQL: this design assumes the PGDG layout docs/INSTALL.md prescribes.
systemctl status postgresql-17
/usr/pgsql-17/bin/pg_config --version
sudo -u postgres psql -tAc "SHOW data_directory"

# pg_rewind prerequisites. If BOTH data checksums are off AND wal_log_hints is
# off, a failed-over node cannot rejoin without a full re-clone. patroni.yml
# turns wal_log_hints on, which takes effect at the adoption restart.
/usr/pgsql-17/bin/pg_controldata /var/lib/pgsql/17/data | grep -iE 'checksum|wal_log_hints'

# Everything Patroni is about to take ownership of. Carry these into
# patroni.yml or they silently revert to Patroni's defaults.
sudo -u postgres psql -c "SELECT name, setting, source FROM pg_settings
  WHERE source NOT IN ('default','override') ORDER BY name;"
sudo -u postgres psql -tAc "SHOW hba_file"    # copy its polaris lines too

# Versions and identities the standby must match.
node -v; id -u polaris; rpm -q timescaledb-2-postgresql-17
openssl x509 -in /etc/polaris-nginx/cert.pem -noout -fingerprint -sha256

# Space, for sizing max_slot_wal_keep_size.
df -h /var/lib/pgsql /opt/polaris
```

**Measure the WAL rate.** This sizes the WAN link, the slot cap and
`maximum_lag_on_failover`. Take it across 24 hours so the TimescaleDB
compression window is included:

```bash
sudo -u postgres psql -tAc "SELECT pg_current_wal_lsn()"      # note it, wait, repeat
sudo -u postgres psql -tAc "SELECT pg_wal_lsn_diff('<later>','<earlier>')/1024/1024 AS mb"
```

Since the release that introduced this document, the web role also samples the
WAL position every five minutes into the `ha.walSamples` setting, so on an
up-to-date install the last 24 hours are already recorded.

---

## 5. How split brain is prevented

Two properties must hold: never two writable primaries, and never two running
application groups. Each has its own independent layers.

**Never two writable primaries**

1. **One lease.** A node runs a primary only while it holds the `leader` key in
   etcd, granted by a linearizable compare-and-swap over a quorum of three.
   Two holders are not possible.
2. **Self-demotion first.** A leader that cannot renew demotes its own
   PostgreSQL to read-only *before* the lease can expire. Only then can the
   standby take it. The timing invariant is
   `ttl >= loop_wait + 2 x retry_timeout` (30 >= 10 + 20). Do not shorten `ttl`
   alone.
3. **PostgreSQL itself.** A hot standby refuses every write. Only a promote
   changes that, and a promote needs the lease.
4. **One-way rejoin.** A returning former primary does not hold the key, so it
   starts as a replica and `pg_rewind` discards any diverged timeline.
5. **Watchdog fencing.** The remaining gap is a frozen Patroni or VM that
   thaws holding a still-valid lease. `watchdog: mode: automatic` with the
   `softdog` module resets the node instead. This is the only true fencing in a
   two-node cluster; leave it on.

**Never two application groups**

1. **`DATABASE_URL` is `localhost` on both nodes.** An application cannot reach
   the other node's database at all, so two writing apps would first require
   two writable primaries.
2. **A start guard in systemd.** The HA drop-ins add an `ExecStartPre` check of
   the local Patroni role to `polaris-migrate` and `polaris-web`, and every
   other unit `Requires=` the migrate one-shot. `systemctl start
   polaris.target` on a replica fails, whoever types it.
3. **The reconciler converges** every 60 seconds and on every Patroni callback,
   and re-disables `polaris.target` if anyone enables it.
4. **Readiness** takes a demoted node out of the load balancer within one
   monitor interval.
5. **A heartbeat in the database.** The web role stamps
   `Setting("ha.activeInstance")` with its hostname every 30 seconds, and
   refuses to boot when a *different* hostname holds a stamp younger than 90
   seconds. This is the one layer that catches two hosts deliberately pointed
   at **one** database. It is not a lock: a stale stamp expires, so a
   legitimate failover is delayed by at most one systemd restart. Override with
   `POLARIS_HA_HEARTBEAT=off` only when you know why.

**The residual window.** For up to ~20 seconds after a demote (callback latency
plus `TimeoutStopSec=20`) the old application may still be running against a
read-only database. It cannot write. It can send one duplicate alert e-mail.
No data diverges.

**Verify continuously**

```bash
patronictl -c /etc/patroni/patroni.yml list         # exactly one Leader
polaris-ha-role verify                              # cert, HEAD, node, uid, tsdb parity
curl -sf localhost:8008/primary && echo primary     # exactly one node answers 200
```

Alert on "no node reports ready", not on "a node is down" — the standby being
down at 443 is the normal state.

---

## 6. How the data moves

Streaming replication is continuous and physical: every commit is shipped as
write-ahead log records and replayed on the standby, usually within
milliseconds. The standby is a byte-identical copy at a slightly earlier point
in time. With one writer nothing can drift, so **there is no reconcile step and
no periodic comparison** — none is needed.

Full or partial copies happen exactly three times:

- **Once, at build:** `pg_basebackup` clones the standby (Patroni does it).
- **After a failover:** `pg_rewind` copies back only the blocks that diverged
  on the old primary.
- **If the standby falls too far behind:** the primary retains WAL for a
  disconnected standby up to `max_slot_wal_keep_size`; below the cap the
  standby catches up from the retained deltas, above it Patroni re-clones. The
  cap exists so a standby that is down for a weekend cannot fill the primary's
  disk and take production with it.

The **file** sync is the periodic part, and it covers only what PostgreSQL does
not carry: the code tree, `.env`, the nginx certificate and key, the unit
files, the built agent binaries, the signing keystore, the uploaded logo. Every
60 seconds, block-level deltas, from the primary's installed files. Never
database data. `deploy/ha/ha-rsync-exclude` lists what is left out and why.

### The certificate is not optional

Every enrolled Polaris agent pins the **exact** nginx leaf certificate by
SHA-256 and does not validate a chain. A standby serving a different
certificate — even a valid one from the same internal CA — is rejected by every
agent on the wire. That is why the sync copies
`/etc/polaris-nginx/{cert,key}.pem` and why `verify` compares fingerprints. When
you rotate the certificate, stage the new pin on the agents first (Server
Settings → Maintenance), exactly as on a single-node install; the standby picks
the new files up within a minute.

---

## 7. Build it

There are two ways through this, and they install the same thing.

**Server Settings → High Availability** is the shorter one. You enter the three
nodes, press Enable, and it hands you one bootstrap script per node. Each script
carries a single-use token and nothing else sensitive; run it as root on that
node and it registers back here, waits for you to approve it, then downloads its
own configuration, certificates and keys over pinned TLS. Read §7a.

The flag-by-flag path in §7b does the same work with `deploy/ha/setup-rhel-ha.sh`
invoked by hand. Use it when you are automating the build, when the node cannot
reach this Polaris over HTTPS, or when you want to see exactly what is happening.

Either way, read §1 to §6 first.

### 7a. Through the High Availability tab

**Phase 0 — ship the code and point the monitor at readiness.** Update Polaris
normally, then repoint your load balancer at `/health/ready` (the monitor spec is
in §7b, phase 0). Do this before anything else: on a single node it already turns
"PostgreSQL is down" from an invisible failure into an out-of-pool node.

**Phase 1 — provision the two new hosts.** The standby gets the same OS image and
hardening as the primary. The witness can be a 1 vCPU cloud instance. Open 2379
and 2380 between all three, 5432 / 8008 / 22 between the two database nodes, and
443 on the standby so your load balancer can probe it.

**Phase 2 — measure, then enable.** Open Server Settings → High Availability.

1. Press **Measure this install**. The guidance card states this install's
   figures: round-trip time to each node, the write-ahead-log rate over the last
   24 hours and the link it implies, how much data a failover would lose, how long
   it would take given your own monitor settings, and how big the standby has to
   be. Anything it could not measure says so rather than showing a green tick.
2. Fill in the three nodes. The **cluster address** is how the nodes reach each
   other and is usually a private address; the public URL is never used between
   them. The primary's row offers this host's own interfaces.
3. Choose the **witness location**, having read the table on that card. This is
   the most consequential choice in the design (§3).
4. Press **Enable**. Nothing is installed and nothing restarts: it generates the
   etcd certificate authority, the database credentials and the file-sync keys,
   and stores them sealed in the database.

**Phase 3 — witness.** Under **Node scripts**, generate the witness script, run it
as root on the witness, then approve the node when it appears under **Approvals**.
Check the source address and the SSH host key fingerprints are the machine you
built before you approve — that is what the panel shows them for. Start etcd:
`systemctl start etcd`.

**Phase 4 — primary (the maintenance window, ~15 min).** Generate and run the
primary script on this host, and approve it. It adopts the running PostgreSQL
under Patroni, which stops the database and the application for a few minutes.
It prints the settings Patroni is taking ownership of and waits for you to
confirm them. Accept the window when the **Cluster** card shows one leader, the
tab reports this node as the primary, `systemctl is-enabled polaris.target` says
disabled, and `curl -sk https://localhost/health/ready` returns 200. Log in,
confirm agents reconnected, run a discovery.

**Phase 5 — standby.** Generate and run the standby script, approve it. It
installs every package the primary has, joins etcd, clones the database and leaves
the application stopped. Watch the lag fall to zero on the Cluster card, then:

```bash
polaris-ha-role verify                    # must be clean
systemctl start polaris-migrate.service   # must FAIL on the standby
```

The second command is the guard proving itself.

**Phase 6 — load balancer, then rehearse.** Add the standby with the same monitor;
it shows down, which is correct. Then work through the drills in §7b phase 6 and
§12. The Cluster card reports **automatic failover not armed** until the standby
sheds its `nofailover` tag, which is the deliberate act that turns failover on.

Two things the tab will not do, on purpose. It never runs the primary's adoption
for you — that stops the database serving the page you clicked from, and it is the
one step with a rollback a human should be watching. And it never switches over:
use `patronictl`, because the command would kill the process answering it.

### 7b. By hand, with flags

### Phase 0 — ship the code, point the monitor at readiness

Update Polaris normally. Then repoint your load balancer's monitor at
`/health/ready`. Do this before anything else: on a single node it already
turns "PostgreSQL is down" from an invisible failure into an out-of-pool node.

```
Monitor:   HTTPS GET /health/ready
Host/SNI:  <your public name>
Header:    Authorization: Bearer <HEALTH_TOKEN>   (only if HEALTH_TOKEN is set)
Interval:  5s      Timeout: 4s      Retries: 3    (down in ~15s)
DNS TTL:   5s
Success:   200      Failure: 503, 502, timeout
```

Make sure "all sites down" does not fall back to a site that is failing its
monitor.

### Phase 1 — certificates

On the **primary**:

```bash
install -m 0755 /opt/polaris/deploy/ha/etcd-ca.sh /usr/local/sbin/polaris-etcd-ca
polaris-etcd-ca init
polaris-etcd-ca issue polaris-a 10.10.1.5          # primary
polaris-etcd-ca issue polaris-b 10.20.1.5          # standby
polaris-etcd-ca issue witness   198.51.100.7       # witness (add SANs if NAT'd)
```

Copy `ca.crt` plus each node's own `.crt` and `.key` to `/etc/polaris/etcd-ca/`
on that node. Back up `/etc/polaris/etcd-ca/ca.key` to your password vault: it
is in no Polaris backup.

### Phase 2 — etcd on all three, in order

Witness first, then primary, then standby. Every member advertises all three by
the same names.

```bash
# on the witness
bash /path/to/deploy/ha/setup-rhel-ha.sh --role witness \
  --node-name witness   --this-addr 198.51.100.7 \
  --peer-name polaris-a --peer-addr 10.10.1.5 \
  --standby-name polaris-b --standby-addr 10.20.1.5 \
  --witness-addr 198.51.100.7 --witness-name witness
systemctl start etcd

# on the primary (etcd only for now — PostgreSQL and Polaris are untouched)
bash /opt/polaris/deploy/ha/setup-rhel-ha.sh --role primary \
  --node-name polaris-a --this-addr 10.10.1.5 \
  --peer-name polaris-b --peer-addr 10.20.1.5 \
  --witness-name witness --witness-addr 198.51.100.7
systemctl start etcd
```

Then the standby host, which also installs its packages, user and directories:

```bash
bash /path/to/deploy/ha/setup-rhel-ha.sh --role standby \
  --node-name polaris-b --this-addr 10.20.1.5 \
  --peer-name polaris-a --peer-addr 10.10.1.5 \
  --witness-name witness --witness-addr 198.51.100.7 \
  --polaris-uid <primary's id -u polaris> \
  --tsdb-version <primary's timescaledb version>
systemctl start etcd
```

Confirm three voting members from any node:

```bash
etcdctl --cacert /etc/polaris/etcd-ca/ca.crt \
        --cert /etc/polaris/etcd-ca/$(hostname -s).crt \
        --key  /etc/polaris/etcd-ca/$(hostname -s).key \
        --endpoints https://127.0.0.1:2379 member list -w table
```

Also exchange the sync keys now: each setup run prints the `authorized_keys`
line to install in the **other** node's `/root/.ssh/authorized_keys`. Both
directions, because the roles swap.

### Phase 3 — adopt the running cluster (the maintenance window, ~15 min)

```bash
bash /opt/polaris/deploy/ha/setup-rhel-ha.sh --role primary --adopt \
  --node-name polaris-a --this-addr 10.10.1.5 \
  --peer-name polaris-b --peer-addr 10.20.1.5 \
  --witness-name witness --witness-addr 198.51.100.7
```

It prints the settings and `pg_hba` lines Patroni is taking over, waits for you
to confirm the rendered `/etc/patroni/patroni.yml` reflects them, then stops
Polaris, masks `postgresql-17`, starts Patroni, creates the replication roles
and hands the application back to the reconciler.

Accept the window when all of these hold:

```bash
patronictl -c /etc/patroni/patroni.yml list      # one Leader, running
polaris-ha-role role                              # primary
systemctl is-enabled polaris.target               # disabled
systemctl show -p Requires polaris-web.service | grep -cE 'postgresql[^ ]*\.service'  # 0
ls /etc/systemd/system/polaris-*.service.d/20-postgres.conf 2>/dev/null              # nothing
curl -sk https://localhost/health/ready           # 200 {"status":"ready"}
```

Log in, confirm agents reconnected (Server Settings → Polaris Agent) and that a
discovery run still works.

### Phase 4 — bring up the standby

Copy `/etc/polaris/ha-secrets.env` from the primary (the credentials must be
identical), and copy the PostgreSQL `parameters:` block from the primary's
`patroni.yml` into the standby's. Then:

```bash
systemctl enable --now patroni                    # clones from the primary
patronictl -c /etc/patroni/patroni.yml list       # watch Lag fall to 0
polaris-ha-role reconcile                          # stops the app, first file sync
polaris-ha-role verify                             # must be clean
```

The standby joins with `nofailover: true`, so it cannot yet win an election.
Prove the guard works before moving on:

```bash
systemctl start polaris-migrate.service            # MUST fail on the standby
```

### Phase 5 — add the standby to the load balancer

Same monitor. It will show **down** (nginx answers, the app does not) — that is
correct.

### Phase 6 — rehearse, then enable automatic failover

Do not skip this. Nothing below has been proven on your hardware until you have
watched it.

1. **Planned switchover.** `patronictl -c /etc/patroni/patroni.yml switchover`.
   Time the app stop, the promote, the app start, the load-balancer flip.
   Confirm sessions survived, agents reconnected, and an alert still delivers.
   Switch back.
2. **Unplanned failover.** Remove `nofailover` from the standby's `tags` and
   `patronictl reload`. On the primary, `systemctl stop patroni`. Watch the
   standby promote, its app start, and the old node come back as a replica via
   `pg_rewind` with its app stopped and the sync direction reversed. Switch
   back.
3. **Update drill.** Run an in-app update on the active node. Within seconds
   `polaris-ha-role status` on both nodes should report the same `head`.
4. **Quorum drills.** §11 and §12.

Automatic failover is on once `nofailover` is gone. Add alerting for "no node
reports ready" and for `polaris-ha-role.service` failures.

---

## 8. Day-to-day operations

### Updating Polaris

Update on the **active** node, through the in-app updater as always. The
standby is not updated directly: the updater calls `polaris-ha-role
notify-peer`, and the standby pulls the new tree within seconds.

`deploy/update-linux.sh` also works, and on an HA node it refuses to run unless
this host is the primary, holds off the reconciler for the duration, and
notifies the peer at the end.

Both paths also refresh the HA files that do not live in the tree once
installed — `/usr/local/sbin/polaris-ha-role`, `polaris-ha-role.service` and
`.timer`, `patroni.service.d/10-polaris.conf`, and the `10-ha.conf` drop-ins —
so a fix to the reconciler arrives with the release that carries it. Only files
already present are refreshed, never created: this script decides which of them
a node gets, so **if a release adds a new HA file, re-run `setup-rhel-ha.sh` on
each node to install it.** Release notes will say so when it happens.

**The one window to know about.** Between an update finishing and the standby
syncing (seconds normally, up to 60 if the notification cannot get through) the
standby is running the previous release. That only matters for a migration that
**drops or renames** a column: the schema sanity check would refuse to start
the older code against the newer database. If a failover lands in that window:

```bash
polaris-ha-role catch-up          # or: catch-up <commit>
polaris-ha-role reconcile
```

Additive migrations are unaffected. After any update, `polaris-ha-role status`
on both nodes is the two-second check that the window has closed.

### Switching over on purpose

```bash
polaris-ha-role hold "planned switchover"    # optional, on both nodes
patronictl -c /etc/patroni/patroni.yml switchover
polaris-ha-role release
```

### TimescaleDB or Patroni upgrades

The loaded TimescaleDB library must match the extension version in the
catalogue, so the two nodes must never diverge. The setup script pins the
packages with `dnf versionlock`. To upgrade:

```bash
# both nodes
dnf versionlock delete timescaledb-2-postgresql-17 timescaledb-2-loader-postgresql-17
dnf install -y timescaledb-2-postgresql-17-<new>
dnf versionlock add timescaledb-2-postgresql-17 timescaledb-2-loader-postgresql-17
# then, in order
patronictl -c /etc/patroni/patroni.yml restart <cluster> <standby>
patronictl -c /etc/patroni/patroni.yml switchover        # standby becomes primary
patronictl -c /etc/patroni/patroni.yml restart <cluster> <old primary>
sudo -u postgres psql -d polaris -c "ALTER EXTENSION timescaledb UPDATE"
```

### Rebuilding the standby from scratch

```bash
patronictl -c /etc/patroni/patroni.yml reinit <cluster> <standby>
polaris-ha-role reconcile && polaris-ha-role verify
```

### Moving the witness

```bash
# on the primary: a certificate for the new member
polaris-etcd-ca issue witness2 <new-addr>
# remove the old member, add the new one
etcdctl ... member remove <old-id>
etcdctl ... member add witness2 --peer-urls=https://<new-addr>:2380
# on the new witness: ETCD_INITIAL_CLUSTER_STATE=existing, then start etcd
# on both database nodes: update etcd3.hosts in patroni.yml, then
patronictl -c /etc/patroni/patroni.yml reload <cluster>
```

### Backups

Unchanged, and still necessary: replication protects against a host, not
against a bad `DELETE` or a corrupted table. Keep the scheduled backup on and
keep its off-host copy directory set. Guard any cron backup job you run
yourself so it only runs where it should:

```bash
polaris-ha-role is-primary || exit 0
```

---

## 9. Reference: what is installed where

| Path | What |
|---|---|
| `/etc/patroni/patroni.yml` | cluster config, 0600 postgres |
| `/etc/etcd/etcd.conf` | etcd member config |
| `/etc/polaris/etcd-ca/` | the etcd CA and this member's certificate |
| `/etc/polaris/pg-tls/` | PostgreSQL's replication server certificate |
| `/etc/polaris/ha.conf` | reconciler config (peer address, sync key) |
| `/etc/polaris/ha-secrets.env` | Patroni credentials, identical on both nodes |
| `/etc/polaris/ha-node` | the marker that puts the updaters in HA mode |
| `/etc/polaris/ha/id_ed25519` | the file-sync key |
| `/usr/local/sbin/polaris-ha-role` | the reconciler |
| `/usr/local/sbin/polaris-patroni-callback` | Patroni to reconciler bridge |
| `/usr/local/sbin/polaris-ha-ssh-wrapper` | forced command for the peer's key |
| `/etc/systemd/system/polaris-*.service.d/10-ha.conf` | Patroni dependency + primary guard |
| `/etc/systemd/system/polaris-ha-role.{service,timer}` | the 60s reconcile |
| `/etc/polkit-1/rules.d/49-polaris.rules` | lets the updater restart the group |
| `/run/polaris-ha/` | role, last sync, hold file |

The sync key is a root-to-root, read-only channel guarded by a forced command.
It is **not** a privilege boundary between the nodes: read-only root rsync can
read anything, and the two nodes already share `.env` (the secrets-at-rest key,
the session secret, the database password) and the nginx private key. They are
one trust domain. Treat either node's sync key like a root password.

---

## 10. Rolling back out of Patroni

If adoption goes wrong, or you decide against HA, on the node that should own
the database:

```bash
systemctl stop patroni && systemctl disable patroni
systemctl unmask postgresql-17 && systemctl enable postgresql-17
cd /var/lib/pgsql/17/data
# Patroni renamed the original config and includes it; restore the plain file.
[ -f postgresql.base.conf ] && mv postgresql.base.conf postgresql.conf
cp pg_hba.conf.polaris-pre-ha pg_hba.conf        # saved by --adopt
rm -f /etc/systemd/system/polaris-*.service.d/10-ha.conf
rm -f /etc/polaris/ha-node
systemctl disable --now polaris-ha-role.timer
systemctl daemon-reload
systemctl start postgresql-17
systemctl enable --now polaris.target
```

The database files are untouched by any of this — Patroni manages a cluster, it
does not convert one.

---

## 11. Runbook: etcd has lost quorum

Symptom: `patronictl list` errors or shows no leader; Patroni logs cannot reach
the DCS; with the witness in the standby DC, a standby-site or WAN outage has
demoted a healthy primary.

First, check whether `failsafe_mode` is holding the primary up: if the primary
still answers `curl localhost:8008/primary` with 200 and PostgreSQL is
writable, you have time. Restore the missing members and stop.

If the primary has demoted and the other two members will not be back soon,
rebuild a single-member cluster on the surviving node. **Only when you are
certain the other members are down** — doing this while another member lives
is how you get two clusters:

```bash
systemctl stop patroni etcd
cp -a /var/lib/etcd /var/lib/etcd.bak.$(date +%s)

# Keep the existing keyspace, drop the other members from it.
etcd --name <this-member> --data-dir /var/lib/etcd/<this-member>.etcd \
     --force-new-cluster &   # or add ETCD_FORCE_NEW_CLUSTER=true and start the unit
# Fix the advertised peer URL, which --force-new-cluster resets to localhost:
etcdctl ... member list
etcdctl ... member update <id> --peer-urls=https://<this-addr>:2380

systemctl start etcd && systemctl start patroni
patronictl -c /etc/patroni/patroni.yml list      # expect this node as Leader
polaris-ha-role reconcile                         # the app comes back
```

When the other sites return, re-add them as new members
(`ETCD_INITIAL_CLUSTER_STATE=existing`, empty data directory) and put the
member list back to three.

---

## 12. Drills

Rehearse before go-live, then quarterly. Each one has a specific failure it is
proving against.

| Drill | How | Expect |
|---|---|---|
| **Planned switchover** | `patronictl switchover` | roles swap, app follows, sessions survive |
| **Unplanned failover** | `systemctl stop patroni` on the primary | standby promotes, old node rejoins by `pg_rewind` as a replica |
| **Partition** | firewalld-block 2379/2380/5432/8008 between the DCs, from the primary | primary demotes within 30s; `CREATE TABLE` on it fails read-only; its app stops; readiness 503. Heal: rewind rejoin, sync direction reverses |
| **Freeze** | pause the primary VM at the hypervisor for longer than the lease, then resume | watchdog resets the node; it rejoins as a replica; no writes on the old timeline |
| **Manual start** | `systemctl start polaris.target` on the standby | fails at `ExecStartPre` |
| **Shared-database misconfiguration** | point a spare instance at the active database | refuses to boot, names the holder, `polaris_ha_active_instance_conflict_total` increments |
| **Update propagation** | in-app update on the active node | both nodes report the same `head` within seconds |
| **Certificate rotation** | rotate the nginx cert with pins staged | `verify` shows matching fingerprints; agents stay connected |
| **Standby rebuild** | `patronictl reinit` | clone completes, `verify` clean |
| **Restore** | restore a backup on the standby | the backup is usable, not merely present |

---

## 13. Command reference

Most of §7a is also reachable from the command line, and the tab shows the same
state these commands report. The tab is the only place that lists **pending node
approvals**, since that decision needs the source address and host keys in front
of you.


```bash
polaris-ha-role role          # primary | replica | unknown
polaris-ha-role status        # JSON: role, head, cert, versions, last sync
polaris-ha-role verify        # parity against the peer; the acceptance check
polaris-ha-role reconcile     # what the timer and the callbacks run
polaris-ha-role preflight     # could this host serve?
polaris-ha-role sync          # pull file state now (replica)
polaris-ha-role notify-peer   # ask the peer to sync now
polaris-ha-role hold "why"    # suspend reconcile;  release  resumes
polaris-ha-role catch-up      # rebuild the code tree from git (emergency)
polaris-ha-role is-primary    # exit status, for cron guards

patronictl -c /etc/patroni/patroni.yml list
patronictl -c /etc/patroni/patroni.yml switchover
patronictl -c /etc/patroni/patroni.yml reinit <cluster> <member>

journalctl -t polaris-ha -f        # every decision the reconciler made
journalctl -u patroni -f
```
