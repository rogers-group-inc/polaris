/**
 * src/services/monitoring/snmpCollectors.ts — the SNMP collectors (CQ-B061, moved verbatim from monitoringService.ts): the raw
 * walk the Device Query tab uses, telemetry (CPU / memory), HOST-RESOURCES and vendor
 * helpers, hardware sensors, interfaces, LLDP, the fast filtered pass and PoE
 * (POWER-ETHERNET-MIB). monitoringService.ts re-exports the public names.
 */

import { trimTrailing } from "../../utils/trimTrailing.js";
import * as snmp from "net-snmp";
import { prisma } from "../../db.js";
import { pickInterfaceAddresses } from "../../utils/interfaceAddress.js";
import { IP_ADDRESS_IF_INDEX_OID, IP_ADDRESS_TYPE_OID, addressesByIfIndexFromIpAddressTable, addressesByIfIndexFromIpAddrTable } from "../../utils/snmpIpAddressTable.js";
import { applyTransform } from "../../utils/symbolTransforms.js";
import { makeOidMonotonicGuard } from "../../utils/oidCompare.js";
import { SYS_OIDS, scalarInstanceOid, pickScalar } from "../../utils/snmpIdentity.js";
import { parseVendorSysDescr, type SysDescrDetail } from "../../utils/snmpDescrIdentity.js";
import { buildFcInventory, FC_ERROR_COLUMNS, FC_SYMBOLS, IFTYPE_FIBRE_CHANNEL, wwnFromBytes, type FcErrorCounters, type FcLoginRow, type FcPortRow } from "../../utils/fibreChannel.js";
import { snmpSelfIdentity, hasSelfIdentity, type EntityIdentityRow, type SnmpSelfIdentity } from "../../utils/snmpEntityIdentity.js";
import { logger } from "../../utils/logger.js";
import type { ApRadioSample, ApVapSample } from "../../utils/fortiapMonitorRow.js";
import { FAP_RADIO_OID, FAP_VAP_OID, decodeRadioMode, decodeChannelWidth, decodeRadioType, parseStationInfoCount, parseVapSuffix } from "../../utils/fortiapRadioSnmp.js";
import { deriveRadioBand } from "../../utils/fortiapRadioBand.js";
import { resolveOidSync, ensureRegistryLoaded, type ResolveScope } from "../oidRegistry.js";
import { deriveDiskBytes, type VendorTelemetryProfile } from "../vendorTelemetryProfiles.js";
import { pickDbProfile, type ProfileSubject } from "../profileResolver.js";
import { sensorTableRows, classifyEntitySensor, entityOperStatusToAlarm, entityTypeColumnTrusted, pseOperStatusToAlarm, unitsDisplayLooksOptical } from "../../utils/hardwareSensors.js";
import { attributeSfpSensors, sfpSensorName, type EntitySensorLayoutRow, type SfpAttribution } from "../../utils/sfpOptics.js";
import { poeClassLabel, poeIfNameByIndex, poeStatusLabel, poeWalkOutcome } from "../../utils/poePorts.js";
import { entityPhysicalClassLabel, entityPhysicalIsInventory } from "../../utils/hardwareSensors.js";
import { dot3DuplexLabel, ifStatusLabel, snmpIfTypeLabel } from "../../utils/ifMib.js";
import { basePortToIfName, fdbStatusIsUsable, fdbStatusLabel, resolveFdbIdentity, type FdbEntry } from "../../utils/macForwarding.js";
import { buildArpNeighbors, type ArpNeighborEntry } from "../../utils/arpNeighbors.js";
import { decodePortList, derivePortVlans, isVlanId, type PortVlanConfig, type VlanMembership } from "../../utils/portVlans.js";
import { matchTrunkPeer, parseTrunkPortMap, trunkMemberMap, type TrunkPortEntry } from "../../utils/fortiswitchTrunkMap.js";
import { type TelemetrySample, type InterfaceSample, type StorageSample, type HardwareSensorSample, type LldpNeighborSample, type WirelessStationSample, type PhysicalEntitySample, type SystemInfoSample } from "./types.js";
import { startPhase, clampPct } from "./common.js";
import { OID, walkLoopError, snmpWalk, snmpVbToString, snmpVbToNumber, snmpMacFromBuffer, withSnmpSession, snmpGetScalar, snmpMultiGet } from "./snmpCore.js";
import { overlayFortiswitchTrunkMembers } from "./fortiswitchTrunks.js";
import { getLldpAssetMatchIndex } from "./lldpMatchIndex.js";

interface SnmpWalkRow {
  oid: string;
  type: string;
  value: string;
}

