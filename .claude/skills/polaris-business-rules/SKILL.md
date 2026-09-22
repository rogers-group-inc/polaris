---
name: polaris-business-rules
description: "The 79 numbered Polaris business rules — each invariant and the incident that forced it. Load BEFORE changing any behavior around subnets/CIDR overlap, reservations, DHCP leases or bindings, discovery writes to assets, lastSeen, Last Seen Switch/AP/Firewall (upstream placement of a device, including the gate that owns its subnet), monitorStatus (up/down/warning/recovering/passive), the FortiLink / CAPWAP controller-link state of a managed FortiSwitch or FortiAP, dependency suppression, maintenance windows and the holds Polaris takes on an asset for downtime it is causing itself (an agent upgrade, reinstall or uninstall that silences the device it is working on), automations/alerts/notifications/escalation/acknowledge/reset, reminders and their quiet time, packet loss, secrets at rest, which install is allowed to claim a database and what a refusal to start on an active-instance heartbeat means (a container or unit that will not come up after an upgrade, 'another host holds a fresh active-instance heartbeat', two instances on one database), backups and the database sslmode handed to pg_dump/psql, whether TimescaleDB is required and what its absence costs, retention and compression, SSH host keys, login restriction, a user changing their own password and what that does to their other sessions, agent upgrade credentials, security response headers (CSP, HSTS) and what an unmatched route answers, what a discovery run reports about devices it skipped or could not read, RBAC grant levels, tags/regions, placeholder MACs, Windows OS names, logos, backups and the database sslmode handed to pg_dump/psql, whether TimescaleDB is required and what its absence costs, retention and compression, SSH host keys, login restriction, a user changing their own password and what that does to their other sessions, the password complexity policy and forcing a non-conforming password to be changed at login, passkeys / WebAuthn (whether one may sign in on its own or only as a second factor, and what it is bound to), agent upgrade credentials, security response headers (CSP, HSTS) and what an unmatched route answers, what a discovery run reports about devices it skipped or could not read, RBAC grant levels, tags/regions, placeholder MACs, Windows OS names, logos; whenever code, a commit or a doc cites 'business rule N' / 'rule N'; and when asked to add or retire a rule."user-invocable: false
---

# Polaris business rules

Every rule records a decision **and** the incident or constraint that forced it. The
reasoning is the point, so nothing in the narrative files is a summary — read the full
rule before changing behavior it governs, and never paraphrase a rule when quoting it.

> **Rule numbers are a stable citation key** (commits, code comments and the other docs cite "business rule 23"). Never renumber; retire a rule in place and give a new one the next free number.

(84 is the next free number — 83 is this file's own newest rule, and **81 is a deliberate
gap**, published then reverted wholesale the same week. **75 is NOT free** — it is claimed by an in-flight worktree that
has not merged yet. 77 and 78 were both in that position and landed on 2026-09-21. `main` alone will tell you none of that: it is exactly the collision the
note under "add or retire a rule" warns about, and on 2026-09-21 two branches both picked 77
because each checked only `main`. Before citing a number, check every branch, not just `main`:
`for b in $(git branch --list 'worktree-*' --format='%(refname:short)'); do echo "$b: $(git show $b:.claude/skills/polaris-business-rules/references/invariants-30-43.md | grep -oE '^[0-9]+\.' | tail -3 | tr '\n' ' ')"; done`)

## How to read

