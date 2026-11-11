/**
 * src/services/monitoring/types.ts — the shapes the monitoring streams produce (CQ-B061, moved verbatim from
 * monitoringService.ts): the probe result and the telemetry / system-info samples and
 * their parts. Types only; monitoringService.ts re-exports every one.
 */

import { type FortiswitchMclagPeer } from "../../utils/fortiswitchCmdb.js";
import { type SysDescrDetail } from "../../utils/snmpDescrIdentity.js";
import { type SnmpSelfIdentity } from "../../utils/snmpEntityIdentity.js";
import { type FcLoginRow, type FcPortRow } from "../../utils/fibreChannel.js";
import type { ApRadioSample } from "../../utils/fortiapMonitorRow.js";
import { type FdbEntry } from "../../utils/macForwarding.js";
import { type ArpNeighborEntry } from "../../utils/arpNeighbors.js";
import { type TrunkPortEntry } from "../../utils/fortiswitchTrunkMap.js";
import { type IpsecTunnelSample, type IpsecConnectionSample } from "../../utils/fortiosIpsec.js";

export interface ProbeResult {
  success: boolean;
  /** Wall-clock duration of the probe, rounded to integer ms. */
  responseTimeMs: number;
  /** Short human-readable reason on failure; null on success. */
  error?: string;
  /**
   * Device uptime in whole seconds, when the probe transport can supply it
   * for free: SNMP sysUpTime (read as the reachability OID anyway), FortiOS
   * system status, and the Polaris Agent (host.Uptime via the responseTime
   * stream). undefined for transports that don't report it (ICMP/SSH/WinRM).
   * recordProbeResult stamps Asset.lastUptimeSec + drives reboot detection
   * (lastRebootAt + device.reboot Event) from it.
   */
  uptimeSec?: number;
  /**
   * The firmware the device reported, when the probe read it for free — today
   * only the FortiOS REST probe (`system/status` envelope `version`). Consumed
   * by probeAsset's live-version reconcile; nothing else reads it.
   */
  firmwareVersion?: string;
  /**
   * "This was not a measurement." Set when the transport could not ask the
   * thing that answers FOR the asset — today only the vCenter probe, when the
   * vCenter server itself is unreachable. `recordProbeResult` writes no sample
   * and moves no counter for a skipped probe; it only bumps `lastMonitorAt` so
   * the cadence keeps its spacing instead of retrying on every tick.
   *
   * Deliberately NOT a failure: a device behind an unreachable hypervisor
   * manager is a device Polaris has no opinion about, and counting it would
   * declare an entire virtual fleet down the moment vCenter hiccups.
   */
  skipped?: boolean;
  /**
   * "Somebody already took this reading." Set by `probeAsset` when a queued
   * probe job reaches a worker after a later job has already polled the asset
   * (see `probeStillDue`). Unlike `skipped`, this must not even stamp
   * `lastMonitorAt`: the earlier job's stamp IS the cadence anchor, and
   * overwriting it would push the next poll later for no reason. `runProbeFor`
   * returns before `recordProbeResult` when it sees this.
   */
  duplicate?: boolean;
  /**
   * "The agent should have reported by now and has not." Set by `probeAsset`
   * on an agent-mode asset whose enrolled agent has been silent past its
   * window (business rule 86, `judgeAgentSilence`). It is the ONE synthetic
   * agent-mode result `recordProbeResult` lets through: a real failed reading,
   * so the covering automation's missedPolls can call a dead host down.
   */
  agentSilent?: boolean;
  /**
   * The device's raw sysDescr, when the probe was asked to carry it.
   *
   * Only the SNMP transport can supply this, and only on the tick where
   * `Asset.lastDescrAt` says the identity read is due — it rides the GET the
   * probe was already making (one extra varbind, same packet, same session,
   * same per-host gate) rather than opening a session of its own. An
   * unreadable or absent sysDescr leaves this undefined and NEVER fails the
   * probe: the probe's job is liveness, and a device that answered sysUpTime
   * is up whatever it says about its own name.
   */
  sysDescr?: string;
  /**
   * sysObjectID, carried beside sysDescr on the same GET. A vendor format
   * whose fields mean different things on different products needs it to
   * decide which it is reading (business rule 161: an APC card's model and
   * serial are the device's only on a rack PDU).
   */
  sysObjectId?: string;
}

