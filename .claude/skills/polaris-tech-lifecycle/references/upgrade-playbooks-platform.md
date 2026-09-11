# Upgrade playbooks — platform

Ordered steps for the things that go end-of-life and need a maintenance window. The machine-
readable summary of each lives in `src/data/platformEol.json` under `playbooks[]`; this file is
the reasoning and the traps.

## How to use a playbook

1. Check the dataset: is the target track's own EOL at least 12 months out? Moving onto
   something that dies next year is a wasted window.
2. Open [version-pin-inventory.md](version-pin-inventory.md) for the family and work its site
   table — that is the checklist.
3. Follow the order below. Order matters most where a host must keep serving.
4. Run `npm run check:versions`. It is the only thing that proves you got every site.
5. Do the verification step. For anything touching the database, that means a restore rehearsal,
   not a green test suite.

## Node major

**Risk: medium.** No data migration, but 23 declaration sites and two install paths.

### Order
1. Confirm the target is an LTS line (even major) and check its EOL.
2. `package.json`: `engines.node` and `@types/node`, then `npm install` to refresh the lockfile.
3. Both Dockerfiles — remember `Dockerfile` has two `FROM` lines.
4. The four Linux setup scripts: the accept-check *and* the install source (`nodejs:N` module
   for RHEL, the NodeSource `node_N.x` repo for Ubuntu).
5. Both Windows scripts: the accept-check, the winget `--version` pin, and the MSI fallback URL.
6. Both workflow files.
7. `docs/INSTALL.md` (three headings), `README.md`, the `CLAUDE.md` tech-stack row.

### Blast radius
Native modules are the real risk: `@node-rs/argon2` and `@resvg/resvg-js` ship prebuilt
binaries per Node ABI, so a major bump can silently fall back to a source build (which needs
`python3` and a compiler — present in `Dockerfile.dev`, not guaranteed on a prod host). Verify
password hashing and PDF/PNG export specifically, not just that the app boots.

### Verification
`npm run typecheck`, `npm run lint`, the full suite **against a real database** (a DB-less run
silently skips ~34 files), then a login and a PDF export on a built install.

### Rollback
Reinstall the previous Node major and restart. Nothing persists per Node version, so rollback is
clean — which is why this is medium and not high.

## PostgreSQL major

**Risk: high.** Data migration, an extension that gates on version, and a backup path with
version-sensitive hooks.

### Order
1. **First**, confirm `timescaledb-2-postgresql-<target>` exists. If the extension has no build
   for the target major, everything else is moot.
2. Take a backup and **rehearse the restore into a scratch database.** The restore path is the
   only code that calls the extension's pre/post-restore hooks, so it is the step most likely to
   surprise you.
3. Install the target major side by side from PGDG. Do not remove the old one yet.
4. `pg_upgrade`, or dump/restore for a small install. Keep the old data directory.
5. Update the extension, then confirm every hypertable, chunk interval and retention policy
   survived — count them before and after.
6. Rewrite the per-host drop-in — `/etc/systemd/system/<unit>.d/20-postgres.conf`, five of them
   — with the new unit name, then `daemon-reload`. **Do not edit the shipped units.** Since
   2026-09-09 they name no PostgreSQL unit at all, because both update paths overwrite them
   verbatim and the name is a host fact; `check:versions` fails if a major reappears in one. On
   Windows the service name and the bin-path probe list move instead.
7. `PG_MAJOR` in `setup-rhel.sh`, `setup-ubuntu.sh` and `deploy/ha/setup-rhel-ha.sh`;
   `PG_CLIENT_MAJOR` in both `-nodb` variants; the installer pin on Windows; the image tags in
   `compose.dev.yml` and the CI service container; **and `postgresql-client-<major>` in
   `Dockerfile` / `Dockerfile.dev`**. Every one of those is checked now — the client was
   unversioned until 2026-09-09, so it silently WAS whatever the base image shipped and agreed
   with the pin only by luck of Debian's release. The image base must actually carry the target
   major (trixie ships 17); if it does not, add the PGDG apt repo to the image, or every
   in-container backup fails the rule-47 check.
8. **Remove the old major's client packages once the switch is final**, and any unversioned
   AppStream `postgresql` / `postgresql-server` left on the host. The app and
   `deploy/update-linux.sh` pick `pg_dump` / `psql` by the SERVER's major (rule 47 —
   `utils/pgClientTools.ts`, `resolve_pg_tool`), so backups follow the new server with no config
   change; but an older client owning `/usr/bin/pg_dump` still breaks every human and script that
   calls the tool by name, and `alternatives --display` will not tell you (it reports its own
   bookkeeping, not the file). `pg_dump --version` is the check.

### Blast radius
The unit dependency is easy to miss and fails *late* — the app starts before Postgres is ready
and the first queries fail. The `-nodb` script variants strip that dependency, so they need
their `sed` patterns updated too, not just the units.

The RHEL AppStream-vs-PGDG inconsistency the inventory used to document was resolved on
2026-09-09 (server packages earlier, client packages that day); a host built before then may
still carry the AppStream 13 packages — step 8 is where that gets cleaned up.

### Verification
Restore a production-sized backup onto the new major and compare the capacity snapshot
(hypertable list, chunk count, database size) against the old one. CI cannot help: its Postgres
has no TimescaleDB.

### On Docker / Unraid
Steps 3, 4, 6, 7 and 8 above assume packages and systemd units, and none of them exist when
PostgreSQL is its own container: the image carries exactly one major's binaries, there is no
side-by-side install and no `pg_upgrade`. The move is **dump → restore into a NEW container with
a NEW data directory**, with the old container kept as the rollback; a tag swap over the existing
data directory exits on `database files are incompatible with server`, and a copy of the old
appdata restores only back into the old major. The full operator procedure is `docs/INSTALL.md` →
*On Docker / Unraid, where PostgreSQL is its own container*.

