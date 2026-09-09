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
6. Rename the `After=` / `Requires=` dependency in the shipped units; on Windows the service
   name, the NSSM `DependOnService`, and the `bin` path candidate all move.
7. The package names, `pg_config` path and installer pin in every setup script (`PG_MAJOR` in
   `setup-rhel.sh`, `PG_CLIENT_MAJOR` in `setup-rhel-nodb.sh`); the image tags in
   `compose.dev.yml` and the CI service container.
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

### Rollback
Keep the old data directory and the old major installed until the new one has run a full
retention cycle. Rollback is "point the units back", which is why keeping both installed matters.

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
1. Decide mainline or stable. The scripts install mainline today.
2. Widen the accept-regex in the four Linux scripts and the migrate helper.
3. Update the three `>=` claims in `docs/INSTALL.md` and the help text beside the HTTP/3 toggle.
4. Re-apply the managed config and confirm HTTP/3 still negotiates.

### Blast radius
Only the reverse proxy. Worth knowing: the WebSocket command channel needs the proxy to allow
upgrades, so verify an agent reconnects, not just that pages load.

## Java major

**Risk: low.** Build-time only, and the feature is opt-in.

### Order
1. Confirm the jsign release in use runs on the target major.
2. The JDK package in the Dockerfile, the winget id and MSI URL in the Windows scripts, the
   `java-N-openjdk-headless` package in the RHEL scripts.
3. Decide what to do about the Ubuntu scripts' unversioned `default-jre-headless` — pinning it
   is the point of the exercise.
4. Re-sign one agent binary and verify the signature chain.

### Blast radius
Signing only. A missing or wrong JDK disables code signing and the UI says so; it does not break
the app or the agent.
