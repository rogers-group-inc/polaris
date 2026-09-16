# Business rules

Polaris carries **64 numbered rules**. Each one records a decision *and* the
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
tree is the sole recovery authority. Resolution is dimension-first with a
per-asset fallback. Reset leaves inherit the trigger's window. Event and change
triggers get a **counterpart Event** instead. The re-notify cooldown was retired
from the builder and its stored values cleared.

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
un-pinning is how alerting stops.

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