Two of its traps are worth knowing before you advise on one, because both are silent until
cutover and neither exists on the scripted path:

- **A new data directory is a new `postgresql.conf`.** Every tuning value is gone. `ssl` and
  `max_connections` are the two that fail rather than merely under-perform: if the old container
  had TLS and the new one does not, the unchanged `DATABASE_URL` dies on
  `The server does not support SSL connections` (node-postgres asks, the server refuses, no
  fallback), and `max_connections` reverts to the image default of 100. On Docker both are set
  as server flags on the container's arguments (`-c ssl=on -c max_connections=150`), not by
  editing a file the image does not keep.
- **Adopting TimescaleDB is cheapest during this move** when the source has none, because the
  hard part — matching extension versions across the restore — only exists when the source
  already has it. Restore the plain dump, `CREATE EXTENSION timescaledb`, and let Polaris convert
  the sample tables on its next boot (5–15 min on a database with weeks of samples).

### Rollback
Keep the old data directory and the old major installed until the new one has run a full
retention cycle. Rollback is "point the units back", which is why keeping both installed matters.
On Docker it is "stop the new container, start the old one, point `DATABASE_URL` back", which
works for exactly as long as you keep the old container and its appdata.

## TimescaleDB

**Risk: high**, for the same reason as Postgres: the data is the product.

### Order
1. Read the chunk-bloat runbook in `polaris-monitoring-discovery` first. An extension move and a
   chunk-interval change **must not land together** — if something regresses you will not know
   which one did it.
2. Confirm the target extension version still supports the running PostgreSQL major. 2.29
   dropped PostgreSQL 15, so on 15 the ceiling is the 2.28.x line.
3. Backup, then update the package, restart PostgreSQL, then `ALTER EXTENSION timescaledb UPDATE`.
4. Confirm hypertables, chunk intervals and retention policies survived.

### Blast radius
Compression and continuous-aggregate behaviour changes between minors. The app detects the
extension at boot and caches that state, so a version change needs a restart to be observed.

### Verification
Manual, against a dev stack with real data volume. There is no CI signal.

## Operating-system major

**Risk: high**, but mostly schedule risk rather than technical risk.

### Order
1. Prefer **rebuild over in-place upgrade.** Polaris installs cleanly from the setup script, so a
   fresh host plus a restore is faster and far more predictable than a distro upgrade.
2. Check the nginx.org repository URL for the new major — the `baseurl` encodes the OS release,
   so this is a code change in the install scripts, not just a doc change.
3. Confirm PGDG and TimescaleDB publish for the new major.
4. Run the setup script on a scratch host; diff the resulting unit files against the shipped ones.
5. Restore a production backup and compare the capacity snapshot before cutting over.

### Blast radius
SELinux and systemd hardening defaults change between majors, which is the most likely source of
a surprise: a probe or an exec that worked on the old major gets blocked on the new one. The
app's own version probes degrade to "unknown" rather than erroring, but check the logs for
permission failures rather than assuming silence means success.

### Verification
A full discovery cycle and one agent install/upgrade on the new host, plus an agent build if
that host builds agents.

## nginx

**Risk: low.** No data, no lockstep beyond the accept-regexes.

### Order
1. Decide mainline or stable. Since 2026-09-09 the scripts install the **stable** branch,
   with the mainline stanza written into the RHEL repo file at `enabled=0` — moving branches is
   two flag flips there, and adding or removing a `/mainline` path segment on Debian/Ubuntu.
2. Widen the accept-regex in the four Linux scripts and the migrate helper.
3. Update the three `>=` claims in `docs/INSTALL.md` and the help text beside the HTTP/3 toggle.
4. Re-apply the managed config and confirm HTTP/3 still negotiates.

### Blast radius
Only the reverse proxy. Worth knowing: the WebSocket command channel needs the proxy to allow
upgrades, so verify an agent reconnects, not just that pages load.

## Java major

**Risk: low.** Build-time only, and the feature is opt-in.

### Order
1. Confirm the jsign release in use runs on the target major — 7.5 is Java 8 bytecode (class
   file major 52), so anything from 8 up. Nothing here forces a newer JDK; a move buys runway.
2. **Confirm the package exists on EVERY platform before touching a file**: RHEL AppStream
   (`java-N-openjdk-headless`), Debian and BOTH Ubuntu LTSes (`openjdk-N-jre-headless`), winget
   (`Microsoft.OpenJDK.N`) and the `aka.ms` MSI. One platform without it puts that host on a
   different signing JDK, which is precisely the failure the named-package change ended.
3. The JDK package in the Dockerfile, the winget id and MSI URL in the Windows scripts, the
   `java-N-openjdk-headless` package in the RHEL scripts and `openjdk-N-jre-headless` in the
   Ubuntu ones. Nothing installs `default-jre-headless` any more — do not reintroduce it, in a
   script or in the image; it carries no version for the check to compare and drifts per host.
4. `JAVA_MINIMUM` in `src/services/agentSigningService.ts` — the number the running app
   states. Both `signingAvailability` error strings interpolate it and the Code-signing
   card renders `availability.javaMinimum`, so the browser carries no literal of its own.
   `check:versions` reads it; it is the only Java site inside `src/`.
5. Keep `polarisTarget` equal to `polarisMinimum` in the dataset. A target above what the
   install paths provision reports a behind-target JDK on every healthy host.
6. Re-sign one agent binary and verify the signature chain.

### Blast radius
Signing only. A missing or wrong JDK disables code signing and the UI says so; it does not break
the app or the agent.
