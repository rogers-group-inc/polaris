# Business rule 83 — full narrative

> Written 2026-09-22 as its own file rather than appended to `narrative-60-64.md`, which
> has been at the 1500-line reference-file ceiling since rules 78 and 80 were split out.
> Rule numbers are a stable citation key — never renumber. (81 is a deliberate gap; see
> the note at the top of `narrative-82.md`.)

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 83](#rule-83) — A serial belongs to one device and one owner; two claimants is a report, never a silent winner

<a id="rule-83"></a>

## Rule 83 — A serial belongs to one device and one owner; two claimants is a report, never a silent winner

A serial number is the one identifier in this application that is supposed to be
unarguable. Business rule 41 already leans on that: a subnet's serving gate is identified
by its chassis serial precisely *because* a name cannot tell a rename from a
replacement. The same assumption is wired through
`utils/fortinetParentKey.ts`, whose own header says duplicate serials "shouldn't exist".

They can, in two ways, and until this rule neither of them was reported.

### The first way: one device, two gates, and a record that changes owner every pass

A FortiSwitch or FortiAP is discovered through the gate that manages it. Discovery writes
what it saw into two places: an `AssetSource` row keyed `(sourceKind, externalId)` —
where `externalId` **is the device's serial** — and, on the Asset itself,
`fortinetTopology.controllerFortigate` / `.controllerSerial` plus
`discoveredByIntegrationId`.

Now suppose two gates both carry that serial on their managed roster. There are two
ordinary reasons: a stack was rehomed and nobody removed it from the old gate's
configuration, or one physical fleet is covered twice (an FMG integration and a
standalone FortiGate integration pointed at overlapping devices — the parity pairing
CLAUDE.md requires makes this easy to arrange by accident).

Nothing collided. The source row's unique key is the DEVICE serial, so the second gate's
pass did not insert a second row — it **updated** the first, moving `integrationId` onto
itself. The topology stamp was written unconditionally, so it moved too. On the next pass
of the other integration, everything moved back.

What moved with it is the part that matters, because none of it is cosmetic:

- **dependency suppression** resolves a switch's parent through the controller stamp
  (rule 38 via `fortinetParentKey`), so the device's parent changed every pass — and with
  it, which outage was allowed to silence it;
- **Device Map membership** and **region tags** (rule 54) are derived from the same
  stamp, so the device moved between sites on the map;
- **description sync** (rule 14) targets the controller by name, so a write could be
  addressed to a gate that no longer had the device;
- **interface auto-monitor** and the **decommission vouching sweep** both key off the
  controller, so a device could be vouched for by one gate and judged absent by the other.

And the whole time, every surface looked confident. There was no card, no Event, no
column — the record simply said something different depending on which integration had
run most recently. **The reason it was undetectable is that the evidence was never
stored**: one row per device, overwritten. So the fix is not a smarter comparison, it is
a table — `AssetControllerClaim`, one row per **(device serial, claiming controller)**,
re-asserted by every discovery pass. A collision is then simply a serial with two fresh
claims, and the sweep in `duplicateSerialConflictService.ts` reads it.

### Why this reports and does not resolve

The obvious next step — let the first claimant keep the record until an operator says
otherwise — was considered and rejected.

A completed move and a stale roster entry **produce identical observations** for as long
as both gates keep answering. Only a person knows which one happened, because the
answer is a fact about the FortiGates' configuration rather than about anything Polaris
can see. Picking a winner would therefore be guessing, and a wrong guess is worse here
than the flapping is: freezing the incumbent invents a state an operator must clear
before a legitimate rehome can land, and it does so **silently**, in the direction where
nothing looks wrong. The flap at least changes.

So discovery is untouched. The card names both gates and, for each, when it last said so
— which is the one column that separates the two explanations, since a gate that has
genuinely lost the device stops re-asserting. That also makes the report self-cleaning:
a claim not renewed within `CLAIM_FRESH_DAYS` (2) stops counting, the group drops below
two claimants, and the reconcile closes the conflict as `system:auto-resolved`. **A
completed move closes its own card without anybody clicking anything.** A stale roster
entry keeps being re-asserted, so it keeps the card, which is exactly the one that needs
a human.

Two days rather than duplicate-IP's seven, and for the opposite reason to rule 40's
generosity: an address claim ages because a DEVICE may have moved, so a long window
avoids false negatives; a controller claim is renewed by every discovery pass of the
integration that owns the gate, so two days is roughly forty-eight missed reads — enough
to ride out an integration outage or a weekend of failed runs, short enough that a
finished move clears within a working day.

### HA is one gate, and the fold has to happen on identity, not on names

An HA cluster publishes a managed roster per member, so without care every switch behind
every clustered gate would be reported as contested — which would have buried the real
ones on exactly the installs most likely to have them.

Claimants are therefore folded onto the **firewall Asset** they resolve to before being
counted. That works because discovery already writes one `fortigate-firewall`
`AssetSource` row per cluster MEMBER serial against the cluster's single asset, so the
member serials converge by themselves. The name-keyed fallback goes through
`resolveInfraParentAsset`, never through a hostname comparison, for the reason that
module exists at all: `controllerFortigate` holds FortiManager's device name, which is
under no obligation to equal the gate's configured hostname (the prod 2026-08-12 bug).
The same fold quietly handles a gate re-registered under a new FMG device entry — same
chassis serial, two names, one claimant.

### The second way: one serial, two records

The other thing a serial can be wrong about is simpler and older. Two Asset rows carry
the same serial — a device that Entra and vCenter both discovered and nothing
cross-linked, or a record that outlived a re-enrolment. Discovery's own serial-mismatch
guards stop the Fortinet paths from producing this, which is why the assumption in
`fortinetParentKey.ts` survived; the directory and hypervisor paths have no such guard.

Here there is no ambiguity to preserve: a serial identifies one physical unit, so two
records of it are one device recorded twice, and the card's only verb is the merge —
through `assetMergeService.mergeAssets`, the same engine the asset page's Merge modal and
the duplicate-IP card use, at `assets:fullwrite` because it deletes a row (rule 40's
level, for the same reason).

Whichever door the merge comes through, the card closes with it. *Review & merge...*
opens the asset Merge modal, which merges through `POST /assets/:id/merge` rather than
the conflict verb, and for a while that left the card on the queue — still listing the
record that had just been deleted — until the next sweep auto-resolved it. An operator
reads that as a merge that did not happen. The merge route now settles the card itself,
as `accepted` in the operator's name, because the merge was the resolution.

The automatic merge takes the same door. It first shipped through the placeholder-ghost
executor the hostname pass uses, which lets the delete cascade the absorbed record's
sources and agent enrolment — harmless for a DHCP-learned ghost, destructive for the
records this rule is about, which are usually two real identities of one machine (a
directory record beside an agent). A merge that removes one of the two things it was
reconciling is not a merge.

The one genuine innocent explanation is that the serial is not a serial. Whiteboxes and
hypervisors ship SMBIOS defaults — `To Be Filled By O.E.M.`, `Default string`, `System
Serial Number`, `0123456789` — and a fleet of them would otherwise arrive as one
enormous group naming machines that have nothing to do with each other, which is how an
operator learns to ignore the conflict queue. Those are filtered by name, by length, and
by the single-repeated-character shape every unprogrammed serial takes. `MAX_PLAUSIBLE_
DUPLICATES` (8) is the second net for the defaults nobody has met yet: past that count
the serial is the suspect, not the assets.

That test is applied where a serial would be WRITTEN, not only here where it is read.
The list, the length floor and the repeated-character shape live in
`utils/serialNumber.ts`; `utils/assetProjection.ts` runs every one of its `SERIAL_RULES`
picks through it, so a placeholder falls through to the next source instead of winning
the field, and `api/routes/agents.ts POST /system-info` clears a stored one once no
source can replace it. Filtering only at sweep time was half a fix: it stopped the false
conflict card, but the junk still sat on the asset, was still rendered as that device's
serial, and was still what a human compared two records by — and because the Polaris
Agent outranks Arc and Intune for this field, a placeholder it reported also buried the
real serial a cloud source already had. The agent carries the same list
(`agent/internal/collectors/serialnumber.go`) so the value never reaches the wire;
`tests/unit/serialNumber.test.ts` asserts the two copies are identical.

### What is deliberately narrower than rule 40

The duplicate-IP sweep excludes every status in `UNMONITORABLE_STATUSES`, because its
question is "can this device be on the network". This rule's question is "does this
record have an owner", and a switch in `storage` (what discovery stamps for an
Unauthorized FortiSwitch) or `quarantined` still sits on the Device Map, still carries
region tags and still changes hands every pass. Only `decommissioned` and `disabled` —
written off, or switched off by an operator — drop out.

