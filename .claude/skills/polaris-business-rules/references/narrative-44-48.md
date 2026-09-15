# Business rules 44–59 — full narrative

> The filename keeps its original range: it is cited from code and from the other skills.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant for each rule is in `invariants-12-29.md` / `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 44](#rule-44) — A quiet window withholds the reminder, not the alert, and the reminder that follows says how long
- [Rule 45](#rule-45) — An address places a device only through the gate that owns it, and only a device nothing else can place
- [Rule 46](#rule-46) — A device filter on an event automation filters the event's subject
- [Rule 47](#rule-47) — A PostgreSQL client is chosen by the server's major and verified before it is trusted, never spawned by bare name
- [Rule 48](#rule-48) — Nobody hands out authority they do not hold
- [Rule 49](#rule-49) — An upgrade never refuses for want of a credential it can find itself, and never records one it has not proved
- [Rule 50](#rule-50) — A response the app did not write is a response with the app's headers missing
- [Rule 51](#rule-51) — `DATABASE_URL` is a driver URL; its `sslmode` value is translated into the libpq vocabulary, never copied
- [Rule 52](#rule-52) — TimescaleDB is part of the install, not a tuning option
- [Rule 53](#rule-53) — A device a run could not read keeps the data it already had, so it is named, never folded in with one the run skipped
- [Rule 54](#rule-54) — A region tag dies when its name is retired, and only then
- [Rule 55](#rule-55) — An address places a device behind a gate only when nothing has seen it, and every surface says which answer it got
- [Rule 56](#rule-56) — What ignoring an alert costs is answered where the thing that costs it lives
- [Rule 57](#rule-57) — A sub-asset alerts only if the operator pinned it
- [Rule 58](#rule-58) — A tag that names no region strands the ranking, so level routing abstains
- [Rule 59](#rule-59) — The controller's view of its own link is a second opinion, and an unreadable controller has no view at all

<a id="rule-44"></a>

## Rule 44 — A quiet window withholds the reminder, not the alert, and the reminder that follows says how long

Reminders (`NotificationRule.repeat`, business rule 32's replacement for the retired
`cooldownSec`) exist to chase an alert nobody has handled. The complaint that produced
this rule is what that costs at night: an unacknowledged alert at 22:00 with a 15-minute
reminder mails the on-call rota 32 times before anyone is awake to read one of them, and
every one of those emails says exactly what the first one said. The first reaction — turn
the reminders off overnight — is the wrong shape, because the reminder is not the problem;
the reminder arriving *while nobody can act on it* is.

So the window holds the reminder rather than cancelling it. The sweep does not advance
`escalationState.tiers.repeat.lastSentAt` on a send it withholds, which means the withheld
reminder is still due — and the first tick after the window ends sends it. There is
deliberately nothing scheduled, nothing queued and no catch-up job: a held reminder is an
overdue one, and `repeatIsDue` already answers that question. It also means quiet time
cannot lose a reminder to a restart, because the only state it keeps is "a reminder was
withheld", not "a reminder is pending".

That withheld-ness is the whole reason the second half of the rule is possible. The stamp
(`quietHeldSince` / `quietHeldCount`) is what lets the reminder ending a hold be a
different email from the fourteen that would have arrived overnight: it leads with
"Reminders resumed after a quiet period — this alert has been active for 9h 12m", and
carries `· ACTIVE 9h 12m` in the subject beside `[REMINDER n]`. The subject is where it
earns its place. That email lands in an inbox holding a night's worth of other mail, and
`[REMINDER 4]` does not distinguish an alert twenty minutes old from one that has been
burning since 22:00 — which is the single fact deciding what the reader does next. It rides
that reminder only: an ACTIVE marker on every reminder is a marker that means nothing.
A standing `Active for` row is a separate, smaller decision — it rides *every* reminder,
because on any re-send the reader's own clock is no longer the answer, and it renders empty
(and prunes) on the initial alert where "Active for: 0m" beside "Raised: just now" is noise.

Four smaller decisions carry it.

**The recurrence is the maintenance scheduler's, not a new one.** `utils/quietTime.ts`
validates the windows with `maintenanceRecurrence.scheduleShapeSchema` and evaluates them
with its `currentWindow` / `nextWindow`. Everything that module solved is solved here for
free: server-local wall clock (a 22:00 quiet window means 22:00 at the site across a DST
shift), the half-open midnight-spanning window whose day-of-week selector matches the START
day, and an operator who already learned that vocabulary in the Maintenance modal. A quiet
time is still a LIST of windows, and any one of them being active means quiet — but since
per-day hours arrived (business rule 16) a SINGLE window says "nights during the week, all
weekend", which used to need two. That is why the wizard edits one window with the shared
`PolarisRecurrence` day/hours editor and lists anything else — a one-shot, a monthly change
freeze, active-date bounds, none of which those rows can express — read-only, offering
removal but never an edit that would silently rewrite it into something else. The list
survives for exactly those, and `quietResumesAt` still chains through abutting windows
because a Friday-night alert resumes Monday at 06:00, not Saturday at 06:00. The browser's
summary and its editor come from the same place for the same reason:
`public/js/recurrence-editor.js`, rather than a second copy in the wizard that would drift
into describing — or saving — one window two ways on two pages.

One consequence of the START-day rule is worth stating because operators meet it here
first. "All day Sunday" replaces Sunday's hours rather than adding to them, so a schedule
of week-nights 22:00–06:00 plus all-day Saturday and Sunday goes quiet from Friday 22:00
and resumes at MIDNIGHT on Monday, not at 06:00: Monday's range starts on Monday at 22:00,
and nothing covers Monday 00:00–06:00. An operator who wants the weekend to run into Monday
morning gives Sunday the hours 22:00–06:00 instead of all day. `quietTime.test.ts` pins it.

**Quiet applies to the reminder pass ONLY.** Not the first alert — a new outage pages
whatever the hour. Not the escalation tiers: a tier exists to chase a *specific* person
harder, usually somebody senior on a longer clock, and silencing it from a control labelled
"reminders" would weaken an escalation the operator configured on a different screen and
would not think to re-check. Not the reset notifications, which are the good news. This is
why the config lives INSIDE `repeat` rather than beside it: it modifies the reminder clock
and nothing else, and it cannot outlive the control that owns it — turning reminders off
drops the windows with them.

**The hold is closed by the send, not by the window.** A reminder whose channel was disabled
or whose recipients resolved empty produces `executed === 0`, retries on the next sweep, and
must still be the one that reports the silence — so the flag is cleared where
`tiers.repeat` is bumped, in the same branch, and nowhere else. For the same reason the
sweep no longer returns early on `tierRuns === 0 && repeatRuns === 0`: a hold is a state
update with no execution behind it, and that early return would have discarded the stamp
every time, leaving the feature working exactly as far as the eye could see (reminders do go
quiet) and failing at the part it was asked for (the reminder afterwards would say nothing).

**A malformed quiet blob must not silence what it was only meant to pause.**
`normalizeRuleToV2` reads a repeat config that no longer matches the schema as "never
repeats" — the right instinct for a hand-edited or restored row, and the wrong one here,
because a bad window would convert "pause overnight" into "never remind anyone again" and
nothing would report it until an outage went unchased. It therefore retries the parse with
`quiet` stripped: the reminders keep their normal cadence and the automation's page shows no
quiet time, which is a bug an operator can actually see.

Two things a reader should not expect. `stopAfterHours` is wall time from the fire, quiet
time included — a quiet period outlasting the cut-off means no further reminders at all, and
the wizard says so in a warning rather than quietly extending an operator's own deadline.
And the maintenance / dependency-suppression pause is not a quiet hold: it `continue`s
above the repeat pass and retires the live alert outright (business rule 16), so nothing
is held and nothing is reported afterwards.

---

<a id="rule-45"></a>

## Rule 45 — An address places a device only through the gate that owns it, and only a device nothing else can place

**The invariant.** For an asset that has an IP address and NO MAC, `lastSeenSwitch` and `lastSeenAp` are derived by the `resolveIpUpstreamChain` sweep (`services/ipUpstreamChainService.ts`, every 10 minutes) along one chain: IP → the containing subnet's owning FortiGate (its chassis serial first, its FortiManager device name second, through `utils/fortinetParentKey.ts`) → THAT gate's `AssetArpEntry` → MAC → the `AssetMacTableEntry` learned port with the fewest MACs, and the `AssetWirelessStation` carrying the MAC or the address. Four refusals, each deliberate: another gate's ARP row never counts (with no owning gate resolvable, the address is accepted only when exactly one gate reports it); two MACs at the address on the owning gate is no answer; an address claim that is not current under rule 40's model is skipped; and ARP / FDB / station rows older than 24 hours are not evidence. The sweep touches MAC-less assets ONLY, it derives the MAC and never adopts it onto the asset, and it never clears a stamp. Each move is audited as `asset.switch_port.changed` / `asset.wireless_ap.changed` by `system:upstream-chain`.

### What was missing

Every writer of the two "last seen" columns was keyed by MAC. Discovery Phase 7.5 matched the FortiSwitch MAC map through the run's own MAC index; the FortiAP station scrape matched `staMacAddr` through the LLDP match index; the SNMP forwarding-database persist resolved its `matchedAssetId` by MAC and stamped nothing at all. So an asset that arrived from Active Directory, Azure Arc, a vCenter cluster, an active scan or the operator form — an address and a hostname, no hardware identity — could never be placed on a switch port or an AP, even though the gate's neighbour cache and the switches' tables already held every fact needed. The Add Asset form's IP cross-reference (`ipContextService`) had walked most of that chain read-only since 2026-08 for a typed address, and stopped one step short of the station table; nothing ran it for the inventory.

### Why a separate sweep, and why it stops where it does

**A sweep, not a hook.** The evidence arrives from three writers on three cadences — FMG/FortiGate discovery for ARP, the SNMP system-info pass for the FDB, the FortiAP scrape for stations — and a MAC-less asset is reached by none of them. Joining the chain inside any one of those write sites would mean the others' tables might be a cycle stale at that moment; reading all three on a cadence of their own, from the current-state tables they leave behind, is the only place the join is honest. The same reasoning made rule 40 a sweep.

**The ARP lookup is scoped to the owning gate.** Overlapping RFC1918 ranges behind different gates on one FortiManager are the normal case on a multi-site fleet, so a global "who has this IP" over every gate's cache would hand a Site A workstation the MAC of whatever sits at the same address in Site B. Phase 7.6 keys ARP evidence by `(gate, ip)` for exactly this reason (rule 17), placeholder-MAC adoption does the same (rule 26), and the subnet's owning gate is resolved the way rule 41 says a gate must be — serial first, FMG device name second, never the hostname. When no gate can be named — a manual subnet, a gate with no Asset row — the rows are still accepted if a single gate reports the address, because a single reporter means no overlap was observed; two reporters is the overlap case and is skipped.

**Two MACs is no answer.** Rule 26 already refuses to burn an address that two ARP rows disagree about into DHCP config; the same duplicate is not a reason to move a device's switch port either. The address is skipped and counted (`ambiguous`), so a persistent count is itself a finding.

**Both ends must be fresh.** The asset's claim on the address follows rule 40's model exactly — an operator-owned claim (pin, or `ipSource="manual"`) never expires; a discovered one must have been re-asserted within `CLAIM_FRESH_DAYS` on its `AssetIpHistory` row, or the device seen when there is no history — because a recycled DHCP address is the other way this chain goes wrong: the laptop that left three weeks ago still records `10.1.1.50`, the printer that got the lease next is what the gate's ARP now answers with, and without the gate the laptop would be stamped onto the printer's port. The evidence tables have their own ceiling (24 hours): they are delete-replaced per scrape, so an older row does not mean the device is still there, it means the writer stopped answering — an offline gate, a switch dropped from monitoring.

**MAC-less assets only.** A MAC-bearing asset already has writers, and their label format differs from this one (`<switchId>/<portName>` from the FortiSwitch MAC map, `<hostname>/<ifName>` here). A second writer on the same column would move it back and forth every tick and audit both halves as changes forever — the ping-pong the asset-change-events baseline exists to prevent within a single discovery run. This sweep therefore writes only what no other writer can. Widening it means reconciling the formats first, and is not a small change.

**The MAC is derived, and since 2026-09 it is adopted.** The original rule refused: writing the ARP MAC onto the asset makes every downstream matcher work for free, but it also makes the row eligible for MAC-keyed dedupe and merge (`mergeDuplicateHostnameAssets` collapses rows sharing a MAC; Entra cross-links by Ethernet MAC), so one wrong adoption — a recycled address inside the freshness window, a gate misresolved — merges two devices and permanently deletes one row's monitoring history. Rule 26 gates the reservation-side adoption behind a double opt-in for the same reason, and adoption here was left as a follow-up behind an opt-in Setting.

It shipped instead as a default, on an explicit operator decision, with the hazard answered in code rather than by a toggle. The reasoning that made that acceptable: every wire-level ambiguity is ALREADY refused upstream of the adoption — `pickArpMac` scopes to the owning gate, returns `"ambiguous"` when two MACs answer one address, and the claim and evidence freshness gates have both already passed. What those refusals cannot see is a MAC that is not ambiguous on the wire but is already spoken for in Polaris, and that is the only remaining way this pass manufactures a merge candidate. `partitionAdoptableMacs` is that check: it refuses a MAC another asset already carries, and refuses BOTH when two candidates in one pass resolve to the same MAC — two asset rows at one address being rule 40's duplicate-IP conflict, whose answer is a Conflict row for an operator, not a silent merge.

A refusal drops the adoption ONLY. The switch and AP stamps derived from the same MAC still land, because a stamp is reversible and a merge is not — the asymmetry is the whole reason the two are separable. Every adoption is audited as its own `asset.mac.adopted` Event naming the address the answer came from, so an operator chasing a bad merge can see what the sweep believed, and a provenance row lands in `AssetMacAddress` with source `ip-upstream-arp` (not a hardware source) so the MAC list says where it came from. Adoption is also what ends the asset's eligibility: the candidate query is `macAddress IS NULL`, so a placed row drops out of the next pass entirely rather than being re-derived and re-compared forever. **The residual risk is real and deliberate**: a gate misresolved under rule 41, or an address recycled inside `CLAIM_FRESH_DAYS`, still adopts — the collision check catches the duplicate only when the other device is already in inventory.

**Nothing is cleared.** An address the network cannot currently account for is absence of evidence, not a move; the last known switch port stays until the chain places the device somewhere else.

### What it gives the form

The same change taught the Add Asset IP cross-reference the station table, with the two ways in that the sweep uses: by the resolved MAC, or by the address the AP itself recorded for the station. The switch-port line can only ever follow a MAC; the Wireless AP line is the one source on that panel that can place a device nothing wired has ever seen, and it says which path found it.

## Rule 46 — A device filter on an event automation filters the event's subject

**The invariant.** An `event` or `change` automation's `scope` decides which devices it fires about. `runEventTail` tests the Event's asset against `scopeMatchesAsset` for every rule whose scope names devices, ahead of the fired-this-event stamp; an event naming no asset, or one whose asset row is gone, is not a match for a filtered rule. An unconstrained scope (`scopeIsUnconstrained`: `{allAssets:true}`, `{}`, or an empty tree) fires about everything, exactly as before.

### The report

"The reboot event automation — I need to alert only for specific devices. When I change it to only be for specific devices and click save, there's no error message, but when I re-open it, it's back to all assets."

Both halves of that were true, and the silence was the design working as written. The wizard's Devices step rendered for every trigger, the condition builder accepted the filter, and its live preview obligingly listed the devices it selected — that preview asks the scope-only endpoint, which has never cared what the trigger is. Then `buildPayload` wrote `scope: isTriggerScoped(draft.trigger) ? draft.scope : {}`, and the trigger catalog said `{ type: "event", scoped: false }`. So the save posted `{}`, the server stored `{}` as a perfectly valid scope, and reopening the automation ran `Object.keys(scope).length === 0` → "All assets", checked. Nothing to error about: every layer agreed with itself, and the only thing that disagreed was the operator's intent, which had been dropped at the payload boundary.

### The second half nobody had reported

`change` triggers had carried `scoped: true` from the start, so the wizard saved their device filters faithfully — and the event tail ignored them just as completely, because it never consulted `scope` at all. A change automation narrowed to firewalls fired for every asset in the fleet. The two bugs are one missing test in one loop, which is why the fix is one predicate applied to both trigger kinds rather than a special case for events.

### Why an event automation is allowed to be about devices at all

The original reasoning for `scoped: false` was sound as far as it went: an audit event is not a reading, it has no asset scope to evaluate against, and many event automations watch things that are not assets — an integration's discovery run, a user's login, a backup, the host's disk. But "the trigger has no scope" and "the operator may not narrow it" are different claims, and only the first one was true. Most Event rows in this install DO name an asset (`resourceType: "asset"`), which is precisely why several of the twelve seeded event automations read as device alerts; `asset.rebooted` is one of them. Once an operator wants that alert for the core switches and not for 900 access points, the device filter is the only vocabulary in the product that says so, and it was already sitting on screen.

### The two refusals

**An event with no asset cannot pass a device filter.** `integration.discover.error` names an integration; a failed login names a user; capacity and backup events name this install. A filter that says "asset type is firewall" has nothing to compare those against, and the honest reading of "only these devices" is that a subject which is not a device is not one of them. So a filtered automation skips them, and an operator who wants both keeps the automation on All assets — which the Devices step now says out loud, because the surprise is real and the alternative is a filtered automation that silently keeps firing about things its filter never mentioned.

**A deleted asset is not tested.** The tail deliberately does not treat a null asset row as a skip — that is how `asset.deleted` reaches an alert at all, and swallowing it would silence the deletion audit trail. But a filter cannot be evaluated against a row that no longer exists, and guessing is worse than not firing: the alternative is a filtered automation firing about a device it may well have excluded. Filtered rules therefore lose the deletion event; unfiltered ones — including every seeded one — keep it.

### Why `{}` had to become its own question

`scopeMatchesAsset({}, asset)` is `false`, and correctly so: a scope the builder wrote with no dimensions and `allAssets` unchecked selects nothing, and the wizard refuses to save one for exactly that reason. But `{}` is also what the wizard wrote for **every event automation ever saved** before this change, and there it means the opposite — the operator picked All assets (or never touched the step) and the payload discarded the flag. Filtering the event tail on `scopeMatchesAsset` alone would therefore have silenced every existing event automation in the install, seeded and hand-written alike, the moment the code shipped. Hence `scopeIsUnconstrained` as a separate, first question, and hence its place in this rule: the next caller that filters on a scope has the same trap waiting for it.

### Cost at fleet scale

The scope test is in memory against the row the tail already primed for the alert text (`primeAssetDetailCache` — one `findMany` for the whole batch, added when a site-wide outage was serializing one point read per asset). "Does this scope constrain anything" is computed once per rule when the matchers compile, not once per event, so a 1000-event batch does not re-walk the same scope object a thousand times. Relation-backed filter leaves — interface name, SSID, FortiGate sighting — resolve through `decorateRelationLeafHits`, one query per distinct leaf for the whole batch and no query at all when no filter asks for one, the same contract the threshold path and `downDetectionService` use. The one new column on the primed select is `discoveredByIntegrationId`, which `scopeMatchesAsset` needs and the template fields did not already cover.

---

## Rule 47 — A PostgreSQL client is chosen by the server's major and verified before it is trusted, never spawned by bare name

**The invariant.** `pg_dump` refuses a server newer than itself. Anything in Polaris that spawns `pg_dump` or `psql` — `backupService` in the app, `deploy/update-linux.sh` in the fallback updater — resolves the binary by the server's MAJOR (`SHOW server_version_num` → `/usr/pgsql-<N>/bin`, `/usr/lib/postgresql/<N>/bin`, `C:\Program Files\PostgreSQL\<N>\bin`; a newer major accepted, an older one never; PATH last), runs `--version` on what it picked, and compares. A `pg_dump` behind the server refuses the backup with the sentence the operator needs — both versions, the path, the fix — as the error itself. `psql` restores across majors and only warns, so for it only "cannot be run" is fatal. The installers install PGDG's versioned client and check the major, `check:versions` flags a bare `dnf install -y postgresql`, and the Maintenance tab shows the resolved tools. `src/utils/pgClientTools.ts` is the pure implementation; `tests/unit/pgClientTools.test.ts` and `tests/unit/updateScriptsContract.test.ts` pin it.

### The report

"Update Failed — Cannot reach the npm registry: timed out after 45s." A screenshot of the Application Updates card, 2026-09-09, prod. The registry was fine (`npm ping`, 199 ms, from the exact systemd sandbox the updater runs in). The host was fine. The update was finished by hand through `deploy/update-linux.sh`, and the second thing that script does is take a backup:

```
pg_dump: error: server version: 15.18; pg_dump version: 13.23
pg_dump: error: aborting because of server version mismatch
```

Nothing about the update caused that. It had been true for months.

### What the host looked like

The server was PGDG PostgreSQL 15.18 with TimescaleDB 2.28 for PG15 — the stated minimum, the documented install, every declaration site consistent. Also installed: `postgresql-13.23` and `postgresql-server-13.23`, RHEL 9's *unversioned* AppStream packages, with an April `initdb_postgresql.log` next to an empty `data/` — the fossil of a pre-PGDG `setup-rhel.sh` that had installed AppStream Postgres, failed, and been superseded in May by PGDG 15 alongside it. The 13 packages were never removed, and the base `postgresql` package owned `/usr/bin/pg_dump` as a regular file — overwriting the alternatives symlink PGDG had registered.

`alternatives --display pgsql-pg_dump` said: *link currently points to /usr/pgsql-15/bin/pg_dump, priority 1500, best version*. `readlink -f /usr/bin/pg_dump` said `/usr/bin/pg_dump` — not a symlink at all. `rpm -qf` said `postgresql-13.23`. The alternatives system was reporting the state it believed it managed, and that report was false about the file on disk.

### Why four guards missed it

The PG15 floor was asserted in fourteen declaration sites and enforced by three mechanisms, and every one of them looked at either the server or a declaration:

- **The Platform Lifecycle card** reads `SHOW server_version` and grades it against `polarisMinimum`, with a real `below_minimum` state. It said 15.18. Correctly. The client binary is outside its field of view.
- **`check:versions`** reported "PostgreSQL 15 — 14 sites consistent". It validates declared pins, and `dnf install -y postgresql` in `setup-rhel-nodb.sh` declares nothing. The check's own warning text names the blind spot: *"Nothing here can disagree, so nothing here can be checked; the host decides."*
- **The installer guard** in `setup-rhel.sh` tested `command -v pg_dump`. Presence. A PostgreSQL 13 client satisfies it perfectly. The comment above the guard even said *"BACKUPS WILL FAIL until this is fixed"* — the right worry, tested against the wrong property.
- **`alternatives`**, as above.

And `backupService` spawned `"pg_dump"` by bare name, so the version that governed backups was whatever PATH resolved — a completely separate question from what version the server was, and one nobody had a reason to ask.

### Why nobody knew

A failing dump threw `"Database backup failed — see the server log for details"`. That is a defensible choice for a tool whose stderr can carry connection details — `pgEnv.ts` exists because the old backup route leaked the password through exactly that channel. But the one line `pg_dump` prints in this case names both versions and implies the fix, and it went only to the journal. The Application Updates card on prod showed *"Backup skipped (disabled in settings)"*: `update.skip_backup` was on, in front of a step the code itself calls irreversible. Whether it was switched off because backups kept failing or because an enterprise product covers the database, the effect was the same — prod had been taking updates with no recovery point Polaris could see, and the mechanism that would have said so was the one that was broken.

### The rule's three parts

**Resolve by major, not by name.** `resolvePgToolPath` walks the per-major install directories for the server's major and the five above it. Newer is fine — `pg_dump` dumps servers back to 9.2 — older is never a candidate. The bare name is the last resort and is flagged `source: "path"` so the caller knows the next step is load-bearing.

**Verify before trusting.** The choice is only as good as the file behind it, and this incident is the proof: a versioned path can be right while PATH lies, and PATH can be a 13 binary while every index says 15. So `--version` runs on whatever was chosen, `parsePgToolMajor` reads it, and `pgClientCompatible` applies the asymmetry — `pg_dump` needs client ≥ server, `psql` does not.

**Say the specific thing.** `describePgClientMismatch` is the sentence that would have ended this in a minute: *pg_dump is PostgreSQL 13 (/usr/bin/pg_dump) but the server is PostgreSQL 15 … dnf install postgresql15 … rpm -qf /usr/bin/pg_dump*. It is the AppError, not a log line behind a generic one. The version mismatch carries no credential and no connection detail, so the reason for the generic message does not apply to it.

### The same lesson, four files late

`setup-rhel.sh` had already learned the versioned-package lesson for the *server* — its comment says a fresh install used to get PostgreSQL 13 and "was not even installing the right major". `setup-rhel-nodb.sh`, its sibling for external databases, still ran `dnf install -y postgresql` for the client. The updater script's rollback restored a Timescale database without the gates `backupService` had learned to run in 2026-08. The updater's `git rev-parse` ran as root and had been silently returning "unknown" since it was written. The pattern of the afternoon was a lesson learned in one file and never carried to the file next to it, and this rule exists so that the next place that spawns a PostgreSQL client has something to cite.

### The next place that spawned a client was CI

2026-09-10, and the shape is the one the paragraph above predicted. The `integration` job in `docker-publish.yml` had been pinned to a `postgres:17-alpine` service container since the stack moved to 17 — but it dumped that container with the *runner image's* client, which is PostgreSQL 16 on ubuntu-24.04. So `backupRestore.test.ts` began failing on `describePgClientMismatch`: the guard working exactly as designed, against an environment nobody had moved alongside the server.

What made it expensive was not the failure but where it landed. `build` declares `needs: [test, integration]`, so the job was reported **skipped** rather than failed — no image published, `main` moving on looking green, and this workflow being the only thing that runs the suites at all. Three unrelated breakages hid behind that for 200 commits.

The fix is the one this rule has always prescribed: install the client by name for the server's major. `pgToolCandidates` probes `/usr/lib/postgresql/<major>/bin` first, so nothing else was needed — no `PATH` edit, no override — and CI now exercises the same `source: "versioned-dir"` resolution production does, instead of the PATH fallback it had been silently testing. Both majors are registered as agreement sites, because "the CI client and the CI server are in the same file" is exactly the kind of thing that looks impossible to get wrong and was already wrong.

### The day after

The operator did the fix: removed the AppStream 13 packages. The next `update-linux.sh` run stopped at *"pg_dump not found (looked for a PostgreSQL ? install and on PATH)"* — with `/usr/pgsql-15/bin/pg_dump` on disk. The `?` is the tell. The script learned the server's major by running `sudo -u postgres psql`, and `psql` by bare name was `/usr/bin/psql`, which the 13 package had owned and taken with it (`alternatives --auto` had not been run). No answer, so `resolve_pg_tool` skipped the versioned directories it exists to search and went straight to a PATH that had nothing either. The TypeScript twin had the same shape — `if (serverMajor != null)` around the scan — hidden only because the app reads the version through its own connection.

Two amendments. The probe borrows each versioned `psql` to ask the question when PATH's cannot. And when the question still has no answer, both twins take the *newest* versioned client before PATH: a newer `pg_dump` is accepted and an older one is refused by the `--version` check either way, so the order only decides how often that check says no. "Falls back to PATH only when nothing versioned exists" was the rule from the start; the unknown-major branch just had not been made to obey it. The host most likely to have no `psql` on PATH is the one that has just followed this rule's own fix — a resolver that fails exactly there is a resolver for the case that never happens.

---

<a id="rule-48"></a>
## Rule 48 — Nobody hands out authority they do not hold

**The invariant.** Admin-equivalence is `users=fullwrite AND roles=fullwrite`. A caller who does not hold it may not create it — not on a role, not on a user. `assertNoPrivilegeEscalation` refuses with a 403 at `POST /roles`, `PUT /roles/:id`, `POST /users` and `PUT /users/:id/role` whenever the target permission set is admin-equivalent and the caller's own is not.

### How it was found

Aikido's AI pentest reported it twice from two directions — "Users write permission allows arbitrary assignment of an admin-equivalent role" (sev 86) and "Users with `roles=write` can grant themselves admin-equivalent permissions" (sev 82) — which is the useful shape of the finding: they are one hole with two doors, and fixing either alone leaves the install exactly as open.

### Why the existing guards did not cover it

Three things looked like they were already guarding this, and none of them were.

`requirePermission("users", "write")` gates the user routes, and `write` sits a rung below `fullwrite` — so the ladder *described* a lesser grant while the route behind it could mint the greater one. The whole point of rule 43's ladder narrowing is that a grant is only as narrow as the act it names, and here the act was "create an administrator".

The **lastAdminEquivalent** guard reads like an admin-tier guard and is the one thing in the file that already called `isAdminEquivalentRole`. But it only fires when a user is moving *out* of the tier, and only to protect the last one: it is a guard against locking yourself out, not against letting yourself in. It has to stay, and it covers none of this.

The **self-edit checks** — "You cannot delete your own account", "You cannot change your own role" — look like escalation guards and are the easiest of the three to over-trust. They only constrain the actor's own row, and the escalation does not go through it. With `users:write` the shortest path was `POST /users`: create a brand-new account on the Administrator role with a password of your choosing, then log in as it. No existing account is touched, so no self-check is consulted, and the audit trail records an ordinary user creation.

### Why the predicate is shared rather than re-stated

`isAdminEquivalentPermissions` already existed in `permissions.ts`, where it ranks roles for the group-mapping "highest privilege wins" tie-break, and `roleService.isAdminEquivalentRole` is the same test against a stored row. Adding a third spelling of "users and roles at Full RW" would have meant that the answer to *which role wins an SSO mapping* and the answer to *who may grant that role* could drift apart, and a drift in that direction is silent. So the caller-side check reuses the same function, and the difference between the two is only where the permissions come from — a stored `Role` for the target, the request's role snapshot for the caller.

### The snapshot, and failing closed

The caller's level is read from `req.roleSnapshot` first and `req.session.roleSnapshot` second — the same order `hasPermission` uses — so a role-bound bearer token is held to the same bar as a browser session rather than sliding past a session-only check. A request that has resolved no snapshot at all is treated as **not** admin-equivalent. That is the direction to fail in: the cost of failing closed is a 403 an administrator can explain, and the cost of failing open is the entire finding, reintroduced by any future path that reaches these handlers without `requirePermission` having run.

### What it deliberately does not do

It is not a four-eyes rule. An administrator granting administrator is the normal way an install gets its second admin, and blocking it would be a different (and much more disruptive) policy than the one the finding asks for. It also does not touch server-side provisioning: `ssoProvisioning` maps an IdP group onto a role with no human actor in the request to test, and the seed creates the first administrator before anyone exists to be escalated. Both are outside the rule by construction, not by exemption.

<a id="rule-49"></a>

## Rule 49 — An upgrade never refuses for want of a credential it can find itself, and never records one it has not proved

**The invariant.** `resolveUpgradeCredential` decides what an agent upgrade connects with: the operator's explicit `credentialId`, else the row's `installCredentialId`, else the Polaris-managed SSH deployment credential for that platform. The transport comes from the credential's `type`, not from the row. An adopted credential is written back onto the row only after the upgrade succeeds.

### How it was found

A Windows server sat on agent 0.17.1 while the current build was 0.17.3. Pressing **Upgrade** returned `No install credential on file for this agent; pass credentialId explicitly.` The operator had just run the SSH-Deployment onboarding script on that host through Azure Arc and seen it report success, which made the refusal read as a bug in the thing they had only just fixed.

Two separate things were true, and neither was visible from the panel.

### Why the row had no credential

`ManagedAgent.installCredentialId` is written at install time and never afterwards — no later path repoints it — and its foreign key is `ON DELETE SET NULL`. That is deliberate (a deleted credential must not block removing a stuck agent), but it means deleting one credential silently strands every agent installed with it. The other road to null is age: migration `20260514010000` added the column with no backfill, so every install older than it has carried a null since.

### Why it stayed stranded

The refusal was thrown by `startUpgrade` **before** it touched `installStatus`. So the row never became `upgrade_failed`; it stayed `active`, stayed inside `upgradeAllOutdated`'s filter as out-of-date, and was re-skipped by every subsequent fan-out — including the auto-upgrade hook that runs after each new build. `upgradeAllOutdated` caught the throw into `perAsset[].error` and moved on, writing no Event and no `installError`. Nothing anywhere said this host was being passed over. It would have sat on 0.17.1 until someone pressed the button by hand and read the message, which is exactly how it was eventually found.

### Why the onboarding script did not help, and why the obvious fix would not have either

The Arc dispatch authorizes the deployment key on the host. It does not touch the ManagedAgent row, and the toast reports *dispatch* — Azure runs the script asynchronously afterwards, which is why that dialog has a **Check outcomes** button.

The obvious repair — fall back to the managed deployment credential — fixes nothing on its own. Migration `20260609000000` backfilled `installTransport='winrm'` onto **every** pre-existing Windows row, and the managed credential is key-only. Honouring the row's transport would hand a passwordless credential to `winrmConnectionFromCred`, which refuses with "WinRM credential is missing username or password". The rows that most need the fallback are precisely the rows carrying that backfilled `winrm`.

So the transport follows the credential's **type**. That is not a special case for the fallback: the install routes already refuse a credential whose `type` does not match the chosen transport, so for a healthy row the two always agree and the change is a no-op there. It is the row's column that is the derived, drifting copy.

### Why adoption waits for success

Rewriting `installCredentialId` and `installTransport` at kickoff would be a guess written down as fact. A Windows box that genuinely only speaks WinRM, and never had the deployment key authorized, will fail to connect over SSH — and if the row had already been repointed, the operator's recorded install credential would have been replaced by one that demonstrably cannot reach the host. Writing on success only means reaching the host is the proof. The failure path leaves the row exactly as it was and lands as `upgrade_failed`, which is itself an upgradeable status (see rule under `UPGRADEABLE_INSTALL_STATUSES`), so the next fan-out retries it.

An explicit operator override is never adopted, even when it works. Polaris records what it chose, not what it was told; adopting an override would turn a one-off "use this credential just now" into a permanent change to the row that the operator never asked for.

### What stays strict

An explicit `credentialId` that does not resolve is still an error — someone who names a credential gets told it is wrong rather than quietly connected with a different one. A WinRM credential on a non-Windows agent is refused. And the rule is scoped to **upgrade**: install, reinstall and uninstall still require a credential on file, which is why the agent table's Reinstall button is still disabled on `hasInstallCredential: false` and force-remove is still the way out.

### The silence itself was the bug

Even with the fallback, a row can still be unupgradeable — no credential, and no deployment keypair ever generated. That now writes an `agent.upgrade_skipped` Event against the asset with the version it is stuck on, and logs a warning. The credential fallback fixes the common case; the Event is what stops the uncommon one from hiding for another two releases.
<a id="rule-50"></a>

## Rule 50 — A response the app did not write is a response with the app's headers missing

The first DAST scan of Polaris (HawkScan, 2026-09-10) returned one Medium finding, and it was
not on any route anyone had written: **CSP: Wildcard Directive**, on `/robots.txt` and
`/sitemap.xml`. Neither path exists. That was the point.

Nothing handled unmatched routes, so they fell through to Express's built-in `finalhandler`,
which does not merely answer 404 — it **replaces** the `Content-Security-Policy` that
`buildHelmetOptions()` had already put on the response with its own `default-src 'none'`. That
looks stricter, and for fetches it is. But `frame-ancestors` and `form-action` do **not** fall
back to `default-src`: with them absent, framing and form submission are unrestricted. So every
404 the app produced advertised a weaker policy than every route that matched, and the two
states were invisible to each other — the headers on a working page proved nothing about the
headers on a missing one. `finalhandler` also echoed the request into its HTML body ("Cannot GET
/robots.txt"), reflecting caller-controlled text back.

The fix is one middleware, mounted after the `/api/v1` router: `next(new AppError(404, "Not
found"))`. `errorHandler` then answers it like every other failure, which means helmet's headers
stay and the body is the app's usual `{ error }` JSON. The message is a constant — the handler
never builds it from the path or the method, so nothing the caller sent comes back.

**Under `/api/v1` the answer is deliberately different.** `requireAuth` is mounted on the API
router ahead of any route match, so an unknown API path answers **401** to an anonymous caller,
and only an authenticated one reaches the JSON 404. That is not an inconsistency to iron out:
the API does not tell an anonymous caller which endpoints exist.

**The same invariant has an edge half, and it is where most of the scan's findings lived.** Of
the four findings, three were headers and only one was in Node:

| Finding | Where it lived |
|---|---|
| CSP: Wildcard Directive (Medium) | `src/app.ts` — the `finalhandler` fall-through above |
| Strict-Transport-Security Multiple Header Entries | `deploy/nginx/polaris.conf` — the edge and helmet both emitted it |
| Server leaks version information | `deploy/nginx/polaris.conf` — `server_tokens` |
| Cookie without HttpOnly (`polaris_csrf`) | by design — see below |

nginx now emits HSTS itself and `proxy_hide_header`s the upstream's copy. Two
`Strict-Transport-Security` headers is not "defense in depth": RFC 6797 §8.1 says a UA that
receives more than one processes **only the first** and the response is non-compliant, so the
comment in that file claiming browsers "take the strongest seen" was wrong as well as moot.
helmet keeps setting it, because that is what protects an install running Node's own TLS with
no proxy in front. `server_tokens off` stops handing a scanner the exact nginx build; it still
sends a bare `Server: nginx`, since dropping the header entirely needs a third-party module.

**The `polaris_csrf` finding is a false positive and must stay one.** It is the double-submit
CSRF cookie; same-origin JavaScript in our own pages has to read it to echo it in
`X-CSRF-Token`. `HttpOnly` on that cookie would not harden anything — it would disable CSRF
protection. The session cookie `connect.sid` is `HttpOnly`, which is the one that matters.

**A scan aimed at the app alone cannot see the edge half.** `npm run dev` on :3010 has no nginx
in front of it, so three of these four findings are structurally invisible to a direct scan and
it reports the proxy clean. `deploy/nginx/README-scan-harness.md` exists for exactly this: it
fronts a dev instance with the shipped directives so they are in the response path. It also
records the one setting the harness must not omit — `TRUST_PROXY=1`, without which Express
ignores `X-Forwarded-Proto`, `req.secure` stays false, and every cookie loses its `Secure`
flag, manufacturing a finding that does not exist in any real proxied install.

Guard: `tests/integration/notFoundHeaders.test.ts` asserts the status, the JSON shape, the
absence of the reflected path, and that a 404's CSP is byte-identical to a matched route's — a
plain status assertion would still pass with `finalhandler` back in place.

<a id="rule-51"></a>

## Rule 51 — `DATABASE_URL` is a driver URL; its `sslmode` value is translated into the libpq vocabulary, never copied

`utils/pgEnv.ts` exists because `pg_dump` and `psql` used to take the connection string as an
argv element, which put the database password in `ps aux`. The fix — decompose the URL into
libpq's `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` / `PGSSLMODE` — was
right, and it carried one assumption that was not: that a parameter shared by name between the
two connection vocabularies is also shared by value.

It is not. `DATABASE_URL` is read by **node-postgres** (under `@prisma/adapter-pg`), and
node-postgres accepts `no-verify`, meaning "encrypt, do not validate the chain". libpq has no
such value. Its `sslmode` takes exactly `disable`, `allow`, `prefer`, `require`, `verify-ca`,
`verify-full`, and anything else is a hard error before a connection is attempted:

```
pg_dump: error: invalid sslmode value: "no-verify"
```

**Polaris itself is the producer of that value.** The first-run wizard's "Allow self-signed
certificate" toggle writes it (`setup/setupRoutes.ts → buildConnectionString`), and that is
correct and stays — the URL's consumer is the driver, and `no-verify` is the only value in the
driver's vocabulary that expresses "TLS against a self-signed server". The bug was never the
wizard; it was copying its output into a different program's vocabulary.

**What it cost.** On a Docker/Unraid install created through the wizard with that box ticked
(2026-09-11), every path that spawns a client tool failed: the manual backup button, the
scheduled backup job, the pre-update backup inside `updateService`, and restore, which takes
the same PG* overlay through `psql`. All four surfaced as
`Database backup failed — see the server log for details`; the real sentence was in the
container log and nowhere else. The install had therefore been taking in-app updates with **no
rollback point** for as long as it had existed, which is the part that makes this worse than a
broken button.

**Why no scripted install ever saw it.** `deploy/update-linux.sh` — the shell twin that runs
the same pre-update dump on RHEL and Ubuntu — connects as the local `postgres` OS user over a
unix socket via peer auth and never constructs a URL, so it has no `sslmode` to mistranslate.
The failure needs a connection URL, which in practice means a remote database or a container
deployment. A green scripted install, and a green CI run against a plaintext
`postgres:17-alpine` service container, are both structurally incapable of catching it.

**The shape of the fix.** `libpqSslMode(value)` translates rather than forwards: `no-verify`
→ `require`, which is not a downgrade — only `verify-ca` and `verify-full` validate the
certificate chain, so `require` is the exact libpq spelling of what `no-verify` asked for. An
unrecognized value **throws a named AppError** rather than being dropped, and that choice is
the load-bearing one: dropping `PGSSLMODE` would let libpq fall back to its `prefer` default,
so an operator who asked for TLS would get opportunistic TLS, a backup that may have crossed
the network in the clear, and no indication that anything had been reinterpreted. A refusal
that names the offending value is recoverable; a silent downgrade of a security parameter is
not.

**Its relationship to rule 47.** They are the two halves of the same question and neither
checks the other. Rule 47 asks *can the client binary we chose work against this server* —
majors, install dirs, `--version`. Rule 51 asks *are the parameters we are handing it in its
own vocabulary*. Rule 47's machinery ran perfectly here: it found `postgresql-client-17`,
compared 17 against the server's 15, judged it compatible, and spawned it — and the child died
on its connection string. Both failures hid behind the same operator-facing sentence, and both
were found only by reading the log the sentence points at.

Guards: `tests/unit/pgEnv.test.ts` pins the translation, the full libpq value set, the
case/whitespace handling, and the refusal (including that the message names the offending
value). Anyone reverting `libpqSslMode` to a passthrough fails them.

<a id="rule-52"></a>

## Rule 52 — TimescaleDB is part of the install, not a tuning option

Two statements lived in the repository at the same time and could not both be true.

`services/backupService.ts`'s own header asserted that "every documented production install
enables TimescaleDB" — which is why the restore path wraps itself in
`timescaledb_pre_restore()` / `timescaledb_post_restore()` (rule 20c), and why the capacity
card's disk forecast assumes chunk-drop retention and ~10× compression. Meanwhile
`docs/INSTALL.md` filed the extension under *Recommended: TimescaleDB*, in a section most
operators never reached, and **no install path installed it**. `setup-rhel.sh` and
`setup-ubuntu.sh` named `timescaledb` only in comments — as the reason they choose the PGDG
repository over RHEL's AppStream — and then never installed the package the comment was
justifying. A fresh scripted install therefore landed on plain PostgreSQL, and the one of the
two statements that was false was the one operators were actually living in.

The consequences were not cosmetic, and none of them announced itself. Retention pruned row by
row instead of dropping chunks. Nothing compressed, so the steady-state size projection on the
Maintenance tab was wrong by an order of magnitude in the direction that matters. The restore
gates ran against a database with no extension to gate, so the rehearsal proved something other
than what would happen in a real restore. And the one signal that could have surfaced it — the
`timescale_recommended` reason in `capacityService` — was gated at 1 GB of sample tables, so a
new install stayed silent for exactly as long as it took to accumulate the data whose storage
was the problem.

### Why the scripts are the only place this can happen

`CREATE EXTENSION timescaledb` requires superuser. The Polaris application user deliberately is
not one, so the app can never fix this about itself — it can only ever **detect**. That
asymmetry is the whole shape of the rule: provisioning belongs to the setup scripts, which run
as root and own the database server, and the app's job is to say loudly that provisioning did
not happen.

So each step in `setup-rhel.sh` / `setup-ubuntu.sh` **errors out rather than warning**: install
`timescaledb-2-postgresql-17` and `timescaledb-tools`, run `timescaledb-tune` (which is what
writes `shared_preload_libraries` — without it the extension is installed and cannot load,
the most confusing of the failure states), try-restart PostgreSQL so a re-run picks the config
change up, then `CREATE EXTENSION` on the polaris database. An install that comes up without
the extension is one whose disk forecast and restore rehearsal are both wrong, which is not a
condition worth continuing past.

The two `-nodb` scripts are the deliberate exception. They do not own the database server —
that is what `-nodb` means — so they attempt the create and warn with the consequence and the
managed-service caveat, rather than aborting a host they have no way to fix from.

`detectTimescale()` now logs the absence at **error** level rather than an info line reading
`installed:false`. On an install Polaris provisioned, a missing extension does not mean "the
operator chose not to"; it means something removed it.

### What the plain-table path is now

The plain-table code path stays, and keeping it is not a hedge on the rule. It is two specific
things: the degraded state of an **external or managed database** that cannot offer the
extension at all (RDS for PostgreSQL, Aurora and Cloud SQL have no TimescaleDB; Timescale
Cloud, Crunchy Bridge and Azure Postgres Flexible Server do), and the **fallback when
`drop_chunks` fails on a table that IS a hypertable**. Neither is a supported way to run an
install Polaris provisioned.

`capacityService`'s `timescale_recommended` reason therefore lost its size gate entirely. It
fires at zero bytes; the 1 GB threshold survives only to choose between `watch` and `warning`,
and the sub-1 GB message says what is actually wrong ("Polaris requires it: retention prunes
row by row, nothing compresses, and the restore gates do nothing") rather than quoting a
storage figure that is not yet alarming.

### The corollary for host-fact probes

Anything that reports the extension as a **host fact** must distinguish "absent" from "could
not tell". `services/haService.ts` → `probeHostFacts()` shells out to `rpm -qa` for
`timescaledb-2-postgresql-*`, and its catch used to be annotated `/* Timescale is optional */`.
It never was optional in the sense that comment implied, and after this rule it is not optional
in any sense: the only way that catch fires is `rpm` itself being unavailable or failing, which
is a fact about the probe and not about the host. A null `tsdbVersion` means **nothing to
compare** — which matters because the figure exists to catch a version skew between the two HA
nodes, and the surrounding comment already warns that a silent "none" on both sides looks like
agreement.

### Not yet proven on a host

The scripted half of this rule has never been run end to end: no RHEL or Ubuntu box was
available when it landed on 2026-09-11. `bash -n` passes on all four scripts and the capacity,
timescale and lifecycle unit tests cover the app half, but **a fresh-install smoke on one
platform is still outstanding**, and until it happens the strongest claim available is that the
scripts are syntactically sound and say the right things.
<a id="rule-53"></a>

## Rule 53 — A device a run could not read keeps the data it already had, so it is named, never folded in with one the run skipped

An 1801F HA pair in production showed pre-upgrade firmware. The FortiGate answered every
monitoring poll. FortiManager was healthy, had the pair online, and showed the correct
version in its own device record. Nothing was broken anywhere an operator could see, and the
firmware had been wrong for weeks.

A firewall's `Asset.osVersion` has exactly one writer: the FMG/FortiGate discovery pass, which
upserts the `fortigate-firewall` AssetSource and projects it. There is no second path. SNMP
cannot help — `parseVendorSysDescr` knows one vendor's sysDescr layout and it is not Fortinet,
so a FortiGate polled over SNMP contributes no `snmp-sysdescr` row at all. And the projection
write is deliberately guarded:

```ts
if (fwProjected.osVersion !== null) updateData.osVersion = fwProjected.osVersion;
```

That guard is correct and must stay: it is what stops a mid-rejoin scrape with no version from
BLANKING a good one (the 2026-07-14 FortiAP incident). Its unavoidable other edge is that a
device nothing read this cycle is indistinguishable, at the write site, from a device read
successfully that had nothing new to say. Both leave the old value in place.

So the question is never "why did the value not change" but "did anything read the device at
all" — and in direct mode the answer was no, every run, for one specific reason.

### Why the gate was never read

Direct mode resolves each FortiGate's management IP from two producers. The warm cache
(`buildFmgWarmCacheIps`) supplies monitor-up firewalls from their own `Asset.ipAddress` with no
FMG round-trip; `resolveDeviceMgmtIp` handles the rest. `processDevice` reads the result by
`fmgNameKey(deviceName)` — **FortiManager's** name for the device.

The warm cache was keyed on `Asset.hostname` — the gate's own `system global hostname`. Those
two names are under no obligation to match, and on this estate at least one gate was already
known to diverge. This is the mismatch `utils/fortinetParentKey.ts` exists to prevent, in a
shape that file did not list: not a child's stamp resolved to a parent, but **a map built from
Asset rows and read back by FMG device name**. Every divergent gate's entry was filed under a
key nothing ever asked for.

A warm-cache miss is supposed to be a slowdown, not a failure — that is what the resolver is
for. But `resolveDeviceMgmtIp` reads exactly one interface, the one named by the integration's
fleet-wide `mgmtInterface` setting, out of `/pm/config/device/<name>/global/system/interface`,
and `_extractV4` rejects `0.0.0.0`:

```ts
if (!ip || ip === "0.0.0.0" || !isValidIpv4(ip)) return null;
```

`0.0.0.0` on a dedicated management interface is the **normal** state of a FortiGate HA
cluster. The per-member management addresses are not in `system interface`; they live under
`config system ha` → `set ha-mgmt-interfaces`, which this query never reads. A standalone 61F
has a real address there and resolves fine. An HA pair does not.

Two misses, and `processDevice` logs `discover.device.skip` at error level and returns null.
The gate is dropped from the entire run — no firmware, no subnets, no leases, no switch or AP
roster — and everything it had stays exactly as it was. The next run does the same thing.

### Why nobody noticed

Monitoring never uses either of those inputs. `buildFortinetConfig` dials `Asset.ipAddress` and
prefers a per-asset REST credential over the integration-level token. Different address,
different credential, different code path. The pair polled green the whole time.

**"It is being monitored fine" is not evidence that anything has read it.** The two answer
different questions, and on this estate they routinely answer differently.

The skip was not invisible, exactly — `onProgress` persists every progress line as an Event, so
`integration.discover.device.skip` was on file. It was just unfindable: one Event among the
thousands a run writes, filed under the *integration* rather than the gate, with nothing on the
asset itself to suggest it had gone unread. The count reached the UI and was then thrown away —
`/discoveries` lists only *running* runs, and both surfaces summed the two skip kinds into a
single "skipped" figure. That summing is what finished the job: **offline is routine here.**
Staged gates awaiting site deployment sit offline in FMG for weeks with cloned configs, and
discovery reads their cached CMDB on purpose. An operator who sees "3 skipped" on this fleet is
right to read it as "3 staged gates", which is exactly what it usually is.

### The rule

Both halves are load-bearing, and the second is the one that survives the next bug of this
shape rather than this specific one:

- **Never sum the two skip states.** `skippedOfflineCount` is a device the run decided not to
  read. `skippedErrorCount` is a device the run *could not* read. They have opposite
  implications for whether the data on screen is trustworthy. `public/js/app.js` and
  `public/js/widgets/discoveryActivity.js` render them as separate `· N offline` /
  `· N unread` parts.
- **Name the unread ones.** `RunAccumulator.skippedErrorDevices` collects the device behind
  each error increment, and `runDiscovery` writes one warning-level
  `integration.discover.devices_unread` Event before the abort/complete branch — first 20
  names plus "and N more", the full list in `details.devices`. In memory rather than a column:
  the run that collects the names is the run that writes them, so a persisted field would have
  exactly one reader.
- **A completion retracts an earlier error for the same device.** `processDevice` logs its
  first direct-REST failure *before* deciding whether to re-resolve the mgmt IP and retry, so a
  gate that fails once and then succeeds was being counted as skipped. Without the retraction
  it would be reported unread despite having been read perfectly, and `done` (completed +
  skipped) would exceed the device roster.

### Two fixes that look obvious and are forbidden

Both were considered and both are already ruled out elsewhere in the codebase's documented
decisions:

- **Falling back to `rawDevice.ip`.** FMG's device-record `ip` field can be a public or NAT
  address; it is what FMG uses to reach the device, not what Polaris should. The mgmt-IP
  resolver reads `system interface` for exactly this reason.
- **Falling back to the FMG proxy transport.** Direct mode fails loudly per-device on a
  precondition failure by design. A silent fallback turns "I disabled proxy" into "I disabled
  proxy except when something else is wrong, in which case it silently re-enables itself and
  overruns FMG's session limit".

Fix the key, or surface the skip. The fix here was both: the warm cache is now keyed on
`fortinetTopology.deviceName` with the hostname as an alias (every device name claimed before
any alias, so one gate's hostname cannot displace another's real name), and the unread gates
are named at the end of every run.

Guard: `tests/unit/fmgWarmCacheKeying.test.ts` covers the divergent-name case, the cross-gate
name collision, case-insensitive dedup against `fmgNameKey`, and the missing-stamp fallback.
<a id="rule-54"></a>

## Rule 54 — A region tag dies when its name is retired, and only then

Two strip paths already existed for `region:<name>` tags, and between them they covered
everything except the case that actually bit.

The reconcile (`applyOneRegion` → `diffRegionMembership`) removes the tag from a target that
has drifted out of membership, bounded by a `RegionTagAssignment` provenance row so that a
hand-applied tag is never destroyed. The map-save review adds a second, deliberately narrow
pass (`stripOutOfRegionFirewallTags`) that judges a coordinate-carrying FIREWALL against a
polygon that still exists, provenance or not, because for a pinned gate the polygon already
implies the tag in the add direction. Both are about a device that MOVED.

Neither can see a tag whose *region name* moved out from under it. Provenance is keyed by
region **id**: a rename does not change the id, so the rows still point at a live region and
say, correctly, "this asset is still a member" — of a region that is now called something
else. A delete drops the provenance entirely. And the gate pass explicitly leaves "a
`region:` tag naming no current region" alone. So the moment a rename or delete finished the
blob write but failed the tag rotation, the leftover tags entered a state no code path in the
application could reach.

That is not hypothetical. `updateRegion` commits the renamed blob inside its own locked
transaction and returns; `applyRename` then runs *outside* it. On prod in 2026-09 the tag
rotation threw there — an unchunked `$transaction` holding an update per row, over a region
covering ~1,100 assets — twice, under two names. The result was 1,492 asset tags and 114
subnet tags reading `region:Eastern Middle Tennessee` and `region:Middle Tennessee` while the
map showed "Middle Eastern Tennessee" and "Middle Tenneessee", invisible to every reconcile,
and cleaned up in the end by hand-written SQL against the production database. The
`region.scope_tags_renamed` half had not run either, so scoped operators were pointing at
region names nothing answered to — silently, since a scope naming no region scopes nothing.

### Why not just strip every tag that matches no region

Because the standing contract is explicit that manual attachments and tags predating
provenance "persist across runs forever", and a background job that quietly deleted them would
be a worse bug than the one being fixed: unlike a stranded tag, a destroyed one leaves no
evidence it was ever there.

When this rule was written, making one was easy. `PUT /assets/:id` accepted `tags: string[]`
and wrote it as given; the `Tag` registry refused hand-created rows in the "Map Regions"
*category* but never checked the NAME, so `region:Narnia` filed under "General" was accepted —
and since the auto-assign device-filter ban was keyed on category too, that was also the way to
get a `TagAutoAssignment` filter onto a `region:` name, i.e. two managed-sync reconcilers on one
string, which is exactly what that ban exists to prevent.

Both doors are shut now. The registry refuses the prefix by name in every category
(`assertNotRegionPrefix`), and asset writes run `assertAddedRegionTagsNameARegion` — a **diff**,
not a ban, because the edit modal PUTs the whole `tags` array back and a blanket refusal would
make every asset in a region unsaveable, and because hand-applying a *live* region's tag to a
device its polygon misses is documented behavior that has to keep working.

That does not retire this rule, for two reasons. Neither guard is retroactive and neither
touches `Asset.tags` in the database, so on any install with history "matches no region" and
"was retired by Polaris" still describe different sets — and the whole point of the sweep is
the install that already has the mess. And the guards live at the route: anything writing
through a token, a future import path, a migration, is one missed validation from putting the
prefix back in play. Bounding the sweep by evidence does not depend on every write path
staying correct forever.

So the sweep is bounded by **evidence rather than absence**. `mapRegionRetiredNames` is a
companion Setting blob holding `{name, regionId, retiredAt, reason}`, and a name lands on it
in the *same locked transaction* that renames or deletes the region — before the tag rotation
is even attempted, which is precisely why it survives a rotation that dies. A tag is swept
only when its name is on that list. A tag naming a region that never existed is not, and never
will be.

### The rest of the shape

**A reclaimed name is not stripped.** If a region is live under a retired name again — deleted
and redrawn, which the delete route already treats as the likely intent when it leaves
principal scopes in place — the name is dropped from the list untouched and the ordinary
reconcile owns those tags from there. Matched case-insensitively, like every other region-name
comparison.

**A failed strip keeps its name.** The sweep catches per name and leaves an unresolved one on
the list. Dropping it would be the original bug again, one pass later.

**The strips run outside the blob lock; only the bookkeeping takes it.** Holding the advisory
lock across thousands of row updates would block every region write for the duration — the
same mistake the rename path made in the other direction. The list rewrite re-reads inside the
transaction and removes only the names this pass finished, so a rename that retired a name
while the sweep was running is not discarded. That is rule 20a's lost-update shape applied to
the second blob, and it is tested the same way.

**It is not retroactive.** An install that stranded tags before this shipped has no
retired-name row for them and the sweep will not touch them. Those need one cleanup, which is
the query that found the prod case:

```sql
WITH live AS (
  SELECT 'region:' || (r->>'name') AS tag
  FROM settings s, jsonb_array_elements(s.value) r
  WHERE s.key = 'mapRegions' AND jsonb_typeof(s.value) = 'array'
)
SELECT t AS orphan_tag, count(*) FROM assets a, unnest(a.tags) t
WHERE t LIKE 'region:%' AND t NOT IN (SELECT tag FROM live)
GROUP BY t;
```

Read the result before stripping anything: this query cannot tell a stranded tag from a
hand-applied one, which is the entire reason the automated sweep does not work this way.

Guards: `tests/unit/mapRegionRetiredSweep.test.ts` pins both halves — that a rename and a
delete record the name, that a polygon-only edit does not, that an unretired name is never
swept, reclamation, retry-on-failure, and the racing-writer case. The chunking that removed
the original trigger is pinned separately by `tests/unit/mapRegionTagChunking.test.ts`.

<a id="rule-55"></a>

## Rule 55 — An address places a device behind a gate only when nothing has seen it, and every surface says which answer it got

**The invariant.** IPAM is the last source consulted for a device's upstream FortiGate, never a replacement for evidence. `resolveOwningGateContexts` (`services/ipUpstreamChainService.ts`) is the one implementation of "which gate is this address behind" — containing subnet → `fortigateSerial` then `fortigateDevice` through `utils/fortinetParentKey.ts`, rule 41's precedence, never a hostname match — and it has three consumers: the rule 45 sweep scoping its ARP lookup, `assetUpstreamService` answering the Last Seen Firewall row, and `dependencyTreeService` placing an otherwise unparentable endpoint. The two new consumers are strictly fallbacks, each labelled, each gated on the claim being current under rule 40.

### What was missing

The Last Seen Firewall row is fed by the freshest `AssetFortigateSighting`. A device no gate has ever reported — an Active Directory workstation, an Azure Arc server, a vCenter VM, an active-scan find, a hand-typed row — has no sighting, so the row read `-` forever, even where Polaris held the subnet its address sits in and knew which FortiGate owns that subnet. The same gap ran deeper than cosmetics: `syncEndpointDependencyEdges` uses that same sighting as its third and last tier, so an endpoint with no switch, no AP and no sighting got no dependency parent at all. "No parent" means "never suppressed", so when its site gate went down, every switch and AP behind that gate correctly read "Dep. Down" while the servers behind it alerted device by device as plain Down — the alert storm the endpoint half was built to stop, still happening to the assets least able to prove where they live.

### Why it goes last, and why that makes it safe

A sighting is a record: a gate reported this device. The IPAM answer is an inference: this address belongs to a network, and that network is served by this gate. They are not the same claim, and a row headed "Last Seen" must not present the second as the first — so the entry carries `source: "subnet"` and the containing `subnetCidr`, and deliberately carries NO `lastSeen`. An inference has no moment. The UI prints "(owns 10.42.8.0/24)" beside the name rather than a timestamp.

Ordering last is also what bounds the blast radius on the alerting side. The tier is consulted only for endpoints the three observed tiers left unplaced, and an unplaced endpoint has no parent — so this can only ever ADD a parent, never move an existing edge somewhere less accurate. The failure mode is therefore a missed alert (a device held in Dep. Down behind a gate it does not really sit behind), never a false one, and even that requires the gate to be CONFIRMED down under rule 38's asymmetric hysteresis rather than merely flapping.

### The two refusals

**A stale claim is not an address.** The endpoint's claim on its address must be current under rule 40's model — operator-owned never expires, a discovered one needs its `AssetIpHistory` row inside `CLAIM_FRESH_DAYS`. This is the recycled-DHCP case that breaks the chain everywhere it appears: the laptop that left three weeks ago still records `10.1.1.50`, and without the gate it would be parented to whichever FortiGate serves that range today and have its alerts suppressed behind a device it has no relationship with. The history row is what the check reads first, because the `src/db.ts` extension bumps it on every write staging `ipAddress` — it tracks discovery cadence rather than change, which is exactly the signal wanted here.

**An unknown address answers nothing.** An address in no known (non-deprecated) network, or one whose owning gate Polaris holds no Asset row for, yields no row and no parent rather than a guess. For the display row that is doubly true: the row exists to carry verbs, and with no Asset row there is nothing to open.

### The same two sources, ranked oppositely, on purpose

`ipContextService.pickNamedGate` puts the subnet ABOVE a sighting on the Add Asset panel, and that is not an inconsistency to reconcile. That panel answers "what is at this address today", where the gate that serves the address now is the better answer and a sighting is a historical fact that survives the device moving. This row answers "where was this device last seen", where evidence outranks inference. Two questions, two rankings, one shared resolver underneath so the gate-identification precedence itself cannot drift between them.

### Permissions

The sighting half reads `AssetFortigateSighting`, gated `assetsQuarantine:read` on its own endpoint; the fallback reads `Subnet`, gated `subnets:read`. Two different grants, so `visibility` reports them separately — a caller holding one and not the other has to be able to tell "no gate owns this address" from "you were not shown that half", the `/ip-context` precedent.

<a id="rule-56"></a>

## Rule 56 — What ignoring an alert costs is answered where the thing that costs it lives

**The invariant.** Two settings decide what *ignoring* an alert costs: whether it keeps
coming back at you, and what closing it out demands of whoever does. Both were columns on
`NotificationRule`, and both moved — but not to the same place, because they are not
properties of the same thing.

- **The note belongs to the SEVERITY.** `requireAckNote` is a property of the alert record —
  who may close it out and on what terms — so a severity band may carry `followUp` =
  `{requireAckNote}`, and `effectiveAckNoteForSeverity` resolves it for the severity the
  alert is sitting at, exactly as `effectiveActionsForSeverity` resolves actions.
- **The reminder belongs to the ACTION.** A repeat re-sends NOTIFY actions and nothing else
  (`REPEATABLE_ACTION_TYPES`), so `repeat` rides `notifyActionEscalatableSchema` and
  `repeatForAction` resolves it.

A band that carries no `followUp`, and an action that carries no `repeat`, inherit the
rule's.

**Why rule-level was wrong, and why the two answers landed in different places.** A
rule-level answer is correct exactly as long as every severity and every delivery of an
automation deserves the same one. The operator who configures different ACTIONS at critical
than at warning is stating, in the only vocabulary the builder offered, that the two
severities are different kinds of event — and "what does closing this cost" is that same
question asked about the aftermath. So the note followed severity.

The reminder did not, and the first attempt to make it per-severity was the wrong shape. The
case that showed it: one automation that pages the on-call and mails a nightly digest. Chase
the page every five minutes; leave the digest alone. That is two answers inside ONE severity,
which a per-severity config cannot express at all — and the moment the control sits on the
notify row, the label has to change too. "Repeat this notification" named the alert; what
repeats is the action the checkbox is attached to.

**Why both use presence, not truthiness.** Each needs a third state its field cannot carry on
its own: *nothing was said here*. A band declaring `requireAckNote: false` is saying "not
here"; an action declaring `repeat: null` is saying "this one does not chase". Both are
answers. Every automation stored before this says neither, and if "said no" and "said
nothing" collapsed into one value the release would have silently switched reminders and note
requirements OFF across the fleet — discovered during an incident, by an alert that quietly
stopped chasing anyone. `followUp == null` and `action.repeat === undefined` are the two
tests that keep them apart. The note's single setting still lives inside a wrapper object for
precisely this reason; it is not a `requireAckNote` key on the band.

**Where the resolution had to reach.**

- *The reminder sweep* (`services/notificationEscalationService.ts`). Each repeating action
  keys its own progress `a<i>:repeat` (`repeatStateKey`) beside that action's escalation
  tiers, so two actions never share a `lastSentAt` — sharing one is how the slower reminder
  comes to ride the faster one's clock. Two gates computed BEFORE the per-notification loop
  widened to `allRepeatsOf`: rule inclusion and the `minAfterMin` due-candidate cutoff. Both
  run before any notification is looked at, so an automation whose only reminder lives on one
  action of one band would otherwise never be loaded and never be queried for. The quiet-time
  cache is keyed rule + severity + action, because the windows live inside each action's own
  `repeat`; one answer per rule would hold a five-minute page through the window an hourly
  digest was given.
- *The upgrade path.* A notification raised before this carries one shared `repeat` state
  entry. The sweep reads that bare key ONCE as the seed for an inheriting action, so an alert
  live across the upgrade keeps its clock instead of firing a fresh `[REMINDER 1]` at
  everyone the first time the new code sweeps. Nothing writes the bare key again.
- *`followUpPolicy`*, which composes the "what happens if you do nothing" sentence
  snapshotted into `Notification.templateCtx` at fire time. One alert carries one such
  sentence while its actions may chase independently, so it advertises the SOONEST of them —
  the same rule its escalation half already applies across chains, for the same reason.
- *Every acknowledge path* (`ackNotePolicyOf` in `services/notificationService.ts`) — the
  Alerts tab, the mobile list, the emailed one-click link and the push action button. Three
  of those four acknowledge without ever rendering a form, so the enforcement in
  `acknowledgeNotifications` is the control and the required field is a courtesy. That check
  used to be one indexed `count` with `rule: { requireAckNote: true }` in the WHERE clause,
  and it cannot stay that way: the question is now about the band the alert is in, which
  lives in a JSON column no SQL predicate on the rule row can reach. It fetches the candidate
  rows and resolves in memory — bounded by the ids the operator selected, not by fleet size,
  reading three small columns.

**The builder contract.** A `followUp` is written onto every band while "use different
actions for each severity level" is on and stripped from all of them when it is off — the
same on/off contract band `actions` already have — and each band section seeds from the
rule's, so ticking the toggle changes nothing by itself. A `repeat` is written onto every
notify row the control is shown on, seeded from `NotificationRule.repeat` when the action
states none, and the rule-level column is retired for that automation in the same collect.
That migrate-on-edit is deliberately scoped to the step the operator actually looked at: an
operator who renames an automation on step 1 and saves never runs the Actions collect, so
their rule keeps inheriting exactly as it did. Nothing is rewritten behind anybody's back.

Four traps found building it, all invisible until an automation misbehaves:

- The ack-note checkbox renders OUTSIDE each section's collapsible body. With several
  severities the Actions step arrives folded, and a folded section that hides what closing an
  alert costs hides a setting somebody meets at 3am.
- A band section rendered while the per-severity toggle was OFF shows a SEED of the rule's
  answer, so it must not be read back. The block carries `data-fu-live`, stamped at render
  time; testing the toggle at collect time is useless because by then it has already flipped.
- A band's `followUp` rides the step-3 row stash as `_bandFollowUp`, exactly as band actions
  and band escalation do. `collectBands` rebuilds `severityBands` from those rows, and it has
  already eaten each of the other two once.
- The quiet-hold stamp (`quietHeldSince`) is per NOTIFICATION while the windows are per
  action, so the "reminders resumed after a quiet period" sentence is gated on the sending
  action having windows of its own. Without that gate, an action with no quiet time sending
  during another action's hold announces a silence it never observed — and closes the hold
  the other action is still in.

**Guards.** `tests/unit/notificationRepeat.test.ts` pins the sweep (two independent clocks,
`repeat: null` vs absent, an action-only repeat being swept at all, band action selection,
per-action quiet windows, the false-resume gate, and the legacy-key seed);
`tests/unit/followUpPolicy.test.ts` pins the advertised sentence (soonest wins, explicit null
contributes nothing, absent inherits, bands);  `tests/unit/ackNotePolicy.test.ts` pins
`ackNotePolicyOf` including the unparseable-JSON fallback; and
`tests/unit/automationsWizardDom.test.ts` pins the placement, the label, two clocks on two
rows, the absence of the control on reset and tier actions, the migrate-on-edit, the
strip-on-untick, the step-3 round trip and the stale-seed trap.

<a id="rule-57"></a>

## Rule 57 — A sub-asset alerts only if the operator pinned it

**The invariant.** Rule 37 settled the device-level question: an automation only fires about
a device Polaris is actually polling. This is the same question one level down. A switch is
not one thing that alerts — it is forty-eight ports, each with its own dimension, its own
firing state and its own alert. A server is its filesystems. A gate is its tunnels. For all
of them the answer is the operator's pin, and nothing else: `Asset.monitoredInterfaces`,
`Asset.monitoredIpsecTunnels`, `Asset.monitoredStorage`, tested by
`services/notificationEngine.ts` -> `interfaceIsPinned()` / `tunnelIsPinned()` /
`storageIsPinned()` in every resolver that reads a dimensioned sample table.

**Why the sample table is not the gate, and never was.** The tempting shortcut is to let
retention answer it: only pinned members get fast samples, so only pinned members have rows
to read. It is wrong on both halves. Every one of these streams ALSO writes the unpinned
members at `cadence:"slow"` — 24 hours, no rollups — and slow rows are rewritten on every
system-info scrape, so they are permanently inside the engine's lookback and never age out
of it. And where a table WAS made pinned-only (interfaces, in the 2026-08 cutover), the gate
was then a property of a storage decision rather than a rule: the window between un-pinning a
port and its last rows expiring could still raise an alert, and any future change to
retention would silently re-open alerting on ports nobody selected.

**Each dimension was closed separately, and each one had already fired in production.**
IPsec went first: the full scrape writes every tunnel the gate reports, so a "tunnel down"
rule alerted on tunnels nobody had chosen, always. The four interface COUNTER metrics
followed — they had only ever been gated incidentally, by the pinned-only sample table.
Storage was last, in 2026-09, and was the worst of the three because a device reports every
filesystem it has: a single fleet-wide "disk over 90%" automation alerted on removable
volumes, ISO mounts, recovery partitions, mapped network drives and archive shares that are
full by design and will be full forever. None of those had been marked for monitoring. The
operator's complaint was not "this alert is wrong" — each one was arithmetically true — it
was that Polaris was answering a question nobody had asked it.

### The corollary the vanished-state sweep needs

An absent pin is a **configuration edge the operator made**, not a collection gap. The
distinction matters because `clearVanishedStates` deliberately FREEZES a firing row on a tick
where its asset produced no readings — a scrape that failed must not read as a recovery. An
unpin produces exactly the same silence, so without a second signal, un-pinning a device's
only alerting interface stranded its alert firing forever.

`pinTestForTrigger` is that signal: it hands the pin predicate for the rule's own metric or
field to the sweep, which tests the scope row's pin arrays directly and clears the row
(`system:out-of-scope`) even when the asset produced nothing at all. Zero extra queries on
the steady-state tick — the arrays are already in `SCOPE_SELECT`. It is also what makes the
Assets page's **Mass Pinning** section safe to unpin in bulk with no alert-cleanup path of
its own, on every facet.

### Two places the rule must also be told

**The builder's pickers list the PIN SET, not the inventory**
(`services/notificationDimensionService.ts`, nouns "monitored interfaces" / "monitored IPsec
tunnels" / "monitored storage mounts"). Offering an unpinned member would offer a filter that
can never fire — the one thing that service exists to prevent — and the noun carries the word
"monitored" so the wizard's empty state reads as the gate ("these devices report no monitored
interfaces") rather than as a claim that the device has no ports.

**A new dimensioned sample stream inherits all of it.** A fourth pin array needs four things
together or it ships ungated: the predicate, the gate in every resolver that reads its table,
the `pinTestForTrigger` arm, and the `DIMENSION_SOURCES` entry that lists it.

### The one dimension that is deliberately ungated: SD-WAN

`AssetPerfSlaSample` is dimensioned — per (health check, WAN member) — and nothing gates it.
That is not an oversight to be tidied up later, and a future session must not "fix" it by
adding a fourth pin array.

The gate exists because a device reports every port, filesystem and tunnel it HAS, most of
which nobody chose and most of which are idle, unplugged or full by design. An SD-WAN
health-check member is the opposite kind of object: it is a performance SLA somebody
configured on the gate, there are a handful per firewall, and the collector only ever sees
what `config system sdwan` declares. The operator's statement of intent was made on the
FortiGate, so asking them to restate it as a pin in Polaris would add a second place to
forget. The table says so itself — its `cadence` is always `"fast"` precisely because it has
no pinned-subset concept — which is why there is nothing to gate on even if someone wanted to.

The three SD-WAN METRICS (`sdwanLatencyMs` / `sdwanJitterMs` / `sdwanPacketLoss`) have always
been ungated for this reason; `sdwanMemberState` (2026-09) is the state field that joins them,
and it is the one that makes the exception visible, since every OTHER dimensioned state field
is gated. What replaces the pin as the safety property is the same one the gates provide:
nothing can alert about a member the gate is not actually probing, because a member that stops
being reported produces no reading at all and the vanished-state sweep retires its alert.

### The consequence, which is announced rather than discovered

Turning one of these gates on makes a rule scoped to devices with an EMPTY pin set go silent,
and retires its live alerts as `system:out-of-scope`. That is the correct reading of an empty
pin set — nothing on this device was marked for monitoring — but it is a fleet-wide behaviour
change on the day it ships, and the fleet it changes is the one that never pinned anything.
Each of the three cutovers carried the same warning, and the storage one is the reason it is
written into the rule: check the storage automations against their scoped devices' pin arrays
BEFORE the release, not after the alerts stop.

<a id="rule-58"></a>

## Rule 58 — A tag that names no region strands the ranking, so level routing abstains

### The automation that was working

A FortiSwitch down automation, scoped `model contains FortiSwitch`, with one notify action
routing to a named engineer plus **"Asset's L1 Region Users"**. It had been in service for
weeks. The named engineer got every alert. The site techs got none of them, and nobody could
say why: the switch carried its region tag, the tech carried the same region on their account,
and the pill in the wizard said L1.

Every check available in the UI agreed the rule was correct. It was not.

### What level routing actually does with a tag it cannot place

`deviceRegionsAtLevels` ranks ASSET-RELATIVE levels — level 1 is the device's own innermost
region, each step out follows a containment edge. "Innermost" is established structurally: seed
`present` from the asset's tags **intersected with the region catalogue**, then drop any entry
that is an ancestor of another entry. What survives is the leaf.

The intersection is the trap. A tag naming no current region cannot be located in the
containment forest, so it was dropped from the seed and the ranking proceeded over whatever was
left. The function's docstring called this "contributes nothing", and for an asset whose ONLY
tag was orphaned that was true — it returned `[]`.

For an asset carrying a division tag as well, it was false in the worst available direction.
Dropping the leaf leaves the division as the innermost surviving entry, so the division
**becomes level 1**. The automation does not fall silent. It pages the wrong tier, confidently.

### Why nothing surfaced it

Every surface an operator can inspect kept saying the rule was fine:

- the stale tag still renders on the asset page, indistinguishable from a live one;
- the automation stays enabled and its deliveries all succeed;
- `Notification.regionTags` faithfully records the tag that was on the asset;
- `notification_deliveries.status` reads `sent`;
- the recipients who DO receive it are real people with a plausible claim to the alert.

Only the tier is wrong, and a tier is not a thing any page displays. The wizard cannot warn
either: it resolves dynamic recipients at FIRE time by design, so at authoring time there is
nothing to check.

### The prod case, 2026-09-14

Region `Middle Tennessee` had been retired under rule 54 — and the surviving asset tags spelled
it `Middle Tenneessee`, with four e's, so even redrawing it under the correct name would not
have matched. 3,587 FortiSwitches carried it alongside `region:Southern Division`.

Every down alert on those switches resolved L1 to `Southern Division` and mailed the two
division contacts. The two people scoped to the site were never reached. The automation had
been "working" for weeks.

Finding it took none of the UI. It took reading `notification_deliveries.target` for a recent
alert, then checking each of the asset's `region:` tags against the names in the `mapRegions`
Setting blob — at which point the pattern was total: **every asset whose leaf tag was in the
catalogue paged its local tech; every asset whose leaf tag was orphaned paged the division.**
No exceptions in the sample.

Redrawing the region fixed the data (`applyRename` rotates asset and subnet tags,
`renameRegionInPrincipalScopes` rotates user, role and group-mapping tags — all three sides
moved, and the fleet went to zero orphaned tags). It did nothing about the mechanism, which
would strand the next automation the next time a region is renamed.

### The rule

`deviceRegionsAtLevels` returns `[]` for **every** requested level when `orphanedRegionTags`
finds any tag it cannot place. Not just the level the stranded leaf would have occupied — the
whole ranking is untrustworthy once one member of it is unplaceable, since any higher level may
also have shifted inward by one.

**The abstention is scoped to the level arm.** `recipientUserIds`, `recipientRoles`,
`recipientRegions`, `recipientDeviceRegion`, `recipientTags` and address-book contacts on the
same action all still resolve. The alert is never lost — only the level-scoped tier is withheld,
until someone rotates the tag or redraws the region. Withholding one tier is recoverable;
paging the wrong one teaches people the alert means something it does not.

### The alternative that was rejected

Treating an orphaned tag as an opaque leaf — letting it hold level 1 and resolve against users
by name — matches operator intent most closely, and was the first instinct. It was rejected
because an unplaceable name has no containment edge: the catalogue-known tags would have to
shift outward to start at level 2, silently redefining what every HIGHER level means on exactly
the assets that are already misconfigured. Trading one silent repointing for another is not a
fix. Abstain, and say so.

### Three silences, three lines

The level arm can reach nobody three ways, and they are indistinguishable from outside while
being fixed completely differently:

| Log line | What it means | The fix |
|---|---|---|
| `region-level routing abstained` | a tag names no map region | rotate the stale tag, or redraw the region |
| `region-level routing resolved no regions` | the asset's nesting is shallower than the level asked for | pick a level the tree actually has |
| `region-level routing matched regions but no users` | the regions exist; nobody is scoped to them | tag a person |

The same pass gave the email branch the warning its `web_push` sibling has had all along. A
recipient resolved by ANY arm whose account carries no email address is dropped silently by
`buildAddressOwnerMap`, and the builder only ever warned about missing PUSH devices — so an
SSO-provisioned account with no mail claim looks perfectly correct on the Users page and can
never be mailed. `email target matched users but none have an email address` is now said out
loud.

### When changing this

The diagnostic path is worth keeping: `notification_deliveries.target` for a recent alert on
the asset, each `region:` tag checked against the `mapRegions` blob, then the users whose
`region_tags ∪ role.region_tags` carry that name. Region routing has no read-only surface that
answers "who would this reach" — until it does, that join is the answer, and rule 54's
`mapRegionRetiredNames` list is where a stranded name is most likely to be explained.
---

<a id="rule-59"></a>

## Rule 59 — The controller's view of its own link is a second opinion, and an unreadable controller has no view at all

A managed FortiSwitch or FortiAP has two independent health stories, and Polaris had only
ever told one of them. The monitor loop asks the DEVICE, on whichever transport the operator
chose. The parent FortiGate separately knows whether it still has a FortiLink session to that
switch, or a CAPWAP tunnel to that AP. Those answers can differ, and the case where they
differ is the interesting one: **a switch whose FortiLink session is dead still answers every
ICMP echo and every SNMP get perfectly well.** It is up by every measure Polaris had, and it
is not doing its job — no switch-controller config reaches it, no VLAN change lands, the gate
has stopped managing it. The monitor loop is structurally unable to see this, because it is
asking the switch, and the switch is fine.

**The data was never missing; it had nowhere to go.** Both Fortinet transports have always
parsed the field — `sw.status === "Connected"` off `switch-controller/managed-switch/status`,
`ap.status` off `wifi/managed_ap` — and both already store it in the AssetSource observed
blob. It reached the Sources tab and stopped there. It was never projected onto the Asset, so
no details row could show it and no automation could read it.

**It is a column, not a key on `fortinetTopology`.** That blob is rewritten wholesale by
discovery on every cycle; a 60-second sweep read-modify-writing it would lose-update the
discovery stamp, which is the trap the region blob hit. Four scalar columns instead —
`fortilinkStatus` / `fortilinkStatusRaw` / `fortilinkCheckedAt` / `fortilinkChangedAt` — which
also lets `resolveAssetStateReadings` read the field straight off the scope row the way
`monitorStatus` and `dependencySuppressed` are read, with no query of its own.

### It runs for every managed device, which is the whole reason it exists

`probeFortinetController` already turns this signal into up/down, but only for assets whose
resolved `responseTimePolling` is `rest_api` — and for those the link state IS their
`monitorStatus`, so a separate field would be saying the same thing twice. The devices where
it says something new are the ICMP- and SNMP-polled ones, which that probe never touches. So
`jobs/sweepFortinetLinkState.ts` sweeps every FortiGate-managed switch and AP regardless of
polling method, and `services/fortinetLinkStateService.ts` holds the decisions.

Cost is bounded by CONTROLLER count, not fleet size: at most two calls per controller per
tick whether it manages 3 devices or 300, through the same 30s per-controller cache in
`monitoringService` that keeps the probe path survivable on FMG proxy mode at concurrency 1.
State the overlap honestly — the sweep and the monitor loop run on independent 60s timers, so
they coalesce only when their ticks land in the same 30s window. A controller already serving
REST-probed devices goes from ~1 call per minute per kind to ~1.5, not to 1 and not to 2; one
serving only ICMP-polled devices was being asked nothing and now costs the full 2.
`POLARIS_FORTILINK_SWEEP_SEC` raises the interval where that matters.

### Three refusals, each of which is a false alarm not sent

**An unreadable controller writes nothing.** Not `down` for every device behind it, not even a
`checkedAt` refresh. This is the loudest false alarm the feature could produce: an expired API
token or a dark FMG would otherwise report a fleet-wide link outage, which is precisely the
moment Polaris knows least. The sweep skips, the same contract as `ProbeResult.skipped`, and a
`fortilinkCheckedAt` that stops advancing is what the details row reads to present the value
as last-known rather than current. Per-controller failures are isolated — one unreachable
FortiGate must not stop the other forty-nine from being swept.

**Answered-but-absent is `unknown`, never `down`.** The probe path treats "not in the
controller's table" as a failure, and for a probe that is right. Here it is not: a brief
post-config-push window looks identical — the same reason discovery's decommission sweep
trusts the CMDB roster over the live status query — and down-detection authority belongs to
rule 36. `unknown` is offered in the automation picker rather than hidden, because on a
FortiSwitch it usually means the switch has aged out of the managed table entirely, and an
operator who wants to hear about that writes `!= up`.

**It never touches `monitorStatus`, `consecutiveFailures`, or anything else the five-state
machine owns.** The value of the column is exactly that it can DISAGREE with the monitor pill.
Folding it in would erase the disagreement and leave the feature pointless.

### What the automation reads, and the anchor that makes a hold mean something

`fortilinkStatus` is an `asset_state` field, so "controller link is down for 3 polls" gets the
whole machinery — scope, device filters, severity bands, auto-reset, escalation, acknowledge.
Two departures from the four Asset-column fields beside it:

**A null value produces NO READING, rather than a reading of null.** Null means the sweep has
never spoken about this device — it is not FortiGate-managed, or it is a pre-feature row
awaiting its first tick. A null reading would make `!= up` true for every workstation, VM and
printer caught by a fleet-wide scope, which is the inverse of what an operator writing that
rule means. Producing no reading also lets the vanished-state sweep clear a live alert on a
device that stops being managed, the way an un-pinned interface clears under rule 57.

**The reading anchor is `fortilinkCheckedAt`, not `lastMonitorAt`.** A `forPolls` hold has to
count times the CONTROLLER answered. The monitor loop's clock says nothing about that, and on
an ICMP-polled switch — the case this field exists for — it would advance every 60s while the
controller had not been read since the token expired, satisfying a three-poll hold on one real
observation. Confirmations refresh `checkedAt` and leave `changedAt` alone, which is what
makes "down for 2h 13m" on the details row the outage length rather than the age of the last
sweep.

Rule 37 still governs who may be alerted about: a FortiGate-managed switch with
`monitored = false` shows the row in asset details and never fires. That is the intended
reading of the monitoring toggle, but it is worth saying out loud, because the switch an
operator most wants a FortiLink alarm on is not always one they thought to turn monitoring on
for.


---
