/**
 * src/services/monitoring/snmpCore.ts — the SNMP session layer every SNMP collector shares (CQ-B061, moved verbatim
 * from monitoringService.ts): session open + the per-host gate, walk / get / multi-get,
 * varbind decoding, the v3 auth / priv mapping. monitoringService.ts re-exports the public names.
 */

import { toNonNegativeInt } from "../../utils/num.js";
import { chunkArray } from "../../utils/chunk.js";
import * as snmp from "net-snmp";
import { AppError } from "../../utils/errors.js";
import { isIpv6Address } from "../../utils/cidr.js";
import { makeOidMonotonicGuard } from "../../utils/oidCompare.js";
import { logger } from "../../utils/logger.js";
import { COLLECTOR_REQUEST_TIMEOUT_MS } from "./monitorSettings.js";
import { startPhase } from "./common.js";

function mapSnmpAuthProtocol(value: unknown): unknown {
  switch (value) {
    case "MD5":    return snmp.AuthProtocols.md5;
    case "SHA":    return snmp.AuthProtocols.sha;
    case "SHA224": return snmp.AuthProtocols.sha224;
    case "SHA256": return snmp.AuthProtocols.sha256;
    case "SHA384": return snmp.AuthProtocols.sha384;
    case "SHA512": return snmp.AuthProtocols.sha512;
    default: throw new AppError(400, `Unsupported SNMP v3 authProtocol "${String(value)}"`);
  }
}

function mapSnmpPrivProtocol(value: unknown): unknown {
  switch (value) {
    case "DES":     return snmp.PrivProtocols.des;
    case "AES":     return snmp.PrivProtocols.aes;
    case "AES256B": return snmp.PrivProtocols.aes256b;
    case "AES256R": return snmp.PrivProtocols.aes256r;
    default: throw new AppError(400, `Unsupported SNMP v3 privProtocol "${String(value)}"`);
  }
}

// Per-SNMP-target serialization gate. Many switch/AP SNMP agents are
// single-threaded — a heavy walk (IF-MIB + LLDP + storage) running in
// parallel with a cheap sysUpTime probe pins the agent's request queue
// and stretches the probe's response time from <50ms to several seconds,
// occasionally past the probe timeout (reads as "packet loss"). All
// SNMP entry points (probeSnmp / collectTelemetrySnmp / collectSystemInfoSnmp)
// run through `withSnmpGate(host, port, ...)` so probe, telemetry,
// systemInfo, and fastFiltered SNMP calls FIFO-serialize against the
// same agent within this Polaris process. FortiOS REST and FMG calls
// have their own concurrency models and aren't routed through this gate.
//
// Each waiter has a bounded wait via SNMP_GATE_WAIT_TIMEOUT_MS — when the
// currently-running collector wedges (e.g. 60s net-snmp timeout on a dead
// host), queued callers fail fast with a clear error instead of all
// waiting the full upstream duration. The wedged collector still holds
// its own slot until it returns; the timeout only bounds wait time for
// callers behind it. Default 30s — enough headroom for a legitimate
// heavy + telemetry back-to-back (~20s with default tier-3 timeouts),
// short enough to surface a hang.
type SnmpGateSlot = {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  timer: NodeJS.Timeout | null;
  timedOut: boolean;
};

const snmpQueues = new Map<string, SnmpGateSlot[]>();

const snmpRunning = new Set<string>();

