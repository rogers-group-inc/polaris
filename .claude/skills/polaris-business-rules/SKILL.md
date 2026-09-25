---
name: polaris-business-rules
description: "The numbered Polaris business rules — each invariant and the incident that forced it. Load BEFORE changing any behavior around subnets/CIDR overlap, reservations, DHCP leases or bindings, discovery writes to assets, a serial number claimed by two firewalls or carried by two asset records and who owns a managed device's record, lastSeen, Last Seen Switch/AP/Firewall (upstream placement of a device, including the gate that owns its subnet), monitorStatus (up/down/warning/recovering/passive), the FortiLink / CAPWAP controller-link state of a managed FortiSwitch or FortiAP, dependency suppression, maintenance windows and the holds Polaris takes on an asset for downtime it is causing itself (an agent upgrade, reinstall or uninstall that silences the device it is working on), automations/alerts/notifications/escalation/acknowledge/reset, reminders and their quiet time, packet loss, secrets at rest, which install is allowed to claim a database and what a refusal to start on an active-instance heartbeat means (a container or unit that will not come up after an upgrade, 'another host holds a fresh active-instance heartbeat', two instances on one database), backups and the database sslmode handed to pg_dump/psql, whether TimescaleDB is required and what its absence costs, retention and compression, SSH host keys, login restriction, a user changing their own password and what that does to their other sessions, the password complexity policy and forcing a non-conforming password to be changed at login, passkeys / WebAuthn (whether one may sign in on its own or only as a second factor, and what it is bound to), agent upgrade credentials, security response headers (CSP, HSTS) and what an unmatched route answers, what a discovery run reports about devices it skipped or could not read, RBAC grant levels, tags/regions, placeholder MACs, Windows OS names, logos, event retention, a column a rule calls dormant; a path check (Path Monitor, formerly connectivity checks) and what a failing one means; whenever code, a commit or a doc cites 'business rule N' / 'rule N' / 'rule Na'; and when asked to add or retire a rule, or which rule number is free next."
user-invocable: false
---

# Polaris business rules

Every rule records a decision **and** the incident or constraint that forced it. Each rule has
three layers, and they answer different questions:

| Layer | Where | What it is | Length |
|---|---|---|---|
| **title** | the index below | the aphorism a commit or comment cites beside the number | one line |
| **invariant** | `references/invariants-*.md` | the CONTRACT as it stands today: what must hold, the functions and columns that hold it, and pointers to the rules it leans on. No dated history, no "until 2026-09 it was…" | about 150 words; 250 is the ceiling |
| **narrative** | `references/narrative-*.md` | the incident, the reasoning, the alternatives rejected, the dated history — verbatim, never summarized | as long as it needs |

Read the invariant first, then the narrative for the same number, **before** changing anything
the invariant constrains. Never paraphrase a rule when quoting it. Each narrative section ends
with a `### Rule N — the invariant as stated in full until 2026-09-22` block: that is the
long-form invariant the contract layer used to carry, moved there verbatim when the layer was
cut back — read it when the short invariant's "why" is not obvious.

## Numbering

**Rule numbers are a stable citation key** (commits, code comments and the other docs cite
"business rule 23"). Never renumber; retire a rule in place and give a new one the next free
number. **81 is a deliberate gap** — published then reverted wholesale the same week, and a
number that means two things is worse than a gap.

**The next free number is derived, never stated here**: run `npm run rules:next`
([scripts/next-rule-number.mjs](../../../scripts/next-rule-number.mjs)). It scans `main` AND
every `worktree-*` branch, because a number that is free on `main` may already be claimed by an
open worktree — on 2026-09-21 two branches both picked 77 by checking `main` alone, and rule 75
has been held by an in-flight worktree since 2026-09-18. Re-run it at merge time; the branch
merging second renumbers (merge-protocol.md § 3).

**Sub-clauses.** A rule may grow lettered clauses — 20a, 29h, 38b, 40(i), 80a — and those
letters are citation keys too, as stable as the number. The convention: **a new PRINCIPLE gets
a new number; a new CONSEQUENCE of an existing principle gets a letter** on that rule. A lettered
clause large enough to carry its own narrative (80a) gets its own `## Rule Na` heading and index
row; the rest live inside their rule's invariant and are cited as `rule 40(i)`.

## How to read

