/**
 * src/utils/snmpEntityIdentity.ts
 *
 * What an SNMP device says about ITSELF through the standard MIBs every
 * vendor implements — business rule 154.
 *
 *  - **Hostname** from `sysName` (SNMPv2-MIB). The device's own configured
 *    name; refused when it is an unconfigured agent's placeholder.
 *  - **Model, serial, manufacturer, firmware** from the ENTITY-MIB
 *    (RFC 4133) row of class `chassis(3)` — the box itself, as opposed to the
 *    fans, PSUs and transceivers the Hardware Modules list shows. The monitor
 *    pass already walks that table; the chassis row is simply the one the
 *    inventory filter (`entityPhysicalIsInventory`) drops, because a chassis
 *    is not a part an operator swaps.
 *
 * Pure: the collector walks, this decides. Everything here follows the
 * `snmpDescrIdentity.ts` rule — **a field is stated only when the device
 * stated it unambiguously, and an ambiguous reading yields nothing rather
 * than a guess**:
 *
 *  - No chassis row → nothing from ENTITY-MIB. A supervisor or line card's
 *    serial is not the chassis serial, so no other class stands in for it.
 *  - Several chassis rows (a stack, a VSS pair, a modular chassis with an
 *    extension) → model and manufacturer only when every row that states one
 *    agrees; never a serial, which is per-member by definition and would
 *    name one member as the whole stack (business rule 83).
 *  - Firmware is `entPhysicalSoftwareRev` — the running OS — never
 *    `entPhysicalFirmwareRev`, which is the ROM / bootloader on most agents.
 *    The chassis row's answer first; failing that, the one value every
 *    module that reports a software revision agrees on (a supervisor's OS IS
 *    the device's OS on NX-OS, which leaves the chassis cell blank). Modules
 *    that disagree — line cards with their own firmware — yield nothing.
 *  - Serials go through `usableSerialOrNull` (business rule 84) so a
 *    placeholder never becomes an identity.
 */

import { tidyMeaningful } from "./snmpIdentity.js";
import { usableSerialOrNull } from "./serialNumber.js";

/** Longest model / version string kept. Bounds a malformed agent. */
const MAX_FIELD = 64;
/** Longest hostname kept — a DNS name's limit. */
const MAX_HOSTNAME = 253;

/** sysName values that name no device, beyond the shared agent placeholders. */
const HOSTNAME_PLACEHOLDERS = new Set([
  "localhost",
  "localhost.localdomain",
  "(none)",
  "default",
]);

/** A firmware string must at least carry a digit: "8.4(2c)", "15.2(7)E3", "v7.4.5". */
const VERSION_SHAPE = /\d/;

/** One entPhysicalTable row, as the collector read it (every class, unfiltered). */
export interface EntityIdentityRow {
  entIndex: number;
  /** `entityPhysicalClassLabel` output: "chassis", "module", "powerSupply", … */
  entClass: string;
  serialNum: string | null;
  mfgName: string | null;
  modelName: string | null;
  softwareRev: string | null;
}

/** The device's own identity, as far as it stated it. Absent field = not stated. */
export interface SnmpSelfIdentity {
  hostname?: string;
  model?: string;
  serialNumber?: string;
  manufacturer?: string;
  osVersion?: string;
}

function bounded(raw: string | null | undefined, max = MAX_FIELD): string | undefined {
  const s = tidyMeaningful(raw ?? undefined);
  if (!s) return undefined;
  return s.length > max ? undefined : s;
}

/** sysName → hostname, or undefined when it names nothing. */
export function hostnameFromSysName(raw: string | null | undefined): string | undefined {
  const s = bounded(raw, MAX_HOSTNAME);
  if (!s) return undefined;
  if (HOSTNAME_PLACEHOLDERS.has(s.toLowerCase())) return undefined;
  return s;
}

function firmware(raw: string | null | undefined): string | undefined {
  const s = bounded(raw);
  return s && VERSION_SHAPE.test(s) ? s : undefined;
}

/** The single value every stated entry agrees on (case-insensitive), else undefined. */
function agreed(values: Array<string | undefined>): string | undefined {
  const stated = values.filter((v): v is string => !!v);
  if (stated.length === 0) return undefined;
  const first = stated[0];
  return stated.every((v) => v.toLowerCase() === first.toLowerCase()) ? first : undefined;
}

/** Model / serial / manufacturer / firmware from the ENTITY-MIB rows. */
export function identityFromEntityRows(rows: readonly EntityIdentityRow[]): SnmpSelfIdentity {
  const chassis = rows.filter((r) => r.entClass === "chassis");
  if (chassis.length === 0) return {};

  const out: SnmpSelfIdentity = {};
  const model = agreed(chassis.map((r) => bounded(r.modelName)));
  if (model) out.model = model;
  const mfg = agreed(chassis.map((r) => bounded(r.mfgName)));
  if (mfg) out.manufacturer = mfg;
  if (chassis.length === 1) {
    const serial = usableSerialOrNull(bounded(chassis[0].serialNum) ?? null);
    if (serial) out.serialNumber = serial;
  }

  const chassisOs = agreed(chassis.map((r) => firmware(r.softwareRev)));
  const osVersion = chassisOs
    ?? agreed(rows.filter((r) => r.entClass === "module").map((r) => firmware(r.softwareRev)));
  if (osVersion) out.osVersion = osVersion;
  return out;
}

/** Both halves together; an empty object when the device stated nothing. */
export function snmpSelfIdentity(
  sysName: string | null | undefined,
  entityRows: readonly EntityIdentityRow[] | undefined,
): SnmpSelfIdentity {
  const out: SnmpSelfIdentity = entityRows ? identityFromEntityRows(entityRows) : {};
  const hostname = hostnameFromSysName(sysName);
  if (hostname) out.hostname = hostname;
  return out;
}

/** True when the identity states at least one field. */
export function hasSelfIdentity(id: SnmpSelfIdentity | undefined): id is SnmpSelfIdentity {
  return !!id && Object.values(id).some((v) => typeof v === "string" && v.length > 0);
}
