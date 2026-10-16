---
name: polaris-business-rules
description: "The numbered Polaris business rules — each invariant and the incident that forced it. Load BEFORE changing any behavior around subnets/CIDR overlap, reservations, DHCP leases or bindings, discovery writes to assets (including which lease, reservation, detected-device entry or network card sets an endpoint's IP — an asset on the wrong or a leftover address — and an asset's per-MAC address list, secondary IPs, the pinned primary address it is monitored on, and the confidence score each address carries), a serial number claimed by two firewalls or carried by two asset records and who owns a managed device's record, lastSeen, Last Seen Switch/AP/Firewall (upstream placement of a device, including the gate that owns its subnet), monitorStatus (up/down/warning/recovering/passive), a chart that reads "updated 1m ago" with no data or a stale banner that never appears (a CPU / memory or interface poll that keeps failing while the device answers ping, and an automation alerting when polls have failed for N minutes), the FortiLink / CAPWAP controller-link state of a managed FortiSwitch or FortiAP, dependency suppression, maintenance windows and the holds Polaris takes on an asset for downtime it is causing itself (an agent upgrade, reinstall or uninstall that silences the device it is working on), automations/alerts/notifications/escalation/acknowledge/reset, reminders and their quiet time, packet loss, secrets at rest, which install is allowed to claim a database and what a refusal to start on an active-instance heartbeat means (a container or unit that will not come up after an upgrade, 'another host holds a fresh active-instance heartbeat', two instances on one database), backups and the database sslmode handed to pg_dump/psql, whether TimescaleDB is required and what its absence costs, retention and compression, SSH host keys, login restriction, a user changing their own password and what that does to their other sessions, the password complexity policy and forcing a non-conforming password to be changed at login, passkeys / WebAuthn (whether one may sign in on its own or only as a second factor, and what it is bound to), agent upgrade credentials, security response headers (CSP, HSTS) and what an unmatched route answers, what a discovery run reports about devices it skipped or could not read, RBAC grant levels, tags/regions, placeholder MACs, Windows OS names, logos, event retention, a column a rule calls dormant; a firmware upgrade — which image a switch or AP may be flashed with, and a flash booked for later (why a scheduled upgrade was refused, missed or waited, who gets the results email); a reboot Polaris sends — the Reboot button on a FortiGate, FortiSwitch, FortiAP or agent host, a booked reboot, Allow reboots on a credential or a FortiManager / FortiGate integration, an agent host's reboot opt-in (its marker and polkit rule), why a reboot was refused, failed or came back unverified, and the hold it takes; a path check (Path Monitor, formerly connectivity checks) and what a failing one means; the AI assistant chat and the AI Assistant integration (what a lookup may see, why a report cannot be typed by the model, who can read a saved conversation, the role and API token it mints, the Efficiency Advisor / R.A.L.P.H. persona — its canned lines, the voice samples the hosted model learns from, and how a persona change is hand-tested); whenever code, a commit or a doc cites 'business rule N' / 'rule N' / 'rule Na'; and when asked to add or retire a rule, or which rule number is free next."
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
was held by an in-flight worktree from 2026-09-18 until it merged on 2026-09-30. Re-run it at merge time; the branch
merging second renumbers (merge-protocol.md § 3).

**Sub-clauses.** A rule may grow lettered clauses — 20a, 29h, 38b, 40(i), 80a — and those
letters are citation keys too, as stable as the number. The convention: **a new PRINCIPLE gets
a new number; a new CONSEQUENCE of an existing principle gets a letter** on that rule. A lettered
clause large enough to carry its own narrative (80a) gets its own `## Rule Na` heading and index
row; the rest live inside their rule's invariant and are cited as `rule 40(i)`.

## How to read