// Read per-call so tests can inject a small value via process.env without
// having to re-import the module (which is awkward inside a single-file test
// suite). Cost is negligible: one Number() coercion per gate entry, dwarfed
// by the upstream net-snmp call this serializes.
function snmpGateWaitTimeoutMs(): number {
  const raw = Number(process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function processNextSnmpSlot(key: string): void {
  if (snmpRunning.has(key)) return;
  const queue = snmpQueues.get(key);
  if (!queue || queue.length === 0) {
    snmpQueues.delete(key);
    return;
  }
  // Skip past any slots that timed out while waiting; their rejection
  // already fired, but their queue entry remains until we drain it here.
  let slot: SnmpGateSlot | undefined;
  while ((slot = queue.shift())) {
    if (!slot.timedOut) break;
  }
  if (!slot || slot.timedOut) {
    snmpQueues.delete(key);
    return;
  }
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  snmpRunning.add(key);
  const waitMs = Date.now() - slot.enqueuedAt;
  if (waitMs > 5000) {
    logger.warn({ host: key, waitMs }, "SNMP gate wait > 5s");
  }
  // Phase tracing for the current handler. Captures the wait portion
  // separately from the fn() runtime so the operator can tell at a
  // glance whether the time was spent queued (= upstream walk holding
  // the agent) or actively walking (= this asset's SNMP agent slow).
  const endPhase = startPhase("snmp.gate_wait");
  endPhase({ host: key, waitMs });
  // INTENTIONAL .then() chain — this is the per-host SNMP serialization gate's
  // slot runner: run fn(), settle the caller's promise, then release the gate
  // and pull the next queued slot. Do NOT rewrite to an async IIFE; the
  // run→settle→process-next ordering is the gate's contract.
  Promise.resolve()
    .then(() => slot.fn())
    .then(slot.resolve, slot.reject)
    .finally(() => {
      snmpRunning.delete(key);
      processNextSnmpSlot(key);
    });
}

// `waitTimeoutMs` overrides the env-derived gate wait for this one caller.
// Used by the operator snmp-walk path, whose deadline is the walk tab's
// 60s client countdown rather than the collectors' fail-fast budget.
export async function withSnmpGate<T>(host: string, port: number, fn: () => Promise<T>, waitTimeoutMs?: number): Promise<T> {
  const key = `${host}:${port}`;
  return new Promise<T>((resolve, reject) => {
    const slot: SnmpGateSlot = {
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
      timer: null,
      timedOut: false,
    };
    const timeoutMs = (typeof waitTimeoutMs === "number" && waitTimeoutMs > 0)
      ? waitTimeoutMs
      : snmpGateWaitTimeoutMs();
    slot.timer = setTimeout(() => {
      if (slot.timedOut) return;
      slot.timedOut = true;
      slot.timer = null;
      const waitMs = Date.now() - slot.enqueuedAt;
      logger.warn(
        { host, port, waitMs, timeoutMs },
        "SNMP gate wait timeout — failing fast",
      );
      reject(new Error(`SNMP gate timeout for ${key} after ${waitMs}ms`));
    }, timeoutMs);
    let queue = snmpQueues.get(key);
    if (!queue) { queue = []; snmpQueues.set(key, queue); }
    queue.push(slot);
    processNextSnmpSlot(key);
  });
}

/** Cap on the amount of work a single subtree walk will do. Guards against pathological devices that publish huge ifTables. */
const SNMP_WALK_MAX = 1000;

// ─── SNMP collectors ────────────────────────────────────────────────────────
//
// HOST-RESOURCES-MIB delivers CPU (hrProcessorLoad), memory (hrStorage rows
// where hrStorageType = hrStorageRam), and storage (hrStorage rows where the
// type is hrStorageFixedDisk). IF-MIB delivers per-interface counters. Both
// are walked once per system-info pass.

export const OID = {
  hrProcessorLoad:           "1.3.6.1.2.1.25.3.3.1.2",
  hrStorageType:             "1.3.6.1.2.1.25.2.3.1.2",
  hrStorageDescr:            "1.3.6.1.2.1.25.2.3.1.3",
  hrStorageAllocationUnits:  "1.3.6.1.2.1.25.2.3.1.4",
  hrStorageSize:             "1.3.6.1.2.1.25.2.3.1.5",
  hrStorageUsed:             "1.3.6.1.2.1.25.2.3.1.6",
  hrStorageRam:              "1.3.6.1.2.1.25.2.1.2",
  hrStorageFixedDisk:        "1.3.6.1.2.1.25.2.1.4",
  hrStorageRemovableDisk:    "1.3.6.1.2.1.25.2.1.5",
  // IF-MIB
  ifDescr:        "1.3.6.1.2.1.2.2.1.2",
  ifType:         "1.3.6.1.2.1.2.2.1.3",
  ifSpeed:        "1.3.6.1.2.1.2.2.1.5",
  ifPhysAddress:  "1.3.6.1.2.1.2.2.1.6",
  ifAdminStatus:  "1.3.6.1.2.1.2.2.1.7",
  ifOperStatus:   "1.3.6.1.2.1.2.2.1.8",
  ifInOctets:     "1.3.6.1.2.1.2.2.1.10",
  ifInErrors:     "1.3.6.1.2.1.2.2.1.14",
  ifOutOctets:    "1.3.6.1.2.1.2.2.1.16",
  ifOutErrors:    "1.3.6.1.2.1.2.2.1.20",
  ifName:         "1.3.6.1.2.1.31.1.1.1.1",
  ifHCInOctets:   "1.3.6.1.2.1.31.1.1.1.6",
  ifHCOutOctets:  "1.3.6.1.2.1.31.1.1.1.10",
  ifHighSpeed:    "1.3.6.1.2.1.31.1.1.1.15",
  ifAlias:        "1.3.6.1.2.1.31.1.1.1.18",
  ipAdEntIfIndex: "1.3.6.1.2.1.4.20.1.2",
  // EtherLike-MIB (RFC 3635). Indexed by dot3StatsIndex, which the MIB
  // defines as the interface's ifIndex — so it joins IF-MIB rows directly.
  dot3StatsDuplexStatus: "1.3.6.1.2.1.10.7.2.1.19",
  // ENTITY-MIB / ENTITY-SENSOR-MIB (RFC 4133 / 3433). For temperature
  // sensors, entPhySensorType=8 (celsius). entPhySensorScale + Precision tell
  // us how to scale entPhySensorValue back to a real number; entPhysicalDescr
  // (indexed by the same physical-entity index) gives the operator-friendly
  // sensor name.
  // POWER-ETHERNET-MIB (RFC 3621) pethPsePortTable. INDEX is
  // { pethPsePortGroupIndex, pethPsePortIndex } and the MIB defines NO join
  // back to ifIndex, so rows are correlated by inference in utils/poePorts.ts.
  pethPsePortDetectionStatus:      "1.3.6.1.2.1.105.1.1.1.6",
  pethPsePortPowerClassifications: "1.3.6.1.2.1.105.1.1.1.10",
  entPhysicalDescr:       "1.3.6.1.2.1.47.1.1.1.1.2",
  // ENTITY-MIB entPhysicalTable inventory columns (RFC 4133). Walked on the
  // heavy cadence only — a transceiver's serial changes when someone swaps it,
  // not on a poll interval.
  // BRIDGE-MIB / Q-BRIDGE-MIB forwarding database (RFC 4188 / 4363).
  // dot1dBasePortIfIndex is the basePort -> ifIndex join BOTH FDB tables need:
  // dot1qTpFdbPort and dot1dTpFdbPort report a dot1dBasePort, never an ifIndex.
  // The address COLUMN is walked alongside them because the index is not
  // always the address: agents exist (FortiSwitch) that index the table by a
  // row number and publish the MAC only here. See resolveFdbIdentity.
  // IP-MIB neighbour cache (RFC 4293), bundled as `std:ip`. Two generations:
  // ipNetToPhysicalTable is current and covers IPv4 ARP *and* IPv6 NDP;
  // ipNetToMediaTable is the deprecated RFC 1213 predecessor, IPv4 only, kept
  // as the fallback for agents that never implemented the successor. On the
  // MODERN table the ifIndex and the address live only in the OID index (the
  // index objects are not-accessible), which is why utils/arpNeighbors.ts
  // decodes the suffix rather than walking them.
  ipNetToPhysicalPhysAddress: "1.3.6.1.2.1.4.35.1.4",
  ipNetToPhysicalLastUpdated: "1.3.6.1.2.1.4.35.1.5",
  ipNetToPhysicalType:        "1.3.6.1.2.1.4.35.1.6",
  ipNetToPhysicalState:       "1.3.6.1.2.1.4.35.1.7",
  ipNetToMediaPhysAddress:    "1.3.6.1.2.1.4.22.1.2",
  ipNetToMediaType:           "1.3.6.1.2.1.4.22.1.4",
  dot1dBasePortIfIndex:   "1.3.6.1.2.1.17.1.4.1.2",
  dot1qTpFdbAddress:      "1.3.6.1.2.1.17.7.1.2.2.1.1",
  dot1qTpFdbPort:         "1.3.6.1.2.1.17.7.1.2.2.1.2",
  dot1qTpFdbStatus:       "1.3.6.1.2.1.17.7.1.2.2.1.3",
  dot1dTpFdbAddress:      "1.3.6.1.2.1.17.4.3.1.1",
  dot1dTpFdbPort:         "1.3.6.1.2.1.17.4.3.1.2",
  dot1dTpFdbStatus:       "1.3.6.1.2.1.17.4.3.1.3",
  // Q-BRIDGE-MIB per-port VLAN config (RFC 4363). dot1qPvid is the port's
  // native/untagged VLAN, indexed by dot1dBasePort like the FDB tables above.
  // The two member columns are PortList BITMAPS indexed by VLAN id -- see
  // utils/portVlans.ts for the bit order, and for why the untagged column is
  // believed only when it is a strict subset of egress.
  dot1qPvid:                    "1.3.6.1.2.1.17.7.1.4.5.1.1",
  dot1qVlanStaticEgressPorts:   "1.3.6.1.2.1.17.7.1.4.3.1.2",
  dot1qVlanStaticUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.3.1.4",
  // dot1qVlanCurrentTable is the fallback for an agent that keeps its VLANs
  // out of the static table. Its INDEX is { dot1qVlanTimeMark, dot1qVlanIndex },
  // so the VLAN id is the LAST index component, not the whole suffix.
  dot1qVlanCurrentEgressPorts:   "1.3.6.1.2.1.17.7.1.4.2.1.4",
  dot1qVlanCurrentUntaggedPorts: "1.3.6.1.2.1.17.7.1.4.2.1.5",
  entPhysicalClass:       "1.3.6.1.2.1.47.1.1.1.1.5",
  entPhysicalName:        "1.3.6.1.2.1.47.1.1.1.1.7",
  entPhysicalHardwareRev: "1.3.6.1.2.1.47.1.1.1.1.8",
  entPhysicalFirmwareRev: "1.3.6.1.2.1.47.1.1.1.1.9",
  // The running OS on a chassis / supervisor row — read for the device's own
  // firmware (business rule 154, utils/snmpEntityIdentity.ts), never stored
  // per module.
  entPhysicalSoftwareRev: "1.3.6.1.2.1.47.1.1.1.1.10",
  entPhysicalSerialNum:   "1.3.6.1.2.1.47.1.1.1.1.11",
  entPhysicalMfgName:     "1.3.6.1.2.1.47.1.1.1.1.12",
  entPhysicalModelName:   "1.3.6.1.2.1.47.1.1.1.1.13",
  entPhysicalIsFRU:       "1.3.6.1.2.1.47.1.1.1.1.16",
  // POWER-ETHERNET-MIB pethMainPseTable (RFC 3621) - the UNIT-level PSE:
  // nominal budget, what is actually being delivered, and the PSE's own
  // health bit. Indexed by pethMainPseGroupIndex (one group on a standalone
  // switch, several on a stack/chassis). Note the extra pethMainPseObjects
  // level in the chain: pethObjects(.1) -> .3 -> Table(.1) -> Entry(.1).
  // FortiSwitch trunk -> physical port map (`fsTrunkMember`). A single
  // OctetString, NOT a table, hence the trailing .0 — the switch publishes its
  // whole trunk/member relationship in one string. See
  // utils/fortiswitchTrunkMap.ts for the format and why matching is a suffix
  // test rather than a reconstruction.
  fsTrunkMember:               "1.3.6.1.4.1.12356.106.3.1.0",
  // Same object one level deeper. The constant above shipped at this depth and
  // silently returned noSuchObject on every switch (a scalar GET resolves an
  // error varbind to null, so the whole trunk overlay just never ran); the walk
  // that caught it named `fsTrunkMember.0` at ...106.3.1.0. Kept as a fallback
  // GET rather than deleted because it is one extra round trip only on a switch
  // that answered nothing at the MIB-stated OID, and a firmware that publishes
  // it deeper cannot be ruled out from one device.
  fsTrunkMemberAlt:            "1.3.6.1.4.1.12356.106.3.1.1.0",
  pethMainPsePower:            "1.3.6.1.2.1.105.1.3.1.1.2",
  pethMainPseOperStatus:       "1.3.6.1.2.1.105.1.3.1.1.3",
  pethMainPseConsumptionPower: "1.3.6.1.2.1.105.1.3.1.1.4",
  entPhySensorType:       "1.3.6.1.2.1.99.1.1.1.1",
  entPhySensorScale:      "1.3.6.1.2.1.99.1.1.1.2",
  entPhySensorPrecision:  "1.3.6.1.2.1.99.1.1.1.3",
  entPhySensorValue:      "1.3.6.1.2.1.99.1.1.1.4",
  entPhySensorOperStatus: "1.3.6.1.2.1.99.1.1.1.5",
  // Textual unit label. RFC 3433's type enum has no dBm member, so this is the
  // only place a device can declare that a reading is optical power.
  entPhySensorUnitsDisplay: "1.3.6.1.2.1.99.1.1.1.6",
  // FORTINET-FORTIGATE-MIB::fgHwSensorTable left this map in 2026-10 (business
  // rule 132): it is the Fortinet profile's sensor-table row now, three symbol
  // NAMES resolved from the uploaded MIB (vendorTelemetryProfiles →
  // FORTIGATE_SENSOR_COLUMNS). Branch-class FortiGates (40F/60F/61F/91G/101F)
  // still depend on it — they implement neither ENTITY-SENSOR-MIB nor the
  // FortiOS REST sensor-info endpoint.
  // LLDP-MIB (RFC 4957). lldpLocPortTable maps localPortNum → ifName/alias so
  // we can stitch lldpRemTable rows back to a real interface. lldpRemTable is
  // indexed by (timeMark, localPortNum, remIndex); we only care about the
  // last two halves, so callers strip the leading timeMark when keying. The
  // management-addr table is indexed by (timeMark, localPortNum, remIndex,
  // addrSubtype, addrLen, addr...) — same dance.
  lldpLocPortIdSubtype:    "1.0.8802.1.1.2.1.3.7.1.2",
  lldpLocPortId:           "1.0.8802.1.1.2.1.3.7.1.3",
  lldpLocPortDesc:         "1.0.8802.1.1.2.1.3.7.1.4",
  lldpRemChassisIdSubtype: "1.0.8802.1.1.2.1.4.1.1.4",
  lldpRemChassisId:        "1.0.8802.1.1.2.1.4.1.1.5",
  lldpRemPortIdSubtype:    "1.0.8802.1.1.2.1.4.1.1.6",
  lldpRemPortId:           "1.0.8802.1.1.2.1.4.1.1.7",
  lldpRemPortDesc:         "1.0.8802.1.1.2.1.4.1.1.8",
  lldpRemSysName:          "1.0.8802.1.1.2.1.4.1.1.9",
  lldpRemSysDesc:          "1.0.8802.1.1.2.1.4.1.1.10",
  lldpRemSysCapEnabled:    "1.0.8802.1.1.2.1.4.1.1.12",
  lldpRemManAddr:          "1.0.8802.1.1.2.1.4.2.1",
  // FORTINET-FORTIAP-MIB::fapStationTable — wireless clients connected to a
  // FortiAP. INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr } where the
  // MAC is encoded as length-prefixed 6 octets (SMIv2 default for OCTET
  // STRING in INDEX), so each row's suffix is 9 parts:
  //   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
  // collectWirelessStationsSnmp walks fapStaSSID as the discriminator
  // (every row has it set), then looks up the parallel columns by the
  // identical suffix.
  fapStaBSSID:        "1.3.6.1.4.1.12356.120.8.1.1.4",
  fapStaVlanId:       "1.3.6.1.4.1.12356.120.8.1.1.5",
  fapStaIpAddr:       "1.3.6.1.4.1.12356.120.8.1.1.6",
  fapStaSSID:         "1.3.6.1.4.1.12356.120.8.1.1.7",
  // FORTINET-FORTIAP-MIB::fapRadioTable (1.3.6.1.4.1.12356.120.4.1.1), INDEX =
  // { fapRadioIndex }. There is no band column, so we derive band per radio
  // from fapRadioType + fapRadioChannelOper (see utils/fortiapRadioBand) and
  // join it onto stations by radioId == fapRadioIndex.
  fapRadioType:        "1.3.6.1.4.1.12356.120.4.1.1.6",
  fapRadioChannelOper: "1.3.6.1.4.1.12356.120.4.1.1.14",
};

export function buildSnmpSession(host: string, config: Record<string, unknown>, timeoutMs?: number): any {
  const port = toNonNegativeInt(config.port, 161);
  const version = config.version === "v3" ? "v3" : "v2c";
  // Caller-supplied timeout (resolved from the per-stream tier hierarchy)
  // overrides the legacy floor — but only when positive. A 0 or negative
  // value would silently disable timeouts in net-snmp, so we treat anything
  // unreasonable as "use the floor".
  const effectiveTimeout = (typeof timeoutMs === "number" && timeoutMs > 0)
    ? timeoutMs
    : COLLECTOR_REQUEST_TIMEOUT_MS;
  // net-snmp defaults to "udp4", which cannot reach an IPv6 target — an asset
  // polled on its primary IPv6 (business rule 128) needs the udp6 socket.
  const transport = isIpv6Address(host) ? "udp6" : "udp4";
  if (version === "v2c") {
    return snmp.createSession(host, String(config.community || ""), {
      port,
      transport,
      version: snmp.Version2c,
      timeout: effectiveTimeout,
      retries: 0,
    });
  }
  const securityLevel = config.securityLevel === "noAuthNoPriv"
    ? snmp.SecurityLevel.noAuthNoPriv
    : config.securityLevel === "authNoPriv"
      ? snmp.SecurityLevel.authNoPriv
      : snmp.SecurityLevel.authPriv;
  const user: any = { name: String(config.username || ""), level: securityLevel };
  if (securityLevel !== snmp.SecurityLevel.noAuthNoPriv) {
    user.authProtocol = mapSnmpAuthProtocol(config.authProtocol);
    user.authKey      = String(config.authKey || "");
  }
  if (securityLevel === snmp.SecurityLevel.authPriv) {
    user.privProtocol = mapSnmpPrivProtocol(config.privProtocol);
    user.privKey      = String(config.privKey || "");
  }
  return snmp.createV3Session(host, user, {
    port,
    transport,
    version: snmp.Version3,
    timeout: effectiveTimeout,
    retries: 0,
  });
}

/**
 * A broken agent returned an OID that doesn't lexicographically follow the
 * previous one — net-snmp's walk would re-anchor on it and spin forever
 * (seen in the field: ControlByWeb X-4xx echoes the queried OID back on
 * GETBULK). 502 because the device answered, just wrongly.
 */
export function walkLoopError(baseOid: string, prevOid: string, oid: string): AppError {
  return new AppError(
    502,
    `SNMP walk of ${baseOid} aborted: agent returned a non-increasing OID (${oid} after ${prevOid}) — ` +
    `the device's SNMP agent is stuck in a GETNEXT/GETBULK loop instead of advancing. ` +
    // No "try SNMP v1" here: buildSnmpSession opens v2c for every non-v3
    // credential, so that advice could not work.
    `A device firmware update is the usual fix.`,
  );
}

/**
 * Walk an OID subtree and return varbinds keyed by the index suffix that
 * follows `baseOid.`. Stops once `maxRows` rows have been collected, or
 * rejects if the agent stops advancing (walk loop).
 *
 * `maxRows` defaults to SNMP_WALK_MAX, which is sized for ifTable-shaped
 * walks. The forwarding-database walks pass their own (larger) cap: a switch
 * with more MACs than SNMP_WALK_MAX would otherwise be truncated here,
 * SILENTLY and below the truncation warning MAC_TABLE_ROW_CAP exists to
 * raise — and a partial FDB makes the per-port MAC counts, and any topology
 * inference drawn from them, quietly wrong.
 */
export function snmpWalk(session: any, baseOid: string, maxRows: number = SNMP_WALK_MAX): Promise<Map<string, any>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, any>();
    const prefix = baseOid + ".";
    const guard = makeOidMonotonicGuard();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(out);
    };
    try {
      session.subtree(
        baseOid,
        20, // maxRepetitions
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (snmp.isVarbindError(vb)) continue;
            if (typeof vb.oid !== "string") continue;
            // Loop guard runs BEFORE the prefix filter: a broken agent that
            // echoes `baseOid` itself never matches `prefix`, so `out` never
            // grows and the SNMP_WALK_MAX cap alone would never trip — the
            // walk would spin forever holding the per-host SNMP gate.
            if (!guard.advance(vb.oid)) {
              finish(walkLoopError(baseOid, guard.last()!, vb.oid));
              return true; // stop the underlying net-snmp walk
            }
            if (!vb.oid.startsWith(prefix)) continue;
            const suffix = vb.oid.slice(prefix.length);
            out.set(suffix, vb.value);
            if (out.size >= maxRows) {
              finish();
              return true;
            }
          }
        },
        (err?: Error) => finish(err),
      );
    } catch (err: any) {
      finish(err);
    }
  });
}

