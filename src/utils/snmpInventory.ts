/**
 * src/utils/snmpInventory.ts
 *
 * Decode an interface list and a storage-mount list out of raw SNMP walks, for
 * a network Discovery (business rule 34).
 *
 * **Why the scan collects this at all.** The auto-monitor step of the wizard
 * offers interface and storage pins by NAME, and the existing pickers are fed
 * by `GET /integrations/:id/interface-aggregate` — assets that already exist
 * and have already been polled. At the scan's monitoring step neither is true
 * yet, so without collecting the inventory during the identification pass the
 * step could only offer a blank pattern box. Once the SNMP session is
 * authenticated these are two more walks, which is the cheapest moment this
 * will ever be available.
 *
 * The output shape is deliberately the resolver's input shape
 * (`ResolverInterface` in autoMonitorInterfacesService) so the SAME pure
 * `resolvePinnedInterfaces` / `resolvePinnedStorage` decide what a selection
 * pins, whether the names came from a scan or from a polled asset. Nothing
 * here writes to `AssetInterface` — the scan's rows describe a device that is
 * not an asset yet.
 *
 * Pure: takes rows, returns rows. The walking lives in the scan runner.
 */

import { ifStatusLabel, snmpIfTypeLabel } from "./ifMib.js";

/** One row of an `snmpWalkRaw` result (shape kept local — no service import). */
export interface SnmpRow {
  oid: string;
  value: string;
  type?: string;
}

/** IF-MIB / IF-MIB-EXT / HOST-RESOURCES-MIB column OIDs the scan walks. */
export const INVENTORY_OIDS = {
  /** ifDescr — present on every agent. */
  ifDescr:      "1.3.6.1.2.1.2.2.1.2",
  /** ifType — decoded through the shared snmpIfTypeLabel. */
  ifType:       "1.3.6.1.2.1.2.2.1.3",
  /** ifOperStatus — the resolver's `onlyUp` filter reads this. */
  ifOperStatus: "1.3.6.1.2.1.2.2.1.8",
  /** ifName (ifXTable) — the short form operators actually pin by. */
  ifName:       "1.3.6.1.2.1.31.1.1.1.1",
  /** hrStorageDescr — the mount path / volume label. */
  hrStorageDescr: "1.3.6.1.2.1.25.2.3.1.3",
  /** hrStorageType — used only to drop the non-disk rows. */
  hrStorageType:  "1.3.6.1.2.1.25.2.3.1.2",
} as const;

/** What a scan learned about one interface. Mirrors ResolverInterface. */
export interface ScanInterface {
  ifName: string;
  ifType: string | null;
  operStatus: string | null;
}

/** What a scan learned about one storage mount. */
export interface ScanStorageMount {
  mountPath: string;
}

/**
 * HOST-RESOURCES-MIB hrStorageType values that are real storage rather than
 * memory. `hrStorageRam` / `hrStorageVirtualMemory` / the buffer and cache
 * pseudo-rows all live in the same table, and pinning "Physical memory" as a
 * storage mount would be nonsense — so this is an ALLOW list (fixedDisk,
 * networkDisk, removableDisk, flashMemory), not a deny list.
 */
const STORAGE_TYPE_ALLOW = new Set([4, 5, 10, 11]);
const HR_STORAGE_TYPE_PREFIX = "1.3.6.1.2.1.25.2.1.";

/** Caps. A chassis can publish thousands of ifIndexes; the picker needs tens. */
export const MAX_SCAN_INTERFACES = 500;
const MAX_SCAN_STORAGE = 100;

/** Strip a leading dot and the column prefix, leaving the index suffix. */
function indexSuffix(oid: string, column: string): string | null {
  const clean = oid.startsWith(".") ? oid.slice(1) : oid;
  if (!clean.startsWith(column + ".")) return null;
  const suffix = clean.slice(column.length + 1);
  return suffix.length ? suffix : null;
}

/** Index a walk's rows by their OID index suffix for one column. */
function byIndex(rows: SnmpRow[], column: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows || []) {
    if (!row || typeof row.oid !== "string") continue;
    const idx = indexSuffix(row.oid, column);
    if (idx == null) continue;
    // First row wins — a re-walk that appended must not let a later empty
    // answer overwrite a good one (the parseSnmpIdentity rule).
    if (!out.has(idx)) out.set(idx, typeof row.value === "string" ? row.value : String(row.value ?? ""));
  }
  return out;
}

function toInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function tidyName(raw: string | undefined): string | null {
  if (raw == null) return null;
  // Collapse whitespace but keep the name verbatim otherwise — an operator
  // pins by exactly what the device calls the port.
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > 128 ? s.slice(0, 128) : s;
}