// ─── System tab: telemetry + system-info collection ────────────────────────
//
// These run on independent cadences from the response-time probe. Telemetry
// (CPU/memory) ticks every ~60s; system info (interfaces + storage) ticks
// every ~10min. ICMP and SSH cannot deliver this data. WinRM is not yet
// supported — see `collectTelemetryWinRm` / `collectSystemInfoWinRm` below.

export interface TelemetrySample {
  cpuPct?:        number | null;
  memPct?:        number | null;
  memUsedBytes?:  number | null;
  memTotalBytes?: number | null;
  /**
   * Per-core utilisation, index = core id. The `vcenter` collector is the
   * only server-side one that fills it (a VM's vCPUs, an ESXi host's
   * physical cores); the agent's copy never passes through here, arriving on
   * its own push path instead. Null, never `[]` — see the column comment.
   */
  cpuCorePcts?:   number[] | null;
  /**
   * The agent's memory bands, in bytes: memUsedBytes + buffers + cached +
   * free = memTotalBytes exactly. The agent fills them on its own push path;
   * the only server-side collector that does is a TrueNAS host (ZFS ARC as
   * `cached`, buffers 0). Never mixed with the vCenter set below.
   */
  memBuffersBytes?: number | null;
  memCachedBytes?:  number | null;
  memFreeBytes?:    number | null;
  /**
   * The vCenter memory bands, in bytes. Disjoint from the agent's
   * buffers/cache/free set and never mixed with it in one row — a VM fills
   * private/shared/ballooned/swapped/compressed, an ESXi host fills
   * consumed/ballooned/swapped. Every other collector leaves them null.
   */
  memPrivateBytes?:    number | null;
  memSharedBytes?:     number | null;
  memBalloonedBytes?:  number | null;
  memSwappedBytes?:    number | null;
  memCompressedBytes?: number | null;
  memConsumedBytes?:   number | null;
  /** Active session count (FortiGate only). Null for every other source. */
  sessionCount?:  number | null;
}

export interface InterfaceSample {
  ifName:       string;
  adminStatus?: string | null;
  operStatus?:  string | null;
  speedBps?:    number | null;
  /** Negotiated duplex of an UP link, "full" | "half"; null when down or unknown. EtherLike-MIB dot3StatsDuplexStatus (SNMP), FortiOS monitor `duplex`, the Polaris Agent, vCenter pNIC links. */
  duplex?:      string | null;
  /** The interface's IPv4 address (one bare address). IPv6 rides `ipv6Address` (business rule 126). */
  ipAddress?:   string | null;
  /** The interface's secondary IPv4 addresses, bare. FortiOS REST only (CMDB `secondary-ip`); undefined everywhere else, which means "not known", not "none". When it is an array, `ipAddress` is the interface's primary. */
  secondaryIps?: string[] | null;
  /** First reportable IPv6 on the interface — never loopback / link-local (utils/interfaceAddress.ts). Listed and kept in history; never the asset's primary address (business rule 126). */
  ipv6Address?: string | null;
  macAddress?:  string | null;
  inOctets?:    number | null;
  outOctets?:   number | null;
  /** Cumulative IF-MIB ifInErrors / FortiOS errors_in. */
  inErrors?:    number | null;
  /** Cumulative IF-MIB ifOutErrors / FortiOS errors_out. */
  outErrors?:   number | null;
  /** "physical" | "aggregate" | "vlan" | "loopback" | "tunnel" — FortiOS REST + SNMP ifType OID. */
  ifType?:      string | null;
  /** For an "aggregate" row, FortiOS's own bundle type: "aggregate" | "redundant" | "hard-switch" | "switch" (software switch) | "vap-switch". FortiOS REST only. */
  ifSubtype?:   string | null;
  /** Aggregate name (for member ports) or parent interface name (for VLANs). FortiOS REST only. */
  ifParent?:    string | null;
  /** 802.1Q VLAN ID. FortiOS REST only. */
  vlanId?:      number | null;
  /** Untagged PVID for a switch port. Managed FortiSwitches only — overlaid from the parent FortiGate's `switch-controller/managed-switch` CMDB. */
  nativeVlan?:  number | null;
  /** Tagged VLAN set for a switch port (allowed-vlans minus untagged-vlans, expanded). Managed FortiSwitches only. */
  taggedVlans?: number[] | null;
  /** True when the port has `set allowed-vlans all` — trunks every VLAN. Takes precedence over `taggedVlans` for UI display. Managed FortiSwitches only. */
  trunksAllVlans?: boolean | null;
  /** Operator-set label that overrides ifName in the UI. FortiOS CMDB `alias`; SNMP ifAlias (1.3.6.1.2.1.31.1.1.1.18). */
  alias?:       string | null;
  /** Operator-set free-text comment. FortiOS CMDB `description`; SNMP has no equivalent. */
  description?: string | null;
  /** PoE detection status from POWER-ETHERNET-MIB — "disabled" | "searching" | "delivering" | "fault" | "test" | "other-fault". SNMP only; FortiOS REST and the agent leave it null. */
  poeStatus?:   string | null;
  /** Negotiated PoE power-budget bracket, "class0".."class4". NOT a wattage measurement — RFC 3621 has no per-port wattage object. SNMP only. */
  poeClass?:    string | null;
  /** L3 addressing mode: "static" | "dhcp" | "pppoe". FortiOS CMDB `system/interface.mode`; SNMP / agent leave null. */
  addressingMode?: string | null;
}