export function snmpVbToString(v: unknown): string {
  if (v == null) return "";
  if (Buffer.isBuffer(v)) return v.toString("utf8").replace(/\u0000+$/, "");
  return String(v);
}

/**
 * Decode a varbind value to a number, or null when the device said nothing.
 *
 * **An unanswered OID is null, never 0.** `snmpGetScalar` resolves `null` for
 * an error varbind (noSuchObject / noSuchInstance / endOfMibView), and the
 * `Number(v)` tail below reads `Number(null)` as a perfectly finite 0 — so a
 * scalar the device does not publish decoded as a confident zero. That cost a
 * FortiSwitch model whose fsSysCpuUsage / fsSysMemUsage do not sit at
 * ...12356.106.4.1.{2,3}.0 its entire CPU & Memory graph: both series read a
 * flat 0.0% forever, and because 0 is not null the HOST-RESOURCES-MIB fallback
 * in `collectTelemetrySnmp` never ran either, so nothing ever corrected it
 * (prod 2026-08-31, FortiSwitchRugged-112D-POE). Same invariant as business
 * rule 24's alarm bit: a source that publishes no value must never have its
 * absence mapped to 0.
 *
 * An EMPTY value gets the same answer for the same reason — an empty OCTET
 * STRING arrives as a zero-length Buffer, and `Number("")` is also 0.
 *
 * A Buffer longer than 8 bytes still falls through to the string coercion,
 * which is how an agent that publishes a wide counter as a decimal OCTET
 * STRING decodes.
 */