| You are about to… | Read |
|---|---|
| touch subnets, blocks, reservations, CIDR math, DHCP leases | rules 1–7 and 11 below; 20a, 23, 26, 41, 42, 69, 77 in the references |
| touch what the IP panel's Status column SAYS about an address, a FortiGate VIP or virtual server, `vipInfo`, or whether an address can be reserved at all | 23 first (the two-facts split), then 77 (which adds the third and composes the pill) |
| touch Asset status, `monitored`, `lastSeen`, `acquiredAt` | rules 9–10 below; 12, 16, 36, 37 |
| touch probes, `monitorStatus`, packet loss, dependency suppression | 29, 30, 36, 38, 55, 59, 67, 78 |
| touch automations, alerts, delivery, acknowledge, reset, escalation, reminders | 18, 19, 24, 25, 32, 39, 44, 46, 56, 58, 59, 60, 66, 67, 78 |
| touch what an alert says about a device that is dependency-down, or who may alert about one | 16 and 37 (the silence), then 78 (the one opt-out from it) |
| touch what an alert EMAIL says — the timezone a timestamp is drawn in, who is on the To line, whether one send may become two, the Acknowledge button | 25 first (it is the one that forbids splitting a send), then 56 and 60 |
| touch discovery writes (assets, descriptions, locations, ARP, MACs) | 13, 14, 15, 17, 22, 26, 28, 35, 40, 41, 45, 55, 79, 83 |
| touch a serial number — what identifies a managed device, which controller owns its record, or two records carrying one serial | 41 (the chassis identity it builds on), then 83 |
| touch how a discovery run reports what it did or did not read — skipped/offline/unread devices, run counters, a device whose data looks stale | 53 |
| touch secrets, backups, SSH, login gating, permission levels | 20b–c, 21, 31, 33, 34, 43, 47, 51, 63 |
| touch a user's own credential — changing a password, session rotation, what a credential change does to that user's other sessions | 61, 62 |
| touch the password complexity bar, or what happens to an existing password that no longer meets it | 63 |
| touch passkeys / WebAuthn — registration, passwordless sign-in, the passkey second factor, what a credential is bound to | 64 |
| touch the database install, the TimescaleDB extension, retention, compression or the capacity/disk forecast | 20c, 47, 51, 52 |
| touch Polaris Agent install, upgrade or its stored credential | 43, 49 |
| touch map regions, `region:` tags, or anything that strips `Asset.tags` | 54, 58 |
| touch a maintenance window, or any surface that REPORTS one — the schedule builder, the calendar, the Active Maintenance widget | 16, 73 |
| add or retire a rule | the numbering paragraph above; add the invariant to the right `invariants-*.md`, the narrative to the right `narrative-*.md`, and cite the number from code. **Never rename the reference files** — `invariants-30-43.md` / `narrative-36-43.md` keep their names whatever range they hold, since other skills and code link to them. **Re-check the next free number on `main` at merge time**: another worktree may have taken it while yours was open, and the branch merging second renumbers (the merge protocol says how) |

Reference files (all verbatim):

- [references/invariants-12-29.md](references/invariants-12-29.md) — the one-paragraph invariant for rules 12–29
- [references/invariants-30-43.md](references/invariants-30-43.md) — the one-paragraph invariant for rules 30–74 (the filename keeps its original range: the reference is cited from code and the other skills)
- [references/narrative-12-24.md](references/narrative-12-24.md) — full narrative, rules 12–24
- [references/narrative-25-35.md](references/narrative-25-35.md) — full narrative, rules 25–35
- [references/narrative-36-43.md](references/narrative-36-43.md) — full narrative, rules 36–43 (the filename is a stable citation key — see the numbering note)
- [references/narrative-44-48.md](references/narrative-44-48.md) — full narrative, rules 44–59 (split out 2026-09-09 when the 36–43 file passed 100 KB; the filename is a stable citation key)
- [references/narrative-60-64.md](references/narrative-60-64.md) — full narrative, rules 60–74 (the filename keeps its original range: it is a stable citation key. Split out 2026-09-15 when the 44–48 file reached the 1500-line ceiling)
- [references/narrative-78.md](references/narrative-78.md) — full narrative, rule 78 (split out 2026-09-21 when the 60-64 file reached the 1500-line ceiling; the filename is a stable citation key)
- [references/narrative-80.md](references/narrative-80.md) — full narrative, rule 80 (split out for the same reason, same day; the filename is a stable citation key)
- [references/narrative-82.md](references/narrative-82.md) — full narrative, rule 82 (written as its own file, the 60-64 file being at the ceiling; **81 is deliberately skipped** — it was published then reverted wholesale the same week, and a citation key that means two things is worse than a gap)
- [references/narrative-83.md](references/narrative-83.md) — full narrative, rule 83 (its own file for the same reason; the filename is a stable citation key)

Read the invariant first (it is the contract), then the narrative for the same number
before changing anything the invariant constrains.

## Rules 1–11 (one-line invariants, in full)