### Rule 83 — the invariant as stated in full until 2026-09-22
> Moved here verbatim from the invariants file on 2026-09-22, when the invariant layer was cut back to the contract alone; the short invariant now points here for the reasoning and the dated history. Nothing below was rewritten; this is the text as `main` carried it at the 2026-09-23 merge, which had already gained clauses the branch had not seen.

**A serial belongs to one device and one owner; two claimants is a report, never a silent winner** — a serial number is the one unarguable identifier (business rule 41 leans on exactly that), and two things can make it arguable. (a) **One managed device, two controller FortiGates.** `AssetSource` is unique on `(sourceKind, externalId)` and externalId for a fortiswitch/fortiap IS the device serial, so a second claiming gate did not collide with the first — it OVERWROTE it, and the unconditional `fortinetTopology` / `discoveredByIntegrationId` stamps moved with it, flipping back on the other integration's next pass. Dependency suppression's parent (rule 38), Device Map membership, region tags (rule 54), description-sync targeting (rule 14), interface auto-monitor and the decommission vouching sweep all follow that stamp, so the device changed owner — silently — every pass. The evidence was never stored, which is why nothing could report it: the fix is `AssetControllerClaim`, ONE ROW PER (device serial, claiming controller), re-asserted every discovery pass, swept by `duplicateSerialConflictService`. (b) **One serial, two Asset rows** — the directory/hypervisor paths have no equivalent of discovery's Fortinet serial-mismatch guards, so a device Entra and vCenter both found can sit on two records. **REPORT-ONLY for (a), and deliberately so**: a completed rehome and a stale roster entry are IDENTICAL observations while both gates answer, only a person knows which, and freezing the incumbent would invent a state an operator must clear before a legitimate move could land — silently, in the direction where nothing looks wrong. Discovery is untouched; the card names both gates and when each last said so, and the report is SELF-CLEANING because a claim not re-asserted within `CLAIM_FRESH_DAYS` (2, not rule 40's 7 — a controller claim is renewed by every discovery pass, so two days is ~48 missed reads) stops counting and the reconcile closes the row `system:auto-resolved`. **HA is ONE gate**: claimants fold onto the firewall ASSET they resolve to before being counted (every cluster member serial converges through its own `fortigate-firewall` AssetSource row), via `resolveInfraParentAsset` and never a hostname compare — the same fold absorbs a gate re-registered under a new FMG device entry. Flavour (b) has no ambiguity to preserve, so its only verb is the merge, through `assetMergeService.mergeAssets` at `assets:fullwrite` (rule 40's level, it deletes a row); its false-positive risk is a serial that is not one, so SMBIOS placeholders are filtered by name, by length and by the single-repeated-character shape, with `MAX_PLAUSIBLE_DUPLICATES` (8) as the net for defaults nobody has met yet — past that count the SERIAL is the suspect, not the assets. That same test now runs at every WRITE point too, which is **business rule 84** — so by the time this sweep runs, a placeholder should never have become an `Asset.serialNumber` at all; these two nets remain the backstop for rows written before that guard and for any path that bypasses the projection. **And because (b)'s only verb was always the merge, it is now taken automatically** (2026-09): `mergeDuplicateHostnameAssets` gained a serial pass that groups on the same `normalizeSerialKey` and reuses this rule's `isUsableSerial` + cap, so a flavour-(b) group is absorbed within 30 minutes — through `mergeAssets`, like the card's own verb, so both records' sources and the agent enrolment survive — and a card that SURVIVES means the merge declined it (over the cap, or the transaction failed). This does not touch (a), whose report-only stance is the decision above. Two upstream fixes landed with it, both about the same silent failure: the discovery asset index keyed `bySerial` VERBATIM while every other identity key was normalized, so a gate reporting a differently-cased or padded serial missed an asset Polaris already had and CREATED A SECOND ONE — the prod case that prompted this, a FortiSwitch recorded twice with the older row holding no `AssetSource` at all, because the newer asset's claim on the unique `(fortiswitch, serial)` key re-bound the row off it. The three Fortinet RMA guards compared serials with `.toUpperCase()` and no trim, which would have let a padded serial match the index and then fail the guard; all four sites now use `normalizeSerialKey`. Both flavours stamp `conflict.detected` (the baseline conflict automation covers them) and dedup on dismissal: (a) on the CLAIMANT set, (b) on the member set. The status filter is deliberately NARROWER than rule 40(a)'s `UNMONITORABLE_STATUSES` — the question here is whether a record has an owner, not whether a device is on the wire, and a `storage` or `quarantined` switch still holds region tags and still changes hands — so only `decommissioned` and `disabled` drop out.

