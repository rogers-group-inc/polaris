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
  touch them.

### The Device Map (same day)

The topology payload's per-switch `endpointCount` / `endpoints[]` and the modal's search
(`topologyGraphService.buildSiteTopology`, `routes/map.ts → GET /map/sites/:id/topology/search`)
attributed endpoints by a `lastSeenSwitch` hostname PREFIX over the site's switch hostnames, so
every site's IDF-1 panel listed every site's IDF-1 endpoints. Both now read the attribution the
recompute already made — the endpoint's `source="endpoint"` / `detectedVia="switch-port"` row
pointing at a site switch — through `buildSiteEndpointAttribution` + the pure
`attributeEndpointToSiteSwitch`. The prefix is still honoured, but only for a hostname that is
UNIQUE among non-retired switches fleet-wide (one grouped query over the site's names): that keeps
an endpoint visible between discovery finalizes, and keeps a VM — which the endpoint half leaves
to its vCenter host edge — under the switch port its MAC was learned on. A shared name with no
edge stays OFF the panel rather than on the wrong site's switch. The count is the same rule in
SQL (`COALESCE(edge.parentAssetId, unique-name switch)`, `split_part` not LIKE), and the search
result's `switchHostname` is the RESOLVED switch's name.

### 91(a) — a shared name is not a duplicate across kinds or serials (2026-10-12)

The Conflicts queue offered an Entra device `CROSSPLAINS-CSR` and a FortiSwitch named
`CROSSPLAINS-CSR-DESK` as "Duplicate assets" with an **Apply merge** button. The Entra name is the
15-char NetBIOS form, so `lookupHostname` matched it against the switch's truncated index key
(`via: "netbios"`) and the Entra sibling check raised a `bothAssetsExist` card. One click would have
absorbed a switch into a laptop.

The match cascade trusts hostname as its LAST rung, after source row, SID, MAC and serial — which
is right only while nothing the two records already say contradicts it. Two things always do:
two usable serials that differ (the same refusal the duplicate-hostname merge job already makes
under rule 91), and a network-infrastructure type against a specific endpoint type. Directory,
vCenter and workload integrations enumerate computers, never switches, so the class split is a
statement of what those sources can contain, not a guess.

The guard lives in `lookupHostname` (an optional `incoming` argument) rather than in
`upsertAssetConflict`, because the non-sibling callers `continue` after queueing a card: a refusal
there would have left the device with no asset at all, every run. Refused at lookup, the caller
proceeds as if nothing shared the name and creates the record's own asset — exactly what an
operator's Reject would have done.

Rejected alternatives: requiring MAC/serial corroboration for every NetBIOS match (AD records
carry neither, and AD-`cn`-vs-Entra-full-name is the case truncation matching exists for);
refusing on any type difference (workstation vs server is an operator retype, not two devices);
deleting stale cards (marking them rejected by `system`, with a `conflict.rejected` Event naming
the reason, leaves the history explaining why the card went away).

### 91(b) — a DHCP hostname is the client's word (2026-10-14, scoped scan F2)

Rule 91(a) stopped a shared name from MERGING two records; it did not stop a lease from moving one. In `syncDhcpSubnets` a lease or detected-device row whose MAC no asset knows falls back to `byHostname`, and the hostname on a lease is whatever the client put in DHCP option 12. A device on any segment a discovered FortiGate serves (a guest SSID is enough) could send a monitored server's name: Phase 6 added its MAC — usually as primary, because the newest non-hardware MAC wins — and, a static-IP server holding no competing lease, its address won the run's claim and became the asset's `ipAddress`. From then on the MAC match kept the asset tied to it, and the monitor sent that asset's SNMP community, WinRM / SSH password or REST token to the claimant. Host-key and certificate pins are per host:port, so the new address was trusted on first use.

Owner decision 2026-10-14 (option a; b was a review Conflict for every such match): a hostname-only match against a monitored or credentialed asset records the sighting and moves nothing. Three things beyond the literal decision were needed for it to hold, and were kept: the recorded MAC carries its own source (`hostname-unverified`) and is never indexed as identity, or the NEXT run would match by MAC and move the address after all (and Phase 7.5 ARP / switch rows would re-address it through `findByMac`); `selectPrimaryMac` passes over that source while anything else is usable; and the device-inventory path's fingerprint, assetType, switch / AP and user writes are skipped too, since they describe the claimant, and an assetType change can alter monitoring. Option b was rejected because a docked laptop or a phone's randomised MAC on a monitored device would raise a Conflict every run.

The cost: a monitored device's genuinely new NIC stays `hostname-unverified` until something with real evidence (system info, the agent, a MAC match) records it. The warning event names it. Not covered: readers outside discovery that build their own MAC index (monitoringService's LLDP / FDB `byMac`, the quarantine target list) still see the row; none of them moves an address.

### 91(c) — a serial on its own address is the device (2026-10-21)

Prod 2026-10-21: a new FortiSwitch (NEWTON-108F-7, serial S108FFTV25010503) appeared twice — the `fortiswitch` asset, and a type-`other` `fortigate-endpoint` asset hostnamed `S108FFTV25010503` with MAC 48:3A:02:DA:54:54 on the switch's management address 172.23.33.130 — and the pair raised a Duplicate IP card. The switch's mgmt port takes a DHCP lease from its gate, and FortiOS lists that client in the lease table and the detected-device inventory with the SERIAL as its hostname. The switch record had no MAC (its `baseMac` cross-join had produced none) and is hostnamed by its switch-id, so Phase 7 found nothing by MAC or by hostname and created an asset. The ghost sweep (`sweepEndpointGhostsInto`, which does look up hostname == serial) runs in Phase 3b, BEFORE Phases 6 and 7, so it could only absorb the ghost on the next run. Every new switch or AP with an unknown MAC therefore produced one false conflict per first discovery.

Decision: Phases 6 and 7 look the hostname up in the serial index too, and accept the hit only when the row's address is the address Fortinet discovery recorded for that device. The hostname is still what the client sent (91(b)); a guest-SSID device sending "S108FF…" would otherwise put its MAC on a monitored switch. Requiring the switch's own mgmt IP means the claimant would have to hold that address, which is a duplicate-IP conflict (rule 40) whatever Polaris does with the name. The rung sits above `hostname` so an existing ghost (hostnamed the serial) no longer catches the row; the Phase 3b sweep still absorbs ghosts already in the database.

What the matched row writes is what a MAC match to Fortinet infrastructure already wrote: the MAC (source `device-inventory`, indexed, so the next run matches by MAC), blank-fill manufacturer / learnedLocation, switch / AP attribution. The infra guards keep the address, presence, OS / version and the `fortigate-endpoint` source off it, and the switch keeps its own hostname — FortiSwitch discovery owns it.

Rejected alternatives: running the ghost sweep again after Phase 7 (it would still mint and delete an asset every first run, with its events and a conflict card in between); matching the serial with no address check (re-opens 91(b) for every monitored switch and AP); also accepting the controller gate's name as corroboration (`controllerFortigate` is FMG's device name, the trap `utils/fortinetParentKey.ts` exists for). Firewalls are excluded: a gate does not report a downstream FortiGate by serial.

Not changed: the Phase 3b sweep's hostname candidate still merges an unprotected endpoint ghost hostnamed the serial with no address check, adopting its MAC only when the canonical has none.
