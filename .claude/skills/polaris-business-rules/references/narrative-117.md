# Business rule 117 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 117](#rule-117) — The host keeps Polaris's secrets and privileges to the account and the peer they belong to

<a id="rule-117"></a>

## Rule 117 — The host keeps Polaris's secrets and privileges to the account and the peer they belong to

### Where it came from

The eighth and last phase of the follow-up to the 2026-10-11 whole-repository security scan: fourteen findings in the install, update and host layer (F165, F170, F220, F259, F196, F228, F217, F236, F240, F256, F195, F206, F221, F230). None was in a request handler. Each one let a local account, a network neighbour or the HA peer reach something only the Polaris account should:

- **The updater's polkit grant was root (F165).** `49-polaris.rules` allowed `org.freedesktop.systemd1.manage-units` for EVERY unit to the polaris user, and the updater used it to hand `systemd-run` a shell script it built itself. Anything running as polaris could `systemd-run` any command as root, at any moment, with no update involved.
- **One database password for every install (F170, F220).** The installers created the role with the literal password `polaris`, in a public repository, and passed it on psql's command line. **The `-nodb` installers took the URL on argv (F259)**, so its password sat in `ps` for the whole install. **`upgrade-node.sh` (F236)** passed the URL to pg_dump on argv, wrote the full dump to `/var/tmp` with the default umask, chowned it to the app user and left it there.
- **Backups were world-readable (F240, F256).** The units set no `UMask`, so `data/backups/` was 0755 and every dump 0644. The decrypted temp file a restore writes was too, and so was the copy the schedule makes to a remote path.
- **HA trust on first use (F196, F228, F217).** The file sync pulls root-executed files (units, sudoers, helpers) from the peer as root, and it accepted whatever host key answered first (`accept-new`). The forced-command wrapper let through anything that STARTED with `rsync --server --sender`, so the peer could add `--remove-source-files`, `--log-file=` or `--write-batch=`. Replication was `hostssl` with a self-signed certificate nobody verified.
- **The Windows agent's bearer was readable by Users (F195, F206).** `%ProgramData%` lets every local user create folders and read what is inside them. The installer wrote `agent.conf.tmp` before setting the ACL, so for a moment a pre-created folder owned by that user would hand them the bearer. On Windows `os.Chmod(0600)` only clears the read-only bit, so every enrollment rewrite inherited "Users: read".
- **The Unraid query tool ran mutations (F221, F230).** The read-only Query API modal refused a document only when it *started* with `mutation`. GraphQL ignores commas, and lets fragments come first. `, mutation { … }` or `fragment F on Query { … } mutation { … }` therefore ran with the stored API key, and left no Event.

### The decisions (approved 2026-10-13, all three recommendations)

1. **A fixed root unit instead of a root shell (option a).** The in-app updater now starts `polaris-update-sync.service`, a root oneshot whose only command is the root-owned `/usr/local/sbin/polaris-update-sync`. The polkit rule allows exactly two things: starting that unit, and start / stop / restart of `polaris.target` and the five polaris services. Transient units, `daemon-reload` and every other unit are no longer granted.
   - **What the helper checks.** It snapshots every input with `cp -P` into a root-only directory first, then validates and installs that copy. A symlink or a file swapped mid-run gets nowhere.
   - **App units and their HA drop-ins** pass an allow-list of directives. They need `User=polaris` exactly once and no `+` / `!` Exec prefix. Ambient capabilities may only be `CAP_NET_BIND_SERVICE`, and dependencies may only name polaris, network, database and nginx units.
   - **Sudoers** must pass `visudo -c` and grant only `polaris-nginx-apply`. Tmpfiles may only create the staging directory. The helper's own unit may hold only the fixed `ExecStart`.
   - **A refused file is not installed and the update carries on**, with the refusal logged.
   - **Existing hosts migrate on their next in-app update.** With no helper installed, the updater runs one bootstrap through the OLD grant. It installs the helper, its unit and the new polkit rule, and that rule withdraws the grant, so the bootstrap cannot run twice.
   - **Residual trust — as first shipped, and wrong.** The helper installed the root helpers (`polaris-nginx-apply`, `polaris-ha-role`, itself, the polkit rule) from the tree the polaris user writes, and the narrative claimed that left no root ON DEMAND because it took an update. It did not: the polaris user may start the unit at any moment, so writing a helper and starting the unit was root on demand. Fixed the same day as rule 117(g), below.
2. **New installs get a random database password; existing ones are told, not rotated (option a).**
   - **Generated by default.** `setup-rhel.sh` / `setup-ubuntu.sh` generate `openssl rand -hex 24` unless `POLARIS_DB_PASSWORD` is set. They feed CREATE / ALTER USER to psql on stdin under `SET password_encryption = 'scram-sha-256'`, and write `scram-sha-256` pg_hba lines. They ALTER an existing role only when `.env` is absent; a re-run on a working install never changes its password.
   - **The `-nodb` installers** take `POLARIS_DATABASE_URL` from the environment or a hidden prompt. `--db-url` still works, with a warning. Every psql call gets a password-free URL plus `PGPASSWORD`.
   - **`upgrade-node.sh`** dumps into a root-only `/var/backups/polaris` (0700, file 0600) through `PGPASSWORD`, and removes the dump once the upgrade succeeds unless `--keep-backup` is given.
   - **No automatic rotation.** A half-finished rotation locks the app out of its own database, so an install still on `polaris`/`polaris` gets a production-only warning capacity reason, `db_default_password` (`databaseUsesPublicDefaultPassword`), pointing at docs/UPGRADING.md → "Rotate the database password".