export interface SnmpWalkResult {
  rows: SnmpWalkRow[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Operator-facing snmpwalk for the asset details SNMP Walk tab.
 *
 * Unlike the internal `snmpWalk()` above (which keys results by index suffix
 * and discards type info), this returns the full OID, the symbolic ASN.1 type
 * name (Counter32, OctetString, OID, ...), and a printable value. Hard-capped
 * at SNMP_WALK_HARD_MAX rows so an accidental walk of a huge subtree on a
 * busy device can't run away.
 */
const SNMP_WALK_HARD_MAX = 5000;

// Gate-wait budget for operator walks. The walk tab's client-side countdown
// aborts the request at 60s, so let the walk wait up to 50s for the per-host
// gate (vs. the collectors' 30s fail-fast default) — a walk queued behind a
// long telemetry/systemInfo scrape on the same device gets the whole
// countdown window to start instead of dying at 30s with a gate timeout.
const SNMP_WALK_GATE_WAIT_MS = 50_000;

function snmpTypeName(t: unknown): string {
  if (typeof t !== "number") return "Unknown";
  return (snmp.ObjectType as Record<number, string>)[t] || `Type(${t})`;
}

function snmpVarbindToPrintable(vb: { type: number; value: unknown }): string {
  const t = vb.type;
  const v = vb.value;
  if (v == null) return "";
  // OctetString: try utf8, fall back to hex when it isn't printable.
  if (Buffer.isBuffer(v)) {
    if (t === snmp.ObjectType.IpAddress && v.length === 4) {
      return `${v[0]}.${v[1]}.${v[2]}.${v[3]}`;
    }
    const text = v.toString("utf8");
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return trimTrailing(text, " ");
    return v.toString("hex").match(/.{1,2}/g)?.join(" ").toUpperCase() || "";
  }
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

export async function snmpWalkRaw(
  host: string,
  config: Record<string, unknown>,
  baseOid: string,
  maxRows: number,
): Promise<SnmpWalkResult> {
  const cap = Math.max(1, Math.min(maxRows | 0, SNMP_WALK_HARD_MAX));
  const start = Date.now();
  return await withSnmpSession(host, config, (session) => {
    return new Promise<SnmpWalkResult>((resolve, reject) => {
      const rows: SnmpWalkRow[] = [];
      const guard = makeOidMonotonicGuard();
      let truncated = false;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ rows, truncated, durationMs: Date.now() - start });
      };
      try {
        session.subtree(
          baseOid,
          20, // maxRepetitions
          (varbinds: any[]) => {
            for (const vb of varbinds) {
              if (snmp.isVarbindError(vb)) continue;
              if (typeof vb.oid !== "string") continue;
              if (!guard.advance(vb.oid)) {
                finish(walkLoopError(baseOid, guard.last()!, vb.oid));
                return true; // stop the underlying net-snmp walk
              }
              rows.push({
                oid: vb.oid,
                type: snmpTypeName(vb.type),
                value: snmpVarbindToPrintable(vb),
              });
              if (rows.length >= cap) {
                truncated = true;
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
  }, undefined, SNMP_WALK_GATE_WAIT_MS);
}

// Vendor-profile selection lives in profileResolver.ts (Phase 4 of uniform
// SNMP): `pickDbProfile` is imported above, and reads the operator's
// ManufacturerProfile rows ALONE — the hardcoded VENDOR_TELEMETRY_PROFILES
// constant is no longer consulted on this path.

/**
 * The identity `pickDbProfile` reads for one asset: its own manufacturer, OS,
 * model and type — nothing else (business rule 173).
 *
 * A per-stream MIB pin used to override the manufacturer and model here, so
 * an uploaded MIB chosen on CPU/Memory or Hardware Sensors silently switched
 * the asset into that MIB's manufacturer profile, while the same dropdown on
 * every other stream did nothing at all. The asset's Manufacturer field (and
 * a profile's "Also applies when", rule 131) is the one way to choose a
 * profile now; the pins are retired.
 */
export function profileSubjectFor(args: {
  manufacturer?: string | null;
  model?:        string | null;
  os?:           string | null;
  assetType?:    string | null;
}): ProfileSubject {
  return {
    manufacturer: args.manufacturer ?? null,
    os:           args.os ?? null,
    model:        args.model ?? null,
    assetType:    args.assetType ?? null,
    mibModule:    null,
  };
}

export async function collectTelemetrySnmp(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  assetType?: string | null,
): Promise<TelemetrySample> {
  // Make sure the symbol table is populated before we try to resolve any
  // vendor symbols. ensureRegistryLoaded short-circuits after the first call.
  await ensureRegistryLoaded();

  const profile = pickDbProfile(profileSubjectFor({ manufacturer, model, os, assetType }));
  // Scope uses the asset's manufacturer/model first so symbol resolution
  // through oidRegistry picks up device-specific MIB overrides. The governing
  // profile's manufacturer is the second scope (business rule 131): a profile
  // reached through `matchPattern` has its MIBs uploaded under its own name,
  // not the asset's.
  const scope: ResolveScope = { manufacturer, model, profileManufacturer: profile?.profileManufacturer };

  return await withSnmpSession(host, config, async (session) => {
    let cpuPct: number | null = null;
    let memUsedBytes: number | null = null;
    let memTotalBytes: number | null = null;
    let memPct: number | null = null;

    // ── CPU ──
    // Try the vendor profile first if one matches and its symbol resolves.
    // If the vendor query yields nothing (MIB not uploaded, or device doesn't
    // expose the OID), fall back to HOST-RESOURCES-MIB so a stock SNMP host
    // still gets coverage.
    if (profile?.cpu) {
      cpuPct = await collectCpuVendor(session, profile, profile.cpu, scope).catch(() => null);
    }
    if (cpuPct == null) {
      cpuPct = await collectCpuHostResources(session).catch(() => null);
    }

    // ── Memory ──
    if (profile?.memory) {
      const m = await collectMemoryVendor(session, profile, profile.memory, scope).catch(() => null);
      if (m) {
        memUsedBytes  = m.memUsedBytes  ?? memUsedBytes;
        memTotalBytes = m.memTotalBytes ?? memTotalBytes;
        memPct        = m.memPct        ?? memPct;
      }
    }
    if (memUsedBytes == null && memPct == null) {
      const hrm = await collectMemoryHostResources(session).catch(() => null);
      if (hrm) {
        memUsedBytes  = hrm.memUsedBytes;
        memTotalBytes = hrm.memTotalBytes;
        memPct        = hrm.memPct;
      }
    } else if (memUsedBytes != null && memTotalBytes != null && memTotalBytes > 0 && memPct == null) {
      memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
    }

    // Hardware sensors are collected separately by `collectHardwareSensors`,
    // which dispatches on temperaturePolling instead of cpuMemoryPolling so an
    // operator can run CPU/memory over REST and hardware sensors over SNMP (the
    // common branch-class FortiGate workaround for an unreliable
    // /api/v2/monitor/system/sensor-info).
    return { cpuPct, memPct, memUsedBytes, memTotalBytes };
  }, timeoutMs);
}

// ─── Vendor + HOST-RESOURCES-MIB helpers ──────────────────────────────────

async function collectCpuHostResources(session: any): Promise<number | null> {
  const cpuRows = await snmpWalk(session, OID.hrProcessorLoad);
  const vals: number[] = [];
  for (const v of cpuRows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryHostResources(
  session: any,
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  const types = await snmpWalk(session, OID.hrStorageType);
  const ramIdx = [...types.entries()].find(([, v]) => snmpVbToString(v) === OID.hrStorageRam)?.[0];
  if (!ramIdx) return null;
  // One GET of the RAM row's three cells. These are single instances, so they
  // must be GOT, not walked: a subtree walk returns only OIDs strictly BELOW its
  // base (snmpWalk keeps `base + "."`), so walking `hrStorageSize.<idx>` can
  // never return `hrStorageSize.<idx>` itself. Until 2026-11-12 this walked
  // them, read key "", and every host without a vendor memory profile (net-snmp
  // on Linux, Windows SNMP) reported no memory at all.
  const unitsOid = OID.hrStorageAllocationUnits + "." + ramIdx;
  const sizeOid  = OID.hrStorageSize            + "." + ramIdx;
  const usedOid  = OID.hrStorageUsed            + "." + ramIdx;
  const cells = await snmpMultiGet(session, [unitsOid, sizeOid, usedOid]).catch(() => new Map<string, unknown>());
  const u = snmpVbToNumber(cells.get(unitsOid)) ?? 1;
  const s = snmpVbToNumber(cells.get(sizeOid));
  const ud = snmpVbToNumber(cells.get(usedOid));
  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;
  if (s != null) memTotalBytes = s * u;
  if (ud != null) memUsedBytes = ud * u;
  if (memTotalBytes && memTotalBytes > 0 && memUsedBytes != null) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  }
  return { memUsedBytes, memTotalBytes, memPct };
}

// Resolve a vendor symbolic OID and emit a single GET on the `.0` instance,
// or a subtree walk + average / sum depending on the profile mode.
async function collectCpuVendor(
  session: any,
  profile: VendorTelemetryProfile,
  cpu: NonNullable<VendorTelemetryProfile["cpu"]>,
  scope: ResolveScope,
): Promise<number | null> {
  const oid = resolveOidSync(cpu.symbol, scope);
  if (!oid) {
    logger.debug({ vendor: profile.vendor, symbol: cpu.symbol, scope }, "vendor CPU symbol unresolved — upload its MIB to enable");
    return null;
  }
  if (cpu.mode === "scalar") {
    const v = await snmpGetScalar(session, oid);
    const n = snmpVbToNumber(v);
    return n != null ? clampPct(n) : null;
  }
  // walk-avg
  const rows = await snmpWalk(session, oid);
  const vals: number[] = [];
  for (const v of rows.values()) {
    const n = snmpVbToNumber(v);
    if (n != null) vals.push(n);
  }
  if (vals.length === 0) return null;
  return clampPct(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function collectMemoryVendor(
  session: any,
  profile: VendorTelemetryProfile,
  mem: NonNullable<VendorTelemetryProfile["memory"]>,
  scope: ResolveScope,
): Promise<{ memUsedBytes: number | null; memTotalBytes: number | null; memPct: number | null } | null> {
  // Prefer byte-form pairs (used + free or used + total). When both are
  // missing fall back to a single percent symbol.
  const usedOid  = mem.usedBytesSymbol  ? resolveOidSync(mem.usedBytesSymbol,  scope) : null;
  const freeOid  = mem.freeBytesSymbol  ? resolveOidSync(mem.freeBytesSymbol,  scope) : null;
  const totalOid = mem.totalBytesSymbol ? resolveOidSync(mem.totalBytesSymbol, scope) : null;
  const pctOid   = mem.pctSymbol        ? resolveOidSync(mem.pctSymbol,        scope) : null;

  const sumWalk = async (oid: string): Promise<number | null> => {
    if (mem.walkSubtree) {
      const rows = await snmpWalk(session, oid);
      let total = 0;
      let any = false;
      for (const v of rows.values()) {
        const n = snmpVbToNumber(v);
        if (n != null) { total += n; any = true; }
      }
      return any ? total : null;
    }
    const v = await snmpGetScalar(session, oid);
    return snmpVbToNumber(v);
  };

  let memUsedBytes: number | null = null;
  let memTotalBytes: number | null = null;
  let memPct: number | null = null;

  if (usedOid) memUsedBytes = await sumWalk(usedOid).catch(() => null);
  if (totalOid) {
    memTotalBytes = await sumWalk(totalOid).catch(() => null);
  } else if (freeOid && memUsedBytes != null) {
    const free = await sumWalk(freeOid).catch(() => null);
    if (free != null) memTotalBytes = memUsedBytes + free;
  }

  if (memUsedBytes != null && memTotalBytes && memTotalBytes > 0) {
    memPct = clampPct((memUsedBytes / memTotalBytes) * 100);
  } else if (pctOid) {
    const p = await sumWalk(pctOid).catch(() => null);
    if (p != null) {
      // Walked-then-summed percentages (e.g. Juniper jnxOperatingBuffer
      // averaged across operating entities) are technically a sum, but the
      // operator-meaningful value is the average. Re-divide by row count.
      if (mem.walkSubtree && pctOid) {
        const rows = await snmpWalk(session, pctOid).catch(() => new Map());
        const count = [...rows.values()].filter((v) => snmpVbToNumber(v) != null).length;
        memPct = count > 0 ? clampPct(p / count) : null;
      } else {
        memPct = clampPct(p);
      }
    }
  }

  if (memUsedBytes == null && memTotalBytes == null && memPct == null) return null;
  return { memUsedBytes, memTotalBytes, memPct };
}

/**
 * Unit-level PoE from pethMainPseTable, as hardware-sensor rows.
 *
 * Emitted as sensors rather than given their own table because that is exactly
 * what they are - per-device readings with a name and a unit - and it means
 * charts, rollups, retention and BOTH automation metrics work with no new
 * code: `hwSensorValue` for "budget nearly exhausted" and `hwSensorAlarm` for
 * the PSE's own faulty bit.
 *
 * `pethMainPseUsageThreshold` is deliberately not collected: it is a
 * configured threshold, not a reading, and storing config as a time series
 * would just be a flat line.
 *
 * Rows are suffixed with the group index only when a device reports more than
 * one PSE, so a standalone switch gets stable, clean sensor names - the name
 * is the automation dimension and the rollup series key, so it must not churn.
 */
async function collectPoePseSnmp(session: any): Promise<HardwareSensorSample[]> {
  const [powers, consumptions, statuses] = await Promise.all([
    snmpWalk(session, OID.pethMainPsePower).catch(() => new Map()),
    snmpWalk(session, OID.pethMainPseConsumptionPower).catch(() => new Map()),
    snmpWalk(session, OID.pethMainPseOperStatus).catch(() => new Map()),
  ]);
  const indexes = new Set<string>([...powers.keys(), ...consumptions.keys(), ...statuses.keys()]);
  if (indexes.size === 0) return [];

  const multi = indexes.size > 1;
  const out: HardwareSensorSample[] = [];
  for (const idx of indexes) {
    const suffix = multi ? ` (PSE ${idx})` : "";
    const alarmStatus = pseOperStatusToAlarm(snmpVbToNumber(statuses.get(idx)));
    const budget = snmpVbToNumber(powers.get(idx));
    const used   = snmpVbToNumber(consumptions.get(idx));
    // The alarm rides the consumption row so a PSE fault surfaces on the
    // reading an operator actually watches, rather than on a static budget.
    if (used != null) {
      out.push({ sensorName: `PoE Power Consumption${suffix}`, sensorClass: "poe", value: used, unit: "W", alarmStatus });
    }
    if (budget != null) {
      out.push({ sensorName: `PoE Power Budget${suffix}`, sensorClass: "poe", value: budget, unit: "W", alarmStatus: null });
    }
  }
  return out;
}

/**
 * Hardware sensors, plus unit-level PoE appended for any device that has a PSE.
 *
 * The append lives in a wrapper because the core collector has three separate
 * return paths (profile sensor table / ENTITY-SENSOR / vendor scalar) and PoE
 * is orthogonal to which of them produced the sensor rows - a FortiSwitch takes
 * the ENTITY-SENSOR path and still has a PSE.
 */
export async function collectHardwareSensorsSnmp(
  session: any,
  profile?: VendorTelemetryProfile | null,
  scope?: ResolveScope,
): Promise<HardwareSensorSample[]> {
  const [sensors, pse] = await Promise.all([
    collectHardwareSensorsSnmpCore(session, profile, scope),
    collectPoePseSnmp(session).catch(() => [] as HardwareSensorSample[]),
  ]);
  return pse.length > 0 ? [...sensors, ...pse] : sensors;
}

async function collectHardwareSensorsSnmpCore(
  session: any,
  profile?: VendorTelemetryProfile | null,
  scope?: ResolveScope,
): Promise<HardwareSensorSample[]> {
  // 1. The profile's sensor table, when its Hardware Sensors row is a `table`
  //    (business rule 132): the columns the row names, walked and joined. On a
  //    FortiGate that is fgHwSensorTable (temperature + fan + voltage + power +
  //    disk + alarm), the comprehensive source there. An empty walk — a
  //    FortiSwitch or FortiAP that inherited the Fortinet row, or a symbol
  //    whose MIB isn't uploaded — falls through to the standard paths below.
  if (profile?.temperature?.mode === "table") {
    const tableRows = await collectSensorTableSnmp(session, profile, profile.temperature, scope ?? {});
    if (tableRows.length > 0) return tableRows;
  }

  // 2. ENTITY-SENSOR-MIB (RFC 3433). Standard table on non-Fortinet gear (and
  //    FortiSwitch). Every class the table reports is surfaced — temperature,
  //    fan, voltage, transceiver bias current and optical power — plus the
  //    agent's own per-sensor oper status as the alarm bit.
  //
  //    This used to keep celsius rows only, drop any row whose descr mentioned
  //    sfp/fan/voltage/bias, and drop any row whose oper status was not ok.
  //    On a FortiSwitch those three filters discarded the entire transceiver
  //    picture — the DDM readings were already on the wire.
  const [types, values, scales, precisions, opers, descrs, unitsDisplays] = await Promise.all([
    snmpWalk(session, OID.entPhySensorType).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorValue).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorScale).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorPrecision).catch(() => new Map()),
    snmpWalk(session, OID.entPhySensorOperStatus).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
    // The only reliable dBm signal — RFC 3433's type enum cannot express
    // optical power, so vendors declare the real unit here.
    snmpWalk(session, OID.entPhySensorUnitsDisplay).catch(() => new Map()),
  ]);
  const out: HardwareSensorSample[] = [];
  // Decided once per table, not per row: a device reporting a single type code
  // across every sensor (FortiSwitchOS stamps celsius on all of them) is
  // defaulting rather than describing, so names classify instead.
  const typeColumnTrusted = entityTypeColumnTrusted(
    [...types.values()]
      .map((v) => snmpVbToNumber(v))
      .filter((n): n is number => n != null),
  );
  // Transceiver readings published as anonymous groups of five get their port
  // (business rule 143). IF-MIB is walked only when the table holds a dBm row
  // at all, so a device with no optics pays nothing for this.
  const layoutRows: EntitySensorLayoutRow[] = [...types.entries()].map(([idx, typeRaw]) => ({
    index:        Number(idx),
    typeCode:     snmpVbToNumber(typeRaw),
    unitsDisplay: snmpVbToString(unitsDisplays.get(idx)) || null,
  })).filter((r) => Number.isInteger(r.index));
  let sfpByIndex = new Map<number, SfpAttribution>();
  if (layoutRows.some((r) => unitsDisplayLooksOptical(r.unitsDisplay))) {
    const ifNames = await snmpWalk(session, OID.ifName).catch(() => new Map());
    sfpByIndex = attributeSfpSensors(layoutRows, [...ifNames.values()].map((v) => snmpVbToString(v)));
  }
  for (const [idx, typeRaw] of types.entries()) {
    const t = snmpVbToNumber(typeRaw);
    const oper = snmpVbToNumber(opers.get(idx));
    const descr = snmpVbToString(descrs.get(idx));
    const unitsDisplay = snmpVbToString(unitsDisplays.get(idx));
    const { sensorClass, unit } = classifyEntitySensor({
      typeCode: t,
      unitsDisplay,
      descr,
      typeColumnTrusted,
    });
    const sfp = sfpByIndex.get(Number(idx));
    const raw = snmpVbToNumber(values.get(idx));
    const scale = snmpVbToNumber(scales.get(idx));   // SI prefix code
    const prec  = snmpVbToNumber(precisions.get(idx)); // decimal-point shift
    // A broken or unreadable sensor keeps its row with a null value: the row IS
    // the fault signal, and dropping it would also strip the alarm status that
    // makes the fault alertable. `value` is nullable for exactly this case.
    const scaled = raw != null && oper !== 2 && oper !== 3
      ? scaleEntitySensor(raw, scale, prec)
      : null;
    out.push({
      // An attributed transceiver reading is named for its port and role; the
      // agent's own descr for these rows is positional and unreliable.
      sensorName:  sfp ? sfpSensorName(sfp.ifName, sfp.role) : (descr || `sensor-${idx}`),
      sensorClass,
      // Six decimals, not two: bias current is stored in BASE amperes, and
      // rounding 8.98 mA to the hundredth of an amp stored 0.01.
      value:       scaled != null && Number.isFinite(scaled) ? Math.round(scaled * 1e6) / 1e6 : null,
      unit,
      alarmStatus: entityOperStatusToAlarm(oper),
      ...(sfp ? { ifName: sfp.ifName } : {}),
    });
  }
  if (out.length > 0) return out;

  // 3. Profile-driven scalar symbol. Used by vendors whose hardware publishes a
  //    single Celsius scalar rather than a sensor table — currently the FortiAP
  //    (fapTemperature @ 12356.120.3.44). The row's transform scales a raw
  //    integer into °C first (tenths_to_units for a DISPLAY-HINT "d-1"
  //    sensor); the resolver only ever passes one METRIC_ROW_TRANSFORMS allows.
  if (profile?.temperature?.mode === "scalar") {
    const tempOid = resolveOidSync(profile.temperature.symbol, scope ?? {});
    if (tempOid) {
      const v = await snmpGetScalar(session, tempOid).catch(() => null);
      const n = applyTransform(snmpVbToNumber(v), profile.temperature.transform);
      if (n != null && Number.isFinite(n)) {
        out.push({
          sensorName:  profile.temperature.sensorName ?? "System",
          sensorClass: "temperature",
          value:       Math.round(n * 10) / 10,
          unit:        "°C",
          alarmStatus: null,
        });
      }
    } else {
      logger.debug(
        { vendor: profile.vendor, symbol: profile.temperature.symbol, scope },
        "vendor hardware-sensor symbol unresolved — upload its MIB to enable",
      );
    }
  }
  return out;
}

// A profile's declarative sensor table (business rule 132). The row's symbol is
// the VALUE column; `columns` names the siblings — a name column, an alarm
// column with its mapping, an optional fixed class and scale. Each column is a
// symbol resolved at the asset's scope then the profile's (rule 131), walked
// once, stringified, and joined on the shared index by `sensorTableRows`. A
// value column that does not resolve walks nothing: the MIB is not uploaded,
// and the profile page says so. An optional column that does not resolve
// costs only its own facts (unnamed rows, no alarm status).
async function collectSensorTableSnmp(
  session: any,
  profile: VendorTelemetryProfile,
  query: NonNullable<VendorTelemetryProfile["temperature"]>,
  scope: ResolveScope,
): Promise<HardwareSensorSample[]> {
  const columns = query.columns ?? { nameSymbol: null, alarmSymbol: null, alarmMap: null, sensorClass: null, transform: null };
  const valueOid = resolveOidSync(query.symbol, scope);
  if (!valueOid) {
    logger.debug({ vendor: profile.vendor, symbol: query.symbol, scope }, "sensor table value column unresolved — upload its MIB to enable");
    return [];
  }
  const nameOid  = columns.nameSymbol  ? resolveOidSync(columns.nameSymbol,  scope) : null;
  const alarmOid = columns.alarmSymbol ? resolveOidSync(columns.alarmSymbol, scope) : null;
  const asStrings = (m: Map<string, unknown>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of m.entries()) out.set(k, snmpVbToString(v));
    return out;
  };
  const [values, names, alarms] = await Promise.all([
    snmpWalk(session, valueOid).catch(() => new Map()),
    nameOid  ? snmpWalk(session, nameOid).catch(() => new Map())  : Promise.resolve(null),
    alarmOid ? snmpWalk(session, alarmOid).catch(() => new Map()) : Promise.resolve(null),
  ]);
  return sensorTableRows({
    values:  asStrings(values),
    names:   names ? asStrings(names) : null,
    alarms:  alarms ? asStrings(alarms) : null,
    columns,
  });
}

// ─── PoE (POWER-ETHERNET-MIB) ──────────────────────────────────────────────
//
// Negative cache for devices with no PSE. Most of a fleet is not PoE-capable,
// and both the heavy AND the per-minute fast cadence would otherwise pay two
// empty column walks per tick per device forever. One empty result marks the
// target for the TTL; a PoE switch keeps paying two small walks a minute,
// which is what makes a PoE fault alertable at the fast cadence instead of the
// heavy one.
//
// Deliberately NOT cached positively: the readings are the whole point, and
// they change whenever a powered device is plugged, unplugged or faults.
const POE_ABSENT_TTL_MS = 30 * 60_000;

const POE_ABSENT_MAX    = 4000;

const poeAbsentCache    = new Map<string, number>();

/**
 * Walk pethPsePortTable and return per-ifName PoE state, or an empty map when
 * the device has no PSE. Correlation to interfaces is inference — see
 * utils/poePorts.ts — so an unresolvable row is dropped, never guessed.
 *
 * `ifNameByIndex` is supplied by the caller because both cadences have already
 * walked ifName/ifDescr for their own purposes; re-walking here would double
 * the cost of the thing this cache exists to keep cheap.
 */
async function collectPoePortsSnmp(
  session: any,
  cacheKey: string | null,
  ifNameByIndex: ReadonlyMap<string, string>,
): Promise<Map<string, { poeStatus: string | null; poeClass: string | null }>> {
  const out = new Map<string, { poeStatus: string | null; poeClass: string | null }>();
  if (ifNameByIndex.size === 0) return out;

  const now = Date.now();
  if (cacheKey) {
    const absentAt = poeAbsentCache.get(cacheKey);
    if (absentAt != null && now - absentAt < POE_ABSENT_TTL_MS) return out;
  }

  // A walk that ERRORED and a walk that answered with NO ROWS mean opposite
  // things. Collapsing both into an empty Map (the old `.catch(() => new Map())`
  // on the status column) is what let ONE timed-out walk write the absent-cache
  // and blank PoE on a healthy switch for the next POE_ABSENT_TTL_MS — half an
  // hour of `poeStatus: null` on every sample it writes, which is long enough
  // for a live PoE alert to be retired as a vanished dimension and re-raised as
  // a new one. Only an ANSWER with no rows is evidence the device has no PSE.
  const [statuses, classes] = await Promise.all([
    snmpWalk(session, OID.pethPsePortDetectionStatus).then((m) => m, () => null),
    snmpWalk(session, OID.pethPsePortPowerClassifications).catch(() => new Map()),
  ]);

  // Unreadable this tick: no rows, and deliberately NO cache write — the next
  // tick asks again rather than assuming the PSE went away. Written as a bare
  // null test rather than only through poeWalkOutcome so `statuses` narrows for
  // the `.get()` calls below.
  if (statuses === null) return out;
  if (poeWalkOutcome(statuses) === "no-pse") {
    if (cacheKey) {
      if (poeAbsentCache.size >= POE_ABSENT_MAX) poeAbsentCache.clear();
      poeAbsentCache.set(cacheKey, now);
    }
    return out;
  }
  if (cacheKey) poeAbsentCache.delete(cacheKey);

  const ifNameBySuffix = poeIfNameByIndex([...statuses.keys()], ifNameByIndex);
  for (const [suffix, ifName] of ifNameBySuffix.entries()) {
    out.set(ifName, {
      poeStatus: poeStatusLabel(snmpVbToNumber(statuses.get(suffix))),
      poeClass:  poeClassLabel(snmpVbToNumber(classes.get(suffix))),
    });
  }
  return out;
}

// Apply ENTITY-SENSOR-MIB scale + precision to a raw integer reading. Scale is
// the SI-prefix code (1=10^-24 ... 9=10^0 ... 17=10^24); precision is a signed
// shift of the decimal point. Both default to "no scaling" when omitted.
function scaleEntitySensor(raw: number, scale: number | null, precision: number | null): number {
  const sExp = scale != null ? (scale - 9) * 3 : 0;
  const pExp = precision != null ? -precision : 0;
  return raw * Math.pow(10, sExp) * Math.pow(10, pExp);
}

/**
 * Walk ENTITY-MIB entPhysicalTable for field-replaceable hardware — the
 * transceivers, PSUs and fan trays an operator can actually swap.
 *
 * Returns [] when the device publishes no entPhysicalTable at all; the caller
 * distinguishes that from "queried and found nothing" by whether it called at
 * all (undefined vs []). Nine columns, all on the heavy cadence only: a serial
 * number changes when someone pulls a module, not on a poll interval.
 *
 * No interface correlation is attempted: see the ifName note at the row
 * build below.
 */
const PHYSICAL_ENTITY_ROW_CAP = 500;

async function collectPhysicalEntitiesSnmp(
  session: any,
): Promise<{ rows: PhysicalEntitySample[]; identityRows: EntityIdentityRow[] }> {
  const [classes, descrs, names, hwRevs, fwRevs, serials, mfgs, models, isFrus, swRevs] = await Promise.all([
    snmpWalk(session, OID.entPhysicalClass).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalDescr).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalHardwareRev).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalFirmwareRev).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalSerialNum).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalMfgName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalModelName).catch(() => new Map()),
    snmpWalk(session, OID.entPhysicalIsFRU).catch(() => new Map()),
    // The tenth column, for the device's own firmware (business rule 154).
    // Same heavy cadence as the other nine.
    snmpWalk(session, OID.entPhysicalSoftwareRev).catch(() => new Map()),
  ]);
  if (classes.size === 0) return { rows: [], identityRows: [] };

  const out: PhysicalEntitySample[] = [];
  // The rows the device's own identity is read from: the chassis (which the
  // inventory filter below drops, being no part anyone swaps) and the modules
  // (whose agreed software revision stands in for a blank chassis cell).
  // Kept apart from `out` and never persisted — utils/snmpEntityIdentity.ts.
  const identityRows: EntityIdentityRow[] = [];
  let dropped = 0;
  const str = (m: Map<string, unknown>, idx: string): string | null => {
    const v = snmpVbToString(m.get(idx)).trim();
    return v ? v : null;
  };

  for (const [idx, classRaw] of classes.entries()) {
    const entIndex = Number(idx);
    if (!Number.isFinite(entIndex)) continue;
    const entClass  = entityPhysicalClassLabel(snmpVbToNumber(classRaw));
    const serialNum = str(serials, idx);
    const modelName = str(models, idx);
    if ((entClass === "chassis" || entClass === "module") && identityRows.length < PHYSICAL_ENTITY_ROW_CAP) {
      identityRows.push({
        entIndex,
        entClass,
        serialNum,
        mfgName:     str(mfgs, idx),
        modelName,
        softwareRev: str(swRevs, idx),
      });
    }
    // RFC 4133 TruthValue: true(1) / false(2).
    const isFru     = snmpVbToNumber(isFrus.get(idx)) === 1;
    if (!entityPhysicalIsInventory({ entClass, isFru, serialNum, modelName })) continue;

    if (out.length >= PHYSICAL_ENTITY_ROW_CAP) { dropped++; continue; }
    out.push({
      entIndex,
      entClass,
      descr:       str(descrs, idx),
      name:        str(names, idx),
      hardwareRev: str(hwRevs, idx),
      firmwareRev: str(fwRevs, idx),
      serialNum,
      mfgName:     str(mfgs, idx),
      modelName,
      isFru,
      // Deliberately NOT populated. Correlating a module to an interface by
      // entPhysicalIndex == ifIndex is the same equivalence the FortiSwitch
      // sensor annotation was reverted for (97e54fd2): right often enough to
      // look correct, silently wrong the rest of the time, and an operator
      // reading "SFP (port5)" cannot tell a real correlation from a
      // coincidence. The honest chain is entPhysicalContainedIn ->
      // entAliasMappingIdentifier (RFC 4133), which needs a real switch to
      // validate against; the column stays nullable and waits for it.
      ifName: null,
    });
  }
  // Loudly, not silently: a truncated inventory that looks complete is worse
  // than one an operator knows is truncated.
  if (dropped > 0) {
    logger.warn({ dropped, cap: PHYSICAL_ENTITY_ROW_CAP }, "entPhysicalTable inventory truncated");
  }
  return { rows: out, identityRows };
}

/**
 * A fibre-channel switch's ports and the devices logged into them (business
 * rule 159, utils/fibreChannel.ts).
 *
 * Every table is named by its MIB SYMBOL and resolved at the asset's scope
 * through the registry (`resolveOidSync`), like every vendor object Polaris
 * reads: the OIDs come from the CISCO-FC-FE-MIB / CISCO-NS-MIB /
 * CISCO-FDMI-MIB the operator uploaded, never from a literal in code.
 *
 * Returns undefined — "not an FC switch, leave stored rows alone" — when
 * CISCO-FC-FE-MIB does not resolve at this scope (no query at all), or when
 * the first error column answers nothing (one GETNEXT). Only a device that
 * answered walks the rest, in parallel; a table whose MIB is missing, or a
 * walk that fails, reads as empty and never fails the pass.
 */
async function collectFibreChannelSnmp(
  session: any,
  ifNameByIndex: ReadonlyMap<string, string>,
  scope: ResolveScope,
): Promise<{ ports: FcPortRow[]; logins: FcLoginRow[] } | undefined> {
  await ensureRegistryLoaded();
  const oid = (symbol: string) => resolveOidSync(symbol, scope);
  const [firstField, firstSymbol] = FC_ERROR_COLUMNS[0];
  const probeOid = oid(firstSymbol);
  if (!probeOid) return undefined;
  const probe = await snmpWalk(session, probeOid).catch(() => new Map());
  if (probe.size === 0) return undefined;

  const empty = () => new Map();
  const walk = (symbol: string) => {
    const o = oid(symbol);
    return o ? snmpWalk(session, o).catch(empty) : Promise.resolve(new Map());
  };
  const otherCols = FC_ERROR_COLUMNS.slice(1);
  const [errCols, loginPort, loginNode, nsPort, nsSym, fdmiHost] = await Promise.all([
    Promise.all(otherCols.map(([, symbol]) => walk(symbol))),
    walk(FC_SYMBOLS.loginPortWwn),
    walk(FC_SYMBOLS.loginNodeWwn),
    walk(FC_SYMBOLS.nsPortWwn),
    walk(FC_SYMBOLS.nsSymbolic),
    walk(FC_SYMBOLS.fdmiHostName),
  ]);

  const numbers = (m: Map<string, unknown>) =>
    new Map([...m].map(([k, v]) => [k, snmpVbToNumber(v)] as [string, number | null]));
  const bytes = (m: Map<string, unknown>) =>
    new Map([...m].map(([k, v]) => [k, Buffer.isBuffer(v) ? [...v] : null] as [string, number[] | null]));
  const texts = (m: Map<string, unknown>) =>
    new Map([...m].map(([k, v]) => [k, snmpVbToString(v) || null] as [string, string | null]));

  const errors = new Map<keyof FcErrorCounters, Map<string, number | null>>([[firstField, numbers(probe)]]);
  otherCols.forEach(([field], i) => errors.set(field, numbers(errCols[i])));

  return buildFcInventory(
    {
      errors,
      loginPortWwn: bytes(loginPort),
      loginNodeWwn: bytes(loginNode),
      nsPortWwn: bytes(nsPort),
      nsSymbolic: texts(nsSym),
      fdmiHostName: texts(fdmiHost),
    },
    ifNameByIndex,
  );
}

/**
 * An FC interface's own port WWN from IF-MIB (business rule 159a): an MDS
 * reports it as the interface's ifPhysAddress, 8 bytes where a MAC is 6. Only
 * for ifType fibreChannel(56), so an 8-byte address on anything else (an
 * EUI-64 on a FireWire / IPoIB port) is never called a WWN.
 */
export function snmpWwnFromPhysAddress(ifTypeVb: unknown, physVb: unknown): string | null {
  if (snmpVbToNumber(ifTypeVb) !== IFTYPE_FIBRE_CHANNEL || !Buffer.isBuffer(physVb)) return null;
  return wwnFromBytes([...physVb]);
}

/** Copy each FC port's counters onto the interface row of the same name. */
export function attachFcErrors(interfaces: InterfaceSample[], ports: readonly FcPortRow[]): void {
  const byName = new Map<string, FcErrorCounters>();
  for (const p of ports) if (p.ifName) byName.set(p.ifName, p.errorCounters);
  if (byName.size === 0) return;
  for (const iface of interfaces) {
    const c = byName.get(iface.ifName);
    if (c) iface.fcErrors = c;
  }
}

/**
 * The fast pinned pass's FC counters (business rule 159a): one GET of the
 * fcIfErrorTable columns at each pinned FC port's ifIndex. Only ports whose
 * ifType is fibreChannel are asked, so a device with no FC port — and an MDS's
 * Ethernet mgmt port — costs nothing. Its own PDU, like duplex: an SNMPv1 agent
 * answers a GET naming one missing instance with noSuchName for the whole PDU,
 * which must cost the FC counters, never the IF-MIB ones already read.
 * Empty when CISCO-FC-FE-MIB does not resolve at this scope.
 */
async function collectFcErrorsByIndex(
  session: any,
  fcIndexes: readonly string[],
  scope: ResolveScope,
): Promise<Map<string, FcErrorCounters>> {
  const out = new Map<string, FcErrorCounters>();
  if (fcIndexes.length === 0) return out;
  await ensureRegistryLoaded();
  const cols = FC_ERROR_COLUMNS
    .map(([field, symbol]) => [field, resolveOidSync(symbol, scope)] as const)
    .filter((c): c is readonly [keyof FcErrorCounters, string] => !!c[1]);
  if (cols.length === 0) return out;
  const oids = fcIndexes.flatMap((idx) => cols.map(([, o]) => `${o}.${idx}`));
  const vbs = await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>());
  for (const idx of fcIndexes) {
    const counters = {} as FcErrorCounters;
    let any = false;
    for (const [field] of FC_ERROR_COLUMNS) counters[field] = null;
    for (const [field, o] of cols) {
      const v = snmpVbToNumber(vbs.get(`${o}.${idx}`));
      counters[field] = v;
      if (v != null) any = true;
    }
    if (any) out.set(idx, counters);
  }
  return out;
}

