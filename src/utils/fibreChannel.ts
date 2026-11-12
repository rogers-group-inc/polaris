/**
 * src/utils/fibreChannel.ts
 *
 * Pure half of business rule 159: what a fibre-channel switch says about the
 * devices logged into its ports, and which asset each one is.
 *
 * The collector walks four Cisco tables and hands the raw rows here:
 *
 *  - CISCO-FC-FE-MIB `fcIfFLoginTable` — one row per logged-in N_Port,
 *    indexed `ifIndex.vsan.loginIndex`, carrying its port and node WWNs;
 *  - CISCO-FC-FE-MIB `fcIfErrorTable` — per-port error counters, indexed
 *    `ifIndex`. Its presence is what says "this device is an FC switch";
 *  - CISCO-NS-MIB `fcNameServerTable` — indexed `vsan.d.a.p` (the FC address),
 *    carrying the port WWN and the symbolic node name the HBA registered;
 *  - CISCO-FDMI-MIB `cfdmiHbaPortTable` — indexed `vsan.<hba id 8>.<port wwn 8>`,
 *    carrying the host name the HBA registered.
 *
 * Rows are joined on the PORT WWN, never on the login index (the MIB calls it
 * "an arbitrary value") or on the FC address alone.
 *
 * Matching a login to an asset (`pickHostMatch`) is by the registered host
 * name only, and only when exactly one asset answers to it (business rule 91:
 * a name is not an identity). A FQDN must match a FQDN exactly; a short name
 * matches an asset's short name. Two candidates is no match, never a guess.
 */

/** Longest registered string kept. Bounds a malformed agent. */
const MAX_TEXT = 255;

/**
 * A WWN as a host spelled it → "10:00:5c:ba:2c:ff:ac:5a", or null. Accepts
 * Linux sysfs (`0x10000090fa1b2c3d`), Windows' bare hex (`10000090FA1B2C3D`)
 * and the colon / dash forms. All-zero and all-ones (sysfs's
 * "not attached" fabric name) are no WWN.
 */
export function normalizeWwn(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const hex = String(raw).trim().toLowerCase().replace(/^0x/, "").replace(/[:\-\s]/g, "");
  if (!/^[0-9a-f]{16}$/.test(hex)) return null;
  if (/^0+$/.test(hex) || /^f+$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}

/**
 * vSphere's `portWorldWideName` / `nodeWorldWideName` are xsd:long — the
 * 64-bit WWN as a SIGNED decimal (an NAA-5 WWN such as 52:4a:… is negative).
 * Two's-complement back to the 16 hex digits.
 */
export function wwnFromVimLong(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^-?\d{1,20}$/.test(s)) return null;
  let n = BigInt(s);
  if (n < 0n) n += 1n << 64n;
  if (n < 0n || n >= 1n << 64n) return null;
  return normalizeWwn(n.toString(16).padStart(16, "0"));
}

/** 8 raw bytes → "10:00:5c:ba:2c:ff:ac:5a", or null for anything else / all-zero. */
export function wwnFromBytes(bytes: ArrayLike<number> | null | undefined): string | null {
  if (!bytes || bytes.length !== 8) return null;
  const out: string[] = [];
  let nonZero = false;
  for (let i = 0; i < 8; i++) {
    const b = Number(bytes[i]);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    if (b !== 0) nonZero = true;
    out.push(b.toString(16).padStart(2, "0"));
  }
  return nonZero ? out.join(":") : null;
}

