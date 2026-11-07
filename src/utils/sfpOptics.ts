/**
 * src/utils/sfpOptics.ts
 *
 * Attributing ENTITY-SENSOR-MIB transceiver (SFP DDM) readings to the port they
 * belong to, on agents that publish them as anonymous groups of five.
 *
 * Why this is inference, and why it is allowed: RFC 3433 sensors are joined to
 * a port through ENTITY-MIB (entPhysicalContainedIn → entAliasMappingIdentifier
 * → ifIndex). FortiSwitchOS publishes neither link — every sensor's parent is
 * the chassis, the alias table maps only the CPU port, and entPhysicalName /
 * Descr are positional labels that can be wrong even about the reading's type.
 * What it DOES publish, validated against `get switch modules status` on an
 * FSW-148F and an FSR-112F-POE (2026-11-06), is a fixed layout:
 *
 *   - each SFP cage is five consecutive rows: temperature, volts, Tx dBm,
 *     Rx dBm, bias current — always in that order;
 *   - an EMPTY cage still emits its five rows (oper status unavailable), so the
 *     k-th group is the k-th cage whether or not a module is seated;
 *   - the cages are the highest-numbered front ports (port9..12 on a 12-port
 *     model, port49..52 on a 52-port one).
 *
 * So the attribution is a convention, guarded (business rule 143): it applies
 * only when the table matches that layout exactly, the groups form one unbroken
 * run, there are at least as many `portN` interfaces as groups, and no empty
 * cage lands on a port whose link is up (an empty cage cannot carry a link —
 * the cheapest contradiction the device itself can show us). Any failure maps
 * nothing, and the readings stay ordinary Hardware Sensors rows; nothing is
 * ever guessed onto a neighbouring port.
 *
 * Kept dependency-free (no Prisma, no SNMP types) so it unit-tests directly,
 * matching utils/poePorts.ts and utils/hardwareSensors.ts.
 */

/** The five readings of one transceiver, in the order the agent publishes them. */
export type SfpOpticRole = "temperature" | "voltage" | "txPower" | "rxPower" | "bias";

const SFP_BLOCK_LAYOUT: readonly SfpOpticRole[] = ["temperature", "voltage", "txPower", "rxPower", "bias"];

/**
 * The label appended to the port name to form the stored sensorName
 * (`port10 Rx power`). The stored name is how history, charts and automation
 * sensor-name patterns address a reading, so these strings are a contract:
 * renaming one orphans that reading's history.
 */
const SFP_ROLE_LABELS: Readonly<Record<SfpOpticRole, string>> = {
  temperature: "SFP temperature",
  voltage:     "SFP voltage",
  txPower:     "Tx power",
  rxPower:     "Rx power",
  bias:        "Bias current",
};

/** One ENTITY-SENSOR row, reduced to what the layout check reads. */
export interface EntitySensorLayoutRow {
  /** entPhysicalIndex — the table's row index. */
  index:        number;
  /** entPhySensorType (RFC 3433 EntitySensorDataType), or null when unreported. */
  typeCode:     number | null;
  /** entPhySensorUnitsDisplay, or null. */
  unitsDisplay: string | null;
  /** entPhySensorOperStatus: ok(1) unavailable(2) nonoperational(3). */
  operStatus:   number | null;
}

/** An interface as IF-MIB reports it: name and ifOperStatus (up(1) down(2) …). */
export interface LayoutInterface {
  ifName:     string;
  operStatus: number | null;
}

export interface SfpAttribution {
  ifName: string;
  role:   SfpOpticRole;
}

/**
 * What one row MEASURES, from the strongest evidence first. The units-display
 * string wins because FortiSwitchOS has been seen stamping one type code on
 * every row (see entityTypeColumnTrusted); the type code is the fallback.
 */
function rowKind(r: EntitySensorLayoutRow): "temperature" | "voltage" | "dbm" | "current" | null {
  const u = (r.unitsDisplay ?? "").trim().toLowerCase();
  if (/\bdbm\b/.test(u))                   return "dbm";
  if (/amp/.test(u))                       return "current";
  if (/volt/.test(u))                      return "voltage";
  if (u === "c" || /celsius/.test(u))      return "temperature";
  if (u !== "") return null;               // a stated unit that is none of the four
  switch (r.typeCode) {
    case 8: return "temperature";
    case 3:
    case 4: return "voltage";
    case 5: return "current";
    default: return null;                  // dBm has no type code (RFC 3433)
  }
}

const BLOCK_KINDS = ["temperature", "voltage", "dbm", "dbm", "current"] as const;

