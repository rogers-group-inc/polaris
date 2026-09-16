/**
 * src/services/stdMibLibrary.ts — built-in standard MIB browse/walk support.
 *
 * Mirrors the upload-MIB pathway (mibService.parseMibStructured +
 * oidRegistry.resolveSymbolsForMib) for the eleven canonical RFC/IEEE
 * modules bundled under [stdMibs/](./stdMibs/). The SNMP Walk tab on the
 * asset details modal consumes this surface via two routes in
 * [../api/routes/mibs.ts](../api/routes/mibs.ts):
 *
 *   GET  /server-settings/mibs/std/:key/structure
 *   POST /server-settings/mibs/std/:key/walk
 *
 * Standard MIBs are immutable at runtime — we parse each one lazily on
 * first request and cache the structured result module-level. The numeric
 * OIDs come from `oidRegistry.resolveStandardSymbols()`: the registry reads
 * the same `stdMibs/` directory, resolves every bundled module TOGETHER as
 * its standard layer, and serves the probe path from it. Reading that one
 * table here means Browse/Walk and the collectors can never disagree about
 * what a standard symbol's OID is.
 *
 * Because the modules resolve together, a MIB anchored on a sibling's
 * symbol just works: Q-BRIDGE-MIB hangs off BRIDGE-MIB's `dot1dBridge` and
 * RSTP-MIB off its `dot1dStp`, and both resolve fully with nothing seeded
 * by hand. Adding a module is dropping the file in `stdMibs/`, adding its
 * `StdMibDef` below, and giving the smoke script an expectation for it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  parseMibStructured,
  type ParsedMibStructured,
} from "./mibService.js";
import { resolveStandardSymbols } from "./oidRegistry.js";

export interface StdMibDef {
  /** Frontend-facing id, e.g. "std:system". */
  key: string;
  /** Human label shown in the SNMP Walk dropdown. */
  label: string;
  /** SMI module name as declared in the file's `<NAME> DEFINITIONS ::= BEGIN`. */
  moduleName: string;
  /** Convenience root OID (used by the legacy raw-OID prefill path). */
  rootOid: string;
  /** Filename under stdMibs/. Multiple std keys may share one file
   * (e.g. std:interfaces + std:if-ext both come from IF-MIB.txt). */
  filename: string;
}

export const STD_MIBS: readonly StdMibDef[] = [
  { key: "std:system",         label: "System (RFC 3418)",                      moduleName: "SNMPv2-MIB",       rootOid: "1.3.6.1.2.1.1",  filename: "SNMPv2-MIB.txt" },
  { key: "std:interfaces",     label: "Interfaces — ifTable (RFC 2863)",        moduleName: "IF-MIB",           rootOid: "1.3.6.1.2.1.2",  filename: "IF-MIB.txt" },
  { key: "std:if-ext",         label: "Interfaces — ifXTable, 64-bit (RFC 2863)", moduleName: "IF-MIB",         rootOid: "1.3.6.1.2.1.31", filename: "IF-MIB.txt" },
  { key: "std:host-resources", label: "HOST-RESOURCES-MIB (RFC 2790)",          moduleName: "HOST-RESOURCES-MIB", rootOid: "1.3.6.1.2.1.25", filename: "HOST-RESOURCES-MIB.txt" },
  { key: "std:entity",         label: "ENTITY-MIB (RFC 4133)",                  moduleName: "ENTITY-MIB",       rootOid: "1.3.6.1.2.1.47", filename: "ENTITY-MIB.txt" },
  { key: "std:entity-sensor",  label: "ENTITY-SENSOR-MIB (RFC 3433)",           moduleName: "ENTITY-SENSOR-MIB", rootOid: "1.3.6.1.2.1.99", filename: "ENTITY-SENSOR-MIB.txt" },
  { key: "std:lldp",           label: "LLDP-MIB (IEEE 802.1AB)",                moduleName: "LLDP-MIB",         rootOid: "1.0.8802.1.1.2", filename: "LLDP-MIB.txt" },
  { key: "std:poe",            label: "PoE — POWER-ETHERNET-MIB (RFC 3621)",    moduleName: "POWER-ETHERNET-MIB", rootOid: "1.3.6.1.2.1.105", filename: "POWER-ETHERNET-MIB.txt" },
  { key: "std:bridge",         label: "Bridge — MAC forwarding + STP (RFC 4188)", moduleName: "BRIDGE-MIB",     rootOid: "1.3.6.1.2.1.17", filename: "BRIDGE-MIB.txt" },
  { key: "std:q-bridge",       label: "Bridge — VLAN-aware forwarding (RFC 4363)", moduleName: "Q-BRIDGE-MIB",  rootOid: "1.3.6.1.2.1.17.7", filename: "Q-BRIDGE-MIB.txt" },
  { key: "std:rstp",           label: "Rapid Spanning Tree (RFC 4318)",         moduleName: "RSTP-MIB",         rootOid: "1.3.6.1.2.1.134", filename: "RSTP-MIB.txt" },
  // The ip group. Carries ipNetToPhysicalTable (the neighbour cache -- ARP for
  // IPv4, NDP for IPv6) and its deprecated RFC 1213 predecessor
  // ipNetToMediaTable: the layer-3 counterpart to BRIDGE-MIB's forwarding
  // database, and the SNMP route to a FortiGate's ARP table.
  { key: "std:ip",             label: "IP — addresses + neighbour cache (RFC 4293)", moduleName: "IP-MIB",   rootOid: "1.3.6.1.2.1.4",  filename: "IP-MIB.txt" },
];

