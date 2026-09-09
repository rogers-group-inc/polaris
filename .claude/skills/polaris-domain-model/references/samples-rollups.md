# Domain model — sample hypertables, rollups and monitor overrides

Each entity below carries its CLAUDE.md definition + load-bearing invariant, followed (in the **Schema** and **Notes** parts) by the field-level schema dump and the extended notes that lived in the skill references (formerly ARCHITECTURE.md). `prisma/schema.prisma` is the source of truth for types; these are the semantics.

## Definitions and invariants

- **AssetMonitorSample / AssetTelemetrySample / AssetInterfaceSample / AssetHardwareSensorSample / AssetStorageSample / AssetIpsecTunnelSample / AssetPerfSlaSample** — the seven append-only sample tables, each with `*Hourly` + `*Daily` rollup companions populated by `runSampleRollup` (14 rollup tables). **They carry `assetId` but NO foreign key to Asset** — they are TimescaleDB hypertables, and a cascade DELETE matching a compressed chunk decompresses it into un-truncatable bloat (prod 2026-06-08). **Never re-add the relation, and never row-DELETE/UPDATE sample rows that could sit in a compressed chunk.** `AssetInterfaceSample` is **pinned-only** (one row per operator-pinned interface); current interface state lives in `AssetInterface`.

- **AssetCustomWidgetSample** — time-series for `ManufacturerCustomWidget` probes. Standalone detail-only TimescaleDB hypertable (no rollups; `timescaleService.STANDALONE_SAMPLE_TABLES`), composite PK `(id, timestamp)`, pruned by `pruneSystemInfoSamples` on the system-info umbrella window.

- **AssetStateSample** — the **0/1 sibling** of `AssetCustomWidgetSample`: one row per (asset, state probe, table row) per scrape. Polarity is **operator-declared** via the probe's `stateMap`, never inferred — vendors disagree, so a bare `value >= 1` is wrong about as often as it's right. Two invariants: **`value` is 0 or 1 and never null** (an absent or incomparable row is DROPPED, because 0 is a positive claim of health that would clear a live alert), and **`rowKey`** is the stable dimension identity while `rowLabel` is what operators read. Deliberately no rollups — averaging a boolean gives a duty cycle, not a state.

- **HostMetricsSample** — Polaris host CPU / memory / load time-series sampled every 30s by `hostMetricsCollector` (web/all role only); `host_metric` rules read the latest row. Plain prunable table (7-day retention).

- **MonitorClassOverride** — tier-2 of the monitor settings hierarchy; manual-scope only post-Phase-2.

## Schema

