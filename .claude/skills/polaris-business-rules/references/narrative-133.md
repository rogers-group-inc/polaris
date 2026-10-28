# Business rule 133 — full narrative

> Written 2026-10-26 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap. (133 was briefly claimed by
> the infra-reserve work, which was shelved unmerged on `shelved/infra-reserve-rule-133` and
> never published; a revival of that work takes a new number.)

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 133](#rule-133) — A tag can sit on an interface, and a tag filter that names a native VLAN tags the ports on it and the switch they belong to

<a id="rule-133"></a>

## Rule 133 — A tag can sit on an interface, and a tag filter that names a native VLAN tags the ports on it and the switch they belong to

### What was asked

2026-10-26, from the operator: "i want to be able to apply tags to interfaces. when editing a
tag, if auto assign by device filter, change to auto assign by filter. i want to include
native vlan tags for assigning tags to interface. if a switch has an interface with the
native vlan on of its interface that is specified by the auto assign by filter, then the
switch gains that tag as well."

A follow-up asked for every discovered VLAN to become a tag automatically, named
`<integration>:<vlan name>` (or `<integration>:<vlan #>`), with its filter pre-built. Asked how
such tags should scope when one integration's sites number or name the same VLAN differently,
which ports should count, and what to do when a VLAN disappears, the operator chose to **skip
the automatic VLAN tags for now** and ship the tags-with-a-filter half, counting **every**
port (trunks included).

### The decision

1. **Interface tags are their own table, keyed by name.** `AssetInterface` is delete-replaced
   on every full scrape (`interfaceInventoryService.persistInterfaceRows`), so a row id lasts
   one poll and a column on it would have to be carried across every replace — and would
   still be lost the moment a port drops out of one scrape (an ambiguous empty FortiOS answer,
   a FortiLink trunk that is down). `AssetInterfaceTag (assetId, ifName, tag)` follows the
   `AssetInterfaceOverride` precedent the Interface Comments box already set: what the
   operator says about a port is keyed by its name and outlives the inventory row.
2. **Two writers, one table, told apart by `source`.** `manual` rows are the operator's;
   `auto` rows are the tag engine's and carry `tagId` as provenance — the `TagAutoAssignment`
   design one level down. The engine adds only to a port no row of that tag name occupies and
   removes only its own rows, so a hand-applied port tag is never clobbered, which is the
   collision defense devices already had.
3. **"Native VLAN" is a device-filter field, so the switch inherits by matching.** The
   operator's "the switch gains that tag as well" is exactly what a relation-backed leaf
   gives: the device matches when ANY of its ports carries the VLAN untagged, the way
   `interfaceName` matches on any port's name. The PORTS are then the matched devices' ports
   on the VLANs the tree asserts. No second propagation engine was needed.
4. **Only VLANs the tree asserts PRESENT tag ports.** `positiveNativeVlans` walks the tree
   with polarity: `equals` under an even number of `none` / `notAll` groups, `notEquals` under
   an odd number. A leaf asserting absence ("not on VLAN 99") names a VLAN the matched device
   is NOT on; tagging its VLAN-99 ports would be nonsense.
5. **Every port counts, trunks included** — the operator's explicit choice, knowing that most
   switches then match the management / default VLAN through their uplinks.
6. **Device-filter vocabulary only.** The automations scope (`SCOPE_FIELD_OPS`) is resolved
   on the engine's 60 s tick and carries a hand-maintained wizard catalog; nobody asked for
   the field there. Tags, the address book, maintenance-style device filters and mass pinning
   get it through `DEVICE_FILTER_FIELD_OPS`.
7. **`region:` and `azure:` are refused on a port.** Both namespaces belong to device-tagging
   reconcilers (the Device Map, the Arc sync); on a port they would mean nothing and no engine
   would ever take them off.

### Freshness

A port moving VLAN is caught on the asset's next full scrape: `persistInterfaceRows` compares
the port→VLAN map before and after (`nativeVlanSignature`, preserved trunks counted on both
sides so a down trunk does not re-fire) and, only on a change, fires
`reconcileTagsForAsset` in the background. Tag create / edit reconciles inline; discovery end
and the 6 h `reconcileTagAssignments` tick are the safety net, and the tick also sweeps auto
port rows whose tag no longer auto-assigns.

### Scale

At 2000 assets the fleet pass asks the interface table BY VLAN (`nativeVlan IN (…)`, a handful
of ids) rather than by device, so a broad filter never becomes a 2000-id IN list against the
largest current-state table; port removals are chunked. The resolver leaf is one GROUP BY per
distinct VLAN, the `interfaceName` shape. The scrape hook costs a string compare per scrape and
no query unless a VLAN moved. The picker's VLAN list is two grouped reads.

### Rejected alternatives

- **A `tags` column on `AssetInterface`, carried forward like `firstSeen`.** Loses the tags
  whenever a port is absent from one scrape, and puts the tag carry on the hot scrape path.
- **Automatic VLAN tags (`<integration>:<vlan>`).** Deferred by the operator. Open questions
  recorded for a revival: one integration's sites can use one name on different numbers and
  one number for different names, so a tag per name needs a per-switch name resolution
  (`vlanNameService`) in the filter, not a number; VLANs that vanish need a keep-or-delete
  policy; SNMP-only switches have no integration to prefix with.
- **Tagging ports for `interfaceName` leaves too.** Not asked for; a name leaf already says
  which ports, and the VLAN case is the one the operator described.

### (g) Automations narrowed by an interface's tag (2026-10-28)

The operator asked for it in one sentence: a switch with several monitored interfaces, some
tagged Priority **Critical** and some **Warning**, alerting at the matching severity. Port
tags already existed (this rule's (a)); an automation could only select ports by name or
description (rule 124), so a priority split meant maintaining a name list per automation.

**Shape: a filter, not a dimension.** `ifTag` copies rule 98's `sdwanMemberIp`, not
`ifNamePattern`. It is kept OUT of `METRIC_DIMENSIONS` / `FIELD_DIMENSIONS` because those
are the reading-KEY space (`dimensionSpaceOf`): adding it would split interface leaves into a
second space and break a reset tree mixing a filtered and an unfiltered interface leaf. The
readings are still keyed by `ifName`; the tag only decides which ports produce one. It does
ride `triggerSignature` (every `dimensionFilter` key does), so a Critical and a Warning
automation on the same trigger never carve each other out under rule 18.

**Targets derived, not listed.** `INTERFACE_TAG_TARGETS` is every metric / field whose
dimensions include `ifNamePattern`, so a new interface condition takes the tag filter the day
it takes a name filter.

**Whole-name match.** The device `tag` condition matches whole names, case-insensitively;
substring (every other `*Pattern`) would let "critical" select "priority-critical". The
wizard's match cue mirrors it (`awInterfaceTagMatch`).

**Fails closed on a failed read, by throwing.** Rule 98 keeps every member when its address
read fails, because a kept reading there is harmless. Here, failing open would raise a
"critical" automation about every port, and failing closed would drop readings, which
clears live alerts as if the tags had been removed. Both are wrong, so the read throws like
the sample query beside it and the rule is skipped for that tick.

**Scale.** One indexed read of `asset_interface_tags` per interface arm per tick, only when
the filter is set, narrowed in SQL to the scoped assets AND the named tags (`@@index([tag])`),
so at 2000 assets it returns the tagged ports, not the table.

Rejected: a new trigger field ("interface tag is X") ANDed with the interface leaf. Two leaves
in a composite fold per DEVICE, so it could never say "this port is down AND this port is
critical"; that is the same reason rule 98 is a filter.

<a id="rule-133-invariant"></a>

### Rule 133 — the invariant as first stated

See `invariants-30-43.md` § 133; nothing longer was ever published.