1. **No overlapping subnets** within the same block. Use `cidrContains()` / `cidrOverlaps()` from `src/utils/cidr.ts` before any subnet creation — and take the per-block advisory lock while you do it: create through `createSubnetRowChecked()` (single row) or `lockBlockForSubnetWrites(tx, blockId)` (batch) in `subnetService.ts`, never a bare `prisma.subnet.create`. A bare create re-opens the race described in rule 20a. Backed by a UNIQUE index on `(blockId, cidr)`.
2. **Subnet must be contained within its parent block** — enforced at service layer.
3. **No duplicate IP reservations** — one `active` reservation per IP per subnet (`@@unique([subnetId, ipAddress, status])`).
4. **Block/subnet deletion protection** — HTTP 409 if any `active` reservations exist.
5. **CIDR normalization** — Host bits zeroed on write (e.g., `10.1.1.5/24` → `10.1.1.0/24`).
6. **sourceType tracking** — All discovered reservations carry a `sourceType`; manual entries default to `manual`.
7. **Conflict detection** — Discovery values differing from an existing manual reservation create a `Conflict` record rather than overwriting.
8. **Event archival** — Events older than 7 days are pruned; syslog (CEF) and SFTP/SCP archival are configurable.
9. **Asset `acquiredAt` ≤ `lastSeen`** — Enforced on every write via `clampAcquiredToLastSeen` in `src/utils/assetInvariants.ts`. If a write would leave `acquiredAt` later than `lastSeen`, `acquiredAt` is clamped down to match. Existing rows are repaired by the `clampAssetAcquiredAt` startup job.
10. **Four statuses cannot be monitored: decommissioned / disabled / storage / quarantined** — `UNMONITORABLE_STATUSES` + `statusAllowsMonitoring` in `src/utils/assetInvariants.ts` is the list; enforcement is centralized in the Prisma extension in `src/db.ts` so every write path benefits, in **both directions**: `clampMonitoredForStatus` forces `monitored=false` + resets `consecutiveFailures` when a create/update/updateMany/upsert stages one of those statuses, and `enforceMonitorableStatus` catches the write that stages `monitored: true` with NO status by reading the row first (the shape of the operator toggle, the discovery monitored-sweep and bulk-monitor — without it every unmonitorable state was one `monitored: true` away from being polled again). `updateMany` narrows its WHERE instead of rewriting rows it can't resolve. **`maintenance` is deliberately NOT on the list** — a window pauses polling via `MONITOR_CANDIDATE_WHERE` while `monitored` keeps the operator's intent so it survives the window (business rule 16). `storage` and `quarantined` joined the list in 2026-08 with the automations-only-fire-on-monitored-assets cutover: a quarantined device is isolated at the FortiGate, so every probe fails BY DESIGN and a security action was producing an outage alert storm about the isolation working. Because quarantine is reversible, it **parks** the flag in `Asset.monitoredBeforeQuarantine` (mirroring `statusBeforeQuarantine`) and the release write restores status + `monitored` together — otherwise releasing a quarantine handed the device back to the network with nobody watching it. Otherwise still one-way: flipping status back to `active` does not auto-resume monitoring, re-enabling is operator-driven. The two operator-facing write paths (`PUT /assets/:id`, `POST /assets/bulk-monitor`) **refuse with a reason** rather than leaning on the silent clamp — a form that saves and comes back unticked reads as a bug. Existing rows are reconciled once by migration `20260827000000_monitorable_status_clamp` and swept every boot by `jobs/clampMonitoredForStatus.ts`.
11. **DNS-resolved reservations** — Any Asset with a primary `ipAddress` falling inside a known (non-deprecated) Subnet that has no existing active reservation gets an auto-created Reservation with `sourceType="dns_resolved"`, `createdBy="system:dns-resolved"`, carrying the asset's hostname (`hostname || dnsName`) and `macAddress` when available. Eligible asset statuses: `active`, `maintenance`, `storage`, `quarantined`. IPv4 only. Never pushes to FortiGates. Never raises Conflict rows — defers silently to authoritative source types. See `src/services/dnsResolvedReservationService.ts`.

## Rules 12–61 (index)

