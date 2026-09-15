# Updates

**Production Polaris is updated through the in-app updater**, at
**Server Settings → Maintenance → Updates**.

> Do **not** use `git pull` and a manual restart. The updater also syncs the
> shipped **systemd units and nginx configuration**, which a pull does not — so a
> manually-updated install silently drifts from the deployment surface every
> release ships.

Gated by `serverSettingsData`.

---

## What the updater does

1. **Takes a pre-update backup.** A failure **aborts the update** by default —
   see [Backup and restore](Backup-and-Restore).
2. Fetches from the configured source repository.
3. Installs dependencies and builds.
4. Runs database migrations.
5. **Syncs the shipped systemd units and nginx config.**
6. Restarts.

The card shows the **update train**, the resolved **source repository** and
where that came from, and what version is available.

---

## The update source

By default the updater uses the install's existing git `origin` — whatever it
was cloned from.

To point it at a fork or an internal mirror, set **`POLARIS_UPDATE_REPO`** in
`.env`. It is applied to `origin` before every fetch.

The URL may contain letters, digits and `. _ ~ : / @ + -` only — enough for
`https://`, `ssh://`, `git://` and the `git@host:owner/repo.git` form. **A value
with any other character is ignored** (the updater keeps using the existing
origin) and logs an error naming it — so if an override appears not to take,
check the log.

---

## Versions

```
<major>.<minor>.<git commit count>
```

The major and minor live in `package.json`; the **patch is the commit count**,
computed at runtime. The full string appears in the sidebar and in backup
filenames.

---

## Before updating

| Check | Where |
|---|---|
| A backup succeeds **now** | Server Settings → Maintenance → take one manually |
| `pg_dump` is compatible | the Maintenance tab reports the resolved tools |
| The platform is supported | **Platform Lifecycle** grades this host |
| A maintenance window is open | so the restart does not page anyone |

That last one is worth doing properly: a
[maintenance window](Maintenance-Windows) stops polling **and retires live
alerts** for the devices it covers — but the Polaris host restarting is
something your own automations may notice.

---

## Platform Lifecycle

The same tab grades Node, PostgreSQL, TimescaleDB, Go, nginx, Java and the OS
against committed end-of-life dates, and links the upgrade steps.

| Grade | |
|---|---|
| **below the minimum** | flagged **critical** |
| **past upstream EOL** | flagged and emailed, but deliberately **does not hold a permanent banner open** — it clears only in a maintenance window |

**Upgrading the *platform* is a separate procedure from updating Polaris**, and
every one of those runbooks lives in
**[`docs/UPGRADING.md`](https://github.com/rogers-group-inc/polaris/blob/main/docs/UPGRADING.md)**:
Node on an existing install, the signing JDK, moving to PostgreSQL 17,
migrating from a distro's PostgreSQL to PGDG, upgrading a legacy
single-process install, migrating to the nginx front end, and recovering an
install whose update already failed on TLS interception.

`docs/INSTALL.md` is **fresh installs only**. If you are changing something on
a host that already runs Polaris, you want `UPGRADING.md`.

> **The updater does not install system packages**, and that is a choice rather
> than a limitation. A PostgreSQL major, a Node major or a JDK is yours to move,
> on your maintenance window — which is exactly why those runbooks are separate
> documents rather than a button.

---

## If an update fails

| Symptom | Look at |
|---|---|
| Aborted at the backup step | [Backup and restore](Backup-and-Restore) — almost always the `pg_dump` major or the `sslmode` translation |
| Fetch fails on a TLS-inspecting network | *Networks that inspect TLS* in `INSTALL.md` for the fix. This is the one environment problem that can leave an install unable to update — and if the update **already** failed this way, the recovery runbook is *Recovering an install whose update already failed on TLS interception* in `UPGRADING.md` |
| Container refuses to boot after the image upgrade | *"another host holds a fresh active-instance heartbeat"* — see below |
| Migration fails on table ownership | check who owns the queue tables; a migration cannot alter tables owned by another role |
| The override repo appears ignored | the URL contained a disallowed character; the log names it |

### "Another host holds a fresh active-instance heartbeat"

A guard against two Polaris instances sharing one database. In a container it
used to identify an instance by `os.hostname()` — **which is the container id,
regenerated on every recreate**. So every image upgrade read the stamp the
previous container had written seconds earlier, found a name that was not its
own, and **refused to boot** ([rule 62](Business-Rules#rule-62)).

It self-healed after 90 seconds **only where the restart policy retried**. On
Unraid, a plain `docker run` or a foreground compose it stayed down.

Identity is now a **uuid persisted under the state directory**, which outlives
the process — exactly the lifetime an install has. Two hosts pointed at one
database still hold two state directories and so two ids, so the case the guard
exists for is untouched.

A **clean shutdown releases the claim**, so a restart, an upgrade or a promotion
waits for nothing. A `kill -9` leaves the stamp and the 90-second window applies
as designed.

One consequence if you run [HA](High-Availability): **the instance id file must
be excluded from the standby sync**, or the standby inherits the primary's
identity and the guard silently stops distinguishing them — undetectable in
operation, because a guard that never fires looks identical to a guard that
cannot.

---

## The fallback script

`deploy/update-linux.sh` exists for a host where the in-app updater cannot run.
It carries the same client-resolution logic, and it dumps as the local
`postgres` user over a unix socket.

Use it when the app will not start. Otherwise use the in-app updater.