```
AssetMonitorSample              -- Time-series of monitoring probe results; written by the monitorAssets job
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  success       Boolean
  responseTimeMs Int?           -- Round-trip in ms on success; null on failure (the "packet loss" signal). ALSO null on every ICMP loss-sampler row: we spawn the system `ping`, so elapsed wall-clock is dominated by process spawn and is not an RTT worth recording -- and NULL keeps the row inert to any RTT reader that forgets the probeKind filter
  error         String?
  probeKind     String?         -- Which probe wrote the row. NULL (and the literal "primary") = the response-time poll on the asset's configured transport; "icmp" = the packet-loss sweep (utils/lossSweep.ts), whose rows also carry packetsSent/packetsReceived. Loss counts EVERY kind -- that is the sampler's whole purpose -- while every response-time reader filters to primary, because ICMP answers in ~1-5ms where SNMP takes 20-200ms. The primary-only readers are: the engine's responseTimeMs/uptimeSec metrics, alertChartService's RTT chart, sampleHistoryService's detail tier + readLastMonitorSuccessAt, the NOC response-time ranking, topologyGraphService's fixed-COUNT traffic light, and EVERY rollup (incident-only rows in a 400-day aggregate would make historical loss non-comparable across time). Nullable rather than defaulted so the add was catalog-only on the hypertable -- the uptimeSec precedent
  packetsSent   Int?            -- ECHOES SENT in this row's burst (utils/burstPing.ts's ICMP sweep). Written ONLY by the sweep; NULL on the response-time poll's own rows and on everything predating the burst-packet-counts migration. Readers MUST treat NULL as the single-probe equivalent -- sent 1, received 1 on success / 0 on failure -- never as zero, which would drop those rows out of the denominator and report a clean fleet. Never 0: a target that could not be attempted at all (unresolvable name, no pinger) writes NO ROW, because "never asked" and "asked and heard nothing" are different facts and only the second is loss
  packetsReceived Int?          -- Echo replies received; 0 is a legitimate reading (a dark host). `success` is kept as `packetsReceived > 0` so every reader that only understands success/failure is unaffected by the sweep's existence. The pair is what makes probeLossPct a ratio of PACKETS rather than of poll OUTCOMES -- the latter can only resolve to 1/N over the window's N polls (6.7% steps at 15 min / 60s) and shares its evidence with down detection, which is the whole reason business rule 29 kept trying to separate the two inside the arithmetic
  @@index([assetId, timestamp])

AssetTelemetrySample            -- System tab CPU+memory snapshot (~60s cadence). Populated by monitoringService.collectTelemetry for FortiOS- and SNMP-monitored assets; ICMP/SSH cannot deliver this data; WinRM/AD return supported=false until WMI Enumerate-over-WS-Management lands.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  cpuPct        Float?
  memPct        Float?          -- Set when the source reports memory only as a percentage (FortiOS)
  memUsedBytes  BigInt?         -- Set when the source reports absolute bytes (SNMP HOST-RESOURCES-MIB hrStorageRam, WMI)
  memTotalBytes BigInt?
  sessionCount  Float?          -- FortiGate active-session count (read from the same /api/v2/monitor/system/resource/usage `session` resource collectTelemetryFortinet already fetches; null for every other source). Rolled up (avg/min/max) into the *Hourly/*Daily companions; surfaced as the System-tab "Active Sessions" chart (FortiGate firewalls only).
  @@index([assetId, timestamp])

AssetInterfaceSample            -- PINNED-ONLY per-interface time-series (2026-08). One row per operator-pinned interface (`Asset.monitoredInterfaces`) per scrape — NOT one per interface. Unpinned interfaces used to be written here as `cadence="slow"` and deleted 24h later; that was ~4-5x the pinned write volume for rows nothing read as history (never compressed, since they died at 24h while the selection-aware compression floor is 2 days; never rolled up; removed by the row-level DELETE behind the 2026-06-08 / 2026-06-17 bloat incidents). Every consumer of them wanted CURRENT STATE, which now lives in `AssetInterface`. Consequences: an unpinned interface charts nothing (the slide-over renders a "not recording history" notice with the pin affordance instead of two empty graphs), and the counter-metric automations ifInBps / ifOutBps / ifInErrorRate / ifOutErrorRate — never pin-scoped, unlike the ifOperStatus/ifAdminStatus/poeStatus state triggers — now produce readings only for pinned interfaces. The `cadence` column stays (storage + IPsec keep the fast/slow split, the prune/rollup paths are shared, and legacy slow rows drain through the existing 24h arm rather than needing a migration). Capacity projection keys off the fleet's pinned-interface count across BOTH cadences and no longer caps interface detail at 24h — see capacityService's UNSELECTED_DOMINATED_ENTITIES. Historical shape below.
                                -- System tab per-interface scrape (~600s cadence). Carries `poeStatus` / `poeClass` from POWER-ETHERNET-MIB (RFC 3621) on the SNMP paths only — FortiOS REST has no equivalent in its interface payload, so a managed FortiSwitch polled through its parent FortiGate leaves both NULL, as does the agent. `poeStatus` is decoded by `utils/poePorts.ts` (disabled / searching / delivering / fault / test / other-fault) and is an asset_state automation field; `poeClass` (class0..class4) is the negotiated power BUDGET bracket, not a measurement — the MIB defines no per-port wattage object. Correlation to ifName is INFERENCE (`poeIfNameByIndex`) because pethPsePortTable is indexed by {group, port} with no ifIndex join. The PoE port index is matched to an interface name's TRAILING NUMBER — a front-panel convention vendors maintain deliberately — and NEVER to an ifIndex: that `index == ifIndex` equivalence is what the FortiSwitch sensor annotation was reverted for (97e54fd2), and a PoE status on the wrong port alerts on a healthy one while staying silent on the faulted one. Ambiguous matches (a stacked switch with 1/0/5 and 2/0/5) and unresolvable rows are dropped rather than attached to a best-guess interface. Both are collected on the heavy AND fast cadences (a PoE fault is alertable per-minute), with a per-host negative cache so non-PoE devices stop paying for the walk after one empty result. Many rows per scrape (one per interface). recordSystemInfoResult also mirrors {ip, interfaceName, mac} into Asset.associatedIps with source "monitor-system-info" — manual entries are preserved. Pinned interfaces (Asset.monitoredInterfaces) get extra rows on the response-time cadence (~60s) via collectFastFiltered. The same fast pass also writes extra AssetStorageSample / AssetIpsecTunnelSample rows for any mountPaths in Asset.monitoredStorage and any tunnel names in Asset.monitoredIpsecTunnels.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  ifName        String
  adminStatus   String?         -- "up" | "down" | "testing" | ...
  operStatus    String?         -- ditto
  speedBps      BigInt?         -- Bits per second; from ifHighSpeed*1e6 or ifSpeed
  ipAddress     String?
  macAddress    String?
  inOctets      BigInt?         -- Cumulative counter; subtract consecutive samples for throughput
  outOctets     BigInt?
  inErrors      BigInt?         -- Cumulative IF-MIB ifInErrors / FortiOS errors_in
  outErrors     BigInt?         -- Cumulative IF-MIB ifOutErrors / FortiOS errors_out
  ifType        String?         -- "physical" | "aggregate" | "vlan" | "loopback" | "tunnel". FortiOS REST via `type` field; SNMP via ifType OID (1.3.6.1.2.1.2.2.1.3).
  ifParent      String?         -- Aggregate name for member ports; parent interface name for VLAN sub-interfaces. Back-filled from the FortiOS REST aggregate `member` array + VLAN `interface` field, AND — for managed FortiSwitches scraped via SNMP — from the parent FortiGate's switch-controller CMDB by `overlayFortiswitchTrunkMembers`: operator LACP `members` plus FortiLink auto-ISL trunks (each physical port's `isl-local-trunk-name`, since the ISL trunk itself carries no members). A single-member parent lets the topology renderer's `preferPhysical` swap the opaque trunk label for the real physical port.
  vlanId        Int?            -- 802.1Q VLAN ID for vlan-type interfaces. FortiOS REST only (from `vlanid` field).
  nativeVlan    Int?            -- Switch-port untagged PVID. Populated only on managed FortiSwitches (`assetType="switch"` with a Fortinet source AND a resolvable `controllerFortigate`) — the parent FortiGate's `/api/v2/cmdb/switch-controller/managed-switch?datasource=1` is fetched once per controller per ~30s (cached via `fortiswitchControllerPortsCache`) and overlaid onto the SNMP IF-MIB rows by port-name == ifName inside `collectSystemInfo`. Other asset types (FortiGates, FortiAPs, non-Fortinet SNMP switches) leave this null.
  taggedVlans   Int[]           -- Switch-port tagged VLAN set, computed at overlay time as `allowed-vlans − untagged-vlans` and expanded to integer ids. The parser in `monitoringService.parseFortiosVlanList` handles FortiOS's three shapes (array of `{vlan-id}` objects, raw number array, comma+range string) and drops the "all" placeholder since we can't surface "every VLAN" as a finite list. Same population path as `nativeVlan`. Empty `[]` on access ports, when overlay didn't apply, AND on trunk-all ports (those carry `trunksAllVlans=true` instead — see below).
  trunksAllVlans Boolean        -- True when the port has `set allowed-vlans all` on FortiOS — trunks every VLAN on the switch. Operationally distinct from both `taggedVlans=[]` (access port) and `taggedVlans=[10,20]` (explicit-list trunk), so it's a separate flag rather than a sentinel value. Detected by reading `port["allowed-vlans-all"]` on newer FortiOS (`"enable"`/`"yes"`/`true` all coerce true via `fortiosBool`); falls back to the string sentinel `"all"` in `allowed-vlans` for older versions. Takes precedence over `taggedVlans` for UI display — the chip reads "Trunk all" / "Trunk <native>/all" and the slide-over surfaces a "Trunk (all)" pill plus any explicit-listed VLANs as an informational sub-line. Stays false on every other source.
  alias         String?         -- Operator-set label that overrides ifName in the UI when present. FortiOS CMDB `alias`; SNMP IF-MIB ifAlias (1.3.6.1.2.1.31.1.1.1.18). The interface table on the System tab swaps `alias` for `ifName` when set (with the real ifName kept as a tooltip + small subtitle), and the interface slide-over title shows `<alias> (<ifName>)`.
  description   String?         -- Free-text comment as reported by the device. FortiOS CMDB `description`; SNMP has no equivalent so this stays null on SNMP-monitored hosts. Surfaced on the interface slide-over and shown as ghost text in the Interface Comments editor when no Polaris override is set; AssetInterfaceOverride.description (when present) takes priority for display.
  addressingMode String?        -- L3 addressing mode: "static" | "dhcp" | "pppoe". FortiOS CMDB `system/interface.mode` only (parsed in `collectSystemInfoFortinet`, kept only if it's one of those three values); SNMP and the Polaris Agent have no equivalent and leave it null. Surfaced as the "Addressing" column on the System-tab interface table (DHCP/Static/PPPoE pill, "—" when null — same convention as the FortiSwitch-only VLAN columns). Config metadata: shown only in the live snapshot, intentionally NOT carried into the hourly/daily interface rollups, and nulled on the fast-cadence re-walk (like ifType/ifParent/vlanId) since that path doesn't fetch CMDB.
  @@index([assetId, timestamp])
  @@index([assetId, ifName, timestamp])

AssetHardwareSensorSample       -- Per-sensor hardware snapshot (the **Hardware Sensors** stream — superseded the temperature-only stream). One row per device hardware sensor per scrape: `sensorName`, `sensorClass` (temperature/fan/voltage/current/optical/poe/power/disk/other — `optical` is transceiver RX/TX power in dBm, `current` its TX bias in base amperes, `poe` the unit-level PSE budget/consumption in watts), `value` (NULL when the agent reports the sensor unreadable or broken — the row is kept because it carries the fault), `unit`, `alarmStatus`. Written by `collectHardwareSensors` (dispatches on `temperaturePolling`, runs in parallel with `collectTelemetry` from `runTelemetryFor`). FortiOS via /api/v2/monitor/system/sensor-info (ALL sensor classes, classified via `classifyHardwareSensor`); SNMP via the `fgHwSensorTable` walk (name/value/alarm, the comprehensive Fortinet source) or ENTITY-SENSOR-MIB (every class the table reports — temperature, fan, voltage, transceiver bias current and optical power — classified by `classifyEntitySensor`, with `entPhySensorOperStatus` supplying the alarm bit). The manufacturer-profile `temperature` metric's `table` type drives the fgHwSensorTable walk; `scalar` drives the FortiAP `fapTemperature` single-reading path. Hosts that publish nothing get no rows; the System tab hides the section. Has `*Hourly`/`*Daily` rollups + the `hardware` retention entity. No `Asset.lastHardwareSensorAt` column — the System tab derives the last-sample timestamp from the latest row here (returned as `lastTemperatureAt` for back-compat), so a failed scrape leaves the prior timestamp in place and surfaces the standard amber "Last successful update X ago" stale banner once it falls behind the resolved cadence.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  sensorName    String
  celsius       Float?
  @@index([assetId, timestamp])
  @@index([assetId, sensorName, timestamp])

AssetStorageSample              -- System tab per-mountpoint storage snapshot. Primary source is HOST-RESOURCES-MIB hrStorageTable (one row per fixed/removable disk). When that table is empty (devices whose SNMP agents don't implement HRM — FortiSwitches, some access points), the shared `collectVendorDiskFallback` synthesizes a single-row sample from the matched VendorTelemetryProfile's `disk` shape (e.g. FortiSwitch `fsSysDiskUsage` / `fsSysDiskCapacity`, mountPath "flash") — called by BOTH collectSystemInfoSnmp and collectStorageOnlySnmp, which carried identical copies of it until 2026-08. The shape takes whichever TWO of used / total / free the profile names and completes the pair (`deriveDiskBytes`), because the editable Manufacturer Profile's Storage row can express a free-bytes pairing the hardcoded profiles don't use; a row that can't produce a byte pair leaves the hardcoded baseline in place. **`Asset.storagePolling` is the sole authority on whether the rows are KEPT** — the interfaces walk produces them as a side effect and every path drops them when the storage stream didn't ask for that transport (`data.storage = []` in the SNMP and vCenter system-info branches, `wantStorage` on ssh/winrm, the method check at the top of runStorageFor), so setting SNMP on Interfaces alone collects nothing.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  timestamp     DateTime        @default(now())
  mountPath     String          -- hrStorageDescr (e.g. "/", "C:")
  totalBytes    BigInt?
  usedBytes     BigInt?
  @@index([assetId, timestamp])
  @@index([assetId, mountPath, timestamp])

AssetCustomWidgetSample         -- Time-series of ManufacturerCustomWidget probe results (Slice 7). One row per (asset, widget) per probe tick — scalar widgets store a single number, table widgets store a row-array. The Custom MIB tab on the asset details modal consumes the latest sample + a short window for line charts via `GET /assets/:id/custom-widgets`. `widgetId` is NOT an FK so deleting a widget from its parent ManufacturerProfile doesn't cascade-blow historical samples — the tab keeps showing the last known values until retention prunes them. Retention (added 2026-06, migration `20260621000000`): a STANDALONE detail-only TimescaleDB hypertable (`timescaleService.STANDALONE_SAMPLE_TABLES` — no hourly/daily rollups), pruned by `pruneSystemInfoSamples` on the system-info umbrella window (the interfaces detail retention) via the compression-safe `drop_chunks` + residue path, same as LLDP. Composite PK `(id, timestamp)` so the partition column is in the PK (create_hypertable requirement).
  id        UUID PK
  assetId   UUID FK → Asset (cascade delete)
  widgetId  String          -- references ManufacturerCustomWidget.id, no FK
  timestamp DateTime
  kind      String          -- "scalar" | "table"
  value     Json
  @@index([assetId, timestamp])
  @@index([assetId, widgetId, timestamp])
  @@index([widgetId])

AssetStateSample                -- STATE PROBES: the 0/1 sibling of AssetCustomWidgetSample, added 2026-08 (migration `20260811000000_state_probes`). One row per (asset, probe, table row) per scrape, already normalized to a boolean by the probe's declared `stateMap` (see `src/utils/stateProbes.ts`). Written by the same `collectAndRecordCustomWidgets` pass that writes AssetCustomWidgetSample — a widget with `widgetType="state"` walks its `symbol` (plus its optional `labelSymbol` for row names, joined on the OID index) and lands HERE instead. Why its own table rather than another `kind` on AssetCustomWidgetSample: the interesting dimension is the table ROW (one sensor, one PSU), each of which alerts independently and needs its own NotificationRuleState row, so real columns make that an indexed `(assetId, probeId, timestamp)` read for the engine and a plain GROUP BY for the builder's row picker, instead of unpacking a JSON array per sample on every 60s tick. Storing the boolean (not the raw reading) means the engine never has to know a vendor's polarity. `value` is 0 or 1 and NEVER null — the collector DROPS unreadable rows, because 0 is a positive claim of health that would clear an active alert. `rowKey` (the OID index suffix, "" for a scalar probe) is the stable identity the engine keys firing state on; `rowLabel` is the resolved display name, snapshotted per sample so an alert can name the row and a rename keeps the alert. Consumed by the `customStateValue` asset_metric (dimensions `stateProbeId` + `stateRowPattern`) and by `GET /assets/:id/custom-widgets` (which attaches each probe's current rows as `stateRows`). Retention: a STANDALONE detail-only TimescaleDB hypertable (`timescaleService.STANDALONE_SAMPLE_TABLES` — deliberately NO hourly/daily rollups, since averaging a boolean yields a duty cycle rather than a state), pruned by `pruneSystemInfoSamples` on the system-info umbrella window via the compression-safe `drop_chunks` + residue path, exactly like AssetCustomWidgetSample. NO FK to Asset (the hypertable cascade-DELETE invariant, migration `20260615000000`). Composite PK `(id, timestamp)`.
  id        UUID PK
  assetId   String          -- no FK (hypertable)
  timestamp DateTime
  probeId   String          -- references ManufacturerCustomWidget.id, no FK
  rowKey    String          -- OID index suffix; "" for a scalar probe
  rowLabel  String          -- resolved row name, falls back to rowKey
  value     Int             -- 0 | 1, never null
  rawValue  String?         -- what the device actually returned, for the asset tab
  @@index([assetId, timestamp])
  @@index([assetId, probeId, timestamp])
  @@index([probeId])

AssetIpsecTunnelSample          -- System tab per-tunnel IPsec snapshot, written on the system-info cadence. FortiOS only — read from /api/v2/monitor/vpn/ipsec, plus a parallel /api/v2/cmdb/vpn.ipsec/phase1-interface lookup so each row carries `parentInterface` (the FortiOS CLI `set interface` value, e.g. "wan1") AND captures the phase-1 `type`. The System tab uses parentInterface to nest tunnel rows under their parent in the Interfaces table — there is no longer a standalone IPsec section. Tunnels whose parentInterface lookup fails (CMDB scope missing, parent filtered out, etc.) fall into an "IPsec Tunnels (unbound)" group at the bottom of the same table. One row per phase-1 tunnel; status rolls phase-2 selectors up to "up" (all up), "down" (all down), or "partial" (mix). Phase-1 entries with CMDB `type: "dynamic"` (dial-up server templates) report status "dynamic" regardless of the phase-2 rollup — these accept connections from dynamic peers, and active sessions appear as separate `parent`-bearing tunnels that are already filtered out, so an up/down/partial label on the template is misleading. Bytes are summed across every phase-2 selector under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates, so the throughput derivation drops negative deltas as counter resets. ADVPN dynamic shortcut tunnels (those returning a non-empty `parent` field on the FortiOS response) are filtered out at the collector so spoke shortcut churn doesn't pollute the table. **CMDB-only synthesis:** `/monitor/vpn/ipsec` only lists tunnels the IKE daemon is actively servicing — a tunnel whose parent interface is down with no IP drops out of the monitor response entirely. The collector appends any phase1-interface CMDB entry missing from the monitor results as a synthetic row (status `down`, or `dynamic` for dial-up templates; `parentInterface` + `remote-gw` from CMDB; null byte counters) so configured-but-dead tunnels keep producing samples instead of silently vanishing from the System tab / Down IPsec Tunnels widget. Synthesis only runs when the monitor call succeeded (a monitor failure is "no ipsec data", never "every tunnel down"). The full IPsec endpoint is skipped on the fast (per-minute) cadence by default; pinning a tunnel name in Asset.monitoredIpsecTunnels turns it back on for that one tunnel.
  id              UUID PK
  assetId         UUID FK → Asset (cascade delete)
  timestamp       DateTime        @default(now())
  tunnelName      String          -- phase-1 name
  parentInterface String?         -- FortiOS phase1-interface CMDB `interface` field (e.g. "wan1"); null when the CMDB lookup fails or returns no match
  remoteGateway   String?         -- rgwy / tun_id
  status          String          -- "up" | "down" | "partial" | "dynamic" (dial-up server templates — see header)
  incomingBytes   BigInt?
  outgoingBytes   BigInt?
  proxyIdCount    Int?            -- # of phase-2 selectors under this phase-1
  @@index([assetId, timestamp])
  @@index([assetId, tunnelName, timestamp])

AssetPerfSlaSample              -- SD-WAN Performance SLA health-check snapshot, written on the system-info cadence. FortiOS only, gated by Integration.config.pullSdwan — read from /api/v2/monitor/virtual-wan/health-check (per-member latency/jitter/packet-loss + link state), with SLA target thresholds joined in from the /api/v2/cmdb/system/sdwan health-check `sla` config. One row per (health-check, WAN-member link). latency/jitter/packetLoss are instantaneous gauges (averaged in rollups, not counter-diffed). Collected by monitoringService.collectSdwanFortinet (pure parser parsePerfSlaHealthCheck) on the heavy pass, written via sampleWriteBuffer.enqueuePerfSlaSamples (cadence always "fast"). Read by `GET /assets/:id/perf-sla-history?healthCheck=&link=` (charts) + `GET /assets/:id/perf-sla-links` (selector + data-exists gate, carries latest thresholds), and by `alertChartService` at DELIVERY time for the SD-WAN charts in an alert email (one read per path alert, over the health check the Notification's dimension names; the stored SLA threshold columns are what that email draws its dashed line from). Surfaced on the asset modal's SD-WAN tab; the latency/jitter/loss charts draw a dashed SLA threshold line on whichever metric the health-check targets.
  id           UUID PK
  assetId      UUID FK → Asset (cascade delete)
  timestamp    DateTime        @default(now())
  healthCheck  String
  link         String          -- WAN member interface (e.g. "wan1", "Overlay-7")
  zone         String?         -- SD-WAN zone (CMDB members[].zone, e.g. "virtual-wan-link"/"overlay"); shown as "interface (zone)" in the Members table
  state        String          -- "up" | "down"
  latencyMs    Float?
  jitterMs     Float?
  packetLoss   Float?
  latency/jitter/packetLoss Threshold -- per-health-check SLA targets (null when unset)
  @@index([assetId, timestamp])
  @@index([assetId, healthCheck, link, timestamp])

MonitorClassOverride            -- Tier-2 of the monitor settings hierarchy. **As of Phase 2, this table is manual-scope only (`integrationId IS NULL`)** — integration-discovered assets get per-class settings via `Integration.config.<klass>Monitor.streams` blocks instead. The `POST` and `PUT` routes reject integration-scoped writes with 400; the `migrateMonitorSettingsPerClass` startup job folds historical integration-scoped rows into the integration streams blocks and deletes them. One row per (assetType, NULL) tuple; each field is nullable so an override can supply just the values that diverge from the tier below.
  id                        UUID PK
  integrationId             UUID? FK → Integration (cascade delete) -- null = override applies to manual-tier (orphan / non-integration-discovered) assets.
  assetType                 String   -- "firewall" | "switch" | "access_point" | "server" | "workstation" | "router" | "printer" | "other" — matches Asset.assetType.
  intervalSeconds           Int?
  failureThreshold          Int?
  probeTimeoutMs            Int?
  cpuMemoryTimeoutMs        Int?  -- Per-request timeout (ms) for the CPU+memory collector. null = inherit from the tier below. Range 1000..120000.
  temperatureTimeoutMs      Int?  -- Per-request timeout (ms) for the temperature collector. null = inherit. Range 1000..120000.
  systemInfoTimeoutMs       Int?  -- Per-request timeout (ms) for the interface / storage / LLDP collector. null = inherit. Range 1000..120000.
  cpuMemoryIntervalSeconds  Int?
  temperatureIntervalSeconds Int?
  systemInfoIntervalSeconds Int?
  customWidgetIntervalSeconds Int?
  customWidgetTimeoutMs     Int?
  -- Legacy single-tier retention (unused going forward — global Setting("sampleRetention") supersedes):
  sampleRetentionDays       Int?
  telemetryRetentionDays    Int?
  systemInfoRetentionDays   Int?
  -- Tiered retention (3 streams × detail/hourly/daily) seeded by migrateRetentionTiers; also superseded by the global Setting going forward but present on the row:
  sampleDetailRetentionDays      Int?
  sampleHourlyRetentionDays      Int?
  sampleDailyRetentionDays       Int?
  telemetryDetailRetentionDays   Int?
  telemetryHourlyRetentionDays   Int?
  telemetryDailyRetentionDays    Int?
  systemInfoDetailRetentionDays  Int?
  systemInfoHourlyRetentionDays  Int?
  systemInfoDailyRetentionDays   Int?
  -- Per-stream polling overrides. storagePolling has no companion credential /
  -- MIB column — storage reuses the interfaces credential at probe time and
  -- HOST-RESOURCES-MIB + the vendor disk fallback in pickVendorProfileMerged
  -- covers OID selection.
  responseTimePolling       String?
  cpuMemoryPolling          String?
  temperaturePolling        String?
  interfacesPolling         String?
  lldpPolling               String?
  storagePolling            String?
  customWidgetPolling       String?
  -- Per-stream credential FKs (set null on delete) — surfaced onto the resolved
  -- *CredentialId fields by resolveMonitorSettings; looked up via loadClassOverrideStreamCredential.
  responseTimeCredentialId  UUID? FK → Credential
  cpuMemoryCredentialId     UUID? FK → Credential
  temperatureCredentialId   UUID? FK → Credential
  interfacesCredentialId    UUID? FK → Credential
  lldpCredentialId          UUID? FK → Credential
  customWidgetCredentialId  UUID? FK → Credential
  @@unique([integrationId, assetType])
  -- Postgres treats nulls as distinct in unique indexes, so the
  -- @@unique([integrationId, assetType]) alone won't prevent two
  -- (null, "switch") rows. The route layer enforces uniqueness for the
  -- manual-tier case before insert.
```

