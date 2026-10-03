# Business rule 91 — full narrative

> Written 2026-10-02 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 91](#rule-91) — A hostname is not an identity: a name several devices of one kind share is resolved by where the child sits, or not at all

<a id="rule-91"></a>

## Rule 91 — A hostname is not an identity: a name several devices of one kind share is resolved by where the child sits, or not at all

### The case

2026-10-02. The operator reviewed the asset-details Dependency Tree and reported that it had
drifted: endpoints and APs were hanging off the wrong switch. Not the wrong KIND of switch —
the wrong site's. On this fleet the FortiLink `switch-id` (which `Asset.hostname` is projected
from, `assetProjection → fortiswitch.switchId`) is renamed per site by convention, so the same
"IDF-1" exists behind every gate. The operator's own check: the ARP tables the firewalls
report and the MAC tables the switches report both placed the devices correctly, and the
`Last Seen Switch` / `Last Seen AP` strings on each asset were right. What had drifted was the
step that turns that string back into an asset.

Every one of those steps was **first-writer-wins on hostname**:

- `utils/fortinetParentKey.ts → buildInfraParentIndex` kept one candidate per hostname — the
  first the caller supplied (the recompute sorts by id, so a stable but arbitrary site). Its
  own comment said so: "a duplicate HOSTNAME absolutely can [exist] … so this must not throw
  or churn on one". It did not throw. It answered.
- `dependencyTreeService → resolveEndpointParent` resolved `lastSeenSwitch`'s name through
  that index, so every endpoint whose switch was called IDF-1 — at any site — was parented to
  one site's IDF-1. Under all-down semantics that is not cosmetic: when the wrong site's switch
  went down, these endpoints read **Dep. Down** and their alerts were retired behind a device
  they never sat under; when their own switch went down, they alerted as plain Down. Both
  directions wrong, both silent.
- `buildDependencyEdgesFromInputs` resolved an AP's `parentSwitch` stamp the same way, so APs
  at site B were drawn under site A's IDF-1 and the tree on site A's switch listed APs from
  three sites.
- `monitoringService → persistLldpNeighbors` matched an LLDP `systemName` through its own
  first-wins `byHostname` map and FROZE the answer as `matchedAssetId`, which the recompute
  then read as a cross-site LLDP adjacency. Controller membership (the gate rosters) rejects
  such an edge only when BOTH gates' rosters are known.