/**
 * Full-replace an asset's hardware inventory. Same delete-replace shape as
 * persistLldpNeighbors / persistMclagPeers: current state, no history.
 *
 * `firstSeen` is preserved across scrapes for a module that is still present,
 * so "this SFP has been in this port since March" survives; a swapped module
 * (same slot, new serial) correctly resets it.
 */
export async function persistPhysicalEntities(assetId: string, rows: PhysicalEntitySample[]): Promise<void> {
  const existing = await prisma.assetPhysicalEntity.findMany({
    where: { assetId },
    select: { entIndex: true, serialNum: true, firstSeen: true },
  });
  const prior = new Map(existing.map((e) => [e.entIndex, e]));
  const now = new Date();

  await prisma.$transaction([
    prisma.assetPhysicalEntity.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetPhysicalEntity.createMany({
          data: rows.map((r) => {
            const was = prior.get(r.entIndex);
            const sameModule = was && (was.serialNum ?? null) === (r.serialNum ?? null);
            return { assetId, ...r, firstSeen: sameModule ? was!.firstSeen : now, lastSeen: now };
          }),
        })]
      : []),
  ]);
}

/**
 * Cap per asset. A single 48-port access switch routinely holds a few thousand
 * FDB entries; a distribution switch can hold tens of thousands. The cap keeps
 * one device from dominating a scrape and the table, and truncation is WARNED
 * rather than silent because a partial table makes the per-port MAC counts --
 * and therefore any uplink inference drawn from them -- quietly wrong.
 */
const MAC_TABLE_ROW_CAP = 4000;

/**
 * Walk `dot1dBasePortIfIndex` and fold it into dot1dBasePort -> ifName.
 *
 * Both switch-class walks that follow report a dot1dBasePort rather than an
 * ifIndex -- the forwarding database and the Q-BRIDGE VLAN bitmaps -- and both
 * need this same join, so it is walked once per pass and handed to each. The
 * join is defined by the MIB (unlike the PoE correlation), so it is reliable;
 * what is not optional is performing it, since attributing a row to whatever
 * interface sits at that number is reliably wrong wherever the two numbering
 * schemes differ.
 */
