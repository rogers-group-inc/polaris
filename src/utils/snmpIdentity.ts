/**
 * src/utils/snmpIdentity.ts
 *
 * Turn an SNMPv2-MIB **system group** walk into asset fields.
 *
 * Nothing in Polaris did this before. Every existing consumer of the system
 * group reads exactly one object — `sysUpTime` for the reachability probe,
 * `sysLocation` over the FortiOS REST API — and the only sysDescr/sysName in
 * the codebase are the LLDP *remote*-neighbour columns, which describe someone
 * else's device. A Discovery (business rule 34) needs the opposite: an address
 * answered SNMP, so who is it?
 *
 * Input is the row list from `snmpWalkRaw(host, config, "1.3.6.1.2.1.1", n)`,
 * which is already the operator walk route's default base OID, so one walk
 * yields the whole group.
 *
 * Two deliberate limits:
 *
 *  - **The vendor table is small and explicit, and an unknown arc returns
 *    nothing.** `sysObjectID`'s enterprise number is a registry with tens of
 *    thousands of entries; shipping a partial copy that guesses would put a
 *    wrong manufacturer on a device an operator then never re-checks, whereas
 *    an empty field is one they fill in. Downstream normalization is free:
 *    `normalizeManufacturer` is applied at the DB layer by the `db.ts`
 *    extension, so a name here only has to be close.
 *
 *  - **A model comes from a FORMAT, never from a pattern.** The system group
 *    has no model object, and a cross-vendor regex over sysDescr ("the token
 *    after the vendor word") fails silently on the vendors it wasn't written
 *    for. But some vendors publish a fixed delimited sysDescr whose fields are
 *    positional by specification — an AXIS camera states its model, product
 *    type and firmware in known slots — and reading that is parsing, not
 *    guessing. Those layouts live in `utils/snmpDescrIdentity.ts`, one entry
 *    per vendor whose format is documented, and a string that doesn't match
 *    its vendor's layout yields nothing. A vendor-specific scalar (the
 *    `modelIdentity` shape in vendorTelemetryProfiles, e.g. FortiSwitch
 *    `fsSysVersion`) is still the better source where one exists; this covers
 *    the equipment that publishes no private MIB worth walking.
 */

import { parseVendorSysDescr } from "./snmpDescrIdentity.js";

/** The system-group objects worth reading. Scalars, hence the trailing .0. */
export const SYS_OIDS = {
  sysDescr:    "1.3.6.1.2.1.1.1.0",
  sysObjectID: "1.3.6.1.2.1.1.2.0",
  sysUpTime:   "1.3.6.1.2.1.1.3.0",
  sysContact:  "1.3.6.1.2.1.1.4.0",
  sysName:     "1.3.6.1.2.1.1.5.0",
  sysLocation: "1.3.6.1.2.1.1.6.0",
} as const;

/** Shape of one `snmpWalkRaw` row (kept local — no import back into services). */
export interface SnmpIdentityRow {
  oid: string;
  value: string;
  type?: string;
}

export interface SnmpIdentity {
  /** sysName, trimmed. May be an FQDN — the projection layer decides. */
  hostname?: string;
  /** sysDescr, whitespace-collapsed and bounded. */
  os?: string;
  /** Resolved from sysObjectID's enterprise arc, else sysDescr's vendor word. */
  manufacturer?: string;
  /** Model, only when the vendor publishes a sysDescr format we can read. */
  model?: string;
  /** Firmware version, from that same format. Asset.osVersion's other name. */
  osVersion?: string;
  /** The vendor's own words for what the device is ("Bullet Camera"). */
  productType?: string;
  /** sysLocation, unless it is a vendor placeholder. */
  snmpLocation?: string;
  /** sysContact, unless it is a vendor placeholder. */
  contact?: string;
  /** Raw sysObjectID, kept for provenance — it identifies the exact model row. */
  sysObjectId?: string;
  /** The enterprise number out of sysObjectID, whether or not it is named. */
  enterpriseNumber?: number;
  /** sysUpTime converted from TimeTicks (hundredths of a second). */
  uptimeSec?: number;
}

/**
 * Enterprise number → vendor name.
 *
 * IANA Private Enterprise Numbers — a public registry fact, not vendor MIB
 * knowledge, which is why this table is the ONE place an enterprise arc may
 * be spelled in `src/` (tests/unit/noEnterpriseOids.test.ts). The number
 * names a vendor; it is never walked, and the telemetry OIDs under it come
 * from the MIB the operator uploads. Covers the vendors Polaris has built-in
 * profiles for plus the ones that turn up on the equipment this feature
 * exists for — PDUs, UPSes, environmental sensors, print devices. Anything
 * not here resolves to `undefined`, never a guess.
 */