| You are about to… | Read |
|---|---|
| touch subnets, blocks, reservations, CIDR math, DHCP leases | rules 1–7 and 11; 20a, 23, 26, 41, 42, 69, 77 |
| touch what the IP panel's Status column SAYS about an address, a FortiGate VIP or virtual server, `vipInfo`, or whether an address can be reserved at all | 23 first (the two-facts split), then 77 (the third fact and the composed pill) |
| touch Asset status, `monitored`, `lastSeen`, `acquiredAt` | 9, 10; 12, 16, 36, 37 |
| touch probes, `monitorStatus`, the failure bucket, packet loss, dependency suppression | 29, 30, 36, 38, 55, 59, 66, 67, 78 — the state machine itself is `polaris-change-impact` → cross-cutting/five-state-monitor-machine.md |
| touch automations, alerts, delivery, acknowledge, reset, escalation, reminders | 18, 19, 24, 25, 32, 39, 44, 46, 56, 58, 59, 60, 65, 66, 67, 78, 85 |
| touch what an alert says about a device that is dependency-down, or who may alert about one | 16 and 37 (the silence), then 78 (the one opt-out from it) |
| touch what an alert EMAIL says — the timezone a timestamp is drawn in, who is on the To line, whether one send may become two, the Acknowledge button | 25 first (it forbids splitting a send), then 56 and 60 |
| touch a maintenance window, a hold Polaris takes for itself, or any surface that REPORTS one | 16 (what a window does), 37 (the gate that reads it), 80 + 80a (holds and event-time), 73 (reporting) |
| touch discovery writes (assets, descriptions, locations, ARP, MACs) | 13, 14, 15, 17, 22, 26, 28, 35, 40, 41, 45, 53, 55, 79, 83 |
| touch a serial number — what identifies a device, which controller owns its record, two records carrying one serial, what the agent reports | 41 (the chassis identity it builds on), 83, 84, 82 (what the agent measures) |
| touch how a device's upstream switch / AP / gate is derived or displayed | 45 (the ARP-chain sweep that WRITES placement) and 55 (IPAM as the last-resort parent it READS) |
| touch how a discovery run reports what it did or did not read | 53 |
| touch map regions, `region:` tags, or anything that strips `Asset.tags` | 54 (what may be stripped) and 58 (what a stranded tag must not do to routing) |
| touch secrets, backups, the PostgreSQL client or its connection parameters, TimescaleDB, retention | 20b–c, 47 (which binary) and 51 (its vocabulary), 52, 71 |
| touch SSH — host keys, the onboarding scripts, the endpoint firewall rule | 21, 72, 76 |
| touch login, sessions, permissions, roles | 31, 34, 43 (grant levels) and 48 (who may grant them), 61, 62, 63, 64 |
| touch Polaris Agent install, upgrade, its stored credential, or a figure it reports | 43a, 49, 80, 82, 84, 85 |
| touch an agent-run path check — what its result means, what it may point at, what is stored from a response body, traceroute hops and path changes | 85 first, then 33 (the vendor HTTP check it is NOT), 36 and 37 (who says "failing" and who may alert) |
| touch a column a rule calls dormant (`cooldownSec`, `failureThreshold`, `awaitingRecoveryConfirm`, `recoveryStartedAt`, `consecutiveSuccesses`) | `polaris-domain-model` → references/dormant-columns.md, then the rule it names |
| add or retire a rule | the section below |

## Add or retire a rule

1. `npm run rules:next` for the number. Never take one listed as claimed by another branch.
2. **Invariant**: one paragraph appended to [references/invariants-30-43.md](references/invariants-30-43.md)
   (the filename is a stable citation key and keeps its name whatever range it holds), in the
   contract shape above — about 150 words, the functions and columns named, no dated history —
   ending with the pointer `→ [narrative-N.md#rule-N](narrative-N.md#rule-N)`.
3. **Narrative**: a new file `references/narrative-N.md` — **one file per rule** from rule 78 on;
   never append to the range files, which are at or near the 1500-line ceiling — headed
   `## Rule N — <title>`, holding the incident, the reasoning and the rejected alternatives.
4. **Index row** in the table below, the narrative file linked from the reference list, the
   `### Rule N` heading in `docs/wiki/Business-Rules.md` (`/polaris-docs-sync` routes it), and
   the number cited from the code and the test that pins it. `npm run check:docs` (`rule-anchors`)
   fails on a pointer that does not resolve, an index row with no invariant, or a narrative
   heading with no invariant.