/**
 * Build the interface list from the four column walks.
 *
 * **ifName is preferred over ifDescr, and that choice is load-bearing.**
 * ifXTable's ifName is the short form a config file and an operator both use
 * ("port3", "Gi1/0/3"); ifDescr on the same port is often a sentence
 * ("GigabitEthernet1/0/3 Interface, Hardware is ..."). The auto-monitor
 * selection stores NAMES, so pinning by ifDescr would produce pins that match
 * nothing once the device is polled through the normal collector, which itself
 * prefers ifName. ifDescr is the fallback for the agents that publish no
 * ifXTable at all.
 *
 * Rows with neither name are DROPPED rather than given a synthetic
 * "ifIndex 7" label: a pin set keyed on a made-up name would silently match
 * nothing.
 */
export function parseScanInterfaces(rows: {
  ifName?: SnmpRow[];
  ifDescr?: SnmpRow[];
  ifType?: SnmpRow[];
  ifOperStatus?: SnmpRow[];
}): { interfaces: ScanInterface[]; truncated: boolean } {
  const names = byIndex(rows.ifName ?? [], INVENTORY_OIDS.ifName);
  const descrs = byIndex(rows.ifDescr ?? [], INVENTORY_OIDS.ifDescr);
  const types = byIndex(rows.ifType ?? [], INVENTORY_OIDS.ifType);
  const opers = byIndex(rows.ifOperStatus ?? [], INVENTORY_OIDS.ifOperStatus);

  // Every index either walk mentioned, ordered numerically so the picker reads
  // like the device's own port list rather than lexically (port10 before port2).
  const indexes = Array.from(new Set([...names.keys(), ...descrs.keys(), ...types.keys(), ...opers.keys()]))
    .sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });

  const seen = new Set<string>();
  const interfaces: ScanInterface[] = [];
  let truncated = false;
  for (const idx of indexes) {
    const ifName = tidyName(names.get(idx)) ?? tidyName(descrs.get(idx));
    if (!ifName) continue;
    // Two ifIndexes reporting one name (seen on stacked switches publishing a
    // management alias twice) collapse to one pickable entry.
    if (seen.has(ifName)) continue;
    if (interfaces.length >= MAX_SCAN_INTERFACES) { truncated = true; break; }
    seen.add(ifName);
    interfaces.push({
      ifName,
      ifType: snmpIfTypeLabel(toInt(types.get(idx))),
      operStatus: ifStatusLabel(toInt(opers.get(idx))),
    });
  }
  return { interfaces, truncated };
}

/**
 * Build the storage-mount list from the hrStorageTable walks.
 *
 * The type column is walked purely to EXCLUDE the memory rows that share the
 * table (RAM, virtual memory, buffers, cache). When the type walk answered
 * nothing at all — plenty of agents publish hrStorageDescr and not much else —
 * every descr row is kept: dropping them would leave the picker empty on a
 * device that plainly reported its volumes.
 */
export function parseScanStorage(rows: {
  hrStorageDescr?: SnmpRow[];
  hrStorageType?: SnmpRow[];
}): { storage: ScanStorageMount[]; truncated: boolean } {
  const descrs = byIndex(rows.hrStorageDescr ?? [], INVENTORY_OIDS.hrStorageDescr);
  const types = byIndex(rows.hrStorageType ?? [], INVENTORY_OIDS.hrStorageType);
  const haveTypes = types.size > 0;

  const seen = new Set<string>();
  const storage: ScanStorageMount[] = [];
  let truncated = false;
  const indexes = Array.from(descrs.keys()).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  for (const idx of indexes) {
    const mountPath = tidyName(descrs.get(idx));
    if (!mountPath) continue;
    if (haveTypes) {
      const typeOid = (types.get(idx) ?? "").trim().replace(/^\./, "");
      // The type is an OID, not an integer: hrStorageFixedDisk is
      // 1.3.6.1.2.1.25.2.1.4. An unparseable value keeps the row (see above).
      if (typeOid.startsWith(HR_STORAGE_TYPE_PREFIX)) {
        const leaf = Number(typeOid.slice(HR_STORAGE_TYPE_PREFIX.length).split(".")[0]);
        if (Number.isFinite(leaf) && !STORAGE_TYPE_ALLOW.has(leaf)) continue;
      }
    }
    if (seen.has(mountPath)) continue;
    if (storage.length >= MAX_SCAN_STORAGE) { truncated = true; break; }
    seen.add(mountPath);
    storage.push({ mountPath });
  }
  return { storage, truncated };
}