/** Front-panel port number of a `portN` ifName, or null for anything else. */
function frontPortNumber(ifName: string): number | null {
  const m = /^port(\d+)$/.exec(ifName.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Map ENTITY-SENSOR rows to (port, role), or return an empty map when the
 * layout is not the one this convention was validated on. Pure.
 *
 * @param rows        every ENTITY-SENSOR row of the device, any order
 * @param interfaces  the device's IF-MIB interfaces (ifName + ifOperStatus)
 * @returns           entPhysicalIndex → attribution, for the SFP rows only
 */
export function attributeSfpSensors(
  rows: readonly EntitySensorLayoutRow[],
  interfaces: readonly LayoutInterface[],
): Map<number, SfpAttribution> {
  const out = new Map<number, SfpAttribution>();
  const sorted = [...rows].sort((a, b) => a.index - b.index);

  // Find every five-row group whose indexes are consecutive and whose kinds
  // read temperature, volts, dBm, dBm, current.
  const blocks: EntitySensorLayoutRow[][] = [];
  for (let i = 0; i + BLOCK_KINDS.length <= sorted.length; ) {
    const cand = sorted.slice(i, i + BLOCK_KINDS.length);
    const consecutive = cand.every((r, k) => r.index === cand[0].index + k);
    const shaped = cand.every((r, k) => rowKind(r) === BLOCK_KINDS[k]);
    if (consecutive && shaped) {
      blocks.push(cand);
      i += BLOCK_KINDS.length;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) return out;

  // One unbroken run: cages are published back to back. A gap means the table
  // is shaped differently from the validated layout, and a later group can no
  // longer be counted as "the k-th cage".
  for (let b = 1; b < blocks.length; b++) {
    if (blocks[b][0].index !== blocks[b - 1][0].index + BLOCK_KINDS.length) return out;
  }
  // A dBm row outside every group is a transceiver reading the layout cannot
  // place — the table is not the shape the convention describes.
  const placed = new Set(blocks.flat().map((r) => r.index));
  if (sorted.some((r) => rowKind(r) === "dbm" && !placed.has(r.index))) return out;

  const ports = interfaces
    .map((i) => ({ ...i, n: frontPortNumber(i.ifName) }))
    .filter((i): i is LayoutInterface & { n: number } => i.n != null)
    .sort((a, b) => a.n - b.n);
  if (ports.length < blocks.length) return out;
  const cagePorts = ports.slice(ports.length - blocks.length);

  // The contradiction check: an empty cage (every row unavailable) cannot hold
  // a link, so if its port is up the mapping is wrong for this model.
  for (let b = 0; b < blocks.length; b++) {
    const empty = blocks[b].every((r) => r.operStatus === 2);
    if (empty && cagePorts[b].operStatus === 1) return out;
  }

  blocks.forEach((block, b) => {
    block.forEach((r, k) => out.set(r.index, { ifName: cagePorts[b].ifName, role: SFP_BLOCK_LAYOUT[k] }));
  });
  return out;
}

/** The stored sensorName for an attributed reading: `port10 Rx power`. */
export function sfpSensorName(ifName: string, role: SfpOpticRole): string {
  return `${ifName} ${SFP_ROLE_LABELS[role]}`;
}

/**
 * Recover the role from a stored sample that carries an ifName — the inverse
 * of `sfpSensorName`, used by the read path to fold samples into the
 * interface row. Null when the name is not one this module wrote.
 */
export function sfpRoleFromSensorName(sensorName: string, ifName: string): SfpOpticRole | null {
  const prefix = `${ifName} `;
  if (!sensorName.startsWith(prefix)) return null;
  const label = sensorName.slice(prefix.length);
  for (const role of SFP_BLOCK_LAYOUT) {
    if (SFP_ROLE_LABELS[role] === label) return role;
  }
  return null;
}

/** Per-port transceiver readings as the interface table carries them. */
export interface InterfaceOptics {
  temperatureC: number | null;
  voltage:      number | null;
  txDbm:        number | null;
  rxDbm:        number | null;
  /** Base amperes, as stored; the UI renders mA. */
  biasA:        number | null;
}

/**
 * Split the latest hardware-sensor samples into the rows the Hardware Sensors
 * table keeps and the per-interface optics the Interfaces table shows.
 *
 * A sample moves only when it carries an ifName, its name decodes to a role,
 * AND that ifName is an interface this asset actually has — a reading whose
 * port is missing from the interface inventory stays visible as a sensor
 * rather than disappearing from both tables.
 */
export function splitOpticsSamples<T extends { sensorName: string; ifName?: string | null; value: number | null }>(
  samples: readonly T[],
  interfaceNames: ReadonlySet<string>,
): { sensors: T[]; optics: Map<string, InterfaceOptics> } {
  const sensors: T[] = [];
  const optics = new Map<string, InterfaceOptics>();
  const FIELD: Record<SfpOpticRole, keyof InterfaceOptics> = {
    temperature: "temperatureC",
    voltage:     "voltage",
    txPower:     "txDbm",
    rxPower:     "rxDbm",
    bias:        "biasA",
  };
  for (const s of samples) {
    const ifName = s.ifName ?? null;
    const role = ifName && interfaceNames.has(ifName) ? sfpRoleFromSensorName(s.sensorName, ifName) : null;
    if (!ifName || !role) { sensors.push(s); continue; }
    let o = optics.get(ifName);
    if (!o) {
      o = { temperatureC: null, voltage: null, txDbm: null, rxDbm: null, biasA: null };
      optics.set(ifName, o);
    }
    o[FIELD[role]] = s.value;
  }
  return { sensors, optics };
}
