# Business rule 134 — full narrative

> Written 2026-10-26 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 134](#rule-134) — An open alert follows its device's rename; a cleared alert keeps the name it fired under

<a id="rule-134"></a>

## Rule 134 — An open alert follows its device's rename; a cleared alert keeps the name it fired under

### What happened

2026-10-26, from the operator: a FortiGate was renamed in FortiManager and on the gate itself
while it was offline. The rename came in as a hostname conflict, the operator accepted it, and
the device page showed the new name — but the active "FortiGate Asset down" alert still read
`SIEBOLDT-61F-1 — SIEBOLDT-61F-1 is down`, the name the gate no longer had.

### Why it happened

A Notification snapshots its device's name at fire time, three times over: `assetHostname`
(what every alert list renders as the subject), the rendered `message` (`{asset} is down`), and
`templateCtx` (the token map reminders and escalations render from at T+delay). The snapshot is
deliberate and stays: a cleared alert is history and must name the device as it was, and an alert
outlives a deleted device (`nocDashboardService → getRecentAlerts` says so). Nothing ever
revisited an OPEN alert when its device was renamed. And a down alert on a device that stays down
lasts as long as the outage, so the stale name is in front of the operator for the whole of it.

### The decision

When an Asset's hostname changes, the device's **uncleared** alerts whose `assetHostname` is still
the old name are rewritten to the new one: `assetHostname`, every whole-word occurrence of the old
name in `message`, and the same in every string value of `templateCtx`.

- **Where it hooks.** The `src/db.ts` extension, on `asset.update` and `asset.upsert` writes that
  stage `hostname`: `hostnameBeforeWrite()` reads the row's name before the write (an indexed point
  read, only for writes staging `hostname` — discovery cadence, never the monitor hot paths), and
  `fireAlertRenameFollow()` calls `alertRenameService → followAssetRename()` fire-and-forget once
  the write lands and the name actually differs. In the extension because a rename arrives through
  discovery projection, an accepted conflict (`conflictResolutionService`), the asset editor and
  merges alike; none of them has to know. `updateMany` is not hooked — no writer stages `hostname`
  through it (the same re-verification as `enforceOperatorOverrides`).
- **What is left alone.** Cleared alerts — history keeps the fire-time name. An alert whose subject
  is not the device: a subnet or automation fold (rule 75) carries the device as its leading
  `assetId` but names the subnet or the automation in `assetHostname`, and the exact match on the
  old name is what tells them apart. Its member labels and host list keep the fire-time names.
- **Whole words only.** `GATE-1` inside `GATE-10`, `SITE-GATE-1` or `GATE-1.corp` is a different
  device; a trailing `.` that ends a sentence is punctuation. A custom message that names the
  device in some other form (lower-cased, an FQDN) is not rewritten.
- **No Event.** The rename itself is the audited action; this follows from it.

Pinned by `tests/unit/alertRenameService.test.ts` (the whole-word replacement and the ctx walk) and
`tests/integration/alertRenameFollow.test.ts` (update and upsert through the extension; cleared and
fold alerts untouched).
