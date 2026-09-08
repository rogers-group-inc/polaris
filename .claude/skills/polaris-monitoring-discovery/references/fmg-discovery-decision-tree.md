# FortiManager Integration — Discovery Decision Tree

This is the operator-facing reference for what the FMG discovery run does and which knobs control which behavior. The detailed phase-by-phase narrative is `discovery-fortinet.md` beside this file; this doc is the at-a-glance decision tree.

```
FMG Integration Discovery
│
├─ Should this run at all?
│   ├─ enabled === true                       (else: skip silently)
│   └─ either: manual trigger (admin clicks Discover Now)
│       or:    autoDiscover === true  AND  now − lastDiscoveryAt >= pollInterval hours
│
├─ Transport mode  (per-device LIVE-MONITOR queries; CMDB always goes native-FMG)
│   ├─ useProxy === true (DEFAULT)
│   │     → /sys/proxy/json wraps each /api/v2/monitor/* call
│   │     → discoveryParallelism FORCED to 1 (FMG drops parallel proxy sessions)
│   │     → uses FMG's apiToken
│   │
│   └─ useProxy === false   ("bypass" / direct)
│         → /api/v2/monitor/* hits each FortiGate's mgmt IP directly
│         → discoveryParallelism up to 20
│         → uses fortigateApiUser + fortigateApiToken (per-FortiGate REST admin)
│         → mgmt IP resolved via FMG CMDB on `mgmtInterface` (defaults to "mgmt" if blank)
│         → REQUIRED: fortigateApiToken non-empty AND mgmt IP resolvable via FMG
│         → If a precondition fails for a given device, that device is SKIPPED
│           with an error log line and NO proxy fallback — its DHCP scopes /
│           switches / APs / endpoints don't sync this run. Operators see the
│           skip message in the discovery log feed and on the Events page.
│
├─ Roster: which FortiGates does this run touch?
│   ├─ Native FMG GET /dvmdb/adom/<adom>/device  →  knownDeviceNames[]
│   │     (no /sys/proxy/json — bypasses FMG concurrency throttle)
│   │     (no conn_status filter — offline FGs stay in the roster)
│   │
│   └─ Filter through deviceInclude / deviceExclude (wildcards: *, ?)
│         deviceInclude empty → all included
│         deviceInclude set   → ONLY matching FGs queried
│         deviceExclude       → matching FGs skipped
│         filtered-out FGs:   stay in knownDeviceNames (so their subnets aren't
│                             marked stale by Phase 2)
│
├─ Per-FortiGate work (parallel up to discoveryParallelism)
│   │
│   ├─ conn_status !== 1 (OFFLINE in FMG)?
│   │     → CMDB-only pull: run the native-FMG CMDB queries below (FMG serves
│   │       the device's cached config even while it's offline) and SKIP every
│   │       live-monitor query (the device is unreachable). Config-only —
│   │       does NOT advance the firewall's lastSeen, does NOT resurrect a
│   │       decommissioned firewall, and every did*Query flag is forced false
│   │       so an offline gate's cached config can never drive a stale-row
│   │       release/decommission (purely additive/refresh). Works in direct
│   │       mode too: an offline gate skips the direct call and reads FMG's
│   │       cache instead.
│   │
│   ├─ CMDB queries — ALWAYS native FMG, never proxied (work OFFLINE)
│   │     - system/global             (geo coords, hostname)
│   │     - vdom/root/system/dhcp/server  (configured DHCP scopes + static reservations)
│   │     - vdom/root/system/interface / global/system/interface  (interface IPs, mgmt-IP resolution)
│   │     - firewall/vip                                 (VIPs)
│   │     - global/switch-controller/managed-switch      (CMDB switch roster)
│   │     - vdom/root/wireless-controller/wtp            (CMDB AP roster)
│   │
│   └─ Live monitor — proxy OR direct per "Transport mode" above (SKIPPED when offline)
│         - system/dhcp                              (active leases)
│         - network/arp                              (IP↔MAC bindings)
│         - switch-controller/managed-switch/status  (live switch status)
│         - wifi/managed_ap                          (live AP status + LLDP[] + mesh)
│         - switch-controller/detected-device        (endpoint MAC table)
│         - user/device/query                        (device inventory / endpoints)
│
├─ DHCP scope sync per FortiGate
│   ├─ dhcpInclude / dhcpExclude filter  (scope name or numeric ID)
│   │
│   ├─ For each surviving scope (CMDB ∪ live, CMDB wins on overlap by IP):
│   │     ├─ matched existing Subnet by CIDR?
│   │     │     yes: update name / vlan / fortigateDevice
│   │     │     no:  must fall inside a parent IpBlock
│   │     │           else: log "no matching parent block", skip
│   │     │
│   │     └─ reservations / leases / interface IPs / VIPs imported as Reservation rows
│   │           sourceType ∈ { dhcp_reservation, dhcp_lease, interface_ip, vip }
│   │
│   └─ Conflict detection
│         incoming value differs from existing manual Reservation
│           → upsert Conflict(entityType=reservation, status=pending)
│           → admin reviews on Events page slide-over
│
├─ Stale-subnet deprecation sweep (after Phase 2)
│     Subnet.discoveredBy == this integration  AND  fortigateDevice ∉ knownDeviceNames
│       → status = "deprecated"
│     (offline FGs in roster: PRESERVED. Only FGs REMOVED from FMG trigger deprecate.)
│
├─ FortiGate firewall asset (Phase 3)
│   ├─ Match by serial (assetIdx.findBySerial)
│   │     fall back: hostname / IP
│   │
│   ├─ Existing → UPDATE projected fields + stamp discoveredByIntegrationId
│   │
│   └─ New → CREATE with discoveredByIntegrationId
│         IF fortigateMonitor.addAsMonitored === true
│           → monitored=true (FRESH creates only; existing FGs untouched)
│
├─ FortiSwitch class (Phase 3b — buildClassMonitorStamp(fortiswitchMonitor))
│   │
│   │   ┌─────────────────┬──────────────────┬──────────────────────────────────────┐
│   │   │ enabled         │ addAsMonitored   │ Stamp on NEW switch                  │
│   │   ├─────────────────┼──────────────────┼──────────────────────────────────────┤
│   │   │ false           │ false            │ ensure monitored=false (sweep off)   │
│   │   │ false           │ true             │ monitored=true (ICMP source default) │
│   │   │ true (with cred)│ false            │ credential stamped; monitored=false  │
│   │   │ true (with cred)│ true             │ credential AND monitored=true        │
│   │   └─────────────────┴──────────────────┴──────────────────────────────────────┘
│   │
│   ├─ EXISTING switch — operator-override preservation:
│   │     monitorOverride === true                       → don't touch `monitored`
│   │     existing monitorCredentialId is null
│   │       OR matches cfg.snmpCredentialId              → safe to re-stamp
│   │     existing monitorCredentialId differs           → preserve operator choice
│   │
│   ├─ fortinetTopology stamp:
│   │     { role: "fortiswitch", controllerFortigate, controllerSerial,
│   │       uplinkInterface, uplinkPhysicalPort, state }
│   │     controllerFortigate = the controller's name IN FORTIMANAGER (which
│   │       need NOT equal the gate's configured hostname); controllerSerial
│   │       is the definitive controller identity. Anything resolving the
│   │       parent ASSET must go through src/utils/fortinetParentKey.ts —
│   │       never match controllerFortigate against Asset.hostname.
│   │     state = controller admission ("Authorized"/"Unauthorized") →
│   │       Authorization badge on asset details; "Unauthorized" also lands
│   │       new switches with status = "storage"
│   │
│   └─ Decommission sweep:
│         controllerFortigate ∈ inventoriedDevices
│         AND serial ∉ live managed-switch/status table
│         AND serial ∉ CMDB roster OF THAT CONTROLLER (per-controller scope —
│             an offline/staged gate's cached roster only protects devices it
│             owns, never another controller's fleet)
│           → status = "decommissioned"
│         (controllers whose inventory query FAILED: switches under them are LEFT alone)
│
├─ FortiAP class (Phase 3b — same pattern via fortiapMonitor)
│   │   identical 4-row stamp table as FortiSwitch
│   │
│   ├─ Switch-port attribution chain:
│   │     1. LLDP from managed_ap.lldp[] (filter system_description starts "FortiSwitch", incl. Rugged)
│   │        → parentSwitch = system_name, parentPort = port_id
│   │     2. Fall back: detected-device MAC table match against AP base_mac
│   │     3. Neither: AP renders hanging directly off the FortiGate in the topology graph
│   │
│   ├─ Mesh stamp:
│   │     mesh_uplink + parent_wtp_id from managed_ap → fortinetTopology.parentApSerial
│   │
│   ├─ Authorization stamp:
│   │     managed_ap `state` ("authorized"/"discovered"/...) →
│   │       fortinetTopology.state → Authorization badge on asset details
│   │     (distinct from `status` = connectivity: connected/online/offline)
│   │
│   ├─ Full LLDP table persist (per online AP):
│   │     managed_ap.lldp[] — ALL entries, not just the FortiSwitch uplink
│   │     (mesh FortiAP peers + non-Fortinet gear included)
│   │       → real AssetLldpNeighbor rows, source "managed-ap"
│   │         (asset LLDP section shows exact neighbors instead of inferred;
│   │          Device Map gets ghost nodes / wireless-bridge edges for free)
│   │     absent lldp field on the row = firmware variance → existing rows kept
│   │     skipped when a monitored AP's resolved lldpPolling = snmp AND that
│   │       stream delivered rows within 48h (a live SNMP stream owns the
│   │       table; a configured-but-dead one does not block the persist)
│   │
│   └─ Decommission via wireless-controller/wtp CMDB roster (same logic)
│
├─ Endpoint enrichment (Phase 7.5)
│   For each MAC seen in switch-controller/detected-device:
│     ├─ skip is_fortilink_peer rows (FortiSwitch peers, not endpoints)
│     ├─ skip infrastructure assetTypes (firewall / switch / access_point)
│     │
│     ├─ Stamp Asset.lastSeenSwitch = "<switchId>/<portName>"
│     │
│     ├─ If asset has no IP, fill from ARP table on same FortiGate
│     │     (conservative: never overwrite an existing IP — IP recycling churn)
│     │
│     └─ Upsert AssetSource(sourceKind="fortigate-endpoint", externalId=MAC)
│
├─ Auto-Monitor Interfaces apply pass (Phase 2c)
│   For each per-class block whose autoMonitorInterfaces ≠ null, evaluate
│   each present block and union the matches into Asset.monitoredInterfaces:
│     ├─ byNames    → explicit ifName list (always pins, ignores up/down)
│     ├─ byPatterns → wildcards (* and ?) when regex=false, raw anchor-free
│     │               regex when regex=true; optional onlyUp filter
│     ├─ byTypes    → physical / aggregate / vlan / loopback / tunnel; onlyUp
│     └─ byLldp     → pin where AssetLldpNeighbor.matchedAssetId points at a
│                     monitored Polaris asset whose assetType is in the set
│                     (firewall / switch / access_point / server / workstation
│                     / router / printer / other) — auto-tracks fleet topology
│   STRICTLY ADDITIVE — never strips operator hand-pins. Each cycle re-applies
│   from scratch; removing values from the config does not unpin existing pins.
│
├─ DHCP push (writeback — pushReservations toggle)
│   manual Polaris-created reservation
│   AND on a subnet discovered by this integration
│   AND pushReservations === true
│   AND macAddress is set
│     →  proxy mode: write reserved-address via /sys/proxy/json
│        direct mode: write via per-FortiGate REST API
│        verify on read-back; FAIL the create if device write didn't land
│
├─ Auto-reserve managed switches/APs (writeback — autoReserveFortinetInfra
│   toggle, requires pushReservations)
│   managed FortiSwitch / FortiAP discovered by this integration
│   AND currently ACTIVE
│   AND its address is held by a dynamic lease, not an existing reservation
│   AND Polaris learned the MAC from the gate's own lease table
│   AND the row has never been pushed before
│     →  same write path as above, pinning an address the device already
│        holds (pool occupancy is unchanged)
│        ≤25 per integration per cycle; the rest wait for later cycles
│        permanent refusal → recorded on the row, never retried
│        decommission / delete the device → the entry is removed again
│
├─ Quarantine push (writeback — pushQuarantine toggle)
│   asset.quarantine action
│   AND pushQuarantine === true on integration
│   AND a sighting exists for this asset on a FortiGate this integration owns
│     → PUT user.quarantine with the MAC in a targets[] entry (drop=enable)
│        record per-target status in Asset.quarantineTargets
│
├─ Description sync (writeback — syncDescriptions toggle; POLARIS IS PRIMARY)
│   interface comment saved in Polaris, or Asset.description set/changed,
│   or the per-discovery reconcile (Phase 13.7) finds device ≠ Polaris
│   AND syncDescriptions === true on integration
│     →  Polaris empty + device has a value: adopt the device value into
│        Polaris (seed once; audited)
│        Polaris has a value: write it to the device — FortiGate
│        system/interface description / system/global alias, FortiSwitch
│        managed-switch + port description, FortiAP wtp location (AP
│        Manager's field, 35-char cap) — and
│        OVERWRITE any device-side edit (audited with the replaced value)
│        proxy mode: writes via /sys/proxy/json; direct mode: per-FG REST
│        verify on read-back; best-effort (Polaris row saves regardless),
│        transient failures retry on the next discovery reconcile
│
└─ Projection apply (Phase 11)
    Re-project every touched asset across all its AssetSource rows:
      hostname  → AD FQDN > Intune > Entra > AD short > FortiGate
      osVersion → Intune > Entra > AD > FortiOS …
    Write back fields where projection ≠ inline-stamped value
    (fixes the "FortiOS clobbers Intune's verbose osVersion" class of bug)
```