async function collectBasePortIfNames(
  session: any,
  ifNameByIndex: ReadonlyMap<string, string>,
): Promise<Map<number, string>> {
  const basePortWalk = await snmpWalk(session, OID.dot1dBasePortIfIndex).catch(() => new Map());
  const basePortToIfIndex = new Map<string, number>();
  for (const [basePort, vb] of basePortWalk.entries()) {
    const idx = snmpVbToNumber(vb);
    if (idx != null) basePortToIfIndex.set(basePort, idx);
  }
  return basePortToIfName(basePortToIfIndex, ifNameByIndex);
}

/**
 * Walk the switch forwarding database.
 *
 * Prefers Q-BRIDGE-MIB `dot1qTpFdbTable`, which a VLAN-aware switch populates
 * and which carries the VLAN in its index; falls back to BRIDGE-MIB
 * `dot1dTpFdbTable` for switches that only answer the older table (those rows
 * have no VLAN dimension at all, hence a null vlanId rather than a guess).
 *
 * Returns undefined when the device answers neither table, so the caller can
 * distinguish "not a bridge" from "a bridge with an empty table" — the same
 * undefined-preserves / []-wipes contract LLDP uses.
 */
/**
 * The device's IP neighbour cache over SNMP (IP-MIB, bundled as `std:ip`).
 *
 * Modern table first, deprecated table as fallback -- the dot1qTpFdbTable ->
 * dot1dTpFdbTable shape. The modern one is preferred for two reasons beyond
 * being current: it carries IPv6 neighbour-discovery entries, which the FortiOS
 * REST `/monitor/network/arp` endpoint does not expose at all, and its
 * `LastUpdated` column is what makes a real per-entry age possible.
 *
 * Decoding is pure and lives in utils/arpNeighbors.ts. Returns `undefined`
 * when nothing decoded -- a router always has neighbours, so zero rows is
 * far more likely "this agent does not implement IP-MIB" than "the cache is
 * empty", and the writer accumulates rather than replacing, so preserving
 * costs nothing.
 */
async function collectArpNeighborsSnmp(
  session: any,
  ifNameByIndex: Map<number, string>,
): Promise<ArpNeighborEntry[] | undefined> {
  // sysUpTime is needed to turn ipNetToPhysicalLastUpdated (a stamp, not an
  // age) into seconds. Walked rather than GET so this uses the same helper as
  // everything else here; the scalar returns a single row keyed "0".
  const sysUpTimeTicks = await snmpWalk(session, "1.3.6.1.2.1.1.3")
    .then((m) => { for (const v of m.values()) return snmpVbToNumber(v); return null; })
    .catch(() => null);

  const physAddress = await snmpWalk(session, OID.ipNetToPhysicalPhysAddress).catch(() => new Map());
  if (physAddress.size > 0) {
    const [type, state, lastUpdated] = await Promise.all([
      snmpWalk(session, OID.ipNetToPhysicalType).catch(() => new Map()),
      snmpWalk(session, OID.ipNetToPhysicalState).catch(() => new Map()),
      snmpWalk(session, OID.ipNetToPhysicalLastUpdated).catch(() => new Map()),
    ]);
    const rows = buildArpNeighbors({
      physAddress, type, state, lastUpdated, sysUpTimeTicks,
      ifNameByIndex, variant: "physical", toNumber: snmpVbToNumber,
    });
    if (rows.length > 0) return rows;
    // The table answered and every row was dropped -- worth saying out loud,
    // the same way the FDB collector reports an undecodable walk, because the
    // silent version looks exactly like a gate with no neighbours.
    logger.warn(
      { phase: "arp.snmp.undecodable", table: "ipNetToPhysical", walked: physAddress.size },
      "IP-MIB neighbour walk answered but no row survived decoding",
    );
  }

  // Deprecated table. No state column and no LastUpdated, so no age.
  const mediaAddress = await snmpWalk(session, OID.ipNetToMediaPhysAddress).catch(() => new Map());
  if (mediaAddress.size === 0) return undefined;
  const mediaType = await snmpWalk(session, OID.ipNetToMediaType).catch(() => new Map());
  const rows = buildArpNeighbors({
    physAddress: mediaAddress, type: mediaType,
    ifNameByIndex, variant: "media", toNumber: snmpVbToNumber,
  });
  if (rows.length === 0) {
    logger.warn(
      { phase: "arp.snmp.undecodable", table: "ipNetToMedia", walked: mediaAddress.size },
      "IP-MIB neighbour walk answered but no row survived decoding",
    );
    return undefined;
  }
  return rows;
}

