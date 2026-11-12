# Business rule 168 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 168](#rule-168) — Polaris keeps its server-local clock in the server timezone it is given, in every process, and leaves the host's clock alone

## Rule 168 — Polaris keeps its server-local clock in the server timezone it is given, in every process, and leaves the host's clock alone

**The finding (2026-11-11, CQ-T010).** Server Settings → Time & NTP stored five things — NTP enable, mode (NTP / SNTP / NTS), a server list, and a timezone override — and nothing read any of them except the settings routes themselves. The host's own time daemon kept the clock whatever the card said; the "Timezone Override" changed only how two timestamps on the Maintenance tab were drawn in the browser. Meanwhile every server-local time in Polaris — maintenance windows, quiet-time windows, scheduled reboots and firmware upgrades, the zone an alert email falls back to — was the PROCESS zone of each role (`Intl`'s resolved zone, which `userTimezoneService.serverTimeZone()` reads). An operator who set the override to fix "my maintenance window fires an hour off" got a card that looked saved and a window that still fired an hour off. The same day the Test Sync button was found to have always answered "Synchronized" with an invented offset; it was made a real SNTP / NTS-KE query (`utils/sntp.ts`), but the servers it tested were still applied to nothing.

**The decision (operator, 2026-11-12: "only keep the timezone override for this application").** The NTP servers, mode, enable flag and Test Sync are removed — Polaris is not the host's time service, and on a container or Unraid install it could not be. The timezone override stays and becomes real, for Polaris only: `serverSettingsService.applyProcessTimezone` assigns `process.env.TZ`, which Node re-reads for `Date`'s local getters and `Intl`'s resolved zone, so every existing server-local reader follows it with no change of its own. Every role applies it before its first job (`app.ts → startBackgroundJobs`) and re-reads it every 30 s, so a change saved on the web role reaches monitor / discovery / dash without a restart — a restart would have been the only alternative, and rule 99 forbids Polaris restarting itself in a container.

**Traps the shape avoids.** Deleting `TZ` does not put Node back on the host zone — it keeps the last assigned one — so clearing assigns the host zone captured at module load. An unknown `TZ` is not an error to Node: it silently becomes "Etc/Unknown", i.e. UTC, so a zone is checked with `isValidTimeZone` (can this build's ICU format in it?) before it is ever assigned, refused with a 400 on save, and read back as "no override" if the stored one stops being usable (a small-ICU image, a zone retired from tzdata). The database is unaffected: every Prisma DateTime is UTC and every raw-SQL clock comparison already writes `now() AT TIME ZONE 'UTC'` (the naive-UTC trap).

**What moves when it changes.** A wall-clock time saved as 22:00 means 22:00 in the new zone. That is the point — the windows are written in the operator's local clock — and the wiki says so beside the picker.

**Carrying data over.** Migration `20261112000200_server_timezone_setting` copies a non-empty `ntp.timezoneOverride` to `key: "timezone"` as `{ override }` and deletes the `ntp` row.

**Rejected.** Applying the settings to the host (a root helper writing chrony.conf and `timedatectl set-timezone`, like the nginx apply unit): systemd installs only, a container cannot change its host's clock, and a time daemon is the host administrator's to run. Labelling the card "not applied": honest, but leaves an override that does nothing. Restarting each role on a change: needless, and forbidden in a container (rule 99).