export interface StorageSample {
  mountPath:   string;
  totalBytes?: number | null;
  usedBytes?:  number | null;
}

/** One row per hardware sensor reported by the device. `value` is the reading
 *  in `unit` (°C / RPM / V / …), null when the sensor is non-readable /
 *  not-present. `sensorClass` is the best-effort classification; `alarmStatus`
 *  is the device-reported health ("ok" / "alarm") when available. */
export interface HardwareSensorSample {
  sensorName:  string;
  sensorClass: string;
  value:       number | null;
  unit:        string | null;
  alarmStatus: string | null;
  /** The port a transceiver reading belongs to (business rule 143); absent otherwise. */
  ifName?:     string | null;
}

/**
 * One SD-WAN Performance SLA health-check reading for a single WAN member.
 * Read from /api/v2/monitor/virtual-wan/health-check. One sample per
 * (health-check, member link). latency/jitter/packetLoss are instantaneous
 * gauges (null when the member reported no value, e.g. link down).
 */
export interface PerfSlaSample {
  healthCheck: string;
  link:        string;
  // SD-WAN zone the member belongs to (CMDB members[].zone). Null when unknown.
  zone:        string | null;
  state:       "up" | "down";
  latencyMs:   number | null;
  jitterMs:    number | null;
  packetLoss:  number | null;
  // SLA target thresholds for the parent health-check (per-health-check config,
  // not per-member). Null when that metric has no configured threshold.
  latencyThresholdMs:  number | null;
  jitterThresholdMs:   number | null;
  packetLossThreshold: number | null;
}

/**
 * One SD-WAN service rule's selection state. Rule definition (name, mode,
 * candidate members) from /api/v2/cmdb/system/sdwan; `selectedMember` is the
 * runtime-active member when resolvable, else null (collector degrades
 * gracefully). One sample per (asset, rule); the detail series is the
 * failover timeline.
 */
export interface SdwanRuleSample {
  ruleName:         string;
  ruleId:           string | null;
  seq:              number | null;
  enabled:          boolean | null;
  mode:             string | null;
  criteria:         string | null;
  healthChecks:     string[];
  dst:              string[];
  status:           "up" | "down";
  selectedMember:   string | null;
  availableMembers: string[];
  // SD-WAN zone(s) the rule prefers, in priority order, when configured for
  // zone-based selection (`priority-zone`). Empty for interface-member rules.
  // When set, `availableMembers` is resolved from the member interfaces of
  // these zones so the UI can group them by zone.
  priorityZones:    string[];
}

/**
 * One LLDP neighbor seen on a local interface. Replaces (per-asset) on each
 * system-info pass that successfully queried LLDP. `localIfName` is the
 * interface on *this* asset that saw the neighbor; the chassis/port fields
 * describe the *remote* end. Capabilities is a list of tokens matching the
 * LLDP-MIB / FortiOS naming ("bridge", "router", "wlan-access-point", …).
 */
export interface LldpNeighborSample {
  localIfName:        string;
  chassisIdSubtype?:  string | null;
  chassisId?:         string | null;
  portIdSubtype?:     string | null;
  portId?:            string | null;
  portDescription?:   string | null;
  systemName?:        string | null;
  systemDescription?: string | null;
  managementIp?:      string | null;
  capabilities?:      string[];
}