export const SNMP_ENTERPRISE_VENDORS: Record<number, string> = {
  9:     "Cisco",
  11:    "HP",
  43:    "3Com",
  171:   "D-Link",
  207:   "Allied Telesis",
  232:   "Hewlett Packard Enterprise",
  253:   "Xerox",
  311:   "Microsoft",
  318:   "APC",
  // 368 is Axis Communications AB (IANA PEN registry). It read "ServerTech"
  // here until 2026-09 — Server Technology is 1718, below — which put the
  // wrong manufacturer on every AXIS camera a Discovery found, and did it
  // via the branch that is hardest to notice: the arc outranks the vendor
  // word in sysDescr, so a camera plainly describing itself as AXIS was
  // still adopted as a PDU vendor's device.
  368:   "Axis Communications",
  534:   "Eaton",
  664:   "Adtran",
  674:   "Dell",
  789:   "NetApp",
  1588:  "Brocade",
  1602:  "Canon",
  1718:  "Server Technology",
  1872:  "Arista",
  1916:  "Extreme Networks",
  1991:  "Foundry",
  2011:  "Huawei",
  2021:  "Net-SNMP",
  2435:  "Brother",
  2636:  "Juniper",
  4526:  "Netgear",
  6027:  "Force10",
  6574:  "Geist",
  8072:  "Net-SNMP",
  10418: "Avocent",
  12148: "Sensaphone",
  12356: "Fortinet",
  14179: "Airespace",
  14988: "MikroTik",
  17095: "Raritan",
  18334: "Konica Minolta",
  20916: "Vertiv",
  21317: "Tripp Lite",
  25506: "H3C",
  30065: "Arista",
  34097: "Ruckus",
  41112: "Ubiquiti",
  47196: "Meraki",
} as const;

/**
 * Vendor words recognizable in sysDescr, for devices whose sysObjectID sits on
 * an arc we don't name (a reseller's OEM number, or an agent reporting the
 * generic Net-SNMP arc while describing real hardware). Matched
 * case-insensitively as a whole word, longest first so "Hewlett Packard
 * Enterprise" wins over "Hewlett".
 */
const DESCR_VENDOR_WORDS: string[] = [
  "Hewlett Packard Enterprise", "Hewlett-Packard", "Allied Telesis", "Extreme Networks",
  "Konica Minolta", "Tripp Lite", "Palo Alto", "Check Point", "Digital Loggers",
  "Cisco", "Juniper", "Fortinet", "FortiGate", "FortiSwitch", "MikroTik", "Ubiquiti",
  "Aruba", "Arista", "Brocade", "Netgear", "D-Link", "TP-Link", "Zyxel", "Huawei",
  "Dell", "Lenovo", "Supermicro", "NetApp", "Synology", "QNAP",
  "APC", "Eaton", "Vertiv", "Liebert", "Raritan", "ServerTech", "Geist",
  "Xerox", "Canon", "Brother", "Lexmark", "Ricoh", "Kyocera", "Zebra",
  "Axis", "Hikvision", "Dahua", "Avigilon",
  "Siemens", "Schneider", "Rockwell", "Moxa", "Advantech",
  "VMware", "Microsoft", "Ruckus", "Meraki", "Sophos", "WatchGuard", "SonicWall",
];

/**
 * Placeholder values shipped by SNMP agents that nobody configured. Storing
 * these is worse than storing nothing: "Sitting on the Dock of the Bay" in an
 * asset's Location reads as data, and an operator filtering on location would
 * see a site that does not exist. Same reasoning as the vendor-placeholder
 * serial rejection in utils/hardwareIdentity.ts.
 */
const PLACEHOLDER_TEXT = new Set([
  // net-snmp's compiled-in defaults, by far the most common.
  "sitting on the dock of the bay",
  "me <me@example.org>",
  "root <root@localhost> (configure /etc/snmp/snmpd.local.conf)",
  "root",
  "unknown",
  "unknown (edit /etc/snmp/snmpd.conf)",
  "not set",
  "notset",
  "n/a",
  "none",
  "<private>",
  "system location not set",
  "system contact not set",
  "configure sysdescr",
]);

/** Longest field we keep. sysDescr in particular can run to a paragraph. */
const MAX_TEXT = 512;