3. **HA: pin the peer, allow-list the wrapper, verify replication on new clusters (option a).**
   - **The wrapper allow-list.** `polaris-ha-ssh-wrapper.sh` splits the command with globbing off and allows only the protocol short-option cluster, `--delete*` / `--delay-updates` / `--numeric-ids`, `--partial-dir` / `--bwlimit`, `.` and absolute paths. It then runs `exec "${ARGS[@]}"`, never a shell string.
   - **Pinned host keys.** The sync uses `StrictHostKeyChecking=yes`, and `polaris-ha-role pin-peer` writes known_hosts. It pins only a key whose SHA256 fingerprint the operator types in, or one listed in `peer_host_fingerprints`, which the enrollment bundle carries from what the peer reported when it enrolled (`peerHostFingerprints`). When nothing is pinned, the sync tries the recorded fingerprints and otherwise refuses, with the command to run. Setup prints this node's fingerprints.
   - **Replication certificates.** A NEW cluster's PostgreSQL serves the member's etcd certificate (cluster CA, serverAuth, SAN = cluster address), and Patroni's replication and rewind connections use `sslmode=verify-full`. An EXISTING cluster keeps working (`require`, encrypted but unverified) until the operator opts in through the docs/HA.md runbook. Setup probes the peer and falls back to `require` with a warning if the peer still serves the self-signed certificate.

The two smaller ones:

- **Private files (`utils/privateFiles.ts`).** `ensurePrivateDir` creates or tightens the backup directory to 0700, and once per process the files already in it to 0600. Every backup, ciphertext and decrypted restore temp file opens with `PRIVATE_FILE_MODE`, and the scheduled remote copy is chmodded after the copy.
- **Agent ACLs.** The Windows installer takes ownership of `%ProgramData%\Polaris` and `Polaris\agent` for Administrators and sets a protected SYSTEM + Administrators DACL BEFORE it writes anything. The agent (0.26.1) sets a protected DACL on its tempfile before writing the bearer — SYSTEM, Administrators and OWNER RIGHTS, so a hand-run dev agent can still read its own file. It also re-protects the canonical folder.
- **Unraid.** `utils/graphqlOperations.ts` lexes the document the way GraphQL does: it skips ignored tokens, strings and block strings, tracks depth, and treats an anonymous `{` as a query. `proxyQuery` refuses unless every top-level operation is a query, and every run writes an `integration.query` Event.

### When changing this

- **A new directive in a shipped polaris unit** must be added to `ALLOWED_KEYS` in `deploy/scripts/polaris-update-sync.sh`, or the next update refuses that unit and keeps the old one. `tests/unit/securityPhase8.test.ts` runs every shipped unit through the validator to catch this.
- **A new root-owned artifact the updater must sync** goes in the helper, `deploy/update-linux.sh` and the HA sync list in `polaris-ha-role.sh`. Never add it to an inline script in `updateService.ts`.
- **A new HA rsync pull with a new flag** needs that flag added to the wrapper's allow-list.
- **Never** widen the polkit rule back to an unconditional `manage-units`.

### 117(g) — root helpers are held for an administrator (2026-10-13, re-scan F2)

The re-scan after phase 8 confirmed (3/3) what the "residual trust" note had talked itself out of. The polaris user writes `/opt/polaris` and the polkit rule lets it start `polaris-update-sync.service` with no update in progress; the unit then installed `deploy/scripts/polaris-nginx-apply.sh` as `/usr/local/sbin/polaris-nginx-apply` — a script sudoers lets polaris run as root — with no validation. The same unit also reinstalled itself and the polkit rule from the tree, either of which hands over root on the next start. A gate on "an update is in progress" was considered and rejected: the in-app update is driven by the polaris user, so any signal it raises a compromised polaris user can raise too. Only a party outside that account can vouch for root code.

Decision (owner, 2026-10-13, option A of three — B was a signed release manifest, C accepting and correcting the docs): the unit never installs a root helper. A changed one is held — listed with its sha256 in `/var/lib/polaris-update-sync/pending`, surfaced as the `root_helpers_pending` warning on the Maintenance tab, logged under `polaris-updater` — and the rest of the update applies normally. `sudo polaris-update-sync --apply-helpers` (the installed, trusted copy) shows each diff against what is installed and installs what the administrator confirms; `deploy/update-linux.sh`, already an administrator acting as root, runs it with `--yes`. The held set is every file root executes or that decides who may: the nginx apply wrapper, the update helper, the polkit rule, and on HA nodes the reconciler, its root unit and timer, the SSH forced command and Patroni's drop-in. Files whose content the helper CAN check — the app units, their HA drop-ins, sudoers, tmpfiles and the update unit itself — still sync automatically. On HA, the standby pulls the primary's INSTALLED copies root-to-root, so an approval on the primary reaches both.

The cost is one shell command on the rare release that changes a root helper. A signed manifest (option B) could automate it later; it needs a release signing key and process, which a FOSS project installed by strangers should adopt deliberately rather than as a side effect of a fix.
