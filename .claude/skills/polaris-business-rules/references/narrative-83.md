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
