# Business rules 44–49 — full narrative

> The filename keeps its original range: it is cited from code and from the other skills.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant for each rule is in `invariants-12-29.md` / `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 44](#rule-44) — A quiet window withholds the reminder, not the alert, and the reminder that follows says how long
- [Rule 45](#rule-45) — An address places a device only through the gate that owns it, and only a device nothing else can place
- [Rule 46](#rule-46) — A device filter on an event automation filters the event's subject
- [Rule 47](#rule-47) — A PostgreSQL client is chosen by the server's major and verified before it is trusted, never spawned by bare name
- [Rule 48](#rule-48) — Nobody hands out authority they do not hold
- [Rule 49](#rule-49) — An upgrade never refuses for want of a credential it can find itself, and never records one it has not proved

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

**The MAC is derived, never adopted.** The obvious "better" version writes the ARP MAC onto the asset so every downstream matcher works for free. It also makes the row eligible for MAC-keyed dedupe and merge (`mergeDuplicateHostnameAssets` collapses rows sharing a MAC; Entra cross-links by Ethernet MAC), so one wrong adoption — a recycled address inside the freshness window, a gate misresolved — merges two devices and permanently deletes one row's monitoring history. Rule 26 gates the reservation-side adoption behind a double opt-in for the same reason. Adoption here is a deliberate follow-up behind an opt-in Setting, not a default, and the touches entry names what it must go through when it comes.

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