export function snmpVbToNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return null;
    if (v.length <= 8) {
      let n = 0n;
      for (const b of v) n = (n << 8n) | BigInt(b);
      return Number(n);
    }
  }
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function snmpMacFromBuffer(v: unknown): string | null {
  if (!Buffer.isBuffer(v) || v.length !== 6) return null;
  return Array.from(v).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export async function withSnmpSession<T>(host: string, config: Record<string, unknown>, fn: (s: any) => Promise<T>, timeoutMs?: number, gateWaitTimeoutMs?: number): Promise<T> {
  // Route every heavy SNMP collector (telemetry / systemInfo / LLDP overlay
  // / operator snmp-walk) through the per-host SNMP gate so a heavy walk
  // doesn't overlap with the cheap response-time probe on the same agent.
  // probeSnmp (which builds its own session for the sysUpTime get) also
  // acquires the same gate — both paths key on host:port so they FIFO.
  const port = toNonNegativeInt(config.port, 161);
  return withSnmpGate(host, port, async () => {
    const session = buildSnmpSession(host, config, timeoutMs);
    // net-snmp emits 'error' rather than throwing for socket/listener errors;
    // attach a no-op listener so a stray error doesn't kill the process. The
    // walk itself will still propagate the error through its callback.
    session.on?.("error", () => {});
    try {
      return await fn(session);
    } finally {
      try { session.close?.(); } catch {}
    }
  }, gateWaitTimeoutMs);
}

// Single-OID GET (instance .0). Returns the varbind value or null.
export function snmpGetScalar(session: any, oid: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = oid.endsWith(".0") ? oid : oid + ".0";
    try {
      session.get([target], (err: Error | null, varbinds: any[]) => {
        if (err) return reject(err);
        const vb = varbinds?.[0];
        if (!vb || snmp.isVarbindError(vb)) return resolve(null);
        resolve(vb.value);
      });
    } catch (err: any) {
      reject(err);
    }
  });
}