5. **Retiring**: leave the number in every table with "retired YYYY-MM-DD, see rule M"; never delete or renumber.
6. **Never rename the reference files.** `invariants-30-43.md` / `narrative-36-43.md` /
   `narrative-44-48.md` / `narrative-60-64.md` keep their names whatever range they hold.

## Reference files

- [references/invariants-01-11.md](references/invariants-01-11.md) — rules 1–11 in full (one-line invariants with no narrative; moved out of this file 2026-09-22)
- [references/invariants-12-29.md](references/invariants-12-29.md) — the invariant for rules 12–29
- [references/invariants-30-43.md](references/invariants-30-43.md) — the invariant for rules 30–85 (the filename keeps its original range)
- [references/narrative-12-24.md](references/narrative-12-24.md) — narrative, rules 12–24
- [references/narrative-25-35.md](references/narrative-25-35.md) — narrative, rules 25–35
- [references/narrative-36-43.md](references/narrative-36-43.md) — narrative, rules 36–43
- [references/narrative-44-48.md](references/narrative-44-48.md) — narrative, rules 44–59 (split 2026-09-09 when 36–43 passed 100 KB)
- [references/narrative-60-64.md](references/narrative-60-64.md) — narrative, rules 60–74 (split 2026-09-15; rules 76, 77 and 79 moved out to their own files 2026-09-22 to keep it under the ceiling)
- one file per rule from here on: [narrative-76.md](references/narrative-76.md), [narrative-77.md](references/narrative-77.md), [narrative-78.md](references/narrative-78.md), [narrative-79.md](references/narrative-79.md), [narrative-80.md](references/narrative-80.md) (80 and 80a), [narrative-82.md](references/narrative-82.md), [narrative-83.md](references/narrative-83.md), [narrative-84.md](references/narrative-84.md), [narrative-85.md](references/narrative-85.md)

## Rules 1–11

One-line invariants, in [references/invariants-01-11.md](references/invariants-01-11.md): no overlapping subnets (1), subnet within block (2), no duplicate reservations (3), deletion protection (4), CIDR normalization (5), `sourceType` tracking (6), conflict detection (7), event retention (8), `acquiredAt ≤ lastSeen` (9), the four unmonitorable statuses (10), DNS-resolved reservations (11).

## Rules 12–85 (index)

Pairs that are two halves of one concern are marked; each keeps its own number because code cites both.