## The four big "what does the operator control?" knobs

| Knob | Default | Effect |
|---|---|---|
| `useProxy` | `true` | Proxy = parallelism 1, FMG token. Direct = parallelism 20, per-FG token. Direct misconfigured per-device = that device skipped with error (no fallback). |
| `fortigateMonitor.addAsMonitored` | `false` | New FGs land monitored. Existing FGs unaffected. |
| `forti{switch,ap}Monitor.{enabled, addAsMonitored, snmpCredentialId}` | all `false` / `null` | 4-way grid above; operator-override preservation on existing rows. |
| `pushReservations` / `pushQuarantine` | both `false` | Writeback toggles; off by default. |
| `autoReserveFortinetInfra` | `false` | Writes a real MAC→IP reserved-address entry for managed FortiSwitches/FortiAPs that hold their address by dynamic lease — the FortiLink case, where the gate otherwise reports the address "Not Reserved". Requires `pushReservations` and is ignored without it. Pins addresses the devices already hold, so the pool's occupancy doesn't change. Unlike every other DHCP write, this one runs on a schedule rather than on an operator action: it is bounded per cycle, uses only the MAC the gate saw requesting the address, verifies each write by read-back, and never re-attempts a row a gate has refused. Turning it off stops new entries but does not remove existing ones — release those reservations to do that. Confirm the behaviour on one gate before enabling fleet-wide. |
| `syncDescriptions` | `false` | Description writeback (Polaris-primary). Polaris descriptions overwrite the device; device values are only imported where Polaris has none. Needs the same Manage Device Configurations RW (proxy mode) / per-FG REST write access (direct mode) as DHCP push. Enable only once Polaris is where your team edits descriptions — device-side edits get reverted. |