async function collectMacTableSnmp(
  session: any,
  ifNameByBasePort: ReadonlyMap<number, string>,
): Promise<FdbEntry[] | undefined> {
  // Each table is walked as a TRIPLE: port, status, and the address column.
  // The address column is not redundant with the index — see resolveFdbIdentity
  // in utils/macForwarding.ts for the agent that indexes by row number.
  let ports = await snmpWalk(session, OID.dot1qTpFdbPort, MAC_TABLE_ROW_CAP).catch(() => new Map());
  let statuses = await snmpWalk(session, OID.dot1qTpFdbStatus, MAC_TABLE_ROW_CAP).catch(() => new Map());
  let addresses = await snmpWalk(session, OID.dot1qTpFdbAddress, MAC_TABLE_ROW_CAP).catch(() => new Map());
  if (ports.size === 0) {
    ports = await snmpWalk(session, OID.dot1dTpFdbPort, MAC_TABLE_ROW_CAP).catch(() => new Map());
    statuses = await snmpWalk(session, OID.dot1dTpFdbStatus, MAC_TABLE_ROW_CAP).catch(() => new Map());
    addresses = await snmpWalk(session, OID.dot1dTpFdbAddress, MAC_TABLE_ROW_CAP).catch(() => new Map());
  }
  if (ports.size === 0) return undefined;

  const out: FdbEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let undecodable = 0;
  let unusableStatus = 0;
  for (const [suffix, portVb] of ports.entries()) {
    const parsed = resolveFdbIdentity(suffix, addresses.get(suffix));
    if (!parsed) { undecodable++; continue; }
    const status = fdbStatusLabel(snmpVbToNumber(statuses.get(suffix)));
    if (!fdbStatusIsUsable(status)) { unusableStatus++; continue; }

    // The unique key is (asset, mac, vlan) and NULLs compare distinct in a
    // Postgres unique index, so de-duplicate here rather than relying on it.
    const key = `${parsed.macAddress}|${parsed.fdbId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (out.length >= MAC_TABLE_ROW_CAP) { dropped++; continue; }
    const basePort = snmpVbToNumber(portVb);
    out.push({
      macAddress: parsed.macAddress,
      vlanId:     parsed.fdbId,
      basePort:   basePort ?? null,
      // Null when the join failed; basePort is retained above so the entry is
      // still identifiable instead of appearing to belong to no port.
      ifName:     basePort != null ? (ifNameByBasePort.get(basePort) ?? null) : null,
      status,
    });
  }
  if (dropped > 0 || ports.size >= MAC_TABLE_ROW_CAP) {
    logger.warn({ dropped, rows: ports.size, cap: MAC_TABLE_ROW_CAP }, "MAC forwarding table truncated");
  }
  // A table that answered but decoded to NOTHING is a read failure, not an
  // empty forwarding database, so preserve the stored rows rather than
  // wiping them — and say so, loudly. Silence here is what made an
  // index-shape mismatch look like a switch with nothing plugged into it.
  if (out.length === 0) {
    logger.warn(
      { rows: ports.size, undecodable, unusableStatus },
      "MAC forwarding table answered but no entries decoded",
    );
    return undefined;
  }
  return out;
}

/**
 * Walk per-port VLAN membership out of Q-BRIDGE-MIB.
 *
 * The native VLAN comes from `dot1qPvid` (one value per port, stated directly).
 * The tagged set is derived from the per-VLAN member bitmaps, with the caveat
 * that the untagged column is often an unusable copy of the egress column --
 * `derivePortVlans` in utils/portVlans.ts holds that decision table.
 *
 * Returns keyed by ifName so the caller can join it onto the interface list
 * without knowing about dot1dBasePorts, and `undefined` -- not an empty map --
 * when the device answers `dot1qPvid` with nothing, which is how an agent that
 * omits the q-bridge subtree entirely reads. The caller leaves the interface
 * rows untouched in that case, so the controller-CMDB overlay that runs
 * afterwards is still the one deciding.
 */
async function collectPortVlansSnmp(
  session: any,
  ifNameByBasePort: ReadonlyMap<number, string>,
): Promise<Map<string, PortVlanConfig> | undefined> {
  // The PVID walk is the gate: it is one row per port and every VLAN-aware
  // agent answers it, so an empty result means the member bitmaps are not
  // worth two more walks.
  const pvidWalk = await snmpWalk(session, OID.dot1qPvid).catch(() => new Map());
  if (pvidWalk.size === 0) return undefined;

  const pvidByBasePort = new Map<number, number>();
  for (const [basePortRaw, vb] of pvidWalk.entries()) {
    const basePort = Number(basePortRaw);
    const pvid = snmpVbToNumber(vb);
    if (!Number.isInteger(basePort) || pvid == null) continue;
    pvidByBasePort.set(basePort, pvid);
  }

  let [egressWalk, untaggedWalk] = await Promise.all([
    snmpWalk(session, OID.dot1qVlanStaticEgressPorts).catch(() => new Map()),
    snmpWalk(session, OID.dot1qVlanStaticUntaggedPorts).catch(() => new Map()),
  ]);
  // An agent that keeps its VLANs out of the static table still publishes the
  // current one. Only reached when static answered nothing, so the common case
  // pays for no extra walk -- the same answered-nothing fallback the
  // forwarding-database walk makes from Q-BRIDGE to BRIDGE-MIB.
  if (egressWalk.size === 0) {
    [egressWalk, untaggedWalk] = await Promise.all([
      snmpWalk(session, OID.dot1qVlanCurrentEgressPorts).catch(() => new Map()),
      snmpWalk(session, OID.dot1qVlanCurrentUntaggedPorts).catch(() => new Map()),
    ]);
  }
  const memberships: VlanMembership[] = [];
  for (const [suffix, egressVb] of egressWalk.entries()) {
    // The static table's suffix IS the VLAN id; the current table's is
    // `<timeMark>.<vlanId>`. Taking the last component reads both.
    const vlanId = Number(String(suffix).split(".").pop());
    if (!isVlanId(vlanId)) continue;
    memberships.push({
      vlanId,
      egress:   decodePortList(egressVb),
      untagged: decodePortList(untaggedWalk.get(suffix)),
    });
  }

  const byPort = derivePortVlans(pvidByBasePort, memberships);
  const out = new Map<string, PortVlanConfig>();
  let unjoined = 0;
  for (const [basePort, cfg] of byPort.entries()) {
    const ifName = ifNameByBasePort.get(basePort);
    if (!ifName) { unjoined++; continue; }
    out.set(ifName, cfg);
  }
  if (out.size === 0) {
    logger.warn(
      { pvidRows: pvidWalk.size, vlans: memberships.length, unjoined },
      "Q-BRIDGE port VLANs answered but none joined to an interface",
    );
    return undefined;
  }
  return out;
}

/**
 * Full-replace an asset's forwarding database. Delete-replace, like
 * persistLldpNeighbors — an FDB entry ages out on the switch in minutes, so
 * there is no history worth keeping.
 *
 * `matchedAssetId` resolves through the SAME cached MAC index LLDP matching
 * uses: at a few thousand rows per switch a per-row lookup would dominate the
 * write.
 */
/**
 * Full-replace an asset's trunk membership. Delete-replace like its siblings.
 *
 * Peer resolution is a SUFFIX match against asset serials, uniqueness-guarded:
 * an ambiguous tail stores NULL rather than attaching the trunk to the wrong
 * device. `firstSeen` survives a re-scrape so "this trunk has been on port23
 * since..." holds across the replace.
 */
export async function persistTrunkMembers(assetId: string, rows: TrunkPortEntry[]): Promise<void> {
  const now = new Date();
  const [existing, serialRows] = await Promise.all([
    prisma.assetTrunkMember.findMany({
      where: { assetId },
      select: { trunkName: true, localPort: true, firstSeen: true },
    }),
    // Only assets that HAVE a serial can be matched; the suffix test is over
    // this map, so keeping it tight keeps the scan small.
    prisma.asset.findMany({
      where: { serialNumber: { not: null } },
      select: { id: true, serialNumber: true },
    }),
  ]);
  const prior = new Map(existing.map((e) => [`${e.trunkName}|${e.localPort}`, e.firstSeen]));
  const serialToAssetId = new Map<string, string>();
  for (const a of serialRows) if (a.serialNumber) serialToAssetId.set(a.serialNumber, a.id);

  await prisma.$transaction([
    prisma.assetTrunkMember.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetTrunkMember.createMany({
          data: rows.map((r) => ({
            assetId,
            trunkName:      r.trunkName,
            localPort:      r.localPort,
            peerSerialTail: r.peerSerialTail,
            matchedAssetId: matchTrunkPeer(r.peerSerialTail, serialToAssetId),
            firstSeen: prior.get(`${r.trunkName}|${r.localPort}`) ?? now,
            lastSeen:  now,
          })),
        })]
      : []),
  ]);
}

export async function persistMacTable(assetId: string, rows: FdbEntry[]): Promise<void> {
  const index = await getLldpAssetMatchIndex();
  const now = new Date();
  const existing = await prisma.assetMacTableEntry.findMany({
    where: { assetId },
    select: { macAddress: true, vlanId: true, firstSeen: true },
  });
  const prior = new Map(existing.map((e) => [`${e.macAddress}|${e.vlanId ?? ""}`, e.firstSeen]));

  await prisma.$transaction([
    prisma.assetMacTableEntry.deleteMany({ where: { assetId } }),
    ...(rows.length > 0
      ? [prisma.assetMacTableEntry.createMany({
          data: rows.map((r) => ({
            assetId,
            macAddress: r.macAddress,
            vlanId:     r.vlanId,
            basePort:   r.basePort,
            ifName:     r.ifName,
            status:     r.status,
            matchedAssetId: index.byMac.get(r.macAddress) ?? null,
            // Preserved so "this device has been on this switch since..." holds
            // across the delete-replace.
            firstSeen: prior.get(`${r.macAddress}|${r.vlanId ?? ""}`) ?? now,
            lastSeen:  now,
          })),
        })]
      : []),
  ]);
}

/**
 * Vendor disk fallback — the storage half of a vendor telemetry profile.
 *
 * Runs when HOST-RESOURCES-MIB's hrStorageTable produced no disk rows, which
 * is every pass on a device whose agent doesn't implement HRM's storage view
 * (FortiSwitches, some access points). Reads whichever two of the used /
 * total / free scalars the profile names — the pair comes from the editable
 * Manufacturer Profile's Storage row when an operator set one, else from the
 * hardcoded profile — and completes the used/total pair via `deriveDiskBytes`.
 *
 * Returns null when the profile has no disk block, when neither OID resolves
 * (the MIB isn't uploaded), or when both readings came back empty. Both
 * callers treat null as "leave storage as it was", which is the same outcome
 * an HRM-empty device had before this path existed. Shared by
 * `collectSystemInfoSnmp` (the full heavy pass) and `collectStorageOnlySnmp`
 * (the dedicated storage cadence) so the two can't drift — they carried
 * byte-identical copies of this until 2026-08.
 */
export async function collectVendorDiskFallback(
  session: any,
  vendorProfile: VendorTelemetryProfile | null,
  vendorScope: ResolveScope,
): Promise<StorageSample | null> {
  const disk = vendorProfile?.disk;
  if (!disk) return null;
  try {
    await ensureRegistryLoaded();
    // Only the symbols this profile actually names are dialed — a used+free
    // profile must not GET a total OID it never declared.
    const oids = {
      used:  disk.usedBytesSymbol  ? resolveOidSync(disk.usedBytesSymbol,  vendorScope) : null,
      total: disk.totalBytesSymbol ? resolveOidSync(disk.totalBytesSymbol, vendorScope) : null,
      free:  disk.freeBytesSymbol  ? resolveOidSync(disk.freeBytesSymbol,  vendorScope) : null,
    };
    // Two resolved OIDs are the floor: one reading alone can't fill a
    // used/total pair, and the Storage table's whole point is the ratio.
    const resolvedCount = [oids.used, oids.total, oids.free].filter(Boolean).length;
    if (resolvedCount < 2) return null;
    const [usedVb, totVb, freeVb] = await Promise.all([
      oids.used  ? snmpGetScalar(session, oids.used).catch(()  => null) : Promise.resolve(null),
      oids.total ? snmpGetScalar(session, oids.total).catch(() => null) : Promise.resolve(null),
      oids.free  ? snmpGetScalar(session, oids.free).catch(()  => null) : Promise.resolve(null),
    ]);
    const { usedBytes, totalBytes } = deriveDiskBytes({
      used:  snmpVbToNumber(usedVb),
      total: snmpVbToNumber(totVb),
      free:  snmpVbToNumber(freeVb),
    });
    if (usedBytes == null && totalBytes == null) return null;
    return { mountPath: disk.mountPath || "system", usedBytes, totalBytes };
  } catch {
    return null;
  }
}

/**
 * Per host: did IP-MIB's ipAddressTable answer the last time it was walked?
 * Lets the FAST cadence skip the empty walk on a device that only has the
 * legacy ipAddrTable — every tick, at fleet scale, that would be a wasted
 * round trip per pinned asset. The heavy pass always re-probes (`probe`), so a
 * device that gains the table, or answered empty once, is re-learned on its
 * next full pass.
 */
const ipAddressTableAnswered = new Map<string, boolean>();

/**
 * An interface's addresses over SNMP, both families (business rule 126):
 * `ifIndex → [address…]` in walk order. ipAddressTable (RFC 4293 — IPv4 and
 * IPv6, with ipAddressType so only unicast rows count) first; the legacy
 * IPv4-only ipAddrTable when the device has none. Cost on a device with the
 * current table: two small walks (one varbind per ADDRESS, not per interface)
 * where there was one; on a legacy device, after its first full pass, the
 * same single walk as before.
 */
async function walkInterfaceAddressesSnmp(session: any, host: string, probe: boolean): Promise<Map<string, string[]>> {
  const toNums = (m: Map<string, unknown>) => new Map([...m].map(([k, v]) => [k, snmpVbToNumber(v)] as [string, number | null]));
  if (probe || ipAddressTableAnswered.get(host) !== false) {
    const [ifIdx, types] = await Promise.all([
      snmpWalk(session, IP_ADDRESS_IF_INDEX_OID).catch(() => new Map<string, unknown>()),
      snmpWalk(session, IP_ADDRESS_TYPE_OID).catch(() => new Map<string, unknown>()),
    ]);
    if (ifIdx.size > 0) {
      ipAddressTableAnswered.set(host, true);
      return addressesByIfIndexFromIpAddressTable(toNums(ifIdx), toNums(types));
    }
    ipAddressTableAnswered.set(host, false);
  }
  const legacy = await snmpWalk(session, OID.ipAdEntIfIndex).catch(() => new Map<string, unknown>());
  return addressesByIfIndexFromIpAddrTable(toNums(legacy));
}

/**
 * The MIB scope a vendor object resolves at for this asset: its own
 * manufacturer / model, then its governing profile's (business rule 131).
 * The same scope the full system-info pass reads the FC tables at, so the fast
 * pass cannot resolve them differently.
 */
export function snmpVendorScope(asset: {
  manufacturer?: string | null; model?: string | null; os?: string | null; assetType?: string | null;
}): ResolveScope {
  const profile = pickDbProfile({
    manufacturer: asset.manufacturer ?? null,
    os:           asset.os ?? null,
    model:        asset.model ?? null,
    assetType:    asset.assetType ?? null,
  });
  return { manufacturer: asset.manufacturer, model: asset.model, profileManufacturer: profile?.profileManufacturer };
}

/**
 * Read the covering manufacturer profile's identity rows — `model` and
 * `serial` (business rule 171) — off a device, for the probe path: an SNMP
 * asset whose only stream is Response Time (a UPS polled for power alone)
 * never runs the system-info pass that reads them otherwise.
 *
 * Its own session, and ONE OID PER GET: on SNMPv1 a single missing varbind
 * fails the whole PDU, and a profile row can name an object this model does
 * not publish (an APC PDU asked for `upsAdvIdentSerialNumber`). Each scalar
 * is asked for at its `.0` instance, then — only if that came back empty — at
 * the bare definition oid (the `pickScalar` rule; a row-suffixed symbol is
 * already an instance). Nothing to read → no session at all. Never throws.
 */
export async function readProfileIdentity(
  host: string,
  config: Record<string, unknown>,
  subject: ProfileSubject,
  timeoutMs?: number,
): Promise<{ model: string | null; serial: string | null }> {
  const none = { model: null, serial: null };
  try {
    await ensureRegistryLoaded();
    const profile = pickDbProfile(subject);
    if (!profile?.model && !profile?.serial) return none;
    const scope: ResolveScope = { manufacturer: subject.manufacturer, model: subject.model, profileManufacturer: profile.profileManufacturer };
    const modelOid  = profile.model  ? resolveOidSync(profile.model.symbol, scope)  : null;
    const serialOid = profile.serial ? resolveOidSync(profile.serial.symbol, scope) : null;
    if (!modelOid && !serialOid) return none;
    return await withSnmpSession(host, config, async (session) => {
      const getOne = async (oid: string): Promise<string> => {
        const vbs = await snmpMultiGet(session, [oid]).catch(() => new Map<string, unknown>());
        return snmpVbToString(vbs.get(oid)).trim();
      };
      const readScalar = async (oid: string | null): Promise<string> =>
        !oid ? "" : (await getOne(scalarInstanceOid(oid))) || (await getOne(oid));
      const rawModel  = await readScalar(modelOid);
      const rawSerial = await readScalar(serialOid);
      return {
        model:  rawModel && profile.model ? profile.model.parse(rawModel) : null,
        serial: rawSerial || null,
      };
    }, timeoutMs);
  } catch {
    return none;
  }
}

export async function collectSystemInfoSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    includeLldp?:  boolean;
    timeoutMs?:    number;
    /** Asset manufacturer — used to pick the vendor disk fallback when HRM returns no disks. */
    manufacturer?: string | null;
    /** Asset model — same fallback path. */
    model?:        string | null;
    /** Asset OS — same fallback path. */
    os?:           string | null;
    /** Asset type — drives the fapStationTable walk for FortiAPs. */
    assetType?:    string | null;
  } = {},
): Promise<SystemInfoSample> {
  // Vendor profile is read once up-front so the disk fallback (below) can
  // consult it without re-deriving. Cheap — the profile rows are in this
  // process's warm cache; ensureRegistryLoaded is called by the disk fallback
  // when it runs. No MIB pin here: this is the systemInfo stream, whose pin
  // the caller has already applied to the interfaces/storage walks.
  const vendorProfile = pickDbProfile({
    manufacturer: opts.manufacturer ?? null,
    os:           opts.os ?? null,
    model:        opts.model ?? null,
    assetType:    opts.assetType ?? null,
  });
  const vendorScope: ResolveScope = { manufacturer: opts.manufacturer, model: opts.model, profileManufacturer: vendorProfile?.profileManufacturer };

  return await withSnmpSession(host, config, async (session) => {
    // Storage: walk hrStorage and pick rows tagged as fixed/removable disk.
    const storage: StorageSample[] = [];
    const endStorage = startPhase("systeminfo.snmp.storage_walk");
    try {
      const types = await snmpWalk(session, OID.hrStorageType);
      const diskIdxs = [...types.entries()].filter(([, v]) => {
        const t = snmpVbToString(v);
        return t === OID.hrStorageFixedDisk || t === OID.hrStorageRemovableDisk;
      }).map(([k]) => k);
      if (diskIdxs.length > 0) {
        const [descrs, units, sizes, useds] = await Promise.all([
          snmpWalk(session, OID.hrStorageDescr).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageAllocationUnits).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageSize).catch(() => new Map()),
          snmpWalk(session, OID.hrStorageUsed).catch(() => new Map()),
        ]);
        for (const idx of diskIdxs) {
          const u = snmpVbToNumber(units.get(idx)) ?? 1;
          const s = snmpVbToNumber(sizes.get(idx));
          const ud = snmpVbToNumber(useds.get(idx));
          storage.push({
            mountPath:  snmpVbToString(descrs.get(idx)) || `disk-${idx}`,
            totalBytes: s != null  ? s * u  : null,
            usedBytes:  ud != null ? ud * u : null,
          });
        }
      }
    } catch { /* fall through; storage stays empty */ }
    endStorage({ disks: storage.length });

    // Vendor disk fallback: when HRM returned no disk rows (typical on
    // devices whose SNMP agents don't implement hrStorageTable — FortiSwitches,
    // some access points, etc.), consult the matched vendor profile for
    // proprietary used/total byte scalars and synthesize one StorageSample.
    if (storage.length === 0) {
      const vendorRow = await collectVendorDiskFallback(session, vendorProfile, vendorScope);
      if (vendorRow) storage.push(vendorRow);
    }

    // Vendor model identity: one scalar GET when the matched profile knows
    // where the device publishes its real model (FortiSwitch fsSysVersion —
    // discovery has no model source for managed switches, so this scrape is
    // the only path to the real hardware model). Best-effort; a null parse
    // (firmware-only string, empty value) leaves detectedModel unset so the
    // persist layer doesn't touch Asset.model.
    //
    // sysDescr rides along in the SAME multi-GET. A Discovery reads it once,
    // at adoption, so a camera upgraded a year later still reported the
    // firmware it shipped with (utils/snmpDescrIdentity.ts) — re-reading it
    // here is what keeps model + firmware current. Batched rather than a
    // second scalar GET so a device WITH a model profile pays exactly the one
    // round trip it already paid, and every other SNMP device pays one: at
    // 2000 assets on the ~10-minute system-info cadence that is ~3 varbinds a
    // second across the fleet, inside the session and the per-host gate this
    // pass already holds.
    let detectedModel: string | null = null;
    // The profile's `serial` row (business rule 171), read on its own GET below.
    let detectedSerial: string | null = null;
    let descrIdentity: SysDescrDetail | undefined;
    let sysDescrText: string | null = null;
    // sysName rides the same multi-GET (business rule 154): the device's own
    // name, for an asset no inventory source names.
    let sysNameText: string | null = null;
    let sysObjectIdText: string | null = null;
    try {
      // Registry load stays behind the model profile that needs it — sysDescr
      // is a fixed OID and every device without a profile is the common case.
      let modelOid: string | null = null;
      if (vendorProfile?.model || vendorProfile?.serial) await ensureRegistryLoaded();
      if (vendorProfile?.model) {
        modelOid = resolveOidSync(vendorProfile.model.symbol, vendorScope);
      }
      // The registry holds the symbol's DEFINITION oid: its `.0` instance
      // rides this batch, and pickScalar asks for the bare oid alone only if
      // that came back empty (utils/snmpIdentity.ts says why).
      // sysObjectID too (business rule 161): a vendor format whose fields
      // describe the card or the device depending on the product needs it.
      const oids = [SYS_OIDS.sysDescr, SYS_OIDS.sysName, SYS_OIDS.sysObjectID, ...(modelOid ? [scalarInstanceOid(modelOid)] : [])];
      const vbs = await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>());

      sysDescrText = snmpVbToString(vbs.get(SYS_OIDS.sysDescr)) || null;
      sysNameText = snmpVbToString(vbs.get(SYS_OIDS.sysName)) || null;
      sysObjectIdText = snmpVbToString(vbs.get(SYS_OIDS.sysObjectID)).trim() || null;
      descrIdentity = parseVendorSysDescr(sysDescrText ?? undefined, sysObjectIdText);

      if (modelOid && vendorProfile?.model) {
        const raw = await pickScalar(
          vbs, modelOid,
          async (oid) => (await snmpMultiGet(session, [oid])).get(oid),
          snmpVbToString,
        );
        if (raw) detectedModel = vendorProfile.model.parse(raw);
      }

      // Not in the batch above: on SNMPv1 one missing varbind fails the whole
      // PDU, and a profile's serial row can name an object this model lacks
      // (an APC PDU asked for upsAdvIdentSerialNumber). Instance, then bare.
      const serialOid = vendorProfile?.serial ? resolveOidSync(vendorProfile.serial.symbol, vendorScope) : null;
      if (serialOid) {
        const getText = async (oid: string): Promise<string> =>
          snmpVbToString((await snmpMultiGet(session, [oid]).catch(() => new Map<string, unknown>())).get(oid)).trim();
        detectedSerial = (await getText(scalarInstanceOid(serialOid))) || (await getText(serialOid)) || null;
      }
    } catch { /* best-effort — identity stays undetected */ }

    // Interfaces: build a map keyed by ifIndex from IF-MIB columns. Prefer
    // ifName / ifHC*Octets / ifHighSpeed when present; otherwise fall back
    // to the legacy 32-bit columns.
    const interfaces: InterfaceSample[] = [];
    let physicalEntities: PhysicalEntitySample[] | undefined;
    let entityIdentityRows: EntityIdentityRow[] | undefined;
    let fibreChannel: { ports: FcPortRow[]; logins: FcLoginRow[] } | undefined;
    let macTable: FdbEntry[] | undefined;
    let arpNeighbors: ArpNeighborEntry[] | undefined;
    let trunkMembers: TrunkPortEntry[] | undefined;
    let trunkLinks = 0;
    const endIfaces = startPhase("systeminfo.snmp.interfaces_walk");
    try {
      const [
        names, descrs, admin, oper, speeds, hiSpeeds, mac,
        in32, out32, inHC, outHC, ipMap, inErr, outErr, ifTypes, aliases, duplexes,
      ] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
        snmpWalk(session, OID.ifAdminStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifOperStatus).catch(() => new Map()),
        snmpWalk(session, OID.ifSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifHighSpeed).catch(() => new Map()),
        snmpWalk(session, OID.ifPhysAddress).catch(() => new Map()),
        snmpWalk(session, OID.ifInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifOutOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCInOctets).catch(() => new Map()),
        snmpWalk(session, OID.ifHCOutOctets).catch(() => new Map()),
        walkInterfaceAddressesSnmp(session, host, true),
        snmpWalk(session, OID.ifInErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifOutErrors).catch(() => new Map()),
        snmpWalk(session, OID.ifType).catch(() => new Map()),
        snmpWalk(session, OID.ifAlias).catch(() => new Map()),
        // Ethernet-only table; a device without EtherLike-MIB answers an
        // empty walk and every interface's duplex stays null.
        snmpWalk(session, OID.dot3StatsDuplexStatus).catch(() => new Map()),
      ]);

      // ifIndex → [addresses], both families (walkInterfaceAddressesSnmp).
      const addrsByIfIndex = ipMap as Map<string, string[]>;

      const allIdx = new Set<string>([
        ...names.keys(), ...descrs.keys(), ...admin.keys(), ...oper.keys(),
      ]);
      for (const idx of allIdx) {
        // Drop rows where IF-MIB advertises neither ifName nor ifDescr — on
        // FortiAPs these are ephemeral per-station / per-VAP virtual interfaces
        // that can't be meaningfully pinned (ifIndex churns as clients
        // associate) and just pollute AssetInterfaceSample + the auto-monitor
        // aggregate.
        const name = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx));
        if (!name) continue;
        const speedHi = snmpVbToNumber(hiSpeeds.get(idx));
        const speed32 = snmpVbToNumber(speeds.get(idx));
        const speedBps = speedHi && speedHi > 0
          ? speedHi * 1_000_000
          : (speed32 != null ? speed32 : null);
        const inHi = snmpVbToNumber(inHC.get(idx));
        const outHi = snmpVbToNumber(outHC.get(idx));
        const aliasRaw = snmpVbToString(aliases.get(idx));
        const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
        const operStatus = ifStatusLabel(snmpVbToNumber(oper.get(idx)));
        interfaces.push({
          ifName:      name,
          adminStatus: ifStatusLabel(snmpVbToNumber(admin.get(idx))),
          operStatus,
          speedBps,
          // Duplex only describes a link that is up; some agents keep
          // reporting the last negotiated value after the cable is pulled.
          duplex:      operStatus === "up" ? dot3DuplexLabel(snmpVbToNumber(duplexes.get(idx))) : null,
          // First reportable IPv4 and IPv6 on the ifIndex (business rule 126).
          ...pickInterfaceAddresses(addrsByIfIndex.get(idx) ?? []),
          macAddress:  snmpMacFromBuffer(mac.get(idx)),
          // An FC port's ifPhysAddress is its 8-byte port WWN (rule 159a).
          wwn:         snmpWwnFromPhysAddress(ifTypes.get(idx), mac.get(idx)),
          inOctets:    inHi != null  ? inHi  : snmpVbToNumber(in32.get(idx)),
          outOctets:   outHi != null ? outHi : snmpVbToNumber(out32.get(idx)),
          inErrors:    snmpVbToNumber(inErr.get(idx)),
          outErrors:   snmpVbToNumber(outErr.get(idx)),
          ifType:      snmpIfTypeLabel(snmpVbToNumber(ifTypes.get(idx))),
          alias,
        });
      }

      // PoE rides the same walk. Correlation needs ifIndex -> name, which
      // this loop has already resolved for every interface it kept, so it is
      // rebuilt here rather than re-walking IF-MIB.
      const poeIfNames = new Map<string, string>();
      for (const idx of allIdx) {
        const n = snmpVbToString(names.get(idx)) || snmpVbToString(descrs.get(idx));
        if (n) poeIfNames.set(idx, n);
      }
      const poeByIfName = await collectPoePortsSnmp(session, host, poeIfNames);
      if (poeByIfName.size > 0) {
        for (const iface of interfaces) {
          const poe = poeByIfName.get(iface.ifName);
          if (poe) { iface.poeStatus = poe.poeStatus; iface.poeClass = poe.poeClass; }
        }
      }

      // Hardware inventory rides the same walk — heavy cadence only, since a
      // module's serial changes on a swap, not on a poll.
      const entityWalk = await collectPhysicalEntitiesSnmp(session)
        .catch(() => undefined);
      physicalEntities = entityWalk?.rows;
      entityIdentityRows = entityWalk?.identityRows;

      // Fibre-channel ports and logins (business rule 159). One GETNEXT for a
      // device that is not an FC switch; port names from the IF-MIB walk above.
      fibreChannel = await collectFibreChannelSnmp(session, poeIfNames, vendorScope).catch(() => undefined);
      // Each port's counters ride its interface row too (rule 159a): that is
      // what a pinned port's sample carries, and what the interface table shows.
      if (fibreChannel) attachFcErrors(interfaces, fibreChannel.ports);

      // IP neighbour cache — firewall-class only, mirroring where the MAC
      // table is gated. A switch's neighbour table holds its own management
      // peers and nothing an operator asks about; the router's is the answer
      // to "what is at this address", which is why it earns the walk here.
      if (opts.assetType === "firewall") {
        const endArp = startPhase("systeminfo.snmp.arp_walk");
        const ifNameByIndex = new Map<number, string>();
        for (const [idx, name] of poeIfNames) {
          const n = Number(idx);
          if (Number.isInteger(n)) ifNameByIndex.set(n, name);
        }
        arpNeighbors = await collectArpNeighborsSnmp(session, ifNameByIndex).catch(() => undefined);
        endArp({ entries: arpNeighbors?.length ?? null });
      }

      // Forwarding database — switch-class only. Every bridge answers this
      // table, but a server or firewall would return nothing useful for a
      // walk that can run to thousands of rows, so the cost is not spent.
      if (opts.assetType === "switch") {
        // dot1dBasePortIfIndex is the join both walks below need; walk it once.
        const ifNameByBasePort = await collectBasePortIfNames(session, poeIfNames);
        macTable = await collectMacTableSnmp(session, ifNameByBasePort).catch(() => undefined);
        // Per-port VLAN membership. On a managed FortiSwitch the parent
        // FortiGate's CMDB is the better source (it is config truth, and the
        // only place `allowed-vlans all` exists as a concept) and overlays on
        // top of this afterwards -- but that overlay needs a resolvable
        // controller and the SNMP interfaces path, so it reaches only a subset
        // of switches. This is what every other switch gets.
        const endQbridge = startPhase("systeminfo.snmp.qbridge_vlan_walk");
        const portVlans = await collectPortVlansSnmp(session, ifNameByBasePort).catch(() => undefined);
        let vlanOverlaid = 0;
        if (portVlans) {
          for (const iface of interfaces) {
            const cfg = portVlans.get(iface.ifName);
            if (!cfg) continue;
            iface.nativeVlan  = cfg.nativeVlan;
            iface.taggedVlans = cfg.taggedVlans;
            vlanOverlaid++;
          }
        }
        endQbridge({ ports: portVlans?.size ?? null, overlaid: vlanOverlaid, total: interfaces.length });
        // Trunk map: one scalar GET, so it costs nothing next to the FDB walk.
        // Undefined (not []) when the device doesn't publish the object at all,
        // so a non-Fortinet switch preserves rather than wipes.
        let trunkRaw = await snmpGetScalar(session, OID.fsTrunkMember).catch(() => null);
        // A non-Fortinet switch answers neither OID; a FortiSwitch that answers
        // nothing at the MIB-stated one gets the second try (see the constants).
        if (trunkRaw == null) {
          trunkRaw = await snmpGetScalar(session, OID.fsTrunkMemberAlt).catch(() => null);
        }
        const trunkStr = snmpVbToString(trunkRaw);
        trunkMembers = trunkStr ? parseTrunkPortMap(trunkStr) : undefined;
        // The scalar is the ONLY source of the trunk/member relationship on a
        // directly-polled switch, so overlay it onto the interface list here as
        // well as persisting AssetTrunkMember rows: the ifTable publishes no
        // aggregation of its own, so without this the System tab lists a trunk
        // and its member ports as unrelated flat rows. Same overlay the
        // controller-CMDB path runs, so the two can't disagree about what a
        // member row looks like, and it back-fills only — a member whose parent
        // already came from CMDB or REST keeps that parent, and a member name
        // the walk didn't return is skipped rather than synthesized (see
        // `synthesizeMissing`).
        if (trunkMembers && trunkMembers.length > 0) {
          trunkLinks = overlayFortiswitchTrunkMembers(
            interfaces,
            trunkMemberMap(trunkMembers),
            { synthesizeMissing: false },
          );
        }
      }
    } catch { /* fall through */ }
    endIfaces({ interfaces: interfaces.length, trunkLinks });

    // LLDP-MIB neighbors. Best-effort — devices without LLDP-MIB return empty
    // walks (we treat that as "unsupported" so we don't wipe stored rows on
    // every scrape). A device with LLDP enabled but zero current neighbors
    // returns lldpLocPortTable rows but an empty lldpRemTable, and we
    // correctly persist that as "queried, no neighbors" → wipe. `includeLldp`
    // false lets the caller skip this when the operator routed LLDP to REST.
    let lldpNeighbors: LldpNeighborSample[] | undefined;
    if (opts.includeLldp !== false) {
      const endLldp = startPhase("systeminfo.snmp.lldp_walk");
      try {
        lldpNeighbors = await collectLldpNeighborsSnmp(session);
      } catch { /* leave undefined; persist layer leaves stored rows alone */ }
      endLldp({ neighbors: lldpNeighbors?.length ?? null });
    }

    // Wireless stations — only attempted on FortiAP assets. fapStationTable
    // is FORTINET-FORTIAP-MIB-specific; firing it on every SNMP system-info
    // pass would burn worker time on devices that can't respond. Same
    // undefined/[] semantics as lldpNeighbors: undefined leaves stored rows
    // alone, [] wipes them.
    let wirelessStations: WirelessStationSample[] | undefined;
    let apRadios: ApRadioSample[] | undefined;
    if (opts.assetType === "access_point") {
      const endWireless = startPhase("systeminfo.snmp.wireless_walk");
      try {
        wirelessStations = await collectWirelessStationsSnmp(session);
      } catch { /* leave undefined */ }
      endWireless({ stations: wirelessStations?.length ?? null });

      // The two levels ABOVE those stations. Same undefined/[] contract, and
      // the same gate — fapRadioTable is FORTINET-FORTIAP-MIB-specific and
      // firing it at every SNMP device would burn worker time on hardware
      // that cannot answer. Discovery writes the same tables from the
      // controller; the two sources carry complementary columns and the
      // persist layer merges them per column.
      const endRadios = startPhase("systeminfo.snmp.ap_radio_walk");
      try {
        apRadios = await collectApRadiosSnmp(session);
      } catch { /* leave undefined */ }
      endRadios({ radios: apRadios?.length ?? null });
    }

    // The device's own name and chassis identity (business rule 154). Pure,
    // from readings this pass already took — no extra round trip beyond the
    // sysName varbind and the softwareRev column.
    const selfIdentity: SnmpSelfIdentity = snmpSelfIdentity(sysNameText, entityIdentityRows);
    // A manufacturer profile's `model` row that answered is the operator's own
    // statement of where this device publishes its model (business rule 68:
    // a profile is an override), so the chassis row does not compete with it —
    // a FortiSwitch keeps "FortiSwitch S548DF" from fsSysVersion.
    if (detectedModel) delete selfIdentity.model;

    return {
      interfaces,
      storage,
      physicalEntities,
      macTable,
      arpNeighbors,
      trunkMembers,
      lldpNeighbors,
      lldpSource: opts.includeLldp !== false ? "snmp" : undefined,
      wirelessStations,
      apRadios,
      detectedModel,
      detectedSerial,
      descrIdentity,
      sysDescr: sysDescrText,
      sysObjectId: sysObjectIdText,
      selfIdentity: hasSelfIdentity(selfIdentity) ? selfIdentity : undefined,
      fibreChannel,
    };
  }, opts.timeoutMs);
}

/**
 * Wire-level filtered SNMP system-info scrape. Pulls only the columns/rows the
 * fast cadence actually needs — pinned interfaces and pinned storage — instead
 * of walking the full IF-MIB / hrStorage subtrees the way `collectSystemInfoSnmp`
 * does. The full pass at the heavy cadence still walks everything; this is
 * strictly an optimization for the per-minute scrape.
 *
 * Three phases:
 *
 *   1. Discovery — walk `ifName` + `ifDescr` (and `hrStorageDescr` when storage
 *      is pinned) to map the operator-supplied names back to their SNMP
 *      indexes. These walks are tiny (one varbind per port / disk) and finish
 *      in well under a second on most agents. We don't currently persist the
 *      name→index map; the heavy-cadence sample already records ifName but
 *      not ifIndex, and adding a column would mean a schema migration. The
 *      bounded walks here are the simpler path.
 *
 *   2. Multi-GET — pack every column-at-index OID we want into one `session.get`
 *      (chunked at SNMP_MULTI_GET_BATCH). On a 48-port switch with one pinned
 *      interface, that's 13 OIDs in a single PDU — vs. 16 full column walks
 *      under the legacy path (~770 OID-fetches). Latency is dominated by the
 *      network round-trip, so one PDU ≈ one round-trip ≈ ~50 ms regardless of
 *      varbind count.
 *
 *   3. Assembly — emit one `InterfaceSample` per matched name (skipping names
 *      that didn't resolve to an index, e.g. the operator pinned a port that
 *      no longer exists on the device). Speed/IP/MAC follow the same picker
 *      rules as the full walk: high-counter prefers `ifHC*Octets` over the
 *      legacy 32-bit columns, speed prefers `ifHighSpeed * 1e6` over
 *      `ifSpeed`, the addresses come from `walkInterfaceAddressesSnmp`.
 *
 * Address resolution is the one gotcha: the address tables are indexed by the
 * ADDRESS, not by ifIndex, so they have to be walked (one varbind per address
 * on the device, not per interface) — once here, so the pinned interfaces get
 * their IPv4 and IPv6 (business rule 126). ipAddressTable is two small walks
 * (ifIndex + type); a legacy-only device, once its first full pass has said
 * so, pays the single ipAddrTable walk it always did. On devices with many
 * addresses (large branches) this is the dominant cost; still tiny compared to
 * the full pass.
 *
 * Returns the same `SystemInfoSample` shape as `collectSystemInfoSnmp` so
 * `recordSystemInfoResult` downstream is unchanged. LLDP and wireless are
 * always skipped on the fast cadence (LLDP rides the heavy cadence, wireless
 * isn't a fast-pin target today).
 */
export async function collectFastFilteredSnmp(
  host: string,
  config: Record<string, unknown>,
  opts: {
    wantedIfaces:   string[];
    wantedStorage:  string[];
    timeoutMs?:     number;
    /** The asset's MIB scope, for a pinned FC port's fcIfErrorTable counters (rule 159a). Omitted = none read. */
    fcScope?:       ResolveScope;
  },
): Promise<SystemInfoSample> {
  const wantedIfaceSet  = new Set(opts.wantedIfaces);
  const wantedStorageSet = new Set(opts.wantedStorage);

  return await withSnmpSession(host, config, async (session) => {
    // ── Phase 1: discover ifIndex for each pinned ifName ──────────────────
    // Walk ifName + ifDescr in parallel; one full pass on a 48-port switch
    // is ~50 varbinds per column ≈ <500ms total. Resolve every pinned name
    // to its index; pinned-but-missing names are dropped silently (same
    // behavior as the full walk: the stored sample just doesn't include
    // that ifName on this tick).
    const ifIndexByName = new Map<string, string>();
    // Full ifIndex -> name map (not just the pinned subset) — PoE correlation
    // may need to match a port by its trailing number against any interface.
    const indexToNameAll = new Map<string, string>();
    const endIfaceDiscovery = startPhase("fastfiltered.snmp.iface_discovery");
    try {
      const [names, descrs] = await Promise.all([
        snmpWalk(session, OID.ifName).catch(() => new Map()),
        snmpWalk(session, OID.ifDescr).catch(() => new Map()),
      ]);
      // ifName is preferred (modern devices); ifDescr fallback covers older
      // agents that don't populate ifName.
      const indexToName = new Map<string, string>();
      for (const [idx, vb] of names.entries()) {
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, vb] of descrs.entries()) {
        if (indexToName.has(idx)) continue;
        const n = snmpVbToString(vb);
        if (n) indexToName.set(idx, n);
      }
      for (const [idx, name] of indexToName.entries()) {
        indexToNameAll.set(idx, name);
        if (wantedIfaceSet.has(name)) ifIndexByName.set(name, idx);
      }
    } catch { /* leave ifIndexByName empty; sample will skip iface rows */ }
    endIfaceDiscovery({ resolved: ifIndexByName.size, wanted: wantedIfaceSet.size });

    // ── Phase 1b: discover hrStorageIndex for each pinned mountPath ───────
    // Storage column rows are also small (one per disk/partition); only walk
    // when at least one mountPath is pinned to avoid burning a round-trip
    // on iface-only fast pins.
    const storageIndexByMount = new Map<string, string>();
    if (wantedStorageSet.size > 0) {
      const endStorageDiscovery = startPhase("fastfiltered.snmp.storage_discovery");
      try {
        const descrs = await snmpWalk(session, OID.hrStorageDescr);
        for (const [idx, vb] of descrs.entries()) {
          const m = snmpVbToString(vb);
          if (m && wantedStorageSet.has(m)) storageIndexByMount.set(m, idx);
        }
      } catch { /* leave empty */ }
      endStorageDiscovery({ resolved: storageIndexByMount.size, wanted: wantedStorageSet.size });
    }

    // ── Phase 2: build the targeted OID list ──────────────────────────────
    // 13 columns per pinned interface, 3 per pinned storage row. Names are
    // resolved in Phase 1; missing names contribute no OIDs.
    const IFACE_COLS = [
      OID.ifName,         // re-pull so the assembly step has the authoritative ifName
      OID.ifAdminStatus,
      OID.ifOperStatus,
      OID.ifSpeed,
      OID.ifHighSpeed,
      OID.ifPhysAddress,
      OID.ifInOctets,
      OID.ifOutOctets,
      OID.ifHCInOctets,
      OID.ifHCOutOctets,
      OID.ifInErrors,
      OID.ifOutErrors,
      OID.ifType,
      OID.ifAlias,
    ];
    const STORAGE_COLS = [
      OID.hrStorageAllocationUnits,
      OID.hrStorageSize,
      OID.hrStorageUsed,
    ];
    const oids: string[] = [];
    for (const idx of ifIndexByName.values()) {
      for (const col of IFACE_COLS) oids.push(`${col}.${idx}`);
    }
    for (const idx of storageIndexByMount.values()) {
      for (const col of STORAGE_COLS) oids.push(`${col}.${idx}`);
    }

    // Also need ifIndex by IP for the pinned interfaces' ipAddress field.
    // ipAdEntIfIndex is indexed by the IP itself, not by ifIndex, so we have
    // to walk it. Tiny on most devices (one varbind per IPv4 address). Skip
    // when no interfaces are pinned (storage-only fast cadence is rare but
    // technically possible).
    // Both families (business rule 126) — the same walk the full pass does,
    // minus the re-probe: a legacy-only device pays one walk, as before.
    let addrsByIfIndex = new Map<string, string[]>();
    if (ifIndexByName.size > 0) {
      const endIpWalk = startPhase("fastfiltered.snmp.ip_walk");
      addrsByIfIndex = await walkInterfaceAddressesSnmp(session, host, false).catch(() => new Map<string, string[]>());
      endIpWalk({ ipMappings: addrsByIfIndex.size });
    }

    // ── Phase 3: one batched multi-GET, then assembly ─────────────────────
    const endMultiGet = startPhase("fastfiltered.snmp.multi_get");
    const vbByOid = oids.length > 0
      ? await snmpMultiGet(session, oids).catch(() => new Map<string, unknown>())
      : new Map<string, unknown>();
    endMultiGet({ oids: oids.length });

    // PoE for the pinned ports. The peth index is not derivable from ifIndex
    // without walking, so this is two small column walks rather than extra
    // OIDs in the multi-GET above; the negative cache keeps non-PoE devices
    // from paying for it every tick.
    const poeByIfName = ifIndexByName.size > 0
      ? await collectPoePortsSnmp(session, host, indexToNameAll)
      : new Map<string, { poeStatus: string | null; poeClass: string | null }>();

    // Duplex for the pinned ports, in its OWN multi-GET rather than in the
    // one above: dot3StatsDuplexStatus exists only on Ethernet interfaces,
    // and an SNMPv1 agent answers a GET naming one missing instance with
    // noSuchName for the WHOLE PDU — which would cost the pass every
    // counter it just read. Here a failure only loses duplex.
    const duplexByIdx = ifIndexByName.size > 0
      ? await snmpMultiGet(session, [...ifIndexByName.values()].map((idx) => `${OID.dot3StatsDuplexStatus}.${idx}`))
          .catch(() => new Map<string, unknown>())
      : new Map<string, unknown>();

    // Pinned FC ports' error counters (rule 159a) — the samples an FC
    // error-rate automation reads.
    const fcIndexes = opts.fcScope
      ? [...ifIndexByName.values()].filter((idx) => snmpVbToNumber(vbByOid.get(`${OID.ifType}.${idx}`)) === IFTYPE_FIBRE_CHANNEL)
      : [];
    const fcByIdx = opts.fcScope && fcIndexes.length > 0
      ? await collectFcErrorsByIndex(session, fcIndexes, opts.fcScope)
      : new Map<string, FcErrorCounters>();

    const interfaces: InterfaceSample[] = [];
    for (const [pinnedName, idx] of ifIndexByName.entries()) {
      const name = snmpVbToString(vbByOid.get(`${OID.ifName}.${idx}`)) || pinnedName;
      const speedHi = snmpVbToNumber(vbByOid.get(`${OID.ifHighSpeed}.${idx}`));
      const speed32 = snmpVbToNumber(vbByOid.get(`${OID.ifSpeed}.${idx}`));
      const speedBps = speedHi && speedHi > 0
        ? speedHi * 1_000_000
        : (speed32 != null ? speed32 : null);
      const inHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCInOctets}.${idx}`));
      const outHi = snmpVbToNumber(vbByOid.get(`${OID.ifHCOutOctets}.${idx}`));
      const aliasRaw = snmpVbToString(vbByOid.get(`${OID.ifAlias}.${idx}`));
      const alias = aliasRaw && aliasRaw.trim() ? aliasRaw.trim() : null;
      const operStatus = ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifOperStatus}.${idx}`)));
      interfaces.push({
        ifName:      name,
        adminStatus: ifStatusLabel(snmpVbToNumber(vbByOid.get(`${OID.ifAdminStatus}.${idx}`))),
        operStatus,
        speedBps,
        duplex:      operStatus === "up" ? dot3DuplexLabel(snmpVbToNumber(duplexByIdx.get(`${OID.dot3StatsDuplexStatus}.${idx}`))) : null,
        ...pickInterfaceAddresses(addrsByIfIndex.get(idx) ?? []),
        macAddress:  snmpMacFromBuffer(vbByOid.get(`${OID.ifPhysAddress}.${idx}`)),
        wwn:         snmpWwnFromPhysAddress(vbByOid.get(`${OID.ifType}.${idx}`), vbByOid.get(`${OID.ifPhysAddress}.${idx}`)),
        fcErrors:    fcByIdx.get(idx) ?? null,
        inOctets:    inHi != null  ? inHi  : snmpVbToNumber(vbByOid.get(`${OID.ifInOctets}.${idx}`)),
        outOctets:   outHi != null ? outHi : snmpVbToNumber(vbByOid.get(`${OID.ifOutOctets}.${idx}`)),
        inErrors:    snmpVbToNumber(vbByOid.get(`${OID.ifInErrors}.${idx}`)),
        outErrors:   snmpVbToNumber(vbByOid.get(`${OID.ifOutErrors}.${idx}`)),
        ifType:      snmpIfTypeLabel(snmpVbToNumber(vbByOid.get(`${OID.ifType}.${idx}`))),
        alias,
        poeStatus:   poeByIfName.get(name)?.poeStatus ?? null,
        poeClass:    poeByIfName.get(name)?.poeClass ?? null,
      });
    }

    const storage: StorageSample[] = [];
    for (const [mountPath, idx] of storageIndexByMount.entries()) {
      const u = snmpVbToNumber(vbByOid.get(`${OID.hrStorageAllocationUnits}.${idx}`)) ?? 1;
      const s = snmpVbToNumber(vbByOid.get(`${OID.hrStorageSize}.${idx}`));
      const ud = snmpVbToNumber(vbByOid.get(`${OID.hrStorageUsed}.${idx}`));
      storage.push({
        mountPath,
        totalBytes: s != null  ? s * u  : null,
        usedBytes:  ud != null ? ud * u : null,
      });
    }

    return {
      interfaces,
      storage,
      // LLDP intentionally omitted on the fast cadence — undefined preserves
      // stored rows from the last heavy pass instead of wiping them. Same
      // contract as `collectSystemInfoSnmp` with `includeLldp: false`.
      lldpNeighbors: undefined,
      wirelessStations: undefined,
      // Inventory likewise omitted here: undefined preserves what the last
      // heavy pass stored. A module's serial does not change per minute, and
      // wiping it on every fast tick would cost a delete-replace for nothing.
      physicalEntities: undefined,
    };
  }, opts.timeoutMs);
}

/**
 * Standalone LLDP-MIB walk for the cross-transport case. Used when the caller
 * has already pulled interfaces+storage via FortiOS REST but the operator
 * routed LLDP to SNMP. Opens its own SNMP session — cheap enough; LLDP walks
 * are normally ~6 columns and finish in a few hundred ms.
 */
export async function collectLldpOnlySnmp(
  host: string,
  config: Record<string, unknown>,
  timeoutMs?: number,
): Promise<LldpNeighborSample[] | undefined> {
  return await withSnmpSession(host, config, async (session) => {
    return await collectLldpNeighborsSnmp(session);
  }, timeoutMs);
}

/**
 * Walk LLDP-MIB and assemble one LldpNeighborSample per remote system seen.
 * Returns `undefined` when the local-port table is empty (suggesting LLDP-MIB
 * is unsupported); returns `[]` when the local table is populated but no
 * remote neighbors are present (so the caller wipes stored rows). Mapping
 * localPortNum → ifName comes from lldpLocPortTable: when the subtype is
 * interfaceName/interfaceAlias we trust lldpLocPortId; otherwise we fall back
 * to lldpLocPortDesc, which is always populated by spec-conformant agents.
 */
async function collectLldpNeighborsSnmp(session: any): Promise<LldpNeighborSample[] | undefined> {
  const [
    locSubtypes, locIds, locDescs,
    chSubtypes, chIds, ptSubtypes, ptIds, ptDescs,
    sysNames, sysDescs, capsEnabled, manAddrEnum,
    ifNames,
  ] = await Promise.all([
    snmpWalk(session, OID.lldpLocPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpLocPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemChassisId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortIdSubtype).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortId).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemPortDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysName).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysDesc).catch(() => new Map()),
    snmpWalk(session, OID.lldpRemSysCapEnabled).catch(() => new Map()),
    // Walking lldpRemManAddrIfSubtype just to enumerate the table indexes —
    // the actual address is encoded in the index suffix, not the column value.
    snmpWalk(session, OID.lldpRemManAddr + ".3").catch(() => new Map()),
    // IF-MIB ifName: fallback for the local port label when lldpLocPortTable
    // is empty. FortiOS uses ifIndex as lldpLocPortNum, so a "port-2" label
    // can be resolved to "internal1" / "wan2" / etc via the IF-MIB table that
    // every SNMP-monitored asset already exposes.
    snmpWalk(session, OID.ifName).catch(() => new Map()),
  ]);

  // No local LLDP ports AND no remote neighbors → device doesn't speak
  // LLDP-MIB. Signal "leave rows alone" so we don't wipe stored neighbors
  // on a transport that can't report. The previous guard returned here on
  // an empty local port table alone, but some FortiOS agents populate
  // lldpRemTable while leaving lldpLocPortTable empty — those reports are
  // authoritative for the remote side, and the per-row port label falls
  // back to "port-<num>" naturally below.
  if (locIds.size === 0 && locDescs.size === 0 && chIds.size === 0) return undefined;

  // localPortNum → friendly label. When the subtype is interfaceName(5) or
  // interfaceAlias(1), the id IS the ifName/alias and we want it. Otherwise
  // use the description — which is what most operators see in CLI output.
  const localPortLabel = new Map<string, string>();
  const allLocalKeys = new Set<string>([...locIds.keys(), ...locDescs.keys()]);
  for (const portNum of allLocalKeys) {
    const subtype = snmpVbToNumber(locSubtypes.get(portNum));
    const id      = parseLldpPortId(subtype, locIds.get(portNum));
    const desc    = snmpVbToString(locDescs.get(portNum)).trim();
    if ((subtype === 1 || subtype === 5) && id) {
      localPortLabel.set(portNum, id);
    } else if (desc) {
      localPortLabel.set(portNum, desc);
    } else if (id) {
      localPortLabel.set(portNum, id);
    } else {
      localPortLabel.set(portNum, `port-${portNum}`);
    }
  }
  // IF-MIB ifName fallback: rem-table-only agents (some FortiOS builds)
  // leave lldpLocPortTable empty but lldpRemLocalPortNum lines up with the
  // ifIndex of the physical port. Stamp any port number that the local-port
  // pass didn't cover so neighbors render as e.g. "internal1 → LAKESIDE-148F-1"
  // instead of "port-2 → LAKESIDE-148F-1".
  for (const [ifIndex, nameVb] of ifNames.entries()) {
    if (localPortLabel.has(ifIndex)) continue;
    const name = snmpVbToString(nameVb).trim();
    if (name) localPortLabel.set(ifIndex, name);
  }

  // (localPortNum, remIndex) → management IP. Decode the index suffix:
  // <timeMark>.<localPortNum>.<remIndex>.<addrSubtype>.<addrLen>.<addr-bytes…>
  // addrSubtype 1 = IPv4 (4 bytes), 2 = IPv6 (16 bytes); ignore others.
  const mgmtByKey = new Map<string, string>();
  for (const suffix of manAddrEnum.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length < 6) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const addrSubtype  = parts[3]!;
    const addrLen      = parseInt(parts[4]!, 10);
    if (!Number.isFinite(addrLen)) continue;
    const addrBytes = parts.slice(5, 5 + addrLen);
    if (addrBytes.length !== addrLen) continue;
    let addr: string | null = null;
    if (addrSubtype === "1" && addrLen === 4) {
      addr = addrBytes.join(".");
    } else if (addrSubtype === "2" && addrLen === 16) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        const hi = parseInt(addrBytes[i]!, 10);
        const lo = parseInt(addrBytes[i + 1]!, 10);
        groups.push(((hi << 8) | lo).toString(16));
      }
      addr = groups.join(":");
    }
    if (!addr) continue;
    const key = `${localPortNum}|${remIndex}`;
    if (!mgmtByKey.has(key)) mgmtByKey.set(key, addr);
  }

  // Enumerate remote neighbors via lldpRemChassisId — always present. The
  // suffix here is `<timeMark>.<localPortNum>.<remIndex>`.
  const out: LldpNeighborSample[] = [];
  for (const [suffix, chRaw] of chIds.entries()) {
    const parts = String(suffix).split(".");
    if (parts.length < 3) continue;
    const localPortNum = parts[1]!;
    const remIndex     = parts[2]!;
    const localIfName  = localPortLabel.get(localPortNum) || `port-${localPortNum}`;
    const chSub  = snmpVbToNumber(chSubtypes.get(suffix));
    const ptSub  = snmpVbToNumber(ptSubtypes.get(suffix));
    out.push({
      localIfName,
      chassisIdSubtype:  lldpChassisSubtypeLabel(chSub),
      chassisId:         parseLldpChassisId(chSub, chRaw),
      portIdSubtype:     lldpPortSubtypeLabel(ptSub),
      portId:            parseLldpPortId(ptSub, ptIds.get(suffix)),
      portDescription:   snmpVbToString(ptDescs.get(suffix)).trim() || null,
      systemName:        snmpVbToString(sysNames.get(suffix)).trim() || null,
      systemDescription: snmpVbToString(sysDescs.get(suffix)).trim() || null,
      managementIp:      mgmtByKey.get(`${localPortNum}|${remIndex}`) ?? null,
      capabilities:      parseLldpCapabilities(capsEnabled.get(suffix)),
    });
  }
  return out;
}

function parseLldpChassisId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(4) → format as colon-separated MAC when length matches.
  if (subtype === 4) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

/**
 * Walk FORTINET-FORTIAP-MIB::fapStationTable and return one
 * WirelessStationSample per connected wireless client. Returns `undefined`
 * when the table is absent (device doesn't implement FORTINET-FORTIAP-MIB
 * or no SSID column is populated) so the caller leaves stored rows alone;
 * returns `[]` when the device was queried but reported zero stations
 * (caller wipes stored rows).
 *
 * INDEX = { fapStaRadioId, fapStaWlanId, fapStaMacAddr (6|8 octets) }.
 * For 6-byte Ethernet MACs the SMIv2 default-encoded suffix has 9 parts:
 *   <radioId>.<wlanId>.6.<b0>.<b1>.<b2>.<b3>.<b4>.<b5>
 * Each parallel column walk lookup uses the same suffix string.
 */
async function collectWirelessStationsSnmp(session: any): Promise<WirelessStationSample[] | undefined> {
  const [ssids, bssids, vlans, ipAddrs, radioTypes, radioChannels] = await Promise.all([
    snmpWalk(session, OID.fapStaSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaBSSID).catch(() => new Map()),
    snmpWalk(session, OID.fapStaVlanId).catch(() => new Map()),
    snmpWalk(session, OID.fapStaIpAddr).catch(() => new Map()),
    // fapRadioTable, indexed by fapRadioIndex — used to derive each station's
    // band. Best-effort: failures leave band null, stations still persist.
    snmpWalk(session, OID.fapRadioType).catch(() => new Map()),
    snmpWalk(session, OID.fapRadioChannelOper).catch(() => new Map()),
  ]);

  // radioIndex (string suffix) → derived band. fapRadioIndex is the single
  // index column, so the walk suffix is the bare radio index.
  const bandByRadio = new Map<string, string | null>();
  for (const suffix of new Set([...radioTypes.keys(), ...radioChannels.keys()])) {
    const type = radioTypes.has(suffix) ? snmpVbToString(radioTypes.get(suffix)).trim() : null;
    const channel = snmpVbToNumber(radioChannels.get(suffix));
    bandByRadio.set(String(suffix), deriveRadioBand(type, channel));
  }

  // Treat all-empty as "table unsupported" so we don't wipe stored rows on
  // a transport that can't report. A genuinely empty AP with the MIB in
  // place still returns at least one column with zero rows — the
  // collector sees an empty Map, suffix loop produces no rows, returns
  // []. The undefined return is reserved for "couldn't query at all."
  if (ssids.size === 0 && bssids.size === 0 && vlans.size === 0 && ipAddrs.size === 0) return undefined;

  // Decode the index suffix back into (radioId, wlanId, MAC). Skip rows
  // whose suffix doesn't match the expected 6-byte-MAC shape — 8-byte
  // forms (PhysAddress SIZE(6|8)) are valid per MIB but FortiAPs in the
  // field only emit 6-byte MACs; an 8-byte row would still decode but
  // wouldn't match anything in Polaris's endpoint inventory anyway. Drop
  // those silently rather than persist a malformed MAC.
  const out: WirelessStationSample[] = [];
  for (const suffix of ssids.keys()) {
    const parts = String(suffix).split(".");
    if (parts.length !== 9) continue;
    if (parts[2] !== "6") continue;
    const radioId = Number(parts[0]);
    const wlanId  = Number(parts[1]);
    const macBytes = parts.slice(3, 9).map((p) => Number(p));
    if (macBytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) continue;
    const staMacAddr = macBytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");

    const ssid  = snmpVbToString(ssids.get(suffix)).trim() || null;
    const bssidRaw = bssids.get(suffix);
    const bssid = bssidRaw ? snmpMacFromBuffer(bssidRaw) : null;
    const vlanId = snmpVbToNumber(vlans.get(suffix));
    // fapStaIpAddr is IpAddress (4 bytes). snmpVbToString gives us dotted-quad on
    // most encodings; we fall through to null on the all-zero "unknown" case
    // so the row carries no IP rather than "0.0.0.0".
    let staIpAddr: string | null = null;
    const ipRaw = ipAddrs.get(suffix);
    if (ipRaw) {
      const s = snmpVbToString(ipRaw).trim();
      if (s && s !== "0.0.0.0") staIpAddr = s;
    }

    out.push({
      staMacAddr,
      staIpAddr,
      ssid,
      radioId: Number.isFinite(radioId) ? radioId : null,
      wlanId:  Number.isFinite(wlanId)  ? wlanId  : null,
      band:    Number.isFinite(radioId) ? (bandByRadio.get(String(radioId)) ?? null) : null,
      vlanId:  vlanId,
      bssid,
    });
  }
  return out;
}

/**
 * Walk FORTINET-FORTIAP-MIB's radio + VAP tables and return one sample per
 * radio, each carrying the SSIDs it broadcasts — the SNMP half of the same
 * inventory discovery writes from the controller's managed_ap row.
 *
 * `undefined` when the radio table could not be read at all (not a FortiAP, no
 * FORTINET-FORTIAP-MIB, SNMP refused): the persist layer then leaves stored
 * rows alone. An AP that answered with zero radios returns [], which wipes.
 *
 * The VAP half is separately optional and deliberately so. A radio whose VAP
 * rows could not be read carries `vaps: undefined`, which preserves the SSIDs
 * the controller already established rather than clearing them — the two
 * sources name a VAP differently (FortiOS by its object name, the MIB by its
 * SSID), so a failed VAP walk that wiped would take the controller's names
 * with it and the next discovery run would put them back. Churn, on the tree
 * an operator is reading.
 */
async function collectApRadiosSnmp(session: any): Promise<ApRadioSample[] | undefined> {
  const [modes, countries, stationInfos, types, txConfigs, txOpers, txMaxes, widths, channels] = await Promise.all([
    snmpWalk(session, FAP_RADIO_OID.mode).catch(() => undefined),
    snmpWalk(session, FAP_RADIO_OID.country).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.stationInfo).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.type).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerConfig).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerOper).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.txPowerMax).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.channelWidth).catch(() => new Map()),
    snmpWalk(session, FAP_RADIO_OID.channelOper).catch(() => new Map()),
  ]);
  // `mode` is the discriminator: every radio row has one, including a disabled
  // radio, so its absence means the table itself is unreadable rather than
  // "this AP has no radios". A radio that answers nothing else still appears.
  if (modes === undefined) return undefined;

  const vaps = await collectApVapsSnmp(session);

  const out: ApRadioSample[] = [];
  for (const suffix of Array.from(modes.keys()).sort((a, b) => Number(a) - Number(b))) {
    const radioIndex = Number(suffix);
    if (!Number.isInteger(radioIndex)) continue;
    const typeInfo = decodeRadioType(types.get(suffix));
    const channel = snmpVbToNumber(channels.get(suffix));
    out.push({
      radioIndex,
      radioType: typeInfo.label,
      // The type enum names the band outright for seven of its eight members,
      // which beats deriving it from the channel; plain 802.11n and anything
      // outside the enum fall through to the shared derivation.
      band: typeInfo.band ?? deriveRadioBand(typeInfo.label, channel ?? null),
      mode: decodeRadioMode(modes.get(suffix)),
      channel: channel ?? null,
      bandwidthMhz: decodeChannelWidth(widths.get(suffix)),
      // The controller's percentage is a different column; these three are the
      // MIB's own unit-less integers. See utils/fortiapRadioSnmp.ts.
      txPowerPct: null,
      txPowerConfig: snmpVbToNumber(txConfigs.get(suffix)) ?? null,
      txPowerOper: snmpVbToNumber(txOpers.get(suffix)) ?? null,
      txPowerMax: snmpVbToNumber(txMaxes.get(suffix)) ?? null,
      txPowerMode: null,
      // The radio's own BSSID is not published by this table — only per-VAP
      // BSSIDs are — so it stays with whatever the controller established.
      baseBssid: null,
      clientCount: parseStationInfoCount(snmpVbToString(stationInfos.get(suffix))),
      countryCode: snmpVbToString(countries.get(suffix)).trim() || null,
      ...(vaps ? { vaps: vaps.get(radioIndex) ?? [] } : {}),
    });
  }
  return out;
}

/**
 * Walk fapVapTable into radioIndex -> the VAPs on that radio. `undefined` when
 * the table could not be read; a radio with no rows in a readable table gets
 * an empty list from the caller, which correctly means "broadcasting nothing".
 *
 * The MIB publishes no VAP object NAME — only the SSID — so `vapName` is the
 * SSID here, while the controller uses the FortiOS object name. That mismatch
 * is resolved in the persist layer by matching on BSSID, which both sources do
 * publish; without it the two writers would each create their own row for the
 * same VAP and take turns deleting the other's.
 */
async function collectApVapsSnmp(session: any): Promise<Map<number, ApVapSample[]> | undefined> {
  const [ssids, bssids, statuses, vlans, staCounts] = await Promise.all([
    snmpWalk(session, FAP_VAP_OID.ssid).catch(() => undefined),
    snmpWalk(session, FAP_VAP_OID.bssid).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.status).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.vlanId).catch(() => new Map()),
    snmpWalk(session, FAP_VAP_OID.staCount).catch(() => new Map()),
  ]);
  if (ssids === undefined) return undefined;

  const byRadio = new Map<number, ApVapSample[]>();
  for (const suffix of ssids.keys()) {
    const idx = parseVapSuffix(String(suffix));
    if (!idx) continue;
    const ssid = snmpVbToString(ssids.get(suffix)).trim();
    // A VAP with no SSID has nothing to key on and nothing to show. The MIB
    // hands back an empty string for an unconfigured WLAN slot, which is what
    // this drops — a real hidden SSID still has a name, it just isn't beaconed.
    if (!ssid) continue;
    // An administratively-down VAP is still inventory, but a VAP the radio
    // reports as DOWN is not broadcasting; keep it out of the tree rather than
    // showing an SSID nobody can join.
    const status = snmpVbToNumber(statuses.get(suffix));
    if (status === 0) continue;
    const bssidRaw = bssids.get(suffix);
    const list = byRadio.get(idx.radioIndex) ?? [];
    list.push({
      vapName: ssid,
      ssid,
      bssid: bssidRaw ? snmpMacFromBuffer(bssidRaw) : null,
      vlanId: snmpVbToNumber(vlans.get(suffix)) ?? null,
      clientCount: snmpVbToNumber(staCounts.get(suffix)) ?? null,
    });
    byRadio.set(idx.radioIndex, list);
  }
  return byRadio;
}

function parseLldpPortId(subtype: number | null, raw: unknown): string | null {
  if (raw == null) return null;
  // macAddress(3) on lldpRemPortIdSubtype — same trick as chassis.
  if (subtype === 3) {
    const mac = snmpMacFromBuffer(raw);
    if (mac) return mac;
  }
  if (Buffer.isBuffer(raw)) {
    const printable = raw.toString("utf8");
    if (/^[\x20-\x7e]+$/.test(printable.trim())) return printable.trim();
    return Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(":");
  }
  const s = String(raw).trim();
  return s || null;
}

function lldpChassisSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "chassisComponent";
    case 2: return "interfaceAlias";
    case 3: return "portComponent";
    case 4: return "macAddress";
    case 5: return "networkAddress";
    case 6: return "interfaceName";
    case 7: return "local";
    default: return null;
  }
}

function lldpPortSubtypeLabel(n: number | null): string | null {
  switch (n) {
    case 1: return "interfaceAlias";
    case 2: return "portComponent";
    case 3: return "macAddress";
    case 4: return "networkAddress";
    case 5: return "interfaceName";
    case 6: return "agentCircuitId";
    case 7: return "local";
    default: return null;
  }
}

// LldpSystemCapabilitiesMap is a 16-bit OctetString; bit 0 (MSB of byte 0)
// is `other`, bit 1 is `repeater`, etc. We only decode the eight defined
// IEEE 802.1AB-2009 capabilities; the rest are reserved.
function parseLldpCapabilities(raw: unknown): string[] {
  const labels = ["other", "repeater", "bridge", "wlan-access-point", "router", "telephone", "docsis-cable-device", "station-only"];
  const out: string[] = [];
  if (Buffer.isBuffer(raw) && raw.length >= 1) {
    const byte = raw[0]!;
    for (let i = 0; i < 8; i++) {
      if (byte & (1 << (7 - i))) out.push(labels[i]!);
    }
  }
  return out;
}