| # | Rule | Invariant | Narrative |
|---|---|---|---|
| 12 | `Asset.lastSeen` means verified network presence | invariants-12-29 | narrative-12-24 |
| 13 | SD-WAN monitoring is opt-in, read-only, FortiOS-only | invariants-12-29 | narrative-12-24 |
| 14 | Description sync is opt-in and Polaris-primary | invariants-12-29 | narrative-12-24 |
| 15 | Location codes ride device descriptions; notes are operator-only | invariants-12-29 | narrative-12-24 |
| 16 | Maintenance windows pause everything; status flips are scheduler-managed — what a window DOES (37 is the gate that reads it; 80 the holds) | invariants-12-29 | narrative-12-24 |
| 17 | ARP presence evidence for stale reservations; the sweep is opt-in | invariants-12-29 | narrative-12-24 |
| 18 | Automation precedence is same-trigger, most-specific-wins | invariants-12-29 | narrative-12-24 |
| 19 | Severity bands escalate one alert by value, each on its own clock | invariants-12-29 | narrative-12-24 |
| 20 | Subnet writes serialize per block (a); secrets are encrypted at rest (b); a backup you cannot restore is not a backup (c) | invariants-12-29 | narrative-12-24 |
| 21 | SSH host-key verification is opt-in and fails closed | invariants-12-29 | narrative-12-24 |
| 22 | The Sources column is `location \|\| learnedLocation`, operator-ordered | invariants-12-29 | narrative-12-24 |
| 23 | Who owns an IP and how the gate hands it out are two facts, not one (77 adds the third) | invariants-12-29 | narrative-12-24 |
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
| 37 | An automation only fires about a device Polaris is actually polling — the ONE alerting gate (reads 16; 78 is its opt-out; 80a its event-time twin) | invariants-30-43 | narrative-36-43 |
| 38 | A device behind a dark parent is not accused, and is not released on one packet | invariants-30-43 | narrative-36-43 |
| 39 | How a person wants to be reached is theirs, not the automation's | invariants-30-43 | narrative-36-43 |
| 40 | Two assets on one address is a conflict; one asset on a stale address is not | invariants-30-43 | narrative-36-43 |
| 41 | A subnet dies with its FortiGate; the chassis, not the name, says which gate | invariants-30-43 | narrative-36-43 |
| 42 | Some address space is not one network; the way to say so is to exclude it | invariants-30-43 | narrative-36-43 |
| 43 | A grant is only as narrow as the act it names (48 is the promotion guard beside it) | invariants-30-43 | narrative-36-43 |
| 44 | A quiet window withholds the reminder, not the alert, and the reminder that follows says how long | invariants-30-43 | narrative-44-48 |
| 45 | An address places a device only through the gate that owns it, and only a device nothing else can place — the ARP-chain sweep that WRITES placement (55 is the read side) | invariants-30-43 | narrative-44-48 |
| 46 | A device filter on an event automation filters the event's subject | invariants-30-43 | narrative-44-48 |
| 47 | A PostgreSQL client is chosen by the server's major and verified, never spawned by bare name (51 is its other half) | invariants-30-43 | narrative-44-48 |
| 48 | Nobody hands out authority they do not hold | invariants-30-43 | narrative-44-48 |
| 49 | An upgrade never refuses for want of a credential it can find itself, and never records one it has not proved | invariants-30-43 | narrative-44-48 |
| 50 | A response the app did not write is a response with the app's headers missing | invariants-30-43 | narrative-44-48 |
| 51 | A `DATABASE_URL` is a driver URL; its `sslmode` is translated into the libpq vocabulary, never copied (47's other half) | invariants-30-43 | narrative-44-48 |
| 52 | TimescaleDB is part of the install, not a tuning option | invariants-30-43 | narrative-44-48 |
| 53 | A device a run could not read keeps its old data, so it is named — never folded in with one the run skipped | invariants-30-43 | narrative-44-48 |
| 54 | A region tag dies when its name is retired, and only then (58 is its other half) | invariants-30-43 | narrative-44-48 |
| 55 | IPAM is the LAST source consulted for a device's upstream gate — it may add a parent, never move one, and every surface says which answer it got (retitled 2026-09-22; 45 is the write side) | invariants-30-43 | narrative-44-48 |
| 56 | What ignoring an alert costs is answered where the thing that costs it lives: the note by severity, the reminder by action | invariants-30-43 | narrative-44-48 |
| 57 | A sub-asset alerts only if the operator pinned it — the pin IS the statement of what may alert | invariants-30-43 | narrative-44-48 |
| 58 | A tag that names no region strands the ranking, so level routing abstains (54's other half) | invariants-30-43 | narrative-44-48 |
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
| 75 | — claimed by an in-flight worktree (alert grouping), not yet on `main` | — | — |
| 76 | Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it | invariants-30-43 | narrative-76 |
| 77 | A VIP describes an address; it does not claim it — and the status says every fact it has | invariants-30-43 | narrative-77 |
| 78 | An automation may choose to speak for a silenced device, and then it must name who silenced it | invariants-30-43 | narrative-78 |
| 79 | An operator's removal of a MAC is a correction, not a suppression | invariants-30-43 | narrative-79 |
| 80 | Downtime Polaris itself causes is not an incident — and a silence it grants expires on its own | invariants-30-43 | narrative-80 |
| 80a | A silence is granted for when the event HAPPENED, not for when something got round to reading it | invariants-30-43 | narrative-80 |
| 81 | — deliberate gap: published then reverted wholesale, 2026-09-22; never re-used | — | — |
| 82 | A measurement of the host must not be dominated by the measurer, and a scheduling offset is not a way to protect one | invariants-30-43 | narrative-82 |
| 83 | A serial belongs to one device and one owner; two claimants is a report, never a silent winner | invariants-30-43 | narrative-83 |
| 84 | A value that cannot identify a device is refused where it would be WRITTEN, not where a sweep would read it | invariants-30-43 | narrative-84 |
| 85 | A path check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means | invariants-30-43 | narrative-85 |

Related skills: `polaris-domain-model` (the entities these rules constrain, and the dormant
columns they retired), `polaris-change-impact` (who else reads or writes the fields a rule
governs; the monitor state machine the down/loss/recovery rules share),
`polaris-monitoring-discovery` (the collectors and discovery phases rules 12–17, 29–30, 36–38
and 41 shape), `polaris-ui-canon` (the Down-severity palette rule 36 hands to the charts).
