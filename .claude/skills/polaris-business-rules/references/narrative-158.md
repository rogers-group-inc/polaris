# Business rule 158 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 158](#rule-158) — Nothing Polaris writes grows without a limit: history has a period, and a row that says nothing is removed

## Rule 158 — Nothing Polaris writes grows without a limit: history has a period, and a row that says nothing is removed

**How it was found.** The 2026-11-11 orphan audit asked what is left behind with no way to remove it. One whole class of answers was not "left behind by a delete" at all but "never deleted by anything": tables with no `delete` or `deleteMany` anywhere in `src/` and no retention job. The sample hypertables age out on tiered retention, Events on the operator's period, completed script runs after 90 days. These did not, and the operator's instruction on reading the list was that the growth had to be dealt with, not just catalogued.

**The five prunes and the two sweeps** (`services/historyRetentionService.ts`, run daily by `jobs/pruneHistory.ts`):

*Alert history.* `Notification` rows were soft-cleared and kept for the life of the install, with their `NotificationDelivery` rows; `QuietTimeSummary` rows likewise, though the UI only ever lists the newest hundred. The decision here was the operator's (2026-11-11), from three options: a setting defaulting to 365 days, a setting defaulting to "keep forever", or reusing the Event retention period. **A setting, default 365 days**, was chosen — one year matches the daily-sample tier, so an alert and the chart that explains it expire together, and a default that actually prunes means the fix reaches existing installs without anyone having to find a switch. `0` keeps everything. Two guards matter more than the number: only an alert that has **cleared** is ever history (an alert raised two years ago and still open is untouched), and the clock starts at `clearedAt`, not at the trigger, so a long-running incident is kept a full period after it ends. The minimum non-zero period is 30 days, because below that "what happened last month" has no answer. Shortening the period deletes history at the next run, so that change is written to Events at warning; each run that deletes alerts writes `alert_history.pruned` so "where did last year's alerts go" has an answer on the record.

*Automation state.* `NotificationRuleState` holds one row per rule × device × dimension. Every sweep in the evaluator that retires a row sets it to `clear`; only a whole-rule event (delete, trigger edit, regroup) ever deleted one. So rows for deleted devices, removed ports, retired path checks and unpinned mounts stayed forever — and `evaluateThresholdRule` loads **every** state row of a rule on every 60-second tick. On a 2000-asset fleet with a per-interface or per-core automation this is the one item in the audit with a real and growing cost on a hot path. A row that is `clear`, links no alert, holds no pending or recovery timer, no half-counted poll run and no band bookkeeping is indistinguishable from no row: the engine upserts one the moment a condition is next met. Such a row is deleted once it has gone a week unwritten. The predicate is exported (`idleRuleStateWhere`) and pinned arm by arm, and it is re-asserted on the delete itself, so a row the engine moved to `pending` between the read and the write survives. Alternatives rejected: deleting on transition to `clear` inside the evaluator (dozens of write sites, on the hot path, and a row that flaps would be created and destroyed every tick), and pruning by "the device no longer exists" (misses removed ports and retired checks, which are most of them).

*Discovery runs.* The audit listed `DiscoveryRun` as never deleted, which is true, and assumed it grew per run, which is not: the table is unique on `integrationId` and each run reuses its integration's row. The first version of this prune deleted finished runs after 30 days and its test failed on the unique constraint — which is how the assumption was caught. The table's real leftover is a finished row whose integration has been deleted (the column has no foreign key), so that is what is pruned. A queued or running row is never touched: `discoveryRunReaper` settles those, and the backup-restore guard counts them.

*Sightings.* `AssetFortigateSighting` had no delete at all. Quarantine fan-out already ignores a sighting older than `quarantine.sightingMaxAgeDays` (default 180), but `syncEndpointDependencyEdges` reads them with no age filter and the Firewall Sightings panel kept showing them. The same setting is now the retention: what quarantine no longer trusts is deleted. `0` means "forever" for quarantine and therefore here.

*Discovery scan runs.* `NetworkScanRun` rows carry every hit of every run. Finished runs are deleted after 90 days — except the newest run of each Discovery, which its list row shows as the last run however old it is.

*Hidden regions and tag provenance.* Two references that outlive what they name, with no foreign key and no sweep: ids of deleted map regions in `User.hiddenMapRegionIds` (the client re-saved the whole list on every toggle, and a deleted region has no eye to click), and `TagAutoAssignment` rows whose tag was deleted (the reconcile only walks tags that still exist).

**Bounded by construction.** Every prune deletes in id-slices of 2000, at most 25 per table per run, with the predicate re-asserted on the delete. The first run on an install with years of alert history therefore removes at most 50 000 alerts and finishes the backlog over a few days, instead of one enormous transaction holding locks on the alerts table while the engine is trying to write to it. At steady state a 2000-asset fleet's daily run is a handful of small deletes. Cutoffs are computed in Node and passed as parameters — no `now()` in SQL (the naive-UTC trap).