- `assetUpstreamService` (the General tab's clickable Last Seen Switch row) and
  `connectionPathService → findSwitchByName` (`findFirst` with an OR) each picked a switch
  without being able to say which.
- `mergeDuplicateHostnameAssets` was one missing `baseMac` away from absorbing one site's
  switch into another's: its tie-break skipped a group only when BOTH tied rows carried a MAC
  that disagreed. Two switches with two different serials and one hostname was a merge.

### What was built

**The name stays; the resolution learns where the child is.** The alternative — stamping the
serial instead of the name into `lastSeenSwitch` — was rejected: the string is read by nine
consumers (the General tab, the Device Map's per-switch endpoint counts, the connection
path, the connection-changed Event, the alert email, the mobile page, three parsers), it is a
display value an operator reads, and a FortiSwitch's switch-id is what every FortiOS table
reports. Changing the stamp would have been a migration of every consumer to fix one lookup.

**`InfraParentScope`** (`utils/fortinetParentKey.ts`). `buildInfraParentIndex` now keeps every
candidate per hostname (`byHostnameAll`) beside the first-writer map. `resolveInfraParentAsset`
filters the same-named set by the expected type FIRST — so a workstation ghost named after a
switch neither shadows the switch nor makes it ambiguous (the shadowing was real:
`assetUpstreamService` had been building one index per asset type to dodge it) — and, when
more than one remains, picks by scope:

1. `preferIds` — candidates the caller has DIRECT evidence for. For an endpoint that is the
   set of switches whose `AssetMacTableEntry` (the SNMP forwarding-table scrape) currently
   holds its MAC, `learned` rows within 48 h. An observation outranks knowing the site.
2. `gateIds`, most trusted first — the FortiGate(s) the child is known to sit under. For an AP:
   its own controller stamp, then the gate whose managed-AP roster lists it. For an endpoint:
   the gates that SIGHTED it (`AssetFortigateSighting`, freshest first), then the gate IPAM says
   owns its address (rule 55's resolver). The earliest gate that singles out exactly one
   candidate wins; a gate under which two same-named candidates sit is refused (a managed
   switch's `switch-id` is the gate's mkey, so this cannot happen for real data).

A candidate's gate is its own controller stamp resolved through the same index
(`controllerGateIdOf`, serial → FMG device name → hostname, memoized) — so a pre-2026-08 switch
row stamping only `controllerFortigate` still places. The name-as-serial step is allowed to
settle a name the hostname step found ambiguous, because a serial is definitive.

**Nothing decisive ⇒ null.** The resolver's contract was already "null means no parent, never
an error"; an ambiguous shared name now lands there too, and `resolveInfraParentAssetDetailed`
says so (`ambiguous`, `candidates`) for the callers that count. This is the safe direction the
endpoint half has always taken: an endpoint nothing can place never suppresses, and the ladder
moves on to the firewall tiers, which still place it at the right SITE by sighting. A dependency
edge to the wrong device is the one outcome worse than no edge.

**The endpoint sync loads the evidence tail-only.** `syncEndpointDependencyEdges` runs its
first pass with `EndpointResolutionStats`, collects the endpoints that HIT a shared name,
loads their MAC-table switches in one indexed query (`matchedAssetId`), resolves the IPAM gate
for the unplaced as before, and runs the final pass. A fleet with unique switch names pays
nothing new. Endpoints still unsettled are logged once per run
(`dependency.endpoints.ambiguous_name`).

**LLDP** (`utils/lldpHostnameMatch.ts`, pure). The match index carries every asset per
hostname plus the gate each Fortinet infra asset sits under (one JSON-path projection over the
infra rows, not the whole topology blob, every 60 s). A shared name matches only the candidate
under the SAME gate as the scraping asset — LLDP is one hop, a neighbour at another site is
impossible — and a firewall is its own gate. "Unique" means unique in the inventory, not merely
once the scraper is set aside: a switch that sees its own name has a twin elsewhere.

**The General tab and the connection path** scope the same way, loading the candidates'
controllers, the asset's MAC-table switches and its sightings only when a name actually
collides; the common case stays one query. **The duplicate-hostname merge** refuses two usable
serials that differ at ANY tier — a serial is identity (rule 83), a hostname is not, and
placeholder serials fall through `isUsableSerial` (rule 84) so two ghosts carrying
"To Be Filled By O.E.M." still merge.

**The tree says which one.** `GET /assets/:id/dependencies` now carries `serialNumber` and
`ipAddress` on every node, and `renderDependencyTreeBlock` tags every row whose hostname
another row in the SAME tree shares with its serial (or, failing that, its address), in the
pivot link's tooltip and in the "directly under X" subtitle too. A tree reading "IDF-1 → IDF-1"
is otherwise unreadable, and the operator opening a row has to know which site it goes to.

### What was deliberately NOT done

- **No fleet-wide MAC-table join.** The forwarding tables are the best evidence Polaris
  holds, but a switch holds an endpoint's MAC on every upstream trunk too, and the tables are
  thousands of rows per switch. They settle a tie among same-named candidates; they do not
  replace the port attribution discovery already made.
- **No change to what `lastSeenSwitch` stores**, for the reasons above.
- **No automatic renaming or merging of same-named switches.** Two switches sharing a
  hostname is a legitimate fleet convention, not a data error — the merge job now refuses to
  touch them, and the Device Map's per-switch endpoint counts (`topologyGraphService`,
  `routes/map.ts`), which still prefix-match `lastSeenSwitch` by hostname, remain a known
  follow-up: within one site's topology they are correct, across sites they over-count.