## Notes

#### AssetMonitorSample / AssetTelemetrySample / AssetInterfaceSample / AssetHardwareSensorSample / AssetStorageSample / AssetIpsecTunnelSample / AssetPerfSlaSample

**AssetMonitorSample / AssetTelemetrySample / AssetInterfaceSample / AssetHardwareSensorSample / AssetStorageSample / AssetIpsecTunnelSample / AssetPerfSlaSample** — seven append-only sample tables. Each has `*Hourly` and `*Daily` rollup companions populated by `runSampleRollup` (14 rollup tables total). `AssetHardwareSensorSample` (the **Hardware Sensors** stream, which superseded the temperature-only stream) holds one row per device hardware sensor per scrape — `sensorClass` (temperature / fan / voltage / current / optical / poe / power / disk / other — `optical` is transceiver RX/TX power in dBm, `current` its TX bias in base amperes, and `poe` the UNIT-level PSE budget/consumption in watts from `pethMainPseTable` (its own class because `power` is deliberately unit-less, carrying Fortinet's status-shaped PSU rows); the enum is mirrored in `notificationTypes`' `sensorClass` dimension, which is CLOSED, so a class missing there is unselectable in the wizard however many samples carry it) + `value` + `unit` + `alarmStatus` (the device's OWN alarm bit, `"ok"`/`"alarm"`/NULL; alertable via the **`hwSensorAlarm`** boolean asset_metric — see business rule 24 — and rendered as the System tab's STATUS column) — from FortiOS `sensor-info` REST or the SNMP `fgHwSensorTable` / ENTITY-SENSOR-MIB walk; it rides the telemetry cadence via the still-internally-named `temperature` polling stream (`Asset.temperaturePolling` etc. unchanged) + the `hardware` retention entity. The last one is the SD-WAN **SLA-metrics** stream (FortiOS only, gated by `Integration.config.pullSdwan`): `AssetPerfSlaSample` = per (health-check, WAN-member) latency/jitter/packet-loss gauges + SLA thresholds; it rides the system-info cadence like IPsec. (The SD-WAN **rules** stream is no longer a time-series — see `AssetSdwanRule` below.) **`AssetMonitorSample.dependencyDown`** (2026-08) marks a FAILED probe taken while the asset was `dependencySuppressed` — its parent was dark at probe time. The probe keeps running while suppressed (half cadence, `resolveProbeIntervalSec`, because the device may still answer over a redundant path), so those rows exist either way; the flag is what lets every chart draw the stretch GREY instead of the red dive that claims an unexplained outage. It is read off the asset row in `recordProbeResult`, never re-derived there — `dependencySuppressed` is owned by the 60s reconciler, and deciding it twice would give two answers. Rolled up as `dependencyFailureCount` on the hourly + daily companions (COALESCEd on the daily re-aggregate, so a pre-column NULL bucket can't wipe a day), and a rollup bucket only reads as a dependency outage when EVERY failure in it was one. `probeOutageService` turns both into an `OutageKind` per window. **`AssetMonitorSample.assetDown`** (2026-09-03) is its sibling and marks a FAILED probe taken while the asset ITSELF was `down` — the marker packet loss is measured AROUND (business rule 29h). `recordProbeResult` stamps it from `nextStatus`, the status the probe RESULTS in; `runLossSweepFor` stamps its burst rows from the asset's CURRENT `monitorStatus`, having no verdict of its own (it never calls `recordProbeResult`). **What the readers exclude is the RUN it appears in, not the row** — every maximal stretch of consecutive failures holding a stamped row goes whole, onset included, because the marker cannot exist before the outage is declared and the `missedPolls - 1` onset misses are fully-lost probes that would otherwise sit in an already-shrunken denominator. That is `probeLossQuery`'s `runId`/`runOutage` window pair and its JS mirror `alertChartService.outageRunFailures`, applied to BOTH the loss chart's line and its caption, because an alert reading 0.0% over a chart captioned *avg 40%* reads as an invented number. A run that never reached `down` carries no marker and counts in full, which is what keeps an alternating device measurable. NULL reads as false (coalesced in SQL, `=== true` in JS), so the change is not retroactive; deliberately NOT rolled up (nothing reads a loss ratio off the hourly/daily companions) and deliberately not extended to `recovering`, whose probes ANSWERED. **These sample/rollup tables (+ `AssetCustomWidgetSample`) carry `assetId` but NO foreign key to Asset** (cascade dropped in migration `20260615000000`): they're TimescaleDB hypertables, and a cascade DELETE matching a compressed chunk decompresses it into un-truncatable bloat (prod incident 2026-06-08). Deleting an Asset orphans its sample rows (queried only by assetId, never surfaced) to age out via `drop_chunks`. Never re-add the relation, and never row-DELETE/UPDATE sample rows that could sit in a compressed chunk — see [polaris-change-impact → tiered-sample-retention](polaris-change-impact). **`AssetInterfaceSample` is PINNED-ONLY** (2026-08): it carries one row per *operator-pinned* interface (`Asset.monitoredInterfaces`) per scrape, not one per interface. Unpinned interfaces previously landed here as `cadence="slow"` and were deleted 24h later — roughly 4–5× the pinned volume, for rows nothing ever read as history: never compressed (deleted at 24h while the selection-aware compression floor is 2 days), never rolled up, and removed by the row-level DELETE behind the compressed-chunk bloat incidents. Every consumer of those rows actually wanted *current state*, which now lives in **`AssetInterface`**. Consequences: an unpinned interface has no chart (the slide-over says so and offers the pin), and the counter-metric automations `ifInBps` / `ifOutBps` / `ifInErrorRate` / `ifOutErrorRate` — which were never pin-scoped, unlike `ifOperStatus`/`ifAdminStatus`/`poeStatus` — only produce readings for pinned interfaces. That pinned-only storage is no longer what enforces it: every interface resolver now gates EXPLICITLY on the pin set (`interfaceIsPinned`), so the rule is the engine's rather than a property of a storage decision that could change again. Storage and IPsec keep the old fast/slow split — but IPsec's unpinned slow rows feed no alerts: both IPsec triggers gate on the tunnel pin set (`tunnelIsPinned`, see `NotificationRuleState`).

#### AssetStateSample

**AssetStateSample** — the **0/1 sibling** of the above: one row per (asset, **state probe**, table row) per scrape, written by the same `collectAndRecordCustomWidgets` pass. A `ManufacturerCustomWidget` with `widgetType="state"` is a *state probe* — a status-shaped OID (alarm bit, PSU present, fan-tray OK) whose reading is normalized to a boolean at scrape time by the probe's operator-DECLARED `stateMap` (`src/utils/stateProbes.ts`: modes `nonzero`/`zero`/`equals`/`notEquals`/`gte`/`lte` + `trueLabel`/`falseLabel`/`trueIsProblem`). Declared rather than inferred because vendors disagree on polarity — SNMPv2 TruthValue is `true(1)/false(2)`, plenty of enums use 2 for the bad state, some agents answer strings — so a bare `value >= 1` is wrong about as often as it's right; storing the boolean means the automation engine never has to know. Alertable per row via the `customStateValue` asset_metric (dimensions `stateProbeId` + `stateRowPattern`). Two invariants: **`value` is 0 or 1 and never null** (the collector DROPS an absent/unreadable/incomparable row, because 0 is a positive claim of health that would clear a live alert — and on a `trueIsProblem=false` probe would raise one about hardware that isn't there), and **`rowKey`** (the OID index suffix, `""` for a scalar probe) is the stable dimension identity while `rowLabel` (resolved from the probe's optional `labelSymbol` sibling walk, joined on that index) is what operators filter and read — so renaming a row keeps its alert. Its own table rather than another `kind` on AssetCustomWidgetSample because the alerting dimension is the ROW: real columns make the engine's read an indexed `(assetId, probeId, timestamp)` scan and the builder's row picker a plain GROUP BY, instead of unpacking a JSON array per sample every 60s. Standalone detail-only hypertable, **deliberately no rollups** (averaging a boolean gives a duty cycle, not a state), same no-FK rule and same `pruneSystemInfoSamples` umbrella window.