| You are about to… | Read |
|---|---|
| touch subnets, blocks, reservations, CIDR math, DHCP leases | rules 1–7 and 11; 20a, 23, 26, 41, 42, 69, 77; 100(j) for a Generic API feed writing IPAM |
| touch what the IP panel's Status column SAYS about an address, a FortiGate VIP or virtual server, `vipInfo`, or whether an address can be reserved at all | 23 first (the two-facts split), then 77 (the third fact and the composed pill) |
| touch Asset status, `monitored`, `lastSeen`, `acquiredAt` | 9, 10; 12, 16, 36, 37 |
| touch probes, `monitorStatus`, the failure bucket, packet loss, dependency suppression | 29, 30, 36, 38, 55, 59, 66, 67, 78, 86, 90, 91 — the state machine itself is `polaris-change-impact` → cross-cutting/five-state-monitor-machine.md |
| touch when a heavy stream (CPU / memory, system info) is due, what "updated X ago" or the stale banner reads, a poll that failed while the device stays up, or `lastTelemetryAt` / `lastSystemInfoAt` and their attempt / failing-since / last-error columns | 118 |
| stage, upload or run a file on a monitored host over SSH / WinRM (agent install, upgrade, uninstall, reboot permission), the agent's process-log tailer and the files it opens, or an agent WebSocket frame Polaris parses | 119 |
| resolve a device from a NAME — `lastSeenSwitch` / `lastSeenAp`, an AP's `parentSwitch`, an LLDP `systemName`, two switches or APs sharing a hostname, the duplicate-hostname merge | 91 (the scope that settles a shared name, and the refusal when nothing does), 41 and 83 (the serial identities it falls back on) |
| touch automations, alerts, delivery, acknowledge, reset, escalation, reminders | 18, 19, 24, 25, 32, 39, 44, 46, 56, 58, 59, 60, 65, 66, 67, 75, 78, 85, 89, 90, 98 (the SD-WAN member IP filter), 106 (the per-email asset Event, and why the event tail ignores it), 118 (the stream-failing state fields), 120 (quiet-time recipient exceptions) |
| touch the capacity snapshot's severity, who records `capacity.severity_changed` / `capacity.severity_recovered`, or how long a change must hold before it alerts | 105, then 32(e) (the verb split) and 71 (what a self-measurement must account for) |
| touch what an alert says about a device that is dependency-down, or who may alert about one | 16 and 37 (the silence), then 78 (the one opt-out from it) and 78a (its acknowledgement follows the root cause's) |
| touch what an alert EMAIL says — the timezone a timestamp is drawn in, who is on the To line, whether one send may become two, the Acknowledge button | 25 first (it forbids splitting a send), then 56 and 60; 120 for the one partition quiet time makes (who is held) |
| touch a maintenance window, a hold Polaris takes for itself, or any surface that REPORTS one | 16 (what a window does), 37 (the gate that reads it), 80 + 80a (holds and event-time), 73 (reporting) |
| touch discovery writes (assets, descriptions, locations, ARP, MACs) — including which DHCP binding, detected-device row or network card sets an endpoint's IP | 13, 14, 15, 17, 22, 26, 28, 35, 40, 41, 45, 53, 55, 79, 83, 101, 102, 103; 100 for the Generic API feed |
| touch a serial number — what identifies a device, which controller owns its record, two records carrying one serial, what the agent reports | 41 (the chassis identity it builds on), 83, 84, 82 (what the agent measures), 91 (what a HOSTNAME is not) |
| touch how a device's upstream switch / AP / gate is derived or displayed | 45 (the ARP-chain sweep that WRITES placement) and 55 (IPAM as the last-resort parent it READS) |
| touch how a discovery run reports what it did or did not read | 53 |
| touch map regions, `region:` tags, or anything that strips `Asset.tags` | 54 (what may be stripped), 58 (what a stranded tag must not do to routing) and 121 (a region's parent is chosen only among its real containers; area paint order) |
| touch secrets, backups, the PostgreSQL client or its connection parameters, TimescaleDB, retention | 20b–c, 47 (which binary) and 51 (its vocabulary), 52, 71 |
| touch SSH — host keys, the onboarding scripts, the endpoint firewall rule | 21, 72, 76 |
| touch login, sessions, permissions, roles | 31, 34, 43 (grant levels) and 48 (who may grant them), 61, 62, 63, 64 |
| touch Polaris Agent install, upgrade, its stored credential, or a figure it reports | 43a, 49, 80, 82, 84, 85 |
| touch a path check — what its result means, what it may point at, what is stored from a response body, traceroute hops and path changes, and the Polaris server as a source (who may aim it, why it does not alert) | 85 first, then 33 (the vendor HTTP check it is NOT), 36 and 37 (who says "failing" and who may alert) |
| touch a reboot — the Reboot button, a scheduled reboot, a credential's or a FortiManager / FortiGate integration's Allow reboots, an agent host's reboot opt-in (its marker and polkit rule), what proves a reboot happened, or the hold it takes | 115 (the whole contract), 80 (the hold), 93 (the booking shape it copies), 87 (the HA refusal and the device login it reuses), 43(g) (why it is `assets:write`) |
| touch the firmware repository — which image a switch, AP or FortiGate is offered, the device-admin login or API token it signs in with, a FortiGate HA member being refused, what a flash may or may not write, or a flash booked for later (a scheduled upgrade and its results email) | 87 (the whole contract), 93 (a booked flash — approved at booking, judged when it fires), 80 (the hold it takes), 43(g) (why flashing is `assets:write` and the `firmware` key is repository-only), 84 (the serial it keys on) |
| touch what happens when an agent host stops reporting — a dead host, `ManagedAgent.lastSeenAt`, an agent-monitored asset stuck `up` | 86 (the silence is the miss), 80 (a hold Polaris takes during its own agent operations) |
| touch the AI assistant or the `llm` integration — what a lookup may see, what a tool may do, where report rows come from, who can read a saved conversation, the role and token the integration mints, a loopback model server, what the assistant may remember about a user and who may write it, the Azure AI Foundry provider (GPT or Claude, API key or Entra app), the Efficiency Advisor / R.A.L.P.H. voice and when the model may play it | 95 (the whole contract; memory is 95(i), providers 95(j), the hosted-model persona 95(k)), 48 (why provisioning needs roles + apiTokens write) |
| touch a surface that restarts Polaris itself — the Capacity Advisor's Restart button, `POST /server-settings/restart`, `restartService()` — or anything that behaves differently in a container | 99 (never self-restart a container; ask the operator) |
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
- one file per rule from here on: [narrative-75.md](references/narrative-75.md), [narrative-76.md](references/narrative-76.md), [narrative-77.md](references/narrative-77.md), [narrative-78.md](references/narrative-78.md), [narrative-79.md](references/narrative-79.md), [narrative-80.md](references/narrative-80.md) (80 and 80a), [narrative-82.md](references/narrative-82.md), [narrative-83.md](references/narrative-83.md), [narrative-84.md](references/narrative-84.md), [narrative-85.md](references/narrative-85.md), [narrative-86.md](references/narrative-86.md), [narrative-87.md](references/narrative-87.md), [narrative-88.md](references/narrative-88.md), [narrative-89.md](references/narrative-89.md), [narrative-90.md](references/narrative-90.md), [narrative-91.md](references/narrative-91.md), [narrative-92.md](references/narrative-92.md), [narrative-93.md](references/narrative-93.md), [narrative-94.md](references/narrative-94.md), [narrative-95.md](references/narrative-95.md), [narrative-96.md](references/narrative-96.md), [narrative-97.md](references/narrative-97.md), [narrative-98.md](references/narrative-98.md), [narrative-99.md](references/narrative-99.md), [narrative-100.md](references/narrative-100.md), [narrative-101.md](references/narrative-101.md), [narrative-102.md](references/narrative-102.md), [narrative-103.md](references/narrative-103.md), [narrative-104.md](references/narrative-104.md), [narrative-105.md](references/narrative-105.md), [narrative-106.md](references/narrative-106.md), [narrative-107.md](references/narrative-107.md), [narrative-108.md](references/narrative-108.md), [narrative-109.md](references/narrative-109.md), [narrative-110.md](references/narrative-110.md), [narrative-111.md](references/narrative-111.md), [narrative-112.md](references/narrative-112.md), [narrative-113.md](references/narrative-113.md), [narrative-114.md](references/narrative-114.md), [narrative-115.md](references/narrative-115.md), [narrative-116.md](references/narrative-116.md), [narrative-117.md](references/narrative-117.md), [narrative-118.md](references/narrative-118.md), [narrative-119.md](references/narrative-119.md), [narrative-120.md](references/narrative-120.md), [narrative-121.md](references/narrative-121.md) , - one file per rule from here on:

## Rules 1–11

One-line invariants, in [references/invariants-01-11.md](references/invariants-01-11.md): no overlapping subnets (1), subnet within block (2), no duplicate reservations (3), deletion protection (4), CIDR normalization (5), `sourceType` tracking (6), conflict detection (7), event retention (8), `acquiredAt ≤ lastSeen` (9), the four unmonitorable statuses (10), DNS-resolved reservations (11).

## Rules 12–118 (index)

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
| 21 | SSH host-key verification fails closed (opt-in until rule 113 made it the default) | invariants-12-29 | narrative-12-24 |
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
| 44 | A quiet window holds the reminder, never skips it, and the reminder that follows says how long (the hold mechanics inside 92) | invariants-30-43 | narrative-44-48 |
| 45 | An address places a device only through the gate that owns it, and only a device nothing else can place — the ARP-chain sweep that WRITES placement (55 is the read side) | invariants-30-43 | narrative-44-48 |
| 46 | A device filter on an event automation filters the event's subject | invariants-30-43 | narrative-44-48 |
| 47 | A PostgreSQL client is chosen by the server's major and verified, never spawned by bare name (51 is its other half) | invariants-30-43 | narrative-44-48 |
| 48 | Nobody hands out authority they do not hold; demoting an admin-equivalent role, ownership tombstoned on user delete, cold session snapshots re-checked (48(d)-(f)) | invariants-30-43 | narrative-44-48 |
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
| 75 | An alert may name many problems on one device, and it ends only when the last of them does | invariants-30-43 | narrative-75 |
| 76 | Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it | invariants-30-43 | narrative-76 |
| 77 | A VIP describes an address; it does not claim it — and the status says every fact it has | invariants-30-43 | narrative-77 |
| 78 | An automation may choose to speak for a silenced device, and then it must name who silenced it | invariants-30-43 | narrative-78 |
| 78a | A dependency-down alert is acknowledged when its root cause's own alert is, and says whose acknowledgement it carries | invariants-30-43 | narrative-78 |
| 79 | An operator's removal of a MAC is a correction, not a suppression | invariants-30-43 | narrative-79 |
| 80 | Downtime Polaris itself causes is not an incident — and a silence it grants expires on its own | invariants-30-43 | narrative-80 |
| 80a | A silence is granted for when the event HAPPENED, not for when something got round to reading it | invariants-30-43 | narrative-80 |
| 81 | — deliberate gap: published then reverted wholesale, 2026-09-22; never re-used | — | — |
| 82 | A measurement of the host must not be dominated by the measurer, and a scheduling offset is not a way to protect one | invariants-30-43 | narrative-82 |
| 83 | A serial belongs to one device and one owner; two claimants is a report, never a silent winner | invariants-30-43 | narrative-83 |
| 84 | A value that cannot identify a device is refused where it would be WRITTEN, not where a sweep would read it | invariants-30-43 | narrative-84 |
| 85 | A path check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means | invariants-30-43 | narrative-85 |
| 86 | An agent that deployed and went quiet has missed its poll — unless Polaris is the one that stopped listening | invariants-30-43 | narrative-86 |
| 87 | A firmware image is offered only to a device whose serial names the image's platform, and only forward; the flash takes a hold and never records a version it has not read back | invariants-30-43 | narrative-87 |
| 88 | **retired 2026-10-08, see rule 98** — was: a port Polaris has positive evidence was never in use does not alert when the automation asks it to skip unused ports | invariants-30-43 | narrative-88 |
| 89 | A per-core CPU hold follows ONE core, the alert names it, and it yields to the all-cores alert on the same device | invariants-30-43 | narrative-89 |
| 90 | An SD-WAN member riding a parent that is over the same line does not alert; the parent's alert names the cause | invariants-30-43 | narrative-90 |
| 91 | A hostname is not an identity: a name several devices of one kind share is resolved by where the child sits, or not at all; 91(a) a shared name is never offered as a duplicate when the records' serials differ or one is network infrastructure and the other an endpoint (`hostnameCollisionGuard`, `dismissRefusedHostnameConflicts`); (b) a hostname-only DHCP / detected-device match never re-addresses a monitored or credentialed asset (MAC kept as `hostname-unverified`, warning event) | invariants-30-43 | narrative-91 |
| 92 | Quiet time withholds the send, never the alert — and what it withheld is reported when it ends (44 is the hold mechanics inside it) | invariants-30-43 | narrative-92 |
| 93 | A booked flash is approved when it is booked and judged when it fires — on time or not at all, and its recipients hear the outcome either way | invariants-30-43 | narrative-93 |
| 94 | A workload Polaris restarts or updates is held, one Polaris stops is paused until Polaris starts it, and every attempt is on the record | invariants-30-43 | narrative-94 |
| 95 | The assistant answers as the person asking, only reads, and never types a figure into a report | invariants-30-43 | narrative-95 |
| 96 | Polaris never drives a FortiGate's API-key lockout: few requests at once, nothing after a 401 until a pause runs out, and a probe it did not send is not a miss | invariants-30-43 | narrative-96 |
| 97 | The all-zero MAC means "no MAC": it never becomes an asset's MAC, and a reservation refuses it as a change | invariants-30-43 | narrative-97 |
| 98 | An SD-WAN condition may be narrowed to the members whose CURRENT address passes a comparison, and a member whose address cannot be read is kept | invariants-30-43 | narrative-98 |
| 99 | Polaris never restarts its own container: in a container it asks the operator to | invariants-30-43 | narrative-99 |
| 100 | A feed an operator describes is an inventory claim: it never vouches for presence or decides monitoring, never outranks a first-party source, and never reaches past its own host | invariants-30-43 | narrative-100 |
| 101 | An address is ranked by how directly it is known: a reservation the device holds, then what the gate sees online, then a held lease, then ARP — and a detection the gate's ARP contradicts decides nothing | invariants-30-43 | narrative-101 |
| 102 | An address belongs to a card, a card may carry several, and the operator picks the pair a device is monitored on (the per-MAC address list, the primary-address pin and how it follows a renumbered card) | invariants-30-43 | narrative-102 |
| 103 | How sure Polaris is of an address is a score the evidence earns, the operator's choice counts but cannot vouch for itself, and the score only informs — except to release a pin the network comes to back, 103(a) (the address-confidence weights, polling credit, penalties, the warn-before-apply check and the pin-release sweep) | invariants-30-43 | narrative-103 |
| 104 | The Active Directory bind account is offered only to a destination discovery chose: an asset an operator pinned (an address or a name) loses the WinRM / SSH fallback to the bind password and needs a credential selected on it | invariants-30-43 | narrative-104 |
| 105 | A capacity severity change is recorded by one evaluator, and only once it has held (the capacityWatch job alone writes `capacity.severity_*`; the `capacity.alertHold` minutes a change must survive) | invariants-30-43 | narrative-105 |
| 106 | Every alert email that leaves is recorded on its asset, and that record never raises an automation (one `notification.email_sent` Event per sent email row, To/Cc named and Bcc counted; the event tail skips it) | invariants-30-43 | narrative-106 |
| 107 | Text an operator types reaches a command line, a script or a generated connection only after it has been checked, and is checked again where it is used: archive-export settings, the agent server URL, onboarding-script addresses, the jsign jar (no longer a setting), a process log path glob (absolute local path, `assets=fullwrite`), an asset address, and JSON api_call bodies | invariants-30-43 | narrative-107 |
| 108 | A way into the install is checked against the account and the host behind it, not a spelling, a stale cookie or a used code: the one-time wizard setup token, canonical route paths for pre-router gates and the exact `/metrics`, a second-factor failure counter the password step cannot reset, single-use TOTP steps, sessions ended by account acts and re-validated each minute, a password to register a passkey, session-only self-service routes, a fresh role snapshot on `/conflicts`, SAML request binding and assertion replay refusal; non-canonical paths 404 before any gate, URL-parser login redirect, LDAP login timing equalized (108(h)-(j)) | invariants-30-43 | narrative-108 |
| 109 | A value is encoded for the context it lands in, not the one it came from: `jsArg` for every inline-handler argument (never `escapeHtml` inside a JS string), formula-neutralised CSV cells, escaped Slack and Teams text, and permissive input checks (no control characters in names, serial shape for an HA peer) behind them | invariants-30-43 | narrative-109 |
| 110 | An outbound host is judged by the ADDRESS it is (every spelling of a literal; embedded IPv4 in IPv6), and a NAME by what it resolves to on the connection (`guardedLookup` / `resolveAllowedHost`); webhook and api_call never follow redirects; SMTP and LLM lift the block for loopback only; restapi test guards its baseUrl (2026-10-13); credential test + webhook / api_call checked on the connection itself (2026-10-14) | invariants-30-43 | narrative-110 |
| 111 | A stored secret follows its destination: a blank or masked secret is restored only while host / port / token URL / transport are unchanged (`restoreStoredSecrets`), a stored secret never serves another integration type, and a new address on a Fortinet-managed device needs Integrations Read-Write, on every route that writes one; every address write and every operator merge (either side) runs `utils/integrationTokenTarget` (111(c), 2026-10-13); LDAP / OIDC secrets and FortiManager's direct-FortiGate keys follow destination; repointing the AI Assistant takes the provisioning grants (111(e)) | invariants-30-43 | narrative-111 |
| 112 | Aiming a stored credential is allowed for a trusted operator (asset editor, Discovery, path check) and recorded: one `credential.used` (info) or `credential.borrowed` (warning, not the owner and no Credentials Full RW) Event per credential, on a change of credential or destination (`recordCredentialUse`); read-level walks use only the asset's own credentials (112(e)) | invariants-30-43 | narrative-112 |
| 113 | A server proves it is the one Polaris pinned before a secret is sent: SSH host keys pinned by default (only `verifyHostKey: false` opts out), WinRM / firmware HTTPS certificates pinned in `TlsCertPin` and checked before the request is written (`pinnedTlsAgent`), Fortinet factory-cert serial pre-check, archive `accept-new` + skip prune on a failed export; FortiOS / FortiManager / REST-credential / HTTP-check secrets pinned too, changed certificates kept + Trust new certificate, re-pin window after Polaris's own firmware upgrade (113(e)-(g)) | invariants-30-43 | narrative-113 |
| 114 | A permission reaches only what it says, and a grant never exceeds the granter: group script gate, asset-alerts rule summary, contact adopt-on-create needs Full RW, scoped-token quarantine merge, refresh rows unowned, utilization reservation split, `assertGrantWithinCaller` on every grant site, api_call headers sealed + masked + url-bound restore, September-migration roles flagged for review (not demoted); group mappings + llm token regeneration are grants, alert-group gate on effective delivery, editable built-ins flagged, preview sample needs assets:read, register respects reservation ownership, quarantined only via its endpoints (114(j)-(n)) | invariants-30-43 | narrative-114 |
| 115 | A device reboots only on an opt-in held where the authority lives, and a reboot Polaris sends is proved, not assumed (a credential's or a Fortinet integration's `allowReboot`, an agent host's marker + polkit rule; HA gates refused; managed switches / APs through their gate; `succeeded` only on proof the device cycled; a `device-reboot` hold held until monitoring records the reboot (a); one booking per asset, cancelled by any other reboot (b); the automation `reboot` action books, never sends (c); unacknowledged agent commands withdrawn) | invariants-30-43 | narrative-115 |
| 116 | No regex Polaris runs can be made to take more than linear time: operator regexes on RE2 (`safeRegex`), globs on a regex-free matcher, MIB whole-file scans on RE2 + parse cache, `trimTrailing` loops, unusable stored patterns skipped and reported, lookahead-free FortiSwitch seed; WinRM SOAP parsed linearly with a 4 MiB body cap | invariants-30-43 | narrative-116 |
| 117 | The host keeps Polaris's secrets and privileges to the account and the peer they belong to: updater restart is a fixed root unit (`polaris-update-sync`) under a polkit rule scoped to it + the polaris units, validated unit/sudoers sync; random DB password + no passwords on argv + `db_default_password` warning; backups 0700/0600; HA wrapper flag allow-list, pinned peer host key, verify-full replication on new clusters; Windows agent ACLs; Unraid query tool queries only; root helpers (sudo-able wrapper, the update helper, polkit rule, HA root files) are HELD for `polaris-update-sync --apply-helpers`, never installed by the unit (117(g)); Unraid block strings refused, HA poll handle hashed + claim from the registering address + claim window, Patroni REST over TLS on new clusters (117(h)-(j)); installer / update-linux / migrate-to-nginx re-runs go through `polaris-update-sync --install` (diff + ask), `.env` written as polaris, nginx config content-checked (117(k)-(m)); root runs the reviewed installed copies `polaris-update-linux` / `polaris-ha-setup`, and setup-rhel-ha.sh reviews its HA root files from an untrusted source (117(n)) | invariants-30-43 | narrative-117 |
| 118 | A poll that failed is stamped as an attempt, never as an update — and how long a stream has been failing is a reading an automation can alert on (telemetry + system info keep `last<Stream>At` (success) / `last<Stream>AttemptAt` (the due anchor) / `<stream>FailingSince` / `<stream>LastError`; success writers spread `telemetrySuccessStamps` / `systemInfoSuccessStamps`; the `telemetryFailingMinutes` / `systemInfoFailingMinutes` state fields) | invariants-30-43 | narrative-118 |
| 119 | What a monitored host gives Polaris, or lets it write, cannot be redirected by another account on the host and cannot take Polaris down: per-run private staging dirs for every elevated agent script (`remoteStaging`), binary SHA-256 checked by the root installer, the process-log tailer never follows a symlink / junction / hard link (agent 0.27.0), a malformed agent WS frame closes only its socket | invariants-30-43.md#119, narrative-119.md |
| 120 | A quiet time can name the readers it does not apply to: recipient exceptions with their own per-severity held map; the send partitions by who is held (live row + held / `deferred` row), a split reminder or tier advances and the held readers get the newest copy at the window's end; summary, all-quiet, all-clear and the recipients footer follow what each reader was told | invariants-30-43.md#120, narrative-120.md |
| 121 | A region's parent is chosen only among the regions that really contain it: `nestUnderId` (Regions panel drag-to-nest) is honoured only while that polygon contains it, else 400 / a `nest-ignored` warning; smallest container or null stores null; delete clears picks; audited as `region.nesting_changed` + `region.levels_shifted`; maps stack polygons by area | invariants-30-43.md#121, narrative-121.md |

Related skills: `polaris-domain-model` (the entities these rules constrain, and the dormant
columns they retired), `polaris-change-impact` (who else reads or writes the fields a rule
governs; the monitor state machine the down/loss/recovery rules share),
`polaris-monitoring-discovery` (the collectors and discovery phases rules 12–17, 29–30, 36–38
and 41 shape), `polaris-ui-canon` (the Down-severity palette rule 36 hands to the charts).
