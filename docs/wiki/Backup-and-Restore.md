# Backup and restore

**Server Settings → Maintenance.** Manual backup, a schedule, backup history,
and restore.

> **A backup you cannot restore is not a backup** ([rule 20c](Business-Rules#rule-20)).
> Take one manual backup immediately after installing and confirm it succeeds.
> The two failure modes below both hide behind a single generic message, and both
> present for the first time during an upgrade if you do not look earlier.

---

## How it works

- Backup and restore are **streamed end to end** — no whole-dump buffering.
- Restore is wrapped in TimescaleDB's **pre-restore / post-restore** calls.
- Filenames embed the **Polaris version**, so a backup always names the build
  that produced it.
- **A failed pre-update backup aborts the update by default.**

Set the automatic cadence on the same tab. History lists what exists.

---

## What is in a backup

The database: address space, assets, sources, samples and rollups, automations,
alerts, roles, credentials, integration configuration, settings.

Two things to understand about that:

- **Secrets are in there, sealed.** Their key is `POLARIS_SECRET_KEY` from
  `.env`, which is **not** in the database dump. **A backup without that key
  restores an install whose every stored secret is unreadable.** Back the key up
  separately.
- **If [directory sync](Address-Book#directory-synced-contacts) is enabled, your
  employee roster is in every backup** — names, addresses, titles, departments,
  phone numbers. That is stated where you enable it, and it is worth
  re-considering at backup-retention time.
- **Firmware images are not in it.** The [Repository](Server-Settings#repository)
  keeps them on the host under `data/firmware`, beside the agent binaries in
  `data/agents`; the database holds only their records. A restore onto a new
  host brings the rows back with a *File missing* flag until the images are
  copied over or uploaded again.

---

## The two failure modes

Both produced the same sentence — *"Database backup failed — see the server
log"* — with the real cause only in the container or service log.

### 1. A `pg_dump` older than the server

`pg_dump` **refuses** a server newer than itself ([rule 47](Business-Rules#rule-47)).

Polaris resolves the client by reading the server's major version, looking for a
versioned client directory for that major, and falling back to `PATH` only when
nothing versioned exists — then runs `--version` on whatever it picked and
compares majors. A **newer** client is accepted; an older one never is.

The refusal names **both versions, the path, and the fix** as the error itself,
never behind "see the server log".

> **Presence is not compatibility**, and `alternatives --display` reports its own
> bookkeeping rather than the file on disk. The host most likely to have no
> `psql` on `PATH` at all is the one that just removed a distro's old PostgreSQL
> package without resetting alternatives.

The Maintenance tab shows the **resolved** tools and their compatibility.

### 2. An untranslated `sslmode`

`DATABASE_URL` is a **driver** URL. node-postgres accepts `no-verify`; libpq —
which `pg_dump` and `psql` read from `PGSSLMODE` — **exits 1** on it
([rule 51](Business-Rules#rule-51)).

Polaris translates: `no-verify` → `require` (the same posture, since only
`verify-ca` and `verify-full` validate the chain), and **refuses an unrecognised
value rather than dropping it** — omitting it lets libpq fall back to `prefer`
and silently downgrades an operator who asked for TLS.

The setup wizard is the producer: ticking **"Allow self-signed certificate"**
writes `sslmode=no-verify`, and that is correct — the URL is for the driver.

> **Structurally this is a remote-database and container failure.** The scripted
> RHEL and Ubuntu installs dump as the local `postgres` user over a unix socket
> and build no URL at all — so **a green scripted install proves nothing about
> it.** If you run Docker, podman, Unraid, or a managed database, test a backup
> explicitly.

The two rules are halves of one thing: 47 says the client binary must be able to
work against the server; 51 says the connection parameters handed to it must be
in that client's own vocabulary. **Neither is checked by the other**, and both
failed for months behind the same sentence.

---

## Restoring

Restore from the same tab. It takes the same connection overlay, so a broken
`sslmode` breaks restore too.

Because restore is wrapped in TimescaleDB's pre/post-restore calls, the target
install **must have the extension**. An install that came up without it has a
wrong disk forecast **and an unrehearsed restore path** from the first byte
([rule 52](Business-Rules#rule-52)).

### Restoring onto a different host

1. Install Polaris at the **same or a newer** version.
2. **Copy `POLARIS_SECRET_KEY` across**, or every stored secret is unreadable.
3. Restore the dump.
4. Re-check integrations and credentials before enabling discovery.

---

## Encrypted backups

Encrypted backups are versioned by an 8-byte magic header. The format that
predates the project's rename is **no longer recognised** — an install carrying
those migrates by dump-and-reinstall, since a plain dump carries cleanly.

---

## A sensible posture

| | |
|---|---|
| Schedule | on, at a cadence matched to how much change you can afford to lose |
| Pre-update backup | leave the abort-on-failure default **on** |
| `POLARIS_SECRET_KEY` | in your password manager **and** your backup, separately from the dump |
| Rehearsal | restore to a scratch install at least once, and again after any PostgreSQL major upgrade |
| Retention | remember what directory sync puts in these files |