/** Dotted OID suffix → integers, or null when any part is not one. */
function oidParts(suffix: string): number[] | null {
  const parts = suffix.replace(/^\./, "").split(".");
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

/** Three FC-address octets → "0xbf1f00". */
export function fcidFromParts(d: number, a: number, p: number): string | null {
  if (![d, a, p].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
  return "0x" + [d, a, p].map((n) => n.toString(16).padStart(2, "0")).join("");
}

/** Trim, collapse whitespace, bound; empty → null. */
function fcText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

/** What an Emulex HBA's symbolic node name states. */
export interface SymbolicNodeDetail {
  hbaModel?: string;
  hbaFirmware?: string;
  hbaDriver?: string;
  hostName?: string;
  osInfo?: string;
}

/**
 * Emulex's own symbolic node name layout, which its drivers (lpfc on Linux,
 * ESXi, Windows) register on every fabric login:
 *
 *   `Emulex SN1200E2P FV14.2.589.5 DV14.0.0.21 HN:host.example.com OS:Linux`
 *
 * Anchored on the vendor word and each field's own tag, so a reordered or
 * truncated string yields the fields it still carries and never a shifted
 * one. Any other vendor's string yields nothing: it stays verbatim in
 * `symbolicName` for the operator to read.
 */
export function parseSymbolicNodeName(raw: string | null | undefined): SymbolicNodeDetail {
  const s = fcText(raw);
  if (!s || !/^Emulex\s/i.test(s)) return {};
  const out: SymbolicNodeDetail = {};
  const model = /^(Emulex\s+\S+)/i.exec(s);
  if (model) out.hbaModel = model[1];
  const fw = /\bFV(\S+)/.exec(s);
  if (fw) out.hbaFirmware = fw[1];
  const dv = /\bDV(\S+)/.exec(s);
  if (dv) out.hbaDriver = dv[1];
  // HN: runs to the next " OS:" (it may be empty: "HN:OS:VMware ESXi").
  const hn = /\bHN:(.*?)(?:\s*OS:|$)/.exec(s);
  const host = hostNameOrNull(hn?.[1]);
  if (host) out.hostName = host;
  const os = /\bOS:(.*)$/.exec(s);
  const osText = fcText(os?.[1]);
  if (osText) out.osInfo = osText;
  return out;
}

/**
 * A registered host name worth matching on, or null. An empty value, or one
 * that is only a domain (".example.com" — a host whose short name was never
 * set), names no host.
 */
export function hostNameOrNull(raw: string | null | undefined): string | null {
  const s = fcText(raw);
  if (!s || s.startsWith(".") || /\s/.test(s)) return null;
  return s;
}

/**
 * Per-port cumulative error counters (fcIfErrorTable). A type alias, not an
 * interface, so it is assignable to Prisma's JSON input (an interface has no
 * implicit index signature) — it is stored as JSON on the interface sample.
 */
export type FcErrorCounters = {
  linkFailures: number | null;
  syncLosses: number | null;
  sigLosses: number | null;
  invalidTxWords: number | null;
  invalidCrcs: number | null;
  linkResetIns: number | null;
  linkResetOuts: number | null;
};

/**
 * Each counter and the CISCO-FC-FE-MIB symbol it is read from. Symbols, not
 * OIDs: a vendor's OIDs resolve from the MIB the operator uploaded
 * (`oidRegistry.resolveOidSync`), never from a literal in src/.
 */
export const FC_ERROR_COLUMNS: ReadonlyArray<[keyof FcErrorCounters, string]> = [
  ["linkFailures", "fcIfLinkFailures"],
  ["syncLosses", "fcIfSyncLosses"],
  ["sigLosses", "fcIfSigLosses"],
  ["invalidTxWords", "fcIfInvalidTxWords"],
  ["invalidCrcs", "fcIfInvalidCrcs"],
  ["linkResetIns", "fcIfLinkResetIns"],
  ["linkResetOuts", "fcIfLinkResetOuts"],
];

/** IANAifType fibreChannel(56): an interface whose fcIfErrorTable row is worth a GET. */
export const IFTYPE_FIBRE_CHANNEL = 56;

/**
 * The automation metrics over an FC port's counters (business rule 159a),
 * each the counter it reads. A rate per MINUTE: these counters move a handful
 * at a time on a failing optic, and "0.0003 errors/s" is a number nobody can
 * set a threshold on.
 */
export const FC_RATE_METRICS = {
  fcCrcErrorRate: "invalidCrcs",
  fcLinkFailureRate: "linkFailures",
  fcSyncLossRate: "syncLosses",
  fcSignalLossRate: "sigLosses",
  fcInvalidTxWordRate: "invalidTxWords",
} as const satisfies Record<string, keyof FcErrorCounters>;

export type FcRateMetric = keyof typeof FC_RATE_METRICS;

export function isFcRateMetric(metric: string | null | undefined): metric is FcRateMetric {
  return !!metric && Object.prototype.hasOwnProperty.call(FC_RATE_METRICS, metric);
}

/**
 * Stored counters (a JSON column) → the typed shape, keeping only finite
 * non-negative numbers. Null when nothing usable is there, so a row that
 * carries no FC reading never reads as "all counters zero".
 */
export function fcErrorsFrom(raw: unknown): FcErrorCounters | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out = {} as FcErrorCounters;
  let any = false;
  for (const [field] of FC_ERROR_COLUMNS) {
    const v = typeof src[field] === "string" ? Number(src[field]) : src[field];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[field] = v;
      any = true;
    } else {
      out[field] = null;
    }
  }
  return any ? out : null;
}

