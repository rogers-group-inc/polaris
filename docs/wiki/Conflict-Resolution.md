# Conflict resolution

A **conflict** is something discovery found that it refuses to resolve on its
own. It queues for a human.

The design rule underneath all of them: **discovery values differing from an
existing manual record create a conflict rather than overwriting**
([rule 7](Business-Rules#rule-7)). An automatic merge that silently loses an
operator's decision is worse than a queue nobody has cleared.

Reached from **Events → Conflicts**, the **Conflict Queue** dashboard widget
(which is **role-scoped** — you only see the ones your role can resolve), and
the conflict slide-over.

| Gate | |
|---|---|
| `discoveryConflicts:read` | see the queue |
| `discoveryConflicts:write` | accept / reject |
| **plus `assets:write`** | **chained**, for the two verbs that edit or delete inventory |

---

## The flavours

| Flavour | Entity | Raised when |
|---|---|---|
| **Field conflict** | reservation | a discovered value differs from a **manual** reservation |
| **Hostname collision** | asset | a discovered device's hostname matches an existing asset |
| **`duplicate-ip`** | asset | two network-present devices claim one address |
| **IP override** | asset | discovery disagrees with an operator's IP pin |
| **`serial-two-controllers`** | asset | one managed FortiSwitch/FortiAP is on **two FortiGates'** rosters |
| **`duplicate-serial`** | asset | two asset records carry the **same serial number** — usually merged automatically, see below |
| **`chassis-replaced`** | subnet | a network's serving FortiGate answers with a different chassis serial |

---

## Field conflicts on reservations

The original flavour. Discovery proposes a hostname, owner, project reference,
notes or source type for an address an operator has already claimed manually.

| Verb | Does |
|---|---|
| **Accept** | adopts the proposed values — **fill-only**: it has only ever filled blanks |
| **Reject** | dismisses; the rejected combination does not re-raise |

Because accept is fill-only, a conflict whose proposed fields are all already
populated would change nothing on accept. Those are raised fill-only in the
first place, and pre-existing ones close themselves on the next cycle.

---

## Hostname collisions

A new device whose hostname matches an existing asset raises a conflict rather
than merging. The card snapshots both sides — what was proposed, and what the
existing asset looked like when the conflict was raised.

Assets **pinned** with a hostname override are excluded from the automatic
duplicate-hostname merge entirely.

---

## Duplicate IP — the long one

`Asset.ipAddress` carries **no uniqueness constraint**, deliberately: two rows
holding one address is a state discovery has to be able to **represent** in order
to report it. (Contrast the IPAM side, where a per-network unique index makes a
duplicate reservation impossible.)

So duplicates are found by a **sweep every 10 minutes** and reported
([rule 40](Business-Rules#rule-40)). The seeded "IP conflict detected"
automation alerts on it.

Eight decisions shape what gets reported.

### (a) Only network-present assets count

Status must not be one of the four unmonitorable ones — so `active` and
`maintenance` only. A shelved, disabled or decommissioned row is not on the
wire.

### (b) A stale record is not a duplicate

DHCP reuses addresses constantly, and an asset keeps the last address a writer
staged until another write moves it. So a departed device's row sits on an
address its successor legitimately holds — and **reporting those would bury the
real ones**.

A claimant counts only while its claim is **current**:

| Claim | Expires? |
|---|---|
| operator-owned — an IP override, or a manual IP source | **never** |
| discovered | must have been **re-asserted within 7 days** |

Freshness is measured on the per-`(asset, ip)` history row, which is bumped on
**every** write staging an IP — so it tracks **cadence, not change**. That is
preferred over the asset's own presence on purpose: a device that is up but whose
recorded address nobody has re-asserted in months is a **stale record**.

### (c) It takes two devices, not two rows

Claimants sharing one non-null MAC are **one device recorded twice** — which is
a merge's problem, not an address conflict. A null MAC proves nothing, so each
such row counts as its own device.

### (d) One pending row per address, never per pair

A three-way collision is **one card** carrying every claimant, not three cards.

### (e) Accept is refused — there are two verbs instead

There is nothing to adopt, so the card offers the verb matching the real cause:

| Cause | Verb |
|---|---|
| **Two devices** | **Reassign IP** — type a new address on **one** claimant. Written with the asset form's own pin semantics, and it **refuses an address another network-present asset already holds**, which would move the duplicate rather than resolve it |
| **One device recorded twice** | **Merge** — name a survivor and the rows to absorb. It runs the same engine the asset page's Merge modal uses, so provenance, MACs, IP history, dependency edges and monitoring carry identically |

Merge accepts **no field winners** — blank-fill is what every automatic absorb
does, and per-field control lives on the asset's Sources tab.

**Reject means dismiss**, and the rejected row is the dedup marker: the **same
claimant set** never re-raises, while a **changed** one does.

### (f) A duplicate that resolves itself closes itself

Auto-resolved as rejected by the system. Nothing may leave a resolved collision
sitting in the queue.

### (g) One claimant has to be equipment somebody addressed on purpose

Eligible types: **switch · access point · firewall · server** (the last covering
vCenter VMs, which are typed `server`).

Two endpoints trading a pool address is DHCP working, not a fault. **An endpoint
sitting on an access point's address is an outage.** So **one** qualifying member
raises the group, and every other claimant still rides the card — the endpoint is
usually what took the address, and moving the endpoint is usually the fix.

Eligibility is tested on the **current** claims, so a departed switch's leftover
record cannot license a conflict between two live laptops.

It is a constant, not a setting — a claim about which equipment has deliberate
addressing, not a per-install preference. `hypervisor` and `router` are
deliberately outside it pending a decision.

### (h) Or the address was assigned on purpose, and the claimants came from
different integrations

A second, independent way past (g). **(g) asks whether the *device* has
deliberate addressing; this asks whether the *address* does.** Both halves are
required:

**Disjoint sources** — two claimants whose source-kind sets share **nothing**.
A shared kind means one integration reported both rows, which is that
integration's identity resolution to fix. A claimant with **no** source rows
abstains rather than qualifying: unknown provenance is not evidence that two
integrations disagree.

**A deliberate address** — an active reservation on the containing network that
is a VIP, a `dhcpBinding = "reservation"`, or a source type in
`manual` / `dhcp_reservation` / `interface_ip` / `vip`.

> **All three columns are read, because [rule 23](Business-Rules#rule-23) makes
> them three separate facts.** Discovery stamps VIP information on a row still
> labelled `dhcp_lease`, and the DHCP-binding phase writes the binding without
> ever flipping the source type — so the source type alone is wrong in *both*
> directions.

A plain `dhcp_lease` is deliberately **not** deliberate: on a leased address two
genuinely different devices may hold it days apart inside the 7-day window.

What (h) reports is overwhelmingly **one device recorded twice**, so the card
leads with the merge rather than with renumbering. The card records which clause
admitted it.

### (i) Or an operator typed the address

The third way a pair qualifies. (g) asks whether the *device* has deliberate
addressing and (h) whether the *address* does; this asks whether a **person**
did the addressing. An IP you typed into the asset form — or pinned — is an
address somebody chose, exactly as a reservation is, so two workstations one of
which was hand-addressed is a conflict even though neither device's type would
qualify it on its own. The card says so in those terms.

It still takes two devices (a shared MAC is one device recorded twice — merge
it) and a *current* counterpart (a departed device's leftover record is not a
collision with the one you just addressed).

### Checked when you save, not just every ten minutes

Creating an asset with an IP, or changing an asset's IP in the edit form, checks
that address **before** the write. If another network-present asset already
records it, a dialog names the holder — type, status, when the address was last
confirmed, whether it is pinned — and offers:

- **Save & submit for conflict review** — the save lands and the Duplicate IP
  card is raised immediately, with the `conflict.detected` event your
  automations already alert on. This is the choice for everyone.
- **Save & review merge with …** — shown only when you hold Assets **full
  read-write** and there is exactly one current holder. It saves, then opens the
  merge review between your record and the holder — the answer when the
  "collision" is one device recorded twice. With several holders, merge from the
  conflict card instead.
- **Cancel** — nothing is written.

A record whose claim is **stale** is listed but does not count as a collision;
saving over it raises nothing. If the check itself fails (a network blip), the
save proceeds — the ten-minute sweep is the backstop, and a pre-flight that could
block a save would be worse than none.

Changing an asset **off** a contested address closes that card on the same save
rather than on the next sweep. Merging two assets re-checks the survivor's
address the same way.

CSV and PDF imports do not trigger this: the CSV import writes no address, and
PDF-imported assets are created in `storage`, which (a) excludes.

---

## IP override conflicts

An operator pins an asset's IP; discovery then stages a **different** one.

The pin is re-asserted, and **one** pending conflict is raised per asset.

| Verb | Does |
|---|---|
| **Accept** | adopts the discovered IP and **releases the pin** |
| **Reject** | keeps the pin, and suppresses re-raise **for that same IP** |

Note the self-disabling case that is *not* a conflict: a discovery write staging
the **same** IP as the pin **releases** the pin in that write, audited. The pin
did its job.

---

## Two FortiGates claim one device

A FortiSwitch or FortiAP is discovered through the FortiGate that manages it,
and that gate becomes the device's owner: its parent for
[dependency suppression](Dependency-Suppression), its placement on the
[Device Map](Device-Map), the source of its region tags, and the gate a
description sync writes to.

When **two** gates carry the same device on their managed roster, whichever
integration ran discovery last owned the record — and the other one took it back
on its next run. Nothing said so; the record just changed. This card is Polaris
telling you it is happening.

The card lists each claiming gate with **when it last reported the device**,
which is the column that tells the two causes apart:

| What you are looking at | What it means |
|---|---|
| Both gates reporting recently | the device was moved and the **old gate still has it configured**, or two integrations cover the same equipment |
| One gate's "last confirmed" going stale | the move is settling; the card will close itself |

**Polaris changes nothing on the FortiGates, and does not pick a winner.** There
is no Accept — remove the device from the roster of the gate that no longer owns
it, and once that gate stops reporting it for **two days** the conflict closes
itself as auto-resolved. **Reject** dismisses the card and changes nothing; the
same pair of gates will not raise it again, but a different pair will.

An HA cluster is one gate, not two — the cluster's members are recognised as the
same FortiGate and never raise this card between themselves.

---

## Two records, one serial number

Two assets carry the same serial. Nearly always one device recorded twice:
two integrations found it and nothing cross-linked the records, or a record
outlived a re-enrolment.

**Polaris usually merges these for you.** Because a shared real serial leaves
no room for doubt — it is one device — a background pass absorbs these groups
automatically, every 30 minutes, keeping whichever record has the stronger
provenance. So you will rarely see this card, and one that *does* appear is a
group the automatic pass declined: a serial shared by more assets than any one
device could have, or a merge that failed. The verbs below are for those.

| Verb | Does |
|---|---|
| **Merge into this** | keeps the row you clicked, absorbs and **deletes** the others |
| **Review & merge…** | opens the full [comparison](Conflict-Resolution#merging-assets-by-hand) first |
| **Reject** | they really are different units; the same set will not re-raise |

Merging needs **full read-write on Assets** — it deletes a record. There is no
Accept: there is nothing to adopt.

Polaris ignores serials that identify nothing rather than reporting them: the
placeholders some hardware ships (`To Be Filled By O.E.M.`, `Default string`,
`System Serial Number`, `Not Specified`, and any serial that is one character
repeated), anything under four characters, and any serial shared by **more than
eight** assets — past that count the serial is the problem, not the assets.

Both serial conflicts are swept every 30 minutes and are covered by business
rule [83](Business-Rules#rule-83).

---

## Chassis replaced

A network records the **serial** of the gate serving it. When the gate answers
with a serial that is neither the stored one nor any member of its cluster, the
physical FortiGate was swapped ([rule 41](Business-Rules#rule-41)).

The conflict is **additive and destroys nothing**:

- the old chassis's network **and its reservations are copied to the archive**;
- nothing is released, re-pushed or deleted;
- the stored serial is **deliberately not re-pointed while the conflict is
  pending** — the pending row *is* the unresolved state. Accepting moves it.

Dedup is keyed on the **(old, new) serial pair**, so a rejected row suppresses
exactly that transition while a second swap raises anew.

### Why the comparison is careful

| Case | Handling |
|---|---|
| **null** stored serial | *unknown* — **learns** on first sight. Nothing is backfilled; every row converges on its own |
| **unreadable** serial this run | *unknown* — applies **no constraint**, never "different". One failed read must not declare the fleet replaced |
| **HA cluster** | compared against a **set**: the reporting gate plus every cluster member. FMG flips the top-level serial to whichever member is active, so a single-value comparison would report a replacement on **every failover** |
| a chassis re-registered under another FMG device entry | genuinely a replacement **for this network** — the comparison is per device, not fleet-wide |

### What it closed

A same-name RMA swap previously matched by CIDR, matched the roster, and let the
new chassis inherit **every reservation row of the old one** — marked synced,
with dead device-side pointers. Silently.

### If you see this about a box nobody swapped

You almost certainly have **address space that is the same at every site** — a
management VLAN, an out-of-band range, an appliance's fixed subnet. Each site's
gate answers with its own serial, so the one shared row reads "replaced" on every
run, with a fresh pair each time so dedup never catches it.

The fix is a [network exclusion](IPAM#exclusions), not a rejection.

---

## Merging assets by hand

The **Sources** tab's merge modal, or the Assets bulk bar with exactly two rows
selected — or, from the asset form's duplicate-address dialog, *Save & review
merge*.

**Merging requires Assets full read-write.** A merge edits one record and
deletes another, so it takes the same level as deploying the agent, on every
path: the modal, the Duplicate IP card's *Merge into this* and *Review & merge*
buttons, and the API. Reassigning an address from the card needs only Assets
write — it deletes nothing.

Per-field winners are pre-selected from the
[Sources priority order](Assets#sources), with the winning column badged
*higher-ranked source* and one line naming which two sources decided it — so an
operator who disagrees with the defaults is pointed at that list rather than
re-picking every row.

Two rules **outrank** the order:

- **An empty value never overwrites a filled one**, in either direction.
- **For Type, the `other` catch-all counts as empty.** A specific type on either
  side wins, and **no merge path** — operator merge, conflict accept, or the
  automatic duplicate-hostname absorb — writes `other` over a real type.

The **survivor** radio is unaffected by all of that: it follows the longer
polling history.

---

## A rejected conflict is a decision

Rejecting is not "dismiss and forget" — the rejected row is what stops the same
finding re-raising forever. That is why the dedup keys are so specific:

| Flavour | Re-raises when |
|---|---|
| duplicate IP | the **claimant set** changes |
| chassis replaced | a **different (old, new) serial pair** appears |
| IP override | a **different** discovered IP is staged |

So reject deliberately, and re-open the queue after a real change.