const STD_MIBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "stdMibs");

/**
 * Lazily-populated parse cache keyed by std key. Values include
 * resolved `fullOid` stamps on every symbol (null where unresolved).
 * Module-level immutable lifetime — std MIBs don't change at runtime.
 */
const _cache = new Map<string, ParsedMibStructured & { unresolvedCount: number }>();

function loadAndCache(def: StdMibDef): ParsedMibStructured & { unresolvedCount: number } {
  const cached = _cache.get(def.key);
  if (cached) return cached;

  const filePath = join(STD_MIBS_DIR, def.filename);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err: msg }, "Failed to read std MIB file");
    throw new AppError(500, `Standard MIB "${def.moduleName}" is not installed on the server`);
  }

  const parsed = parseMibStructured(raw);
  // The registry resolved every bundled module together; a symbol this
  // module IMPORTs from a sibling is in the table alongside its own.
  const numeric = resolveStandardSymbols();

  // Stamp resolved OIDs onto each symbol the structured parser produced.
  for (const sym of parsed.symbols) {
    sym.fullOid = numeric.get(sym.name) ?? null;
  }

  const unresolvedCount = parsed.symbols.filter((s) => s.fullOid === null).length;
  if (unresolvedCount > 0) {
    logger.debug(
      { module: def.moduleName, unresolvedCount, total: parsed.symbols.length },
      "std MIB has unresolved symbols (likely IMPORTS-only references)",
    );
  }

  const result = { ...parsed, unresolvedCount };
  _cache.set(def.key, result);
  return result;
}

/** List every bundled standard MIB. */
export function listStdMibs(): readonly StdMibDef[] {
  return STD_MIBS;
}

/** Look up a std MIB definition by frontend key (`std:lldp` etc.). Returns null when unknown. */
export function getStdMibDef(key: string): StdMibDef | null {
  return STD_MIBS.find((m) => m.key === key) ?? null;
}

/**
 * Parsed structure for the std MIB at `key`, with `fullOid` resolved on
 * every symbol that the BUILT_IN_OIDS seed can reach. Throws AppError(404)
 * for an unknown key, AppError(500) if the file is missing or unparseable.
 */
export function getStdMibStructure(key: string): ParsedMibStructured & { unresolvedCount: number } {
  const def = getStdMibDef(key);
  if (!def) throw new AppError(404, `Unknown standard MIB key "${key}"`);
  return loadAndCache(def);
}