| # | Rule | Invariant | Narrative |
|---|---|---|---|
| 12 | `Asset.lastSeen` means verified network presence | invariants-12-29 | narrative-12-24 |
| 13 | SD-WAN monitoring is opt-in, read-only, FortiOS-only | invariants-12-29 | narrative-12-24 |
| 14 | Description sync is opt-in and Polaris-primary | invariants-12-29 | narrative-12-24 |
| 15 | Location codes ride device descriptions; notes are operator-only | invariants-12-29 | narrative-12-24 |
| 16 | Maintenance windows pause everything; status flips are scheduler-managed | invariants-12-29 | narrative-12-24 |
| 17 | ARP presence evidence for stale reservations; the sweep is opt-in | invariants-12-29 | narrative-12-24 |
| 18 | Automation precedence is same-trigger, most-specific-wins | invariants-12-29 | narrative-12-24 |
| 19 | Severity bands escalate one alert by value, each on its own clock | invariants-12-29 | narrative-12-24 |
| 20 | Subnet writes serialize per block; secrets are encrypted at rest; a backup you cannot restore is not a backup | invariants-12-29 | narrative-12-24 |
| 21 | SSH host-key verification is opt-in and fails closed | invariants-12-29 | narrative-12-24 |
| 22 | The Sources column is `location \|\| learnedLocation`, operator-ordered | invariants-12-29 | narrative-12-24 |
| 23 | Who owns an IP and how the gate hands it out are two facts, not one | invariants-12-29 | narrative-12-24 |
| 24 | Alert on the device's own alarm bit before inventing a threshold | invariants-12-29 | narrative-12-24 |
| 25 | An alert you can't acknowledge from where you read it isn't acknowledgeable; the acknowledger is a session | invariants-12-29 | narrative-25-35 |
| 26 | A generated MAC is a placeholder until the network proves otherwise | invariants-12-29 | narrative-25-35 |
| 27 | A logo is picked by theme; a name is text only when the picture doesn't say it | invariants-12-29 | narrative-25-35 |
| 28 | The Windows build is the authority; the product name is not | invariants-12-29 | narrative-25-35 |
| 29 | A miss taken while the device is DOWN is the outage, not the link; everything else counts | invariants-12-29 | narrative-25-35 |
| 30 | Confirmation is the configured cadence's job; ICMP only fills in the loss ratio | invariants-30-43 | narrative-25-35 |
| 31 | The login page is the way back in, so restricting it is opt-in and must refuse to lock you out | invariants-30-43 | narrative-25-35 |
| 32 | A reset condition starts as the trigger inverted and resolves where the alert lives | invariants-30-43 | narrative-25-35 |
| 33 | A device that answers is not a device that works; the check belongs to the VENDOR | invariants-30-43 | narrative-25-35 |
| 34 | An active scan finds things; a separate grant adds them | invariants-30-43 | narrative-25-35 |
| 35 | The GAL is a mirror, not a source of truth; Polaris only deletes what it wrote | invariants-30-43 | narrative-25-35 |
| 36 | The automation decides what "down" means; a device no automation covers is never judged | invariants-30-43 | narrative-36-43 |
| 37 | An automation only fires about a device Polaris is actually polling | invariants-30-43 | narrative-36-43 |
| 38 | A device behind a dark parent is not accused, and is not released on one packet | invariants-30-43 | narrative-36-43 |
| 39 | How a person wants to be reached is theirs, not the automation's | invariants-30-43 | narrative-36-43 |
| 40 | Two assets on one address is a conflict; one asset on a stale address is not | invariants-30-43 | narrative-36-43 |
| 41 | A subnet dies with its FortiGate; the chassis, not the name, says which gate | invariants-30-43 | narrative-36-43 |
| 42 | Some address space is not one network; the way to say so is to exclude it | invariants-30-43 | narrative-36-43 |
| 43 | A grant is only as narrow as the act it names | invariants-30-43 | narrative-36-43 |
| 44 | A quiet window withholds the reminder, not the alert, and the reminder that follows says how long | invariants-30-43 | narrative-44-48 |
| 45 | An address places a device only through the gate that owns it, and only a device nothing else can place | invariants-30-43 | narrative-44-48 |
| 46 | A device filter on an event automation filters the event's subject | invariants-30-43 | narrative-44-48 |
| 47 | A PostgreSQL client is chosen by the server's major and verified, never spawned by bare name | invariants-30-43 | narrative-44-48 |
| 48 | Nobody hands out authority they do not hold | invariants-30-43 | narrative-44-48 |
| 49 | An upgrade never refuses for want of a credential it can find itself, and never records one it has not proved | invariants-30-43 | narrative-44-48 |
| 50 | A response the app did not write is a response with the app's headers missing | invariants-30-43 | narrative-44-48 |
| 51 | A `DATABASE_URL` is a driver URL; its `sslmode` is translated into the libpq vocabulary, never copied | invariants-30-43 | narrative-44-48 |
| 52 | TimescaleDB is part of the install, not a tuning option | invariants-30-43 | narrative-44-48 |
| 53 | A device a run could not read keeps its old data, so it is named — never folded in with one the run skipped | invariants-30-43 | narrative-44-48 |
| 54 | A region tag dies when its name is retired, and only then | invariants-30-43 | narrative-44-48 |
| 55 | An address places a device behind a gate only when nothing has seen it, and every surface says which answer it got | invariants-30-43 | narrative-44-48 |
| 56 | What ignoring an alert costs is answered where the thing that costs it lives: the note by severity, the reminder by action | invariants-30-43 | narrative-44-48 |
| 57 | A sub-asset alerts only if the operator pinned it — the pin IS the statement of what may alert | invariants-30-43 | narrative-44-48 |
| 58 | A tag that names no region strands the ranking, so level routing abstains | invariants-30-43 | narrative-44-48 |
| 59 | The controller's view of its own link is a second opinion, and an unreadable controller has no view at all | invariants-30-43 | narrative-44-48 |
| 60 | A footer that tells the reader who else knows must never name a Bcc | invariants-30-43 | narrative-60-64 |
| 61 | Changing a credential ends every other session on it, and rotating your own must carry the CSRF token across | invariants-30-43 | narrative-60-64 |
| 62 | An install is identified by something it persists, never by the name the runtime handed the process | invariants-30-43 | narrative-60-64 |
| 63 | The complexity bar belongs to the operator, and a password that no longer meets it is replaced on the far side of the second factor | invariants-30-43 | narrative-60-64 |
| 64 | A passkey is bound to the origin that issued its challenge, the install decides what a passkey is for, and it never names an account that does not already exist | invariants-30-43 | narrative-60-64 |
| 65 | A delivery test is a specimen of the alert, not a rehearsal against live inventory | invariants-30-43 | narrative-60-64 |
| 66 | A measurement window may be counted in readings, and then the hold counts poll GROUPS | invariants-30-43 | narrative-60-64 |
| 67 | A missed response-time poll is the timeout it cost, and an outage resets the window | invariants-30-43 | narrative-60-64 |
| 68 | What Polaris ships and what the operator owns are two different kinds of MIB, and a profile is only ever an override | invariants-30-43 | narrative-60-64 |
| 69 | A reservation count is of addresses HELD; a release is history, and only a cascade counts it | invariants-30-43 | narrative-60-64 |
| 70 | Absence from a directory decommissions what the directory MANAGES, and only when the read was whole | invariants-30-43 | narrative-60-64 |
| 71 | A figure Polaris reports about itself accounts for itself, and a measurement whose mechanism broke says so instead of reading zero | invariants-30-43 | narrative-60-64 |
| 72 | A detection script asserts every prerequisite its remediation establishes, and a mode that establishes nothing refuses instead of reporting success | invariants-30-43 | narrative-60-64 |
| 73 | Planned downtime is reported as planned, and a scoped view of a window still reports the WHOLE window | invariants-30-43 | narrative-60-64 |
| 74 | A field Polaris writes onto a device is budgeted where the operator types it, and the budget is the DEVICE's | invariants-30-43 | narrative-60-64 |
| 76 | Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it | invariants-30-43 | narrative-60-64 |
| 77 | A VIP describes an address; it does not claim it — and the status says every fact it has | invariants-30-43 | narrative-60-64 |
| 78 | An automation may choose to speak for a silenced device, and then it must name who silenced it | invariants-30-43 | narrative-78 |
| 79 | An operator's removal of a MAC is a correction, not a suppression | invariants-30-43 | narrative-60-64 |
| 80 | Downtime Polaris itself causes is not an incident — and a silence it grants expires on its own | invariants-30-43 | narrative-80 |
| 82 | A measurement of the host must not be dominated by the measurer, and a scheduling offset is not a way to protect one | invariants-30-43 | narrative-82 |
| 83 | A serial belongs to one device and one owner; two claimants is a report, never a silent winner | invariants-30-43 | narrative-83 |

Related skills: `polaris-domain-model` (the entities these rules constrain),
`polaris-change-impact` (who else reads or writes the fields a rule governs),
`polaris-monitoring-discovery` (the collectors and discovery phases rules 12–17, 29–30, 36–38 and 41 shape).