**Each prune stands alone.** `pruneHistory` runs them in sequence and collects failures; one that throws is reported and the rest still run, then the job throws so the failure is logged and counted. A retention job that stops at its first error is how a table quietly starts growing again.

**Where the setting lives.** Alert History is a field on the Events page's Settings → Retention tab, beside the Event retention it resembles, served and saved through the same `GET` / `PUT /events/retention-settings` so the dialog makes one call. It is a separate `Setting` row (`alertHistoryRetention`): Events are pruned hourly with an archive step, alerts daily without one. The field is optional on the `PUT`, so an older client still saves the Event settings. A blank field is refused: a cleared number input is `NaN` in the browser and `null` on the wire, `Number(null)` is `0`, and `0` is the one value that turns pruning off — `normalizeAlertHistoryDays` accepts only a number or a non-empty numeric string.

**What is deliberately not pruned.** Resolved `Conflict` rows: a rejected conflict is the record that stops the same finding being raised again (rule 139), so deleting it re-opens it. The subnet archive: it was designed as "not a retention entity", and whether it gains a delete is the operator's call, tracked in `docs/ORPHAN-AUDIT-LEDGER.md`. `TopologyLayout` rows for retired views are left to the topology work in flight.

### Rule 158(a) — a backup file is a backup whether or not the history names it

**How it was found.** The same audit, looking at what Polaris leaves on disk. Backups are files in `data/backups`; the Maintenance tab's Backup History is drawn from a `backup_history` Setting row, written after each dump and capped at 50 entries. The row was treated as the list of backups. It is not: it is an index, and three ordinary things leave a file the index does not name.

- **The cap.** The 51st backup pushed the oldest entry out. Its file stayed. A manual or pre-update backup is never pruned by anything, so on an install that updates monthly and takes the odd manual backup the directory outgrew the index within a few years; scheduled backups prune themselves by reading the same index, so one that fell off the end was never pruned either.
- **A history write that failed.** By design a failed index write does not fail the backup — the file is good. It was also, from then on, invisible.
- **A restore.** Restoring an older backup replaces every table, the Setting row included, with the one inside the dump. Every backup taken since — including the pre-restore one an operator would most want — lost its entry in the moment it mattered.

An unnamed file could not be seen, downloaded or deleted from the UI; only a shell on the host could reach it. The tab also drew just the newest 20 entries of the 50, so entries 21–50 were equally out of reach.

**What it does.** `listBackups` returns the history plus every file in `BACKUP_DIR` that has no entry and whose name is one `createBackup` mints (`bk-<ms>`, `bk-pre-update-<ms>`, `bk-scheduled-<ms>`), flagged `untracked`. Kind comes from the name, the creation time from the timestamp in it, the size from the file, and "encrypted" from the file's own magic header. What cannot be recovered is the original download filename and the Polaris version in it, so the name is derived and the tab badges the row **Found on disk**. `getBackupRecord` and `deleteBackup` resolve such a file the same way, so Download and Delete work on it; delete still writes its Event. The tab lists every backup in a scrolling table. The cap is raised to 500 so that the index keeps the real filename and version for far longer; correctness no longer depends on it.

**The edges.** A file modified in the last two minutes is skipped: a dump has a file before it has an entry, and listing it would offer a download of half a backup. Only minted names are considered, so a temp file, a restore upload or anything an operator put in the directory is neither listed nor deletable through the API — `deleteBackup` on any other name is still a 404. Scheduled-backup pruning reads `listBackups`, so an untracked scheduled backup now counts toward the retain count and is pruned in turn; manual and pre-update backups are still never pruned automatically. That is deliberate — deleting a backup nobody asked to delete is a different decision from showing it.

**Not covered.** Off-host copies. `copyBackupOffHost` pushes each scheduled backup to an SFTP/SCP target and nothing ever removes one there. Polaris would need delete rights on a server whose purpose is to be the copy that survives Polaris; that is an operator decision and is open in `docs/ORPHAN-AUDIT-LEDGER.md`.

### Rule 158(b) — the firmware repository holds no file without a row and no row without bytes

**How it was found.** Firmware images are bytes in `data/firmware/<id>.out` and a `FirmwareImage` row naming them. An upload lands in `.incoming`, is registered (row inserted with `storagePath: "pending"`, file renamed to `<id>.out`, path written), and every failure path the code can see cleans up after itself. The ones it cannot see are a process that dies or a disk that refuses:

- an **image file no row points at** — `deleteImage` removes the row and then the file, and logs a warning if the `rm` fails; a database restored from before an upload forgets the row and keeps the file;
- an **upload abandoned in `.incoming`** — the process restarted mid-upload, or died between multer finishing and the route discarding a refused upload;
- a **row whose bytes never landed** — the process died between the insert and the rename. This one is visible, as an image flagged missing, and as the platform's primary it is what a flash would be offered.

Images are up to 300 MiB each, and nothing in the Repository tab can reach the first two.