## Discovering a single FortiGate (and its switches/APs)

The **Discover Now** button on a FortiGate firewall asset's details panel (System tab, where Poll Now used to sit; requires assets write access) re-runs discovery for **that one gate only** — useful after changing DHCP scopes, switch/AP membership, or VIPs on a single site without waiting for (or paying the cost of) a full FMG sweep.

What it does:
- Runs the normal per-device pipeline for the one gate: subnets, static reservations, leases, interface IPs, VIPs, FortiSwitch/FortiAP sync, endpoint enrichment, stale VIP/reservation release for that gate.
- Runs the **per-controller switch/AP decommission** for that gate (a FortiSwitch/FortiAP that vanished from behind it is decommissioned — only when the gate's inventory query succeeded, same protection as a full run). This makes Discover Now a per-gate ghost-switch/AP cleanup tool.
- Shows on the Integrations page as "Discovering \<device\>…" with the normal abort button; a scoped run and a full run never overlap (whichever is running wins; the other request is refused with a clear message).

What it deliberately does NOT do (these wait for the next full discovery):
- Stale-subnet deprecation and firewall decommission (fleet-roster sweeps).
- DNS/OUI enrichment, dependency-tree recompute, map-region / firewall-tag / criteria-tag reconciles, description-sync reconcile, auto-monitor apply.
- Advance the integration's `lastDiscoveryAt` — the next scheduled full run happens exactly when it would have anyway.

Notes:
- A gate excluded by `deviceInclude`/`deviceExclude` refuses to run (the same filter re-check the probe endpoint applies).
- If the gate is offline in FMG, the run pulls FMG's cached CMDB config only (additive refresh, no decommissions) — same offline semantics as a full run.
- For an HA cluster, re-discovering any member's asset re-discovers the cluster (the FMG device).
- On a standalone FortiGate integration the button simply runs that integration's normal discovery — it already is a single gate.
- **Discover Now on a FortiSwitch or FortiAP** scopes the run to that device's CONTROLLER gate (resolved through `src/utils/fortinetParentKey.ts`, never by hostname match) — a switch is only ever discovered as a by-product of its controller's pass, and the per-controller decommission above is exactly what a stale switch needs. The response carries `viaController: true` and the gate's name so the UI can say which device is actually being discovered.
- Every other asset type renders the button DISABLED with the reason in its title rather than hidden; the route returns the same reason as a 400. Directory / vCenter / Arc assets are told to run their integration from the Integrations page (per-asset scoping for those is not built yet).

## Direct mode vs the probe path — same strict behavior

The discovery path (this doc) and the response-time probe controller-redirect path (`fetchFortinetControllerInventory` in `src/services/monitoringService.ts`) both run with `useProxy=false` strict semantics — a precondition failure (missing token, missing mgmtInterface, mgmt-IP not resolvable) **fails loudly per-device** with a clear error rather than silently falling back to FMG proxy. This matters at scale: a silent fallback to proxy turns "I disabled proxy" into "I disabled proxy except when something else is wrong, in which case it silently re-enables itself and overruns FMG's session limit."

## Companion docs

- **`discovery-fortinet.md`** — phase-by-phase narrative, the underlying data shapes (DHCP scopes / reservation sourceTypes / `fortinetTopology` blob shape), and the multi-source asset model that backs the projection step.
- **`monitoring-architecture-polling.md` → "Polling-method redesign"** — how the resolved per-stream polling method (`responseTimePolling` / `telemetryPolling` / `interfacesPolling` / `lldpPolling`) flows from per-asset → class override → integration tier → source default for monitoring (post-discovery).