/** Collapse whitespace (sysDescr is routinely multi-line) and bound length. */
function tidy(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** tidy(), but drop the well-known unconfigured-agent placeholders. */
function tidyMeaningful(raw: string | undefined): string | undefined {
  const s = tidy(raw);
  if (!s) return undefined;
  return PLACEHOLDER_TEXT.has(s.toLowerCase()) ? undefined : s;
}

/**
 * Enterprise number out of a sysObjectID.
 *
 * `1.3.6.1.4.1.<enterprise>.…` — anything not under the enterprises arc
 * (a device answering with a mib-2 OID, or garbage) yields null.
 */
export function enterpriseFromSysObjectId(sysObjectId: string | undefined): number | null {
  if (!sysObjectId) return null;
  const m = /^(?:\.)?1\.3\.6\.1\.4\.1\.(\d+)(?:\.|$)/.exec(sysObjectId.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Vendor name for a sysObjectID, or undefined when the arc isn't one we name. */
export function vendorFromSysObjectId(sysObjectId: string | undefined): string | undefined {
  const n = enterpriseFromSysObjectId(sysObjectId);
  if (n == null) return undefined;
  return SNMP_ENTERPRISE_VENDORS[n];
}

/**
 * Vendor word out of a sysDescr. Whole-word match so "Cisconnect" is not
 * Cisco; longest candidate first so a multi-word vendor isn't shadowed by its
 * own first word.
 */
export function vendorFromSysDescr(sysDescr: string | undefined): string | undefined {
  const s = tidy(sysDescr);
  if (!s) return undefined;
  const ordered = [...DESCR_VENDOR_WORDS].sort((a, b) => b.length - a.length);
  for (const word of ordered) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(s)) return word;
  }
  return undefined;
}

/** Index the walk rows by OID, tolerating a leading dot and duplicate rows. */
function indexRows(rows: SnmpIdentityRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows || []) {
    if (!row || typeof row.oid !== "string") continue;
    const oid = row.oid.startsWith(".") ? row.oid.slice(1) : row.oid;
    // First row wins: a re-walk that appended rows must not let a later,
    // emptier answer overwrite a good one.
    if (!out.has(oid)) out.set(oid, typeof row.value === "string" ? row.value : String(row.value ?? ""));
  }
  return out;
}

/**
 * Parse a system-group walk into asset fields.
 *
 * Pure. Never throws — a device that answers half the group yields a partial
 * identity, which is exactly what the Results step should show rather than
 * failing the whole hit.
 */
export function parseSnmpIdentity(rows: SnmpIdentityRow[]): SnmpIdentity {
  const byOid = indexRows(rows);
  const out: SnmpIdentity = {};

  const hostname = tidyMeaningful(byOid.get(SYS_OIDS.sysName));
  if (hostname) out.hostname = hostname;

  const descr = tidy(byOid.get(SYS_OIDS.sysDescr));
  if (descr) out.os = descr;

  const sysObjectId = tidy(byOid.get(SYS_OIDS.sysObjectID));
  if (sysObjectId) {
    out.sysObjectId = sysObjectId;
    const enterprise = enterpriseFromSysObjectId(sysObjectId);
    if (enterprise != null) out.enterpriseNumber = enterprise;
  }

  // sysObjectID first: it is a registered assignment, whereas a vendor word in
  // sysDescr can name the OS ("Cisco IOS") on someone else's hardware, or the
  // agent ("Net-SNMP") rather than the box. The descr fallback matters for
  // OEM/reseller arcs we don't name — but Net-SNMP's own arc is deliberately
  // NOT trusted over the description for the same reason, so when the arc
  // resolves to Net-SNMP we still prefer a real vendor word if the descr has one.
  // A vendor whose own sysDescr FORMAT we can read (utils/snmpDescrIdentity)
  // supplies the model and firmware the system group has no object for, and
  // names itself while it is at it — so it takes the description's side of the
  // precedence rule below, ahead of the bare word match, having proved the
  // vendor by parsing the layout rather than by spotting a word.
  const detail = parseVendorSysDescr(descr);
  if (detail?.model) out.model = detail.model;
  if (detail?.osVersion) out.osVersion = detail.osVersion;
  if (detail?.productType) out.productType = detail.productType;

  const arcVendor = vendorFromSysObjectId(sysObjectId);
  const descrVendor = detail?.manufacturer ?? vendorFromSysDescr(descr);
  const arcIsGenericAgent = arcVendor === "Net-SNMP";
  const manufacturer = arcIsGenericAgent ? (descrVendor ?? arcVendor) : (arcVendor ?? descrVendor);
  if (manufacturer) out.manufacturer = manufacturer;

  const location = tidyMeaningful(byOid.get(SYS_OIDS.sysLocation));
  if (location) out.snmpLocation = location;

  const contact = tidyMeaningful(byOid.get(SYS_OIDS.sysContact));
  if (contact) out.contact = contact;

  // TimeTicks are hundredths of a second. A negative or non-numeric reading is
  // dropped rather than stored as 0 — "up for no time at all" is a claim.
  // Note the empty-string guard: Number("") is 0, so an agent that answers the
  // OID with no value would otherwise report "just rebooted".
  const ticksRaw = byOid.get(SYS_OIDS.sysUpTime);
  const ticksText = ticksRaw == null ? "" : String(ticksRaw).trim();
  if (ticksText !== "") {
    const ticks = Number(ticksText);
    if (Number.isFinite(ticks) && ticks >= 0) out.uptimeSec = Math.floor(ticks / 100);
  }

  return out;
}

/** True when the walk said anything usable about the device. */
export function hasSnmpIdentity(identity: SnmpIdentity): boolean {
  return !!(identity.hostname || identity.os || identity.manufacturer || identity.sysObjectId);
}
