# Business rule 139 — full narrative

> Written 2026-11-02 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 139](#rule-139) — An asset holding two DHCP reservations is a conflict, and resolving it keeps one and releases the rest

<a id="rule-139"></a>

## Rule 139 — An asset holding two DHCP reservations is a conflict, and resolving it keeps one and releases the rest

**What prompted it (2026-11-02).** The owner released a DHCP reservation from the Networks
panel and found the asset still linked to it (rule 102(b) is that half). While that was being
fixed they added, verbatim: "if an asset has two dhcp reservations, then raise a conflict".

A DHCP reservation is a person's statement that this device gets this address. Two on one
device is almost never intended: the device was re-addressed and the old entry stayed on the
gate, or it moved sites and the reservation at the old site still holds an address nobody can
use. Polaris let both stand and linked the asset to both, so releasing one left it answering to
the other with nothing anywhere saying so.

### What counts

- **A gate binding.** An ACTIVE reservation that is a MAC-to-IP entry on a FortiGate:
  `sourceType` `dhcp_reservation` (learned from the gate) or a Polaris row the gate confirmed
  (`pushStatus` `synced`). A lease is a hand-out, not a choice; a manual row never pushed is
  Polaris bookkeeping with nothing on the gate; infra rows (`fortiswitch` / `fortinap`) belong
  to the controller (rules 23, 45); a VIP describes an address (rule 77).
- **Reached through the MAC list.** A reservation names a MAC, not an asset, so it reaches one
  through `AssetMacAddress` (single-MAC rows; a range row is an interface fold, not a card). A
  MAC two assets both list is skipped — which asset holds the reservation is then a
  duplicate-record question (rules 40, 83), not this one. The all-zero MAC is no one's (rule 97).
- **Every MAC of the asset.** The owner said "an asset", so a wired and a Wi-Fi reservation on
  one laptop are two. That case is often deliberate, and Reject is how the operator says so —
  the same set never re-raises.
- **Not** decommissioned / disabled assets (nothing to address) and not Fortinet infra.

### Why a sweep

Both sides of the join have many writers: discovery's reservation sync, reserve / release from
the IP panel, the push queue, and every MAC writer. One fleet pass — the active gate bindings,
then the MAC rows naming them — answers it for every asset, as the duplicate-IP sweep (rule 40)
does for addresses. 10 minutes, scheduler role, writes only on change.

### The verb

Accept would name nothing, so it is refused. The card's per-row **Keep this one** posts
`/conflicts/:id/keep-reservation` with that reservation's id, and every other reservation in
the set is released through `releaseReservation` — the same path as Release in the IP panel:
deleted from the gate when DHCP writeback is on, and detached from the asset by rule 102(b).
It takes the release gate (`reservations:write`, and below Full RW only rows the caller
created), checked on every row before any is released, because a resolution that releases two
rows and then refuses the third leaves the operator with neither the old state nor the new.
The conflict is accepted only when every release succeeded; a release that failed leaves it
open for the sweep to refresh.

### Rejected

- **Raising per MAC instead of per asset.** It would keep the laptop wired + Wi-Fi case quiet,
  but the owner's words were per asset, and Reject already covers the deliberate pair.
- **Auto-releasing the older reservation.** Which one is stale is a fact about the network the
  operator knows and Polaris does not; a reservation on another site's gate may be the live one.
- **Raising at write time.** The writers are too many to hook, and a duplicate is a property of
  the fleet — the rule 40 reasoning.

### Leases, and releasing one at a time (2026-11-03)

The owner, verbatim: "perhaps we expand duplicate reservation to also include leases with the ability to revoke a lease or keep the lease and remove the reservations". The common case it names: a device with a reservation it is not using, holding a lease elsewhere — the gate hands the device one address while IPAM promises it another.

- **A held `dhcp_lease` is a binding beside the reservations** (`isDhcpBinding`; `isDhcpReservation` keeps the old meaning). A set conflicts only with two or more bindings AND at least one reservation (`bindingsConflict`). Without that guard every laptop holding a wired and a Wi-Fi lease would raise a card — that is DHCP working, not two promises.
- **Two verbs per row.** *Keep* (the old *Keep this one*, renamed at the owner's request) releases every other binding — on a lease row that is "keep the lease and remove the reservations". *Release* / *Revoke lease* (`POST /conflicts/:id/release-reservation`, `releaseOneReservation`) removes just that one through the same `releaseReservation` path, which revokes a lease on the gate when DHCP writeback is on; the card resolves (accepted, by the operator) once the still-active rest no longer conflicts, and otherwise stays open with the row dropped.
- **The card links out.** The network opens its slide-in at the address; the FortiGate opens its asset, resolved at sweep time through `utils/fortinetParentKey.ts` (`gateAssetId`) because `Subnet.fortigateDevice` is FortiManager's device name and never a hostname match; the MAC copies on click; the address no longer wraps (the primary badge sits under it).

Rejected: counting two leases alone (DHCP working); a lease-only "Revoke all leases" card verb (Keep on a reservation already does it, and one more verb was not asked for).

### Who resolves it (2026-11-04)

Rule 141 (f). The question that started the write-scope review was whether this conflict has
RBAC of its own and whether a region could resolve its own. It does, and it is a
**reservations** task, not a conflicts one: the list is visible at `discoveryConflicts:read`,
and Keep / Release / Revoke lease need `reservations:write` (`assertDuplicateReservationRelease`
+ `assertDhcpBindingInScope` in `routes/conflicts.ts`) with at least ONE binding in the caller's
reservations write scope — the reservation theirs, or its network or the conflicted device
carrying one of their tags. Once in, EVERY binding in that conflict may be released, including
on a gate in another region: the conflict is one device's, and half-resolving it would leave
the device with two bindings on purpose. `discoveryConflicts:write` is not consulted for this
flavour. `GET /conflicts` carries `canResolve` / `canRelease` and, per binding, `inScope`, so
the card hides Release on a binding out of reach and the whole action cell below the gate.