/**
 * Wireless station seen connected to a FortiAP. Collected from SNMP
 * `fapStationTable` (1.3.6.1.4.1.12356.120.8.1.1) and persisted via the
 * system-info pass into AssetWirelessStation. MAC is normalized
 * colon-uppercase before persist; the persist layer resolves
 * `matchedAssetId` by MAC lookup against the endpoint inventory.
 */
export interface WirelessStationSample {
  staMacAddr:      string;
  staIpAddr?:      string | null;
  ssid?:           string | null;
  radioId?:        number | null;
  wlanId?:         number | null;
  band?:           string | null;
  vlanId?:         number | null;
  bssid?:          string | null;
  signalStrength?: number | null;
  noise?:          number | null;
  bandwidthTx?:    number | null;
  bandwidthRx?:    number | null;
  idleSeconds?:    number | null;
}

/** One field-replaceable unit from ENTITY-MIB entPhysicalTable. */
export interface PhysicalEntitySample {
  entIndex:    number;
  entClass:    string;
  descr:       string | null;
  name:        string | null;
  hardwareRev: string | null;
  firmwareRev: string | null;
  serialNum:   string | null;
  mfgName:     string | null;
  modelName:   string | null;
  isFru:       boolean;
  /** Display-only correlated interface for a transceiver; never an identity. */
  ifName:      string | null;
}

export interface SystemInfoSample {
  interfaces:    InterfaceSample[];
  storage:       StorageSample[];
  /**
   * Field-replaceable hardware inventory. `undefined` means the collector
   * didn't try (non-SNMP transport / fast cadence); `[]` means the device was
   * queried and reported no FRUs, which the persist layer treats as "wipe".
   */
  physicalEntities?: PhysicalEntitySample[];
  /**
   * Switch MAC forwarding database. Same undefined/[] contract: undefined
   * means not collected or the device answers no FDB table at all, `[]` means
   * a bridge that currently has nothing in its table.
   */
  macTable?: FdbEntry[];
  /** IP neighbour cache (ARP / NDP). Firewall-class only; see collectArpNeighborsSnmp. */
  arpNeighbors?: ArpNeighborEntry[];
  /**
   * FortiSwitch trunk -> local-port map. Same undefined/[] contract.
   */
  trunkMembers?: TrunkPortEntry[];
  ipsecTunnels?: IpsecTunnelSample[];
  /**
   * Who is connected through this gate's IPsec / SSL-VPN: ADVPN spokes and
   * shortcuts, dial-up peers, FortiClient users. Per source, the
   * undefined/[] contract: `ipsecConnections` undefined = the IPsec monitor
   * read failed or did not run (stored IPsec rows stay), `[]` = read, nobody
   * connected (wipe). `sslVpnSessions` the same for the SSL-VPN half, which
   * is a separate read that fails on its own. Full pass only.
   */
  ipsecConnections?: IpsecConnectionSample[];
  sslVpnSessions?:   IpsecConnectionSample[];
  // SD-WAN (perfSla / sdwanRules) is not part of this sample any more — it has
  // its own cadence and runner (runSdwanFor).
  /**
   * LLDP neighbors observed during this scrape. `undefined` means the
   * collector didn't try (unsupported transport / fast-cadence skip);
   * `[]` means the device was queried but reported zero neighbors and the
   * persistence layer should treat that as "wipe all stored neighbors".
   */
  lldpNeighbors?: LldpNeighborSample[];
  /** Which transport produced lldpNeighbors. Stamped onto each persisted row for diagnostics. */
  lldpSource?:    "fortios" | "snmp" | "genericapi";
  /**
   * Wireless stations connected to a FortiAP, observed during this
   * scrape. Same undefined/[] semantics as lldpNeighbors. Only populated
   * by the SNMP fapStationTable path on `assetType="access_point"`
   * assets; FortiOS-REST AP telemetry path stays undefined.
   */
  wirelessStations?: WirelessStationSample[];
  /** The AP's radios + the SSIDs each one broadcasts (FORTINET-FORTIAP-MIB's
   *  fapRadioTable + fapVapTable). Absent when the tables could not be read —
   *  "unknown, do not wipe", the same contract as the two above. */
  apRadios?: ApRadioSample[];
  /**
   * MCLAG ICL peers (FortiSwitch only), from the parent FortiGate's
   * switch-controller managed-switch CMDB. Same undefined/[] semantics as LLDP:
   * `undefined` = not collected (leave stored rows alone), an array (even empty)
   * = full-replace the asset's ICL-peer rows. Current-state, no history.
   */
  mclagPeers?: FortiswitchMclagPeer[];
  /**
   * FortiLink-enabled interface names (the fortilink-flagged interfaces + their
   * member ports) seen on this FortiGate, from CMDB `system/interface`. Used to
   * exclude FortiLink links from LLDP when the integration's
   * `excludeFortilinkLldp` toggle is on. Only populated by the FortiOS REST
   * path (which fetches CMDB); `[]` when CMDB returned no fortilink interfaces,
   * `undefined` when CMDB wasn't fetched (SNMP-interfaces path).
   */
  fortilinkInterfaces?: string[];
  /**
   * Real hardware model detected during the scrape, when the matched vendor
   * profile carries a model-identity query (FortiSwitch fsSysVersion — the
   * value has the firmware version appended after the model token, and the
   * profile's parse strips it). `undefined`/null = not collected or
   * unrecognized → leave Asset.model alone. recordSystemInfoResult adopts a
   * non-null value onto Asset.model only while the stored model is empty or
   * still the generic discovery literal ("FortiSwitch…"), so an
   * operator-typed model is never overwritten.
   */
  detectedModel?: string | null;
  /**
   * What the vendor's OWN sysDescr format stated, when the vendor publishes
   * one Polaris can read (utils/snmpDescrIdentity.ts). `undefined` for every
   * other device, which is most of them — and the reason this is safe to
   * collect fleet-wide: no readable layout, no opinion, no write.
   */
  descrIdentity?: SysDescrDetail;
  /** The raw sysDescr behind it, so Asset.os can follow the firmware. */
  sysDescr?: string | null;
  /** sysObjectID from the same multi-GET (business rule 161). */
  sysObjectId?: string | null;
  /**
   * What the device stated about itself through sysName and its ENTITY-MIB
   * chassis row (business rule 154, utils/snmpEntityIdentity.ts). Undefined
   * when the transport has no such reading (REST, agent) or the device stated
   * nothing; persisted as the `snmp-identity` enrichment source.
   */
  selfIdentity?: SnmpSelfIdentity;
  /**
   * A fibre-channel switch's ports and the devices logged into them (business
   * rule 159, utils/fibreChannel.ts). Undefined = not an FC switch, or a
   * transport that cannot say: stored rows stay. An object = the device was
   * walked, and its rows replace the stored ones.
   */
  fibreChannel?: { ports: FcPortRow[]; logins: FcLoginRow[] };
}

