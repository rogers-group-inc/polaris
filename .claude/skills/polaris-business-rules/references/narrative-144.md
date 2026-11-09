# Business rule 144 — full narrative

> Written 2026-11-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 144](#rule-144) — A link whose evidence stopped because Polaris stopped asking is kept as last known, not dropped

<a id="rule-144"></a>

## Rule 144 — A link whose evidence stopped because Polaris stopped asking is kept as last known, not dropped

**The problem.** Operator report, 2026-11-09: "when devices go into a dependency down state,
the topology map loses the connections between the assets — at least the switch to switch
connections; the switch to AP connections are still there." About an hour after a FortiSwitch
went dependency-down, every switch-to-switch line touching it disappeared from the Device Map,
and because the chain demotion (FortiGate → switch controller edges demoted for switches reached
through another switch) reads the interface edges, every switch then fell back to a direct line
off the FortiGate: the site redrew as a star.

**Why.** Switch-to-switch links have no persisted source. They are re-derived on every topology
read from two kinds of row: `AssetInterface` (FortiOS peer aggregates named after the peer's
serial or hostname — `interfaceTopologyService.ts → inferInterfaceTopology`) and LLDP neighbours
(`topologyGraphService.ts → lldpOnlySwitchLinks`), each behind a one-hour `lastSeen` cutoff so a
re-patched cable does not leave a phantom line. Both kinds are written only by the full system-info
scrape, and `runsHeavyCadences` (`utils/monitorStatus.ts`) withholds that scrape from a
dependency-suppressed, down, warning or recovering device — correctly: a full walk at a dark
device is wasted work. So the rows aged out because Polaris stopped asking, not because the
cabling changed. The healthy end was no help: `resolvePreservedTrunkNames` keeps an absent
FortiLink trunk row on the upstream switch but deliberately leaves its `lastSeen` at the last
real sighting. Switch-to-AP links survived because they come from `fortinetTopology.parentSwitch`,
a discovery-stamped field with no freshness check.

**The decision.** The cutoff's purpose is "a link must not outlive its cable", and a row that stopped
being refreshed because its device went dark says nothing about the cable. So the hour applies
only while both ends are still fully polled. `keepsLastKnownLinks(a)` — monitored and
`runsHeavyCadences(a)` false — names a DARK device; a link with a dark end is kept from rows up to
`INTERFACE_LAST_KNOWN_MS` (7 days) old and carries `lastKnownAt`, the newest sighting it rests on.
The map draws it long-dashed and faded, with a legend row and a tooltip line saying when it was
last seen, so it is never read as a live reading. Seven days bounds it: a site dark for a week no
longer keeps its cabling.

**The consequence beyond the map.** Discovery Phase 12 (`recomputeDependencyTree`) builds the
dependency tree from the same `inferInterfaceTopology` edges, so a dark switch now also keeps its
place as a parent for those seven days. Before, the tree could lose the edge to a switch an hour
after it went dark — exactly the switch whose children dependency suppression (rule 38) must keep
silent. Keeping last-known edges makes suppression stable through a long outage.

**Rejected alternatives.**
- *Widen the cutoff for everyone (e.g. 24 h).* A re-patched cable between two healthy switches
  would leave a phantom line for a day — the bug the hour exists for — and it re-incurs scan cost.
- *Keep polling dark devices for interfaces.* Against the whole point of `runsHeavyCadences`, and
  a down device cannot answer anyway.
- *Persist inferred links in their own table.* More machinery for the same answer: the rows
  already exist; only the read's freshness rule was wrong for this case.

**Where it is enforced.** `keepsLastKnownLinks` (`utils/monitorStatus.ts`); the 7-day read and the
per-link hour in `inferInterfaceTopology`, whose dark set (`darkAssetIds`) is read for the seeds
BEFORE any early return — a site of plain LLDP inter-switch links has no peer-aggregate
candidates, and the first cut returned an empty dark set there and kept nothing; the `lastKnown`
argument of `lldpOnlySwitchLinks`; the per-cable expansion copying `lastKnownAt` onto every cable;
`isLastKnown` in `topology-render.js` (style, legend `edge:lastKnown`, tooltip). Pinned by
`tests/unit/topologyLastKnownLinks.test.ts`. Verified on a dev database seeded from the operator's
78-device export with rows aged three hours: nothing dark → no switch links (the hour still holds);
a chain of four dark → its four links, all last known; every switch dark → all 43 and no star.