**What it does.** `firmwareRepositoryService.sweepFirmwareFiles`, called from the daily `pruneHistory` pass, removes all three. A `<uuid>.out` with no row is removed once it is an hour old; a file in `.incoming` once it is a day old (a slow upload of a large image over a poor link is not a leftover); a `pending` row once it is an hour old. The rows are read before the directory is, so a file registered between the two reads is younger than the grace period; if the rows cannot be read the sweep throws and deletes nothing. Only names the service mints are candidates in `data/firmware` — an image an operator copied there by hand under its vendor filename is left alone.

**Deployment shapes.** The sweep runs in the web / all role, which is the role that takes uploads; every role on a host shares the state directory. On an HA standby the directory is not replicated, so the standby has rows and no files — the sweep only ever removes a file with no row or a row that never had a file, never a row whose file is missing, so it cannot damage a standby. The cost is one `readdir` and one single-column read of a table that holds two rows per platform, once a day, at any fleet size.

### Rule 158(c) — a process's log config goes with its pin

**How it was found.** Pinning a process on an agent host lets an operator set where its log is: a source and, for a file, a path glob. The glob is privileged input — the agent reads that path as a privileged user — so setting or changing one needs Agent Deploy and passes a shape check (rule 107). The config is a row in `AssetProcessConfig`, keyed by asset and process name, written by upsert and by nothing else. Unpinning the process removed the name from `Asset.monitoredProcesses` and left the row. It was invisible from then on (the agent is only sent configs for pinned names, and the UI only shows a pinned process's config), and it was not gone: pin the same process again, a month later, and the old glob was back in force — delivered to the agent on the say-so of whoever re-pinned it, who needs only `assets:write`, not Agent Deploy.

**What it does.** An operator's unpin deletes the config in the same request. Unpins also happen without an operator — a discovery rule that stopped matching, a mass-pin run — and those can flap, so they are not treated as a decision: the daily retention pass removes a config whose process is not pinned on its asset only once the row has been untouched for seven days (`PROCESS_CONFIG_UNPINNED_DAYS`). A config whose asset no longer exists goes in the same pass. The sweep reads through Prisma rather than one raw `DELETE … USING`, because `updatedAt` is a naive-UTC column and a raw comparison against a bound timestamp reads it in the session's time zone.

### Rule 158(d) — an archive entry is removed by an operator, never by age

**How it was found.** Archiving a network (rule 41) moves it and its reservations into `ArchivedSubnet` / `ArchivedReservation` so the address space is free and the old state can still be reviewed. Nothing could ever remove an entry. A site that swapped a firewall three times kept three full copies of every network behind it; a network archived by mistake and recreated left its copy for good.

**The decision.** Defaulted by the implementer (C-D2 in the ledger) on the operator's stated preference through this audit: a visible, operator-decided removal over a silent automatic one. The archive is a review record with no natural expiry — the day someone asks "what was on that range before the replacement" may be years out — so it gets a Delete, not a retention period.

**What it does.** `DELETE /subnets/archived/:id` at `subnets:fullwrite`, the level that archives. It deletes the entry and its archived reservations and writes `subnet.archive_deleted` at warning, carrying the CIDR, the block, the serial and the reservation count, so the Event outlives the record. It is refused with 409 while a PENDING chassis-replacement conflict points at the entry: that conflict's comparison and its Accept both read the archived reservations, and deleting them would leave a conflict that can only be rejected. A resolved conflict is a frozen snapshot and holds nothing.

**Not done: a screen for it.** The archive has no page in the UI at all — the two reads and now the delete are API-only. So this makes an archive entry removable, but not yet "through the Polaris UI" in the audit's sense. A list-and-review surface for archived networks is a new UI pattern and goes through the design-first rule; it is open in the ledger.

Pinned by `tests/unit/historyRetentionService.test.ts` and `tests/integration/historyRetention.test.ts`; 158(a) by `tests/unit/backupUntracked.test.ts`, 158(b) by `tests/unit/firmwareFileSweep.test.ts`, 158(c) by the "158(c)" cases in `tests/integration/historyRetention.test.ts`, 158(d) by the delete cases in `tests/integration/subnetArchive.test.ts`.

### Rule 158(e) — directory contacts whose integration is gone

**How it was found.** Audit row B.11, listed as suspected and confirmed by reading the delete path. `DirectoryContactSource.integrationId` deliberately has no foreign key, so the integration delete purges the directory-synced contacts itself, before the row goes. That purge is wrapped in a catch that writes an error Event and lets the delete continue — rightly, since a contacts problem should not make an integration undeletable. But when it did fail, the provenance rows went on naming an integration that no longer existed, and the employee roster they had put into the address book stayed there with nothing that would ever refresh it or take it away.

**What it does.** The daily history prune groups the provenance rows by integration, drops the ones whose integration still exists, and runs the ordinary purge for the rest. The purge keeps its own rules: a contact someone made by hand, or one another directory still vouches for, stays.

Pinned by the "rule 158(e)" case in `tests/integration/historyRetention.test.ts`.
