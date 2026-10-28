# Business rule 137 — full narrative

> Written 2026-10-28 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 137](#rule-137) — A tag on a network a FortiGate serves is inherited by the ports of that gate's switches that carry the network's VLAN, and by those switches

<a id="rule-137"></a>

## Rule 137 — A tag on a network a FortiGate serves is inherited by the ports of that gate's switches that carry the network's VLAN, and by those switches

**What prompted it (2026-10-28).** Rule 136(e) made a down automation take its severity from
the device's or the port's Priority tag. The operator then tagged the discovered VLAN networks
in IP Management with Priority tags and asked whether a switch port on one of those VLANs
inherits the tag, and whether a port on several gets the highest. It did not: a network's tags
stayed on the network. The only way a port picked up a tag automatically was rule 133 — a
tag's own device filter naming `Native VLAN equals N` — which is per tag, native-only, and
means re-typing the VLAN map that IPAM already holds.

The operator's words: "if i put a priority tag or any other tag on a network and then that
same network is on a switch that belongs to an asset that the network belongs to (switch is a
child of a gate or firewall or router, the network was discovered from the fortigate or
firewall or router) then i'd like the switch and interface to inherit those tags. if a network
is learned from a dhcp server or something, then we wouldn't be able to make that match".

**Why the match is FortiGate ↔ FortiSwitch only.** Two facts have to meet: which gate a
network came from, and which gate a switch sits under. FortiManager / FortiGate discovery is
the only integration that stamps both — `Subnet.fortigateSerial` / `fortigateDevice` on the
network, `fortinetTopology.controllerSerial` / `controllerFortigate` on the switch — and the
only one that records per-port VLAN membership (`nativeVlan`, `taggedVlans`,
`trunksAllVlans`). The Generic API feed deliberately never writes the gate stamp (rules 41 /
45). A "router" in any other integration has no network-to-device link to follow, so it is not
in scope; the operator anticipated that for a DHCP-learned network. VLAN ids are reused per
site, so the match is per gate: VLAN 30 behind gate A is not VLAN 30 behind gate B.

Both sides resolve to an asset id through `utils/fortinetParentKey.ts` rather than comparing
strings: `Subnet.fortigateDevice` is FortiManager's device NAME, which need not match the
gate's hostname (the 2026-08 incident behind that module), and on an HA pair the stamped serial
can be either member's.

**Decisions taken with the operator (2026-10-28).**

- *Which ports carry a network* — native **and** tagged VLANs, but never a trunk set to allow
  all VLANs. Rejected: native only (a trunk listing the VLAN is on that network as much as an
  access port is); every port that can carry it, uplinks included (a FortiLink uplink would
  inherit every network's tags behind its gate, so every uplink would read Critical and a
  Priority-severity interface-down rule would page Critical for each one).
- *Which tags* — every tag on the network except the system-managed ones. `region:` belongs to
  the Device Map and `azure:` to the Arc sync, and rule 133(e) already refuses both on a port.
  `dhcp-discovered` and the integration type (`fortimanager` / `fortigate`) are markers
  discovery stamps on the network itself; handing them to a switch would say something false.
  Rejected: Priority tags only (the operator asked for "any other tag" too).
- *The switch inherits too* — the union of its carrying ports' inherited tags, the same shape
  as rule 133's "a switch with a port on VLAN 30". So a switch with ports on a Critical VLAN
  and a Warning VLAN carries both, and rule 136(e) alerts on it at Critical.

**Why its own provenance, not rule 133's.** Rule 133's engine owns `auto` port rows by
`tagId`, and `reconcileAllTags` sweeps every `auto` row whose `tagId` is not a managed Tag.
A network-inherited row has no Tag behind it, so as `auto` it would be deleted on the next
sweep. Hence source `network`. On the device side `TagAutoAssignment` is keyed `(tagId,
assetId)` — again a Tag — so the switch's half got `NetworkTagAssignment (assetId, tag)`, keyed
by NAME because several networks can hand one switch the same tag and it must stay while any
of them does. A registry rename rewrites it beside `Asset.tags`.

**Why it never claims an existing copy, and leaves off one an operator removed.** The same
two-layer collision defense as the tag-filter engine: a tag already on the switch with no
provenance row is someone else's (hand-applied, or a filter's); and a provenance row whose
tag is missing means the operator took it off, which stands until the inheritance itself ends.
When ours ends, a tag a filter ALSO owns on that switch stays — the filter engine counts its
own provenance and would never put it back. On a port, any existing row of the name occupies
it, and a manual save naming an inherited tag converts it to manual, exactly as for `auto`.

**Scale.** One fleet pass reads the gated networks (only rows with tags), every firewall and
switch (`id`, `hostname`, `serialNumber`, `assetType`, `fortinetTopology`), and the ports by
VLAN id (`nativeVlan IN … OR taggedVlans && …`, never an IN of every switch), then diffs
against the `network` rows and the provenance table. Writes are chunked at 50. A steady state
writes nothing. The per-switch path is the same query with an `assetId`. Network edits fire a
coalesced fleet pass, so a burst of edits costs two passes, not one each.

<a id="rule-137-invariant"></a>

### Rule 137 — the invariant as first stated

See `invariants-30-43.md` § 137; nothing longer was ever published.
