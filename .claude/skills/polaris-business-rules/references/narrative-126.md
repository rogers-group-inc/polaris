# Business rule 126 — full narrative

> Written 2026-10-21 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 126](#rule-126) — An interface reports both families, but only addresses that identify it, and IPv4 stays the address a device is polled on

<a id="rule-126"></a>

## Rule 126 — An interface reports both families, but only addresses that identify it, and IPv4 stays the address a device is polled on

### What was there before (2026-10-21)

Every interface row held ONE bare address in `ipAddress`, and no collector stored two. The
write paths copied it straight through: into the `AssetInterface` current-state table
(interfaceInventoryService `toRow`), into the `AssetInterfaceSample` hypertable for pinned
interfaces, through the agent push, and up into the rollups' `lastIpAddress`. On the way,
`buildMonitorAssocIpEntries` mirrored each one into the asset's address list and IP history,
filtering nothing but empties and duplicates.

Two things followed from that. IPv6 was invisible wherever a collector chose IPv4, and most
did: SNMP walked only the IPv4-only RFC 1213 `ipAddrTable`, WinRM asked for
`-AddressFamily IPv4`, vCenter's guest-NIC regex took dotted quads. And whatever a collector
DID report reached the address list unfiltered. The Polaris Agent's NIC loop takes the first
non-loopback IPv4, and otherwise the first address of ANY family, so `lo` reported 127.0.0.1
and an IPv6-only NIC reported its fe80:: address. Both landed in the address list and IP
history. Those feed path-check hop resolution, the application map and search, so a
link-local address present on every IPv6 host tied unrelated hosts together.

### The decisions

**A separate column, not a second row.** An interface keeps one row per name (the unique key
is `(assetId, ifName)`), and its IPv6 sits in `ipv6Address` beside the IPv4. The column is
added plainly nullable on the hypertables, with no default and no backfill, for the reason the
interface_poe migration gives. Verified against a TimescaleDB database whose interface sample,
hourly and daily tables each held a compressed chunk: all three stayed compressed after the
`ADD COLUMN`, their rows read NULL, and a fresh row carrying the column inserted beside them.

**One normalizer, at every write, not in each collector.** `splitInterfaceAddresses` is the
only place that decides what an interface may report. A collector can be wrong, or old: the
agent fleet upgrades on its own schedule, and an agent that predates the fix keeps sending
127.0.0.1 and fe80::. Filtering where the rows are written fixes those agents the moment the
server is updated. An IPv6 a collector put in `ipAddress` (the agent's fallback, TrueNAS's
IPv6-only fallback) is moved to the IPv6 column rather than dropped, so nothing that was shown
before disappears.

**Listed, never polled.** The address list gets both families, as separate rows under the
same interface and MAC, so the asset panel groups them under their card. `Asset.ipAddress`
is what every probe transport dials, and all of them assume IPv4, so nothing automatic may
move a device onto an IPv6. Three paths could have:

- unpinning re-projects the address from the listed rows (`bestListedAddress`). It now
  chooses among IPv4 only;
- a pinned address follows its card when the card "reports only that address now"
  (`db.ts → enforceOperatorOverrides`). With the IPv6 listed beside it, a card whose IPv4
  went quiet would otherwise report only its IPv6. The card's rows are filtered to the pinned
  address's own family first;
- the rule-103(a) sweep releases a pin the network backs on its own, unless another address
  scores as high. A card's IPv6 is not an alternative to its IPv4, so `pinReleaseVerdict`
  compares only within the family.

An operator may still pin an IPv6 explicitly. That is a choice they made, not one Polaris made
for them.

### Rule 126 — the invariant as stated in full

See `invariants-30-43.md` § 126.
