# Business rule 79 — full narrative

> Moved verbatim out of `narrative-60-64.md` on 2026-09-22 (one narrative file per rule is the convention from
> rule 78 on; that file was at the 1500-line ceiling). Rule numbers are a stable citation key and did not change.
> The invariant is in `invariants-30-43.md`.

- [Rule 79](#rule-79) — An operator's removal of a MAC is a correction, not a suppression

## Rule 79 — An operator's removal of a MAC is a correction, not a suppression

An asset's MAC list is not a list of the device's NICs. It is every address anything has ever
seen that device transmit as, which on a modern fleet includes docks and USB adapters (whose
MAC follows the dock, not the laptop), randomized Wi-Fi addresses, and ZTNA-relayed
identities — plus whatever a ghost-merge brought across from another record. So the list
periodically names an address that belongs to some *other* device, and the operator needs a
way to say so. `DELETE /assets/:id/macs/:mac` is that way.

The question this rule settles is what "remove" means when discovery runs again.

The tempting answer is that it means *never again*: tombstone the row, teach
`reconcileMacAddresses` to skip it, done. It is tempting because the alternative sounds like
the feature not working — the operator removes a MAC, a discovery pass runs, the MAC is back,
and that reads as the button being broken. The design was offered in exactly those terms in
2026-09 and **declined**, and the reasoning is what this rule records, because the next
session to see a MAC come back will reach for the tombstone again.

Polaris cannot distinguish a stale association from a live one, and the two want opposite
treatment:

- A MAC inherited from a bad merge, or from a DHCP lease on a decommissioned device, is
  **never reported again**. Deleting the row is the whole fix; a tombstone adds nothing.
- A MAC that comes **straight back** is being transmitted right now. Something on the wire is
  presenting that address alongside this device — a dock shared between desks, a relayed
  identity, a mis-cabled port. That is a fact about the network, and the only mechanism that
  would make it stop appearing is one that makes Polaris lie about what it can see.

A suppression helps in the first case, where nothing needed help, and in the second case
produces a permanently wrong asset record that *looks* correct — the worst available outcome,
because it is the one nobody re-examines. Leaving the removal one-shot means a returning MAC
is a signal: it says the association is live, and points at a physical thing to go and find.

Two obligations fall out of that choice.

**The confirm has to say so.** A control that silently fails to stick is indistinguishable
from a broken one, and the operator will click it repeatedly. The dialog states that discovery
will re-add the address if the network reports it again, so a MAC that returns is legible as
the documented behaviour rather than a defect. The same sentence is in the operator wiki.

**The primary MAC has to be recomputed properly.** Removing the row the `Asset.macAddress`
scalar pointed at forces a promotion, and that promotion is the same decision
`selectPrimaryMac` makes everywhere else, so it goes through that helper rather than a local
sort. A freshest-`lastSeen` sort — which is what the endpoint did until 2026-09-21 — breaks
both of the helper's rules at once: it lets a dock sighting outrank the device's own
Intune-reported NIC, and it can promote the start key of an interface-scrape `[mac, macEnd]`
range, which is a block of switch-port addresses rather than a device identity. The range case
is self-correcting in the ugliest way: the next discovery reconcile overwrites the scalar
again, so the asset's primary MAC flickers between two values on a schedule. An asset whose
only surviving entries are ranges correctly ends with `macAddress = null`.

Finally, the grant. Correcting an inventory record is the assets administrator's act, so the
route is `assets:write` — and it always was. What was wrong for as long as the endpoint
existed is the browser: the single control that called it was gated on `canManageNetworks()`,
i.e. `subnets:fullwrite`, so the built-in `assetsadmin` role could call the endpoint all day
and never saw the button, while an admin holding every key saw it and never noticed. Too-loose
gating announces itself with a 403; gating on another page's key is silent, and presents as a
missing feature rather than a permissions bug. See `polaris-ui-canon` →
`canon-shared-kit.md` for the general form.

### Rule 79 — the invariant as stated in full until 2026-09-22
> Moved here verbatim from the invariants file on 2026-09-22, when the invariant layer was cut back to the contract alone; the short invariant now points here for the reasoning and the dated history. Nothing below was rewritten.

**An operator's removal of a MAC is a correction, not a suppression** — `DELETE /assets/:id/macs/:mac` deletes the `AssetMacAddress` row and nothing else. No tombstone, no exclusion list, no source-scoped ownership: if the network reports that address against the same asset again, the next discovery reconcile re-adds it, and that is the designed outcome rather than the removal having failed. Polaris cannot tell a stale association from a live one, and only one of them should stick — a MAC inherited from a bad merge or a decommissioned DHCP lease is never seen again and stays gone, while a MAC that keeps returning is being transmitted right now (a shared dock, a ZTNA-relayed identity), which is a fact about the network the operator needs to see rather than a record to paper over. A suppression would turn the second case into a permanently wrong asset record that looks correct. Two obligations follow. The confirm must SAY the address may come back — a control that silently fails to stick reads as a bug. And the primary-MAC recompute that follows a removal goes through `utils/macAddresses.ts → selectPrimaryMac()` rather than a local freshest-wins sort, so hardware-truth sources still outrank sightings and a `[mac, macEnd]` range row — a port block, not a device identity — is never promoted into `Asset.macAddress`. The grant is `assets:write`: correcting inventory is the assets administrator's act, and the browser control must name that same key (it read `subnets:fullwrite` until 2026-09-21, which hid the button from the only built-in role whose job this is).