/** The other tables the collector walks, by MIB symbol. */
export const FC_SYMBOLS = {
  loginPortWwn: "fcIfNxPortName",           // CISCO-FC-FE-MIB
  loginNodeWwn: "fcIfNxPortNodeName",       // CISCO-FC-FE-MIB
  nsPortWwn:    "fcNameServerPortName",     // CISCO-NS-MIB
  nsSymbolic:   "fcNameServerSymbolicNodeName", // CISCO-NS-MIB
  fdmiHostName: "cfdmiHbaPortHostName",     // CISCO-FDMI-MIB
} as const;

export interface FcPortRow {
  ifIndex: number;
  ifName: string | null;
  errorCounters: FcErrorCounters;
}

export interface FcLoginRow {
  ifIndex: number;
  ifName: string | null;
  vsan: number;
  portWwn: string;
  nodeWwn: string | null;
  fcid: string | null;
  symbolicName: string | null;
  hostName: string | null;
  hbaModel: string | null;
  hbaFirmware: string | null;
  hbaDriver: string | null;
  osInfo: string | null;
}

/** The raw walks, keyed by OID suffix, values already decoded by the collector. */
export interface FcWalks {
  /** fcIfErrorTable columns: counter → (ifIndex suffix → number|null). */
  errors: Map<keyof FcErrorCounters, Map<string, number | null>>;
  /** fcIfNxPortName: `ifIndex.vsan.loginIndex` → 8 bytes. */
  loginPortWwn: Map<string, number[] | null>;
  /** fcIfNxPortNodeName: same index → 8 bytes. */
  loginNodeWwn: Map<string, number[] | null>;
  /** fcNameServerPortName: `vsan.d.a.p` → 8 bytes. */
  nsPortWwn: Map<string, number[] | null>;
  /** fcNameServerSymbolicNodeName: `vsan.d.a.p` → text. */
  nsSymbolic: Map<string, string | null>;
  /** cfdmiHbaPortHostName: `vsan.<8>.<8>` → text. */
  fdmiHostName: Map<string, string | null>;
}

/** Cap on stored rows per switch — a director-class chassis stays well under it. */
const FC_ROW_CAP = 2000;

/**
 * Join the walks into port rows and login rows. Pure. Ports are every ifIndex
 * the error table answered; logins every row of the login table with a
 * readable port WWN, named through the name server and FDMI by that WWN.
 */