export interface CollectionResult<T> {
  /** false → monitor type can't deliver this data; caller should not stamp lastXxxAt */
  supported: boolean;
  /** Set on a successful collection (even if some sub-fields are null). */
  data?: T;
  /** Short failure reason; only set when supported && data is undefined. */
  error?: string;
}

/**
 * Slim subset of Asset columns that `recordProbeResult` needs for its
 * state-machine update. Lets the hot loop (runProbeFor) preload the asset
 * once and skip the second findUnique inside recordProbeResult.
 *
 * The type is structural — fields named the same as on the Asset model so
 * a `Prisma.AssetGetPayload<...>` row (the shape probeAsset already loads
 * with its includes) satisfies it without an explicit map step.
 */
export interface AssetMonitorSnapshot {
  id: string;
  hostname: string | null;
  assetType: string;
  monitored: boolean;
  monitorStatus: string | null;
  /** Last SNMP sysUpTime reading (whole seconds); drives reboot detection. */
  lastUptimeSec?: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  discoveredByIntegrationId: string | null;
  monitorIntervalSec: number | null;
  cpuMemoryIntervalSec: number | null;
  temperatureIntervalSec: number | null;
  systemInfoIntervalSec: number | null;
  probeTimeoutMs: number | null;
  /** Parent dark at load time — tags a failed probe as an explained miss. */
  dependencySuppressed?: boolean | null;
  cpuMemoryTimeoutMs?: number | null;
  temperatureTimeoutMs?: number | null;
  systemInfoTimeoutMs?: number | null;
  /** The address probed, and the polling run on it (business rule 103). */
  ipAddress?: string | null;
  ipConfirmedFor?: string | null;
  ipConfirmedSince?: Date | null;
}
