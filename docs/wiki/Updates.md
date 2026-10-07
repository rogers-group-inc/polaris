# Updates

**Production Polaris is updated through the in-app updater**, at
**Server Settings → Maintenance → Application Updates**.

> Do **not** use `git pull` and a manual restart. The updater also syncs the
> shipped **systemd units and nginx configuration**, which a pull does not — so a
> manually-updated install silently drifts from the deployment surface every
> release ships.

Applying an update is gated `serverSettingsData` (Read-Write — the key has no
Read rung); looking at the card rides `serverSettingsSystem` Read.

**Docker / podman installs do not use it.** A container image carries no git
checkout, so the card reports *"In-app updates are disabled in Docker"* — pull
the new image and recreate the container instead; data and settings persist on
the mounted state volume.

---

## What the updater does

**Check for Updates** fetches and reports what is available. Applying then runs
seven steps, each shown with its own status:

1. **Back up database.** A failure **aborts the update** by default —
   see [Backup and restore](Backup-and-Restore). Two deliberate ways past it:
   untick **Back up database before applying updates** on the card, or tick
   *proceed without a backup* in the confirmation after a backup has failed.
   Migrations cannot be rolled back, so either is a decision to have no
   rollback point.
2. **Pull latest code** from the configured source repository.
3. **Install dependencies** — preceded by a check that the npm registry is
   reachable, because `npm ci` deletes the working dependency tree before it
   discovers it cannot download a new one.
4. **Generate Prisma client.**
5. **Build TypeScript.**
6. **Run migrations.**
7. **Restart service** — first syncing the shipped **systemd units** (only
   files that changed, then a daemon-reload) and, on an nginx-fronted install
   whose config Polaris manages, the **nginx config** (rendered, `nginx -t`,
   reload), then restarting the whole `polaris.target` group so no role keeps
   running old code against the new schema.

An nginx config that was hand-edited since Polaris last wrote it is **not**
overwritten — the update logs it, and the Web Server tab shows the drift
banner until you adopt it again.

The card shows the current version, the resolved **source repository** and
where that came from, the **update train**, and a *Recent updates* history.
Every update writes `server.update.started` and `server.update.applied` (or
`server.update.failed`) Events.

### Update train

| Train | Follows |
|---|---|
| **Nightly — latest commits** (default) | the tip of the update branch — every change |
| **Release — stable releases only** | the highest published release tag (`v1.2.3` or `1.2.3`), checked out detached. With no tags published yet it reports up to date with a note |

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
| `pg_dump` is compatible | the Maintenance tab shows a *"Backups cannot run on this host"* banner when it is not |
| The platform is supported | **Platform Lifecycle** grades this host |
| A maintenance window is open | so the restart does not page anyone |

That last one is worth doing properly: a
[maintenance window](Maintenance-Windows) stops polling **and silences
alerts** for the devices it covers (alerts already open stay open and resolve
normally afterwards) — but the Polaris host restarting is
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
| A new nginx block never arrives (systemd split-role install) | a known problem: the update cannot currently rewrite nginx there. Add the block by hand — see the [Repository](Server-Settings#repository) section for the one that matters today |

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
