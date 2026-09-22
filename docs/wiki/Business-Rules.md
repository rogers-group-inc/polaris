# Business rules

Polaris carries **78 numbered rules**. Each one records a decision *and* the
incident or constraint that forced it. The reasoning is the point — a great deal
of Polaris's behaviour is a considered rule rather than an accident, and this is
where the reasons live.

**Rule numbers are a stable citation key.** Commits, code comments and the rest
of this wiki cite "rule 23". They are never renumbered; a retired rule is retired
in place.

> The full narrative for every rule — the incident, the alternatives considered,
> the failure mode — lives in the repository under
> `.claude/skills/polaris-business-rules/`. This page is the index, in the rules'
> own terms.

---

## Rules 1–11 — the IPAM floor

### Rule 1
**No overlapping networks within one block.** Enforced at the service layer under
a per-block advisory lock, and backed by a unique index. A create that bypasses
the lock re-opens the race in [rule 20a](#rule-20).

### Rule 2
**A network must be contained within its parent block.**

### Rule 3
**No duplicate IP reservations** — one *active* reservation per address per
network, backed by a unique index.

### Rule 4
**Block and network deletion are protected.** 409 while any active reservation
exists inside. (Archiving is deliberately exempt — see [rule 41](#rule-41).)

### Rule 5
**CIDRs are normalised on write.** Host bits are zeroed: `10.1.1.5/24` stores as
`10.1.1.0/24`.

### Rule 6
**Every discovered reservation carries a `sourceType`.** Manual entries default
to `manual`.

### Rule 7
**Conflict detection.** A discovery value differing from an existing manual
reservation creates a [Conflict](Conflict-Resolution) rather than overwriting.

### Rule 8
**Event archival.** Events older than 7 days are pruned; syslog (CEF) and
SFTP/SCP archival are configurable.

### Rule 9
**`acquiredAt` ≤ `lastSeen`**, clamped on every write and repaired at boot.

### Rule 10
**Four statuses cannot be monitored** — `decommissioned`, `disabled`, `storage`,
`quarantined`. Enforced centrally in **both** directions, so no write path can
stage monitoring onto one.

`quarantined` joined the list because a quarantined device is isolated at the
gate and **every probe fails by design** — a security action was producing an
outage alert storm about the isolation working. Because quarantine is reversible
the flag is **parked** and restored on release; otherwise releasing handed the
device back with nobody watching it.

`maintenance` is deliberately **not** on the list. The two operator-facing paths
**refuse with a reason** rather than leaning on the silent clamp — a form that
saves and comes back unticked reads as a bug.

### Rule 11
**DNS-resolved reservations.** Any asset whose primary IP falls in a known,
non-deprecated network with no active reservation gets one auto-created. IPv4
only, **never pushed to a gate**, and it **never raises a conflict** — it defers
silently to anything authoritative.

---

## Rules 12–29

### Rule 12
**`lastSeen` means verified network presence.** Written through one function that
never regresses it and stamps provenance. **Polling is authoritative for
monitored assets** — the discovery-origin sources are refused so they cannot
advance presence past what polling established. A failed probe writes nothing.

### Rule 13
**SD-WAN monitoring is opt-in, read-only, FortiOS-only.** It **never writes to
the device**. Where FortiOS will not expose the runtime selected route, the value
is *inferred* and labelled as such.

### Rule 14
**Description sync is opt-in and Polaris-primary.** A non-empty Polaris value
always wins; an empty Polaris field adopts the device value. No conflict state
exists.

### Rule 15
**Location codes ride device descriptions; notes are operator-only.** The asset
description's codes win **exclusively** when it carries any — no per-key
fall-through — and **discovery never writes notes on an existing asset**.

### Rule 16
**Maintenance windows pause everything**, and status flips are scheduler-managed.
A window **retires the alerts that were already live** rather than freezing them:
no reset actions run, and a still-bad condition re-earns its debounce and fires
anew afterwards. A day carries a **list** of hour ranges, and each range is its
own occurrence with its own start. See [Maintenance windows](Maintenance-Windows).

### Rule 17
**ARP presence is evidence for stale reservations; the sweep is opt-in.** MAC
match is required, matching is scoped per (gate, IP), and **absence of an ARP
entry is never negative evidence**. The cache-priming sweep is off by default
because it is IDS-visible.

### Rule 18
**Automation precedence is same-trigger, most-specific-wins.** Higher scope rank
**carves out** the devices it covers from every lower-ranked automation; same-rank
ties **both fire**. `monitorStatus` is keyed by operator and value, **not** by
device filter — it is one per-asset column, so every `== down` rule must be able
to carve the others out. See [Automations](Automations#precedence--the-single-most-important-behaviour).

### Rule 19
**Severity bands escalate one alert by value, each on its own clock.** Severities
must strictly increase; thresholds need not be monotonic — the most-severe *met*
tier wins. **Holds are counted in readings, not seconds.**

### Rule 20
Three operability invariants. **(a)** Network writes serialise per block. **(b)**
**Secrets are encrypted at rest** — sealing per model, opening all-models; raw
SQL bypasses it. **(c)** **A backup you cannot restore is not a backup** — the
path is streamed end to end, restore is wrapped in TimescaleDB's pre/post-restore
calls, and a failed pre-update backup **aborts the update** by default.

### Rule 21
**SSH host-key verification is opt-in and fails closed.** No pin stores and
accepts; a match accepts; a **changed key refuses the connection**. An internal
error refuses rather than silently skipping.

### Rule 22
**The Sources column is `location || learnedLocation`, and the order is
operator-set.** It feeds the **projection**, not just rendering. Invariant: **a
source blob may never be built from the projection's own output** — that
laundered an AD OU path into a FortiGate-sourced field and accumulated a prefix
per cycle.

### Rule 23
**Who owns an IP and how the gate hands it out are two facts, not one.**
`sourceType` answers ownership; `dhcpBinding` (`null` / `lease` / `reservation`)
answers service. The binding is written **without ever flipping the source type**.
A managed device that goes away gives its address back — on decommission, never
on "no longer discovered".

### Rule 24
**Alert on the device's own alarm bit before inventing a threshold for it.** The
device knows its own per-model limits. A source publishing no alarm bit must
never have its absence mapped to 0 — and **an absent reading must not be read as
an absent dimension** either, or a dropped collection becomes indistinguishable
from a port that has no such feature.

### Rule 25
**An alert you cannot acknowledge from where you read it is not acknowledgeable,
and the acknowledger is a session.** One URL for email and push, identity from
the session behind it. **Loading is a GET and acknowledging is a POST**, so a
mail gateway prefetching links cannot acknowledge anything. **An alert that is
over carries no button at all.** And **one notify action sends one email**:
everyone it names is on the same To line, so each reader can see who else is
already on it. Nothing about the reader splits that message — not their
timezone (times are the Polaris server's, and the footer names the zone) and
not their permissions (a reader who cannot acknowledge gets the button and is
refused, with a reason, on the acknowledge page). See
[Actions](Automation-Actions#acknowledgement).

### Rule 26
**A generated MAC is a placeholder until the network proves otherwise.** The
placeholder prefix is the **only** marker — there is no boolean column, because
the prefix is visible on the gate's own table. Adoption is double-gated, works on
ARP and device-inventory evidence only, and is not retroactive in either
direction.

### Rule 27
**A logo is picked by theme family; a name is text only when the picture does not
already say it.** Painting the wrong variant makes the logo *disappear*.

### Rule 28
**The Windows build is the authority; the product name is not.** `ProductName`
reads "Windows 10 Pro" on every Windows 11 client, so **no projection priority
can fix it**. The family comes from a build threshold; an unlisted build keeps
its raw version. Windows Server is excluded entirely. Not retroactive.

### Rule 29
**A miss taken while the device is DOWN is the outage, not the link; everything
else counts.** The packet-loss ratio is plainly failed/total over the window, it
counts **packets not rows** where it can, only an answering device reports loss,
and a reading at or above the rule's ceiling is not a reading. Every maximal run
of failures that reached `down` is **dropped whole**, onset included.

**The chart and the alert can legitimately disagree** — the chart counts every
probe because a picture of a window has to be continuous. See
[Triggers](Automation-Triggers#packet-loss-is-special).

---

## Rules 30–48

### Rule 30
**Confirmation is the configured cadence's job; ICMP only fills in the loss
ratio.** The failure counter is a **leaky bucket with a ceiling**. An answered
probe is `recovering` whatever the level; the level decides what a *miss* means.
Recovery costs exactly the cap, however long the outage ran. **A skip is not a
miss**, and a re-queued job is not a second reading. See
[Monitor states](Monitor-States).

### Rule 31
**The login page is the way back in, so restricting it is opt-in and must refuse
to lock you out.** Both halves or neither; the page is dropped and the API
answers the same generic 401; **SSO is never gated**; it fails open on a read
error; the save refuses a scope excluding the caller.

### Rule 32
**A reset condition answers "what has to become true again", so it starts as the
trigger inverted — and it resolves where the alert lives.** While firing, the
tree is the sole recovery authority. Resolution is dimension-first: a reset
condition on the same kind of component clears that component's alert alone,
and only a condition on something device-wide (CPU, memory, monitor status)
clears them together — one healthy port never clears another port's alert. A
reset condition also watches the same components the trigger does, including
the unpinned PoE ports a fault condition covers (Rule 57). Reset leaves
inherit the trigger's window. Event and change
triggers get a **counterpart Event** instead — and a signal Polaris writes under
one action for both directions is split so it has one (`capacity.severity_recovered`,
`platform.lifecycle_recovered`), written only on a landing back at healthy, never
on a partial recovery. The direction a trigger fires on is an editable **detail
condition** on the trigger step, not a hidden setting. The re-notify cooldown was
retired from the builder and its stored values cleared.

### Rule 33
**A device that answers is not a device that works — and the check belongs to the
vendor, not to a login.** The HTTP check is a manufacturer widget, not a polling
method. The body match is load-bearing, redirects are never followed, and it
**never moves `monitorStatus`**.

### Rule 34
**An active scan finds things; a separate grant adds them.** Scanning and
adopting are separate grants, chained at the route. Opt-in, IDS-visible, no
scheduler, no shipped default range. Adoption is new-addresses-only. See
[Network Discovery](Network-Discovery).

### Rule 35
**The GAL is a mirror, not a source of truth — and Polaris only deletes what it
wrote.** Provenance decides deletion; a Polaris user or manual contact wins; an
empty or catastrophically shrunken read never wipes; the run Event carries
**counts only**.

### Rule 36
**The automation decides what "down" means; a device no automation covers is
never judged.** A device covered by no down automation reads **`passive`** — still
polled, still charted, no verdict. The same automation owns the way back up, and
**decides what colour Down is**.

### Rule 37
**An automation only fires about a device Polaris is actually polling.** One gate,
every trigger path: monitored **and** not suppressed. Un-monitoring a device
**clears** its live alerts. A deleted asset still fires.

### Rule 38
**A device behind a dark parent is not accused, and is not released on one
packet.** **(a)** Release is asymmetric — entering needs every parent confirmed
down, leaving needs a parent genuinely back (`up` / `unknown` / `passive` only;
`warning` holds). **(b)** A miss the upstream explains is **grey, not red**.

### Rule 39
**How a person wants to be reached is theirs, not the automation's.** The
notification preference is an **account** setting, and every client reconciles its
own subscription to it at boot. It is consulted only when the action group offers
both methods, only accounts are filtered, and **a preference never deletes an
alert**.

### Rule 40
**Two assets on one address is a conflict; one asset on a stale address is not.**
Eight clauses — see [Conflict resolution](Conflict-Resolution#duplicate-ip--the-long-one).
The short version: only network-present assets, only current claims, two
**devices** not two rows, one card per address, two verbs instead of accept, and
one claimant must be equipment somebody addressed on purpose **or** the address
itself must be deliberate with disjoint reporting sources.

### Rule 41
**A subnet dies with its FortiGate, and the chassis — not the name — says which
gate that is.** A name cannot tell a rename from a replacement. Tri-state in both
directions, compared against the **cluster's whole serial set**, and the conflict
is **additive**. A retired network **moves to the archive** rather than going
deprecated, because a deprecated row's CIDR becomes unrecordable rather than
reusable.

### Rule 42
**Some address space is not one network, and the way to say so is to exclude it.**
Global, CIDR-identified and frozen after create, one-directional containment,
enforced at the single creation seam, **taken space to an allocator rather than a
refusal**, and it **destroys nothing**.

### Rule 43
**A grant is only as narrow as the act it names.** Deploying the agent is
`assets:fullwrite`, not `write`. `assetsProbe` is a **read-only key**.
`credentials` carries the ownership dimension, testing a stored row included.

### Rule 44
**A quiet window withholds the reminder, not the alert — and the reminder that
follows says how long.** Held, never skipped. The hold is closed by the **send**,
not by the window ending. It does not touch the first alert, the escalation
tiers, or the reset notifications.

### Rule 45
**An address places a device only through the gate that owns it, and only a
device nothing else can place.** MAC-less assets only, one chain, four refusals.
The derived MAC **is** adopted — refused when another asset already carries it,
and refused for both when two candidates resolve to the same one. Stamps are
never cleared: absence of evidence is not a move.

### Rule 46
**A device filter on an event automation filters the event's subject.** An event
naming no asset cannot satisfy a device filter, so a *filtered* automation never
fires on one — an unconstrained one still does. "Unconstrained" is its own
question, asked first.

### Rule 47
**A PostgreSQL client is chosen by the server's major and verified, never spawned
by bare name.** `pg_dump` refuses a server newer than itself. **Presence is not
compatibility.** A mismatch refuses the backup with the sentence the operator
needs — both versions, the path, the fix — as the error itself, never behind
"see the server log".

### Rule 48
**Nobody hands out authority they do not hold.** Admin-equivalence cannot be
minted by a caller who lacks it, at any of the four sites. Not four-eyes; the
mirror of the last-admin guard. A request with no role snapshot **fails closed**.

---

## Rules 49–64

### Rule 49
**An upgrade never refuses for want of a credential it can find itself, and never
records one it has not proved.** An unresolvable stored id counts as absent; an
explicit one that fails is an error. The transport follows the **credential's
type**. Adoption happens **only on success** — reaching the host is the proof.

### Rule 50
**A response the app did not write is a response with the app's headers missing.**
An unmatched route is **answered**, never dropped to the framework's handler,
which would replace the CSP with one dropping `frame-ancestors` and `form-action`
and echo the request back. The 404 message is a constant. Under `/api/v1` an
anonymous caller gets **401, not 404**.

### Rule 51
**A `DATABASE_URL` is a driver URL; its `sslmode` is translated into libpq's
vocabulary, never copied.** `no-verify` maps to `require`; an unrecognised value
is **refused** rather than dropped, because omitting it silently downgrades TLS
to opportunistic. This broke **every backup path on every install created through
the wizard with self-signed certificates ticked**, behind one generic message.

### Rule 52
**TimescaleDB is part of the install, not a tuning option.** Its absence is a
broken install **from the first byte**, not a problem that begins at a size
threshold — so the capacity warning has **no size gate**. Every install path
provisions it and errors out rather than warning.

### Rule 53
**A device a run could not read keeps its old data, so it is named — never folded
in with one the run skipped.** *Offline* and *unread* are different states and no
surface may sum them. The projection's null-guards mean an absent read never
blanks a good value — and therefore never corrects one either. **"It is being
monitored fine" is not evidence that anything has read it.**

### Rule 54
**A region tag dies when its name is retired, and only then.** Both halves — no
region answers to the name, **and** Polaris recorded retiring it. Stripping every
`region:` tag matching no region is the one thing this must not do, because
manual attachments survive every reconciler.

### Rule 55
**An address places a device behind a gate only when nothing has seen it, and
every surface says which answer it got.** IPAM is the **last** source consulted.
It can only ever **add** a parent, never move one, so the failure mode is a missed
alert and never a false one. An inference has no moment, so the row prints no
timestamp.

### Rule 56
**What ignoring an alert costs is answered where the thing that costs it lives:
the note by severity, the reminder by action.** Both tests are **presence, never
truthiness** — an explicit `false` is an answer, an absent key inherits.

### Rule 57
**A sub-asset alerts only if the operator pinned it — the pin IS the statement of
what may alert.** The pin is a gate, never a side effect of retention: every
stream writes samples for unpinned members too. There is **no opt-out**;
un-pinning is how alerting stops. **One exception:** a PoE condition written as
*Interface PoE status* **is** `fault` (or `other-fault`) alerts on every
PoE-capable port, pinned or not. A port with nothing plugged in reports
*searching* and a port you switched PoE off on reports *disabled*, so *fault*
can only mean the switch detected a powered device and failed to power it —
which is the one PoE failure you cannot find another way, because the access
point or camera on the far end never comes up at all. Every other PoE
comparison, and every other interface condition, stays pinned-only.

### Rule 58
**A region tag naming no region strands the whole ranking, so level routing
abstains rather than promoting the container.** Dropping the leaf promotes its
container to L1 — the automation pages the division while the site's own people
hear nothing, and **it is undetectable from every surface an operator has**.
Abstention is scoped to the level arm alone.

### Rule 59
**The controller's view of its own link is a second opinion, and an unreadable
controller has no view at all.** An unreadable controller writes **nothing**;
answered-but-absent is **`unknown`, never `down`**; it never touches
`monitorStatus`. A null produces **no reading at all**.

### Rule 60
**A footer that tells the reader who else knows must never name a Bcc.** A blind
copy that appears in a footer every recipient reads has stopped being blind. The
invariant is not "the renderer filters Bcc out" but **"the renderer is never
handed one"**. The footer names the audience of the **send** — one dispatch of
the automation's actions — rather than of the whole alert, so a reminder never
names someone who is only on an escalation tier.

### Rule 61
**Changing a credential ends every other session on it, and rotating your own must
carry the CSRF token across.** The point of a new password is the revocation. The
caller's own session is rotated but kept — and the CSRF token must survive that,
or the still-open page 403s on its next write with nothing thrown anywhere.

### Rule 62
**An install is identified by something it persists, never by the name the runtime
handed the process.** In a container `os.hostname()` is the container id, which is
regenerated on every recreate — so **every image upgrade refused to boot**,
reading the stamp the previous container had written seconds earlier. Identity is
now a persisted id under the state directory.

### Rule 63
**The complexity bar belongs to the operator, and a password that no longer meets
it is replaced on the far side of the second factor.** The schema is a shape
check; the policy is a setting, failing to the **defaults** rather than to "no
policy". Demanding the change in front of the second factor would be an **MFA
bypass wearing a policy's clothes**.

### Rule 64
**A passkey is bound to the origin that issued its challenge, the install decides
what a passkey is for, and it never names an account that does not already
exist.** Local accounts only. The relying party is derived from the request and
**pinned into the ceremony at issue time**. Two deployment shapes cannot host
passkeys at all and return a **reason**; two more are misconfigured proxies
wearing those refusals.

---

### Rule 65
**A delivery test is a specimen of the alert, not a rehearsal against live
inventory.** The automation wizard's test buttons fire against a **made-up
device** — hostname, IP, MAC, location, model, description, sub-asset and charts
are all invented sample data, from the ranges reserved for documentation — and
the alert is attached to no asset, so it never appears on a real device's alert
list. No reading is quoted; the headline states the **condition** you
configured. The email is marked **TEST** in its subject, in a banner above the
body, and in the plain-text alternative, and that marking is added at send time,
so customizing the email template cannot remove it.

### Rule 68
**Polaris ships two kinds of MIB, and only one of them is yours to remove.**
The generic IETF/IEEE modules are **built in**: every install has them, nobody
can delete or edit them, and they change only when you update Polaris. That is
what makes interfaces, LLDP, PoE, VLAN tables, storage and ENTITY sensors
collect the moment SNMP works.

A **manufacturer's own MIB** is different. Where Polaris ships one — Cisco's
today — it is loaded into your MIB Database on the first start of a **fresh
install**, where it sits alongside anything you uploaded and **you can delete
it**. An install that was upgraded rather than installed fresh receives none:
your MIB Database is yours, and an upgrade does not add vendor files to it.

A **manufacturer profile** says which symbol *is* the CPU and which pair *is*
the memory — the half a MIB cannot tell you. Polaris ships one only where it
overrides something the generic MIBs cannot already do, which is why Cisco has
one (per-pool memory, and a 5-second CPU where the standard MIB gives a
5-minute average) and MikroTik has none (RouterOS reports CPU, memory and
storage through the standard MIB already).

Deleting either is supported and neither is silent. Without the profile, that
manufacturer falls back to the standard MIBs — the device keeps being
monitored, you lose only the vendor-specific figures. Without the MIB, the
profile's rows read *unresolved* and name the module to re-upload.

---

### Rule 69
**A reservation count is of addresses held, and a release is history.** Polaris
never deletes a reservation when it is given up — it marks it `released` or
`expired` and keeps it, because that history is how you answer "who had .47 in
March". So every count of how full a network is counts only reservations that
are **active and sitting on an address**: the Networks list's Reservations
column, its Utilization percentage, and the bar at the bottom of the address
list all use that same figure, and they agree by construction. A whole-network
reservation holds no individual address and is not counted either — you see it
as the network's `reserved` status instead. The percentage is over the addresses
the CIDR can hand out (254 on a /24); where there is no sensible denominator —
IPv6 — you get an em dash rather than a 0% bar, which would claim the network is
empty.

The unfiltered total still exists and is used for exactly one thing: **what a
deletion or an archive takes with it.** Both remove every reservation row
whatever its status, so both confirmations name that larger number before you
commit.

---

### Rule 70
**Absence from a directory decommissions what that directory manages, and only
when the read was whole.** Deleting a computer object, or disabling a device
account, is how an operator retires a machine — so Active Directory and Entra ID
can act on it, the way the vCenter integration already acts on a VM that leaves
the inventory. The pass is **opt-in** per integration (*Decommission devices
that leave the directory*, off by default) because the first run of a sweep
nobody asked for is a fleet-wide status change.

**What decides** is the **Managed by** row on the asset's System tab, not its
list of sources. If the directory manages the asset, its word is final — a DHCP
sighting, a vCenter record or a reporting agent does not keep a deleted computer
object active. If another integration manages it, the sweep only drops its own
stale source row.

**What refuses it**: a scoped *Discover Now* run; a cancelled or capped read; an
**empty** read (a bind failure or a withdrawn consent, far more often than an
emptied directory); and a missing set too large to be ordinary turnover — over
50 devices, or over a fifth of what the integration holds, which is the only
guard that catches a narrowed base DN or a half-revoked grant. Every refusal
writes a warning naming the reason and changes nothing.

**What is not a deletion**: a device your OU or name filter excludes, and a
device *Include disabled* skipped. Both are still in the directory, so both keep
their asset. A disabled device is decommissioned but **keeps** its source row.

See [Integration-Directory](Integration-Directory) for the operator view.

---

## Reading a rule correctly

Three habits make these easier to apply:

1. **The invariant is the contract; the narrative is the reason.** When you need
   to know whether something is allowed, read the invariant. When you need to
   know whether to change it, read the narrative first.
2. **Most of these exist because of a specific, observed failure** — often a
   silent one. Where a rule looks over-careful, it is usually because the
   obvious simpler version was tried and failed invisibly.
3. **Never paraphrase a rule when quoting it.** The wording is load-bearing, and
   half of them turn on a distinction one adjective carries.

### Rule 71
**A figure Polaris reports about itself accounts for itself, and a measurement
whose mechanism broke says so instead of reading zero.** The Maintenance tab's
**Current size** is every relation in the database, and the table list under it
accounts for all of it: Polaris's tables as rows, then a line each for the
pg-boss job queue, the PostgreSQL catalog, anything in another schema, and an
*Unattributed* residual, then a **Total** that matches the figure above. Those
parts are what the total is made of, not a second measurement of it, so they
cannot disagree with it.

Sizes are read from PostgreSQL's catalog rather than by measuring the data
directory, which is what keeps the tab instant on a large install — so a figure
is accurate as of the last `VACUUM`/`ANALYZE`, and the card says so when that
matters. **"N relations have never been vacuumed or analyzed"** means those
relations report zero pages whatever they hold and every size shown is
understated: run `vacuumdb --analyze-in-stages`, which is owed after a restore
or a PostgreSQL major-version upgrade. **"Hypertable sizing is degraded"** means
Polaris could not read TimescaleDB's chunk catalog, so the sample tables are
listed at their parent size — near zero — and their real bytes appear under
*Unattributed*. Neither condition is left to be inferred from a number that
looks small, because that is exactly what happened before this rule existed: a
76.6 GB database whose largest listed table was 1.4 GB, for a day, unnoticed.

See [Server-Settings](Server-Settings) for the card itself.

### Rule 72
**A detection script asserts every prerequisite its remediation establishes, and
a mode that establishes nothing refuses instead of reporting success.** The SSH
onboarding scripts Polaris generates come in pairs — a detection half that
answers "is this endpoint ready", and a remediation half that makes it ready —
and the pairing is what lets a fleet self-heal instead of being configured once
and drifting. That only holds if the two halves agree about what "ready" means.

So detection checks the account as well as the key: that it exists, that it is
enabled, and that it is a member of local Administrators on Windows (or has its
sudoers drop-in on Linux). An endpoint missing any of those cannot have the
agent installed on it, so reporting it compliant would be reporting success for
something that does not work.

And when you choose **use an existing account**, the script verifies that
account and **stops** if it is not there or is not an administrator, instead of
carrying on to authorize a key for an account that does not exist. It verifies
without changing anything — choosing an existing account is not asking Polaris
to create one or to promote it.

The firewall rule is deliberately not checked. If you did not give Polaris a
server address there is no rule to look for, and a check nothing can satisfy
would make the pair remediate forever.

One consequence you will see: both scripts now refuse to download until you have
named the account on the **SSH Deployment** card. Before, the Windows detection
script would render without one — and could not tell you anything useful when
it did.

See [Polaris-Agent](Polaris-Agent) for the card and the scripts.

### Rule 73
**Planned downtime is reported as planned, and a scoped view of a window still
reports the whole window.** A device in a maintenance window has its monitor
status frozen, so it is deliberately left out of every "down", "warning" and
"stale" surface Polaris has ([rule 16](#rule-16)) — which means a dashboard
built from those widgets says nothing at all about the devices that are down on
purpose. **Active Maintenance** is the one surface that does, and two things
follow from being the only one.

Its count never wears the red that every other widget's count means "these are
down" in. Nobody should act on planned work, so it is not coloured as though
somebody should.

And filtering it by region, asset type or FortiGate narrows the **list**, not
the windows in it. Every other widget's rows are devices, so dropping the ones
out of scope is right; a maintenance row is a *schedule*, covering whatever mix
of devices it matched. So a schedule appears whenever **any** of its devices is
in scope, and is then shown whole — every device counted, every type named —
with the in-scope share stated beside it ("4 devices (2 in this scope)"). The
alternative reports a smaller outage than the one actually running, which is
the number an operator would size the work and the return time against.

Window times are the **Polaris server's** wall clock, the same clock the
schedule is evaluated against; the countdown beside each one is computed
against yours, so the two agree wherever you are sitting.

See [Maintenance-Windows](Maintenance-Windows) and
[Dashboard](Dashboard#the-widget-library).

### Rule 74

**A field Polaris writes onto a device is budgeted where you type it, and the
budget is the device's.**

A DHCP reservation's **notes** are a plain comment on a network Polaris only
reads. On a network it pushes to, they are the body of the FortiGate's
`reserved-address` description, which the device holds 255 characters of — and
Polaris spends part of that on the wrapper that makes the entry attributable:

```
Polaris/<user>: <notes> [<hostname>]
```

The prefix is how a FortiGate admin tells Polaris's entries from hand-made ones.
The bracketed hostname at the end is how Polaris reads the hostname back off the
gate if it ever has to rebuild from one.

Everything in those 255 characters competes, so the room left for notes is
**computed**, not fixed: a long service-account name or a long hostname leaves
less. The form counts it down for you while you type.

Going over is **refused** — the save fails, naming the budget, what you typed
and how many characters to cut. Polaris does not truncate. It used to, at a much
smaller limit, and it cost twice: a comment was cut on the firewall with nothing
said at either end, and the cut took the trailing `[hostname]` with it, after
which the next discovery read the tail of the note back as the device's
hostname.

Two things this does **not** do. It does not apply off a pushing network —
there is no device field to fit. And it does not block an edit to some other
field on a reservation whose note was written before the rule existed (or by
discovery): only a save that actually changes the notes or the hostname is
judged, so a row can always be shortened rather than being stuck.

See [IPAM](IPAM#pushing-reservations-to-the-gate).

### Rule 76

**Access is granted on the network profile the endpoint is actually on, and
scoping it counts for nothing while a wider rule stands beside it.**

Installing the OpenSSH Server capability makes Windows create a firewall rule of
its own, `OpenSSH-Server-In-TCP`. That rule accepts TCP/22 from **any source**,
and it applies to the **Private profile only**. Both halves matter:

- A **domain-joined** endpoint is on the Domain profile, so the rule never
  applies to it. sshd is installed, running, and unreachable — the service looks
  healthy and the event log says nothing.
- On a Private network it opens port 22 to **every host on it**. Firewall rules
  are additive allows, so a tightly scoped rule beside it narrows nothing.

The Windows onboarding script settles it, and what "settled" means depends on
whether you filled in **Polaris server address**:

| Server address | Windows firewall after the run |
|---|---|
| set | `Polaris SSH (TCP 22)` allows TCP/22 from that address on **every** profile, and `OpenSSH-Server-In-TCP` is **disabled** — the Polaris rule is the only way in |
| blank | nothing is opened, and `OpenSSH-Server-In-TCP` is widened from Private to **Domain, Private** so a domain-joined endpoint is reachable. Which sources may connect is unchanged, so restrict port 22 some other way |

**Public is never added**, on either path: being unreachable on your own domain
network is the problem being solved, and an any-source rule on the profile a
laptop picks up in an airport is not part of it. Both paths are safe to re-run,
and the detection script does not judge the firewall — it cannot know which of
the two shapes to expect.

See [Polaris Agent](Polaris-Agent#the-windows-firewall-rule-and-the-one-windows-writes-for-itself).

### Rule 77

**A VIP describes an address; it does not claim it — and the status says every
fact it has.**

A FortiGate virtual IP states what happens to traffic for an address. That is a
third fact about the address, beside who holds it and how the gate hands it out
([rule 23](#rule-23)), and treating it as the single answer caused two problems
at once.

**You could not reserve one.** A VIP row was refused like an interface address.
But the addresses behind a VIP — its mapped addresses, a virtual server's
realserver pool — are ordinary hosts that want a DHCP reservation, and holding
the external one in the address register is a reasonable thing to want. Those
are now reservable, and the VIP rides along: the new reservation carries it, the
address keeps reporting it, and the row reads **VIP / Reserved**. Editing and
releasing a VIP row are still refused, because that mapping belongs to the
device. An interface address is still refused outright: it is live on an
interface.

**And you often could not see the VIP at all.** The Status column showed one
fact per address, so a VIP on a leased address read "DHCP Lease" and a VIP on a
conflicted address read "Conflict" — including, at worst, on an address whose
reservation had just been refused *because* of that VIP. Status now reports the
VIP first and what is happening to the address second: **VIP / Leased**, **VIP /
Reserved**, **VIP / Conflict**, or **VS /…** for a load-balance virtual server.
Labels on addresses with no VIP are unchanged. The exports of the address list
use the same wording, so a PDF cannot disagree with the table it came from.

The per-network **Discover** button reads the gate's VIP table as part of its
pass. A VIP table it could not read is reported as not read — never as "there
are no VIPs" — so nothing already recorded is retired on a failed read
([rule 53](#rule-53)), and a VIP is only ever retired by the gate that owns it.

See [IPAM](IPAM#addresses-that-carry-a-firewall-vip).

### Rule 78

**An automation may choose to speak for a silenced device, and then it must
name who silenced it.**

A device behind a down switch or firewall is **dependency-down** (Dep. Down),
and every automation stays silent about it — the outage is the parent's, and one
alert on the parent is the whole story ([rule 37](#rule-37), [rule 16](#rule-16)).
That is right for the network team and wrong for the people who only watch one
device: the operators subscribed to a PLC's down automation heard nothing when
the switch above it died.

So a `monitor status is down` automation — and only that kind — can tick
**Dependency-Down Bypass** on its Actions step. With it on, the automation still
raises its alert **the moment the device turns Dep. Down**; it does not wait for
the device's own missed-poll count, because the upstream's confirmed outage is
the evidence. The alert **says DEPENDENCY DOWN** in the subject, the headline
and the message, and **names the upstream device** — and, when that device is
itself Dep. Down under something further up, the device that is actually down
(a suppressed switch's FortiGate). If Polaris cannot work out who, the alert
still goes out, saying so.

The alert's kind follows the device's state. A plain Down alert on a device that
then turns Dep. Down is **ended and raised again** as dependency-down, naming
the switch; a dependency-down alert whose upstream has recovered while the
device is still down is ended and raised again as the device's own outage.
Neither sends a "resolved" message — nothing recovered.

Three things the toggle does **not** change. A **maintenance window still
silences** the device. **Reminders and escalation still wait** while the device
is dependency-down — you get one notification, and the follow-ups resume when
the upstream is back. And every automation **without** the toggle behaves
exactly as before.

See [Dependency suppression](Dependency-Suppression) and
[Automation triggers](Automation-Triggers#monitorstatus--down-is-the-down-detection-automation).

### Rule 79

**Removing a MAC from an asset is a correction, not a block.**

An asset's MAC list is not a list of its network cards. It is every address
anything has ever seen that device transmit as — which includes docks and USB
adapters (the address follows the dock, not the laptop), randomised Wi-Fi
addresses, and identities relayed through ZTNA, plus whatever a merge brought
across from another record. So the list sometimes names an address belonging to
a different device, and the **×** beside each entry is how you say so.

What it does not do is blacklist the address. The row is deleted and nothing
else; if the network reports that MAC against the asset again, the next
discovery run adds it back. That is deliberate, and it is useful:

- An address inherited from a bad merge, or from a lease on a device that is
  gone, is never reported again — so deleting it is the whole fix.
- An address that **comes straight back** is being transmitted right now. Some
  physical thing is presenting it alongside this device. Suppressing it would
  leave you with an asset record that is wrong but looks right.

So a MAC that keeps returning is telling you the association is live, not that
the button failed. Go and find the dock.

Removing the entry that is currently the asset's primary **MAC Address**
promotes the best survivor: the device's own cards — as reported by the Polaris
Agent, Intune or vCenter — outrank anything a firewall or switch merely saw. A
folded port range (`AA:…:00 – AA:…:2F`) is a block of switch ports rather than a
device identity, so it is never promoted; an asset left holding only ranges
correctly shows no primary MAC.

Needs **Assets: Write** (the built-in *assetsadmin* role, and admin).

See [Assets](Assets#correcting-a-wrong-mac-association).

### Rule 80

**Downtime Polaris itself causes is not an incident, and a silence it grants
expires on its own.**

Upgrading, reinstalling or uninstalling the [Polaris Agent](Polaris-Agent) stops
the agent service on the host. That drops the agent's connection, which raises
`agent.disconnected` — and the built-in automation on that event would page you
about work you asked for.

So each of those three operations puts the asset into a
[maintenance window](Maintenance-Windows#windows-polaris-opens-for-itself) for
its duration. A first install and a retry do not: there is no agent running to
disconnect, and silencing a host mid-install would hide a real failure.

Two parts of this are deliberate and worth knowing:

- **It ends when the agent comes back**, not when the installer finishes. The
  disconnect can take up to a minute to be noticed, so ending the window early
  would let the alert through anyway.
- **It expires on its own** — 20 minutes for an upgrade or uninstall, 30 for a
  reinstall — whatever happened to the operation that opened it. A device in
  maintenance is not being monitored, so a window that could be left open by a
  crashed upgrade would quietly stop watching a production machine. If that cap
  is ever reached, the alert that was suppressed fires late rather than never.

A failed operation ends its window immediately: an agent that is down because
its upgrade failed is exactly what you want to hear about.

See [Maintenance Windows](Maintenance-Windows#windows-polaris-opens-for-itself)
and [Polaris Agent](Polaris-Agent#upgrading).