export function buildFcInventory(
  walks: FcWalks,
  ifNameByIndex: ReadonlyMap<string, string>,
): { ports: FcPortRow[]; logins: FcLoginRow[] } {
  const nameOf = (ifIndex: number) => ifNameByIndex.get(String(ifIndex)) ?? null;

  const portIdx = new Set<string>();
  for (const col of walks.errors.values()) for (const k of col.keys()) portIdx.add(k);
  const ports: FcPortRow[] = [];
  for (const k of [...portIdx].sort((a, b) => Number(a) - Number(b))) {
    const ifIndex = Number(k);
    if (!Number.isInteger(ifIndex) || ports.length >= FC_ROW_CAP) continue;
    const counters = {} as FcErrorCounters;
    for (const [field] of FC_ERROR_COLUMNS) {
      const v = walks.errors.get(field)?.get(k);
      counters[field] = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    ports.push({ ifIndex, ifName: nameOf(ifIndex), errorCounters: counters });
  }

  // Name server and FDMI, keyed by port WWN.
  const nsByWwn = new Map<string, { fcid: string | null; symbolic: string | null }>();
  for (const [suffix, bytes] of walks.nsPortWwn) {
    const wwn = wwnFromBytes(bytes);
    const p = oidParts(suffix);
    if (!wwn || !p || p.length !== 4) continue;
    nsByWwn.set(wwn, { fcid: fcidFromParts(p[1], p[2], p[3]), symbolic: fcText(walks.nsSymbolic.get(suffix)) });
  }
  const fdmiByWwn = new Map<string, string>();
  for (const [suffix, text] of walks.fdmiHostName) {
    const p = oidParts(suffix);
    // vsan, then the HBA id (8 octets), then the port WWN (8 octets).
    if (!p || p.length !== 17) continue;
    const wwn = wwnFromBytes(p.slice(9, 17));
    const host = hostNameOrNull(text);
    if (wwn && host) fdmiByWwn.set(wwn, host);
  }

  const logins: FcLoginRow[] = [];
  for (const [suffix, bytes] of walks.loginPortWwn) {
    if (logins.length >= FC_ROW_CAP) break;
    const p = oidParts(suffix);
    const portWwn = wwnFromBytes(bytes);
    if (!p || p.length !== 3 || !portWwn) continue;
    const [ifIndex, vsan] = p;
    const ns = nsByWwn.get(portWwn);
    const sym = parseSymbolicNodeName(ns?.symbolic);
    logins.push({
      ifIndex,
      ifName: nameOf(ifIndex),
      vsan,
      portWwn,
      nodeWwn: wwnFromBytes(walks.loginNodeWwn.get(suffix)),
      fcid: ns?.fcid ?? null,
      symbolicName: ns?.symbolic ?? null,
      // FDMI is the HBA's own registration for exactly this purpose; the
      // symbolic name's HN: field is the fallback.
      hostName: fdmiByWwn.get(portWwn) ?? sym.hostName ?? null,
      hbaModel: sym.hbaModel ?? null,
      hbaFirmware: sym.hbaFirmware ?? null,
      hbaDriver: sym.hbaDriver ?? null,
      osInfo: sym.osInfo ?? null,
    });
  }
  logins.sort((a, b) => a.ifIndex - b.ifIndex || a.vsan - b.vsan || a.portWwn.localeCompare(b.portWwn));
  return { ports, logins };
}

/** An asset that might be the host a login names. */
export interface FcMatchCandidate {
  id: string;
  hostname: string | null;
  dnsName: string | null;
}

const shortOf = (n: string) => n.split(".")[0];

/**
 * Which asset a registered host name is, or null (business rule 91).
 *
 *  - An exact name match (hostname or DNS name, case-insensitive) wins when
 *    it is unique.
 *  - Otherwise short names are compared — but a FQDN on one side only meets a
 *    SHORT name on the other: `esx07.a.com` never matches `esx07.b.com`.
 *  - Two or more candidates at the deciding tier is no match.
 */
export function pickHostMatch(hostName: string | null, candidates: readonly FcMatchCandidate[], excludeId?: string): string | null {
  const n = hostNameOrNull(hostName)?.toLowerCase();
  if (!n) return null;
  const nIsFqdn = n.includes(".");
  const nShort = shortOf(n);
  const exact = new Set<string>();
  const loose = new Set<string>();
  for (const c of candidates) {
    if (c.id === excludeId) continue;
    for (const raw of [c.hostname, c.dnsName]) {
      const a = (raw ?? "").trim().toLowerCase();
      if (!a) continue;
      if (a === n) exact.add(c.id);
      else if (shortOf(a) === nShort && (!nIsFqdn || !a.includes("."))) loose.add(c.id);
    }
  }
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return null;
  return loose.size === 1 ? [...loose][0] : null;
}

/**
 * Which asset reports this port WWN as its own HBA, or null. Exact by
 * construction, so it outranks a name; but two assets claiming one WWN (a
 * cloned VM, a re-used HBA moved between hosts with a stale row) is still
 * no match, never a pick.
 */
export function pickWwnMatch(
  portWwn: string,
  hbaRows: ReadonlyArray<{ assetId: string; portWwn: string }>,
  excludeId?: string,
): string | null {
  const ids = new Set(hbaRows.filter((r) => r.portWwn === portWwn && r.assetId !== excludeId).map((r) => r.assetId));
  return ids.size === 1 ? [...ids][0] : null;
}

/** The names to look assets up by: each host name and its short form. */
export function hostLookupNames(hostNames: Iterable<string | null>): { exact: string[]; shorts: string[] } {
  const exact = new Set<string>();
  const shorts = new Set<string>();
  for (const h of hostNames) {
    const n = hostNameOrNull(h)?.toLowerCase();
    if (!n) continue;
    exact.add(n);
    shorts.add(shortOf(n));
  }
  return { exact: [...exact], shorts: [...shorts] };
}