/**
 * Targeted multi-OID GET. Backs the wire-level filtered fast cadence: pulls
 * exactly the column values we need at known ifIndex / hrStorageIndex slots
 * instead of walking entire IF-MIB / hrStorage subtrees. Chunked to
 * SNMP_MULTI_GET_BATCH OIDs per request because most agents enforce a per-PDU
 * varbind limit (anywhere from ~50 to ~100 depending on vendor); 40 is safely
 * below the lowest commonly-seen cap.
 *
 * Returns a Map keyed by the input OID with the varbind value (or null on
 * varbindError / noSuchInstance — same as snmpGetScalar). Errors from the
 * SNMP layer (timeout, connection failure) reject the promise.
 */
const SNMP_MULTI_GET_BATCH = 40;

export function snmpMultiGet(session: any, oids: string[]): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, unknown>();
    if (oids.length === 0) return resolve(out);
    // Dedup + preserve order. Useful for callers that build OID lists across
    // many resolution steps and may accidentally repeat.
    const uniqueOids = Array.from(new Set(oids));
    const batches = chunkArray(uniqueOids, SNMP_MULTI_GET_BATCH);
    let remaining = batches.length;
    let aborted = false;
    const fail = (err: Error) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    };
    for (const batch of batches) {
      try {
        session.get(batch, (err: Error | null, varbinds: any[]) => {
          if (aborted) return;
          if (err) return fail(err);
          for (let i = 0; i < batch.length; i++) {
            const vb = varbinds?.[i];
            if (!vb || snmp.isVarbindError(vb)) {
              out.set(batch[i] as string, null);
            } else {
              out.set(batch[i] as string, vb.value);
            }
          }
          remaining -= 1;
          if (remaining === 0) resolve(out);
        });
      } catch (err: any) {
        return fail(err);
      }
    }
  });
}
