/**
 * src/utils/locationCodes.ts
 *
 * Physical-location codes embedded in FortiSwitch/FortiAP admin descriptions,
 * e.g. "a:Mine b:Shop f:2 r:North Closet ra:R2 jb:112-305":
 *
 *   a: area    b: building    f: floor    r: room    ra: rack    jb: junction box
 *
 * Hierarchy (outermost first): area > building > floor > room > rack >
 * junction box. `ra:` was added 2026-11-10 (operator request); `r:` still
 * means room — a key matches only when the colon follows it directly, so
 * "ra:" is never read as "r:" with a value of "a:…".
 *
 * Parsed server-side only — the topology endpoint resolves each node's
 * effective codes (Asset.description → device description; Asset.notes is
 * deliberately NOT a source — notes are operator-only and never inform the
 * topology map) and ships the final strings, so the browser never needs the
 * grammar.
 *
 * Grammar: keys are case-insensitive and match only at start-of-string or
 * after whitespace, so "hub:5" / "shelf:3" are not tokens. A value runs until
 * the next known token or end of string and is trimmed; an empty value means
 * the key is absent. Leading prose and unknown "xx:" tokens are ignored.
 * A duplicated key keeps its last occurrence.
 */

export type LocationCodes = {
  area: string | null;
  building: string | null;
  floor: string | null;
  room: string | null;
  rack: string | null;
  junctionBox: string | null;
};

const EMPTY: LocationCodes = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };

const KEY_TO_FIELD: Record<string, keyof LocationCodes> = {
  a: "area",
  b: "building",
  f: "floor",
  r: "room",
  ra: "rack",
  jb: "junctionBox",
};

// Longest keys first ("jb" before "b", "ra" before "r") so a multi-letter key
// is never shadowed by a single-letter prefix. Matches only at ^ or after
// whitespace.
const TOKEN_RE = /(?:^|\s)(jb|ra|a|b|f|r):/gi;

/** Parse a:/b:/f:/r:/ra:/jb: codes out of a free-text description. */
export function parseLocationCodes(raw: string | null | undefined): LocationCodes {
  if (!raw || typeof raw !== "string") return { ...EMPTY };
  const out: LocationCodes = { ...EMPTY };

  TOKEN_RE.lastIndex = 0;
  type Hit = { field: keyof LocationCodes; valueStart: number; tokenStart: number };
  const hits: Hit[] = [];
  for (let m = TOKEN_RE.exec(raw); m; m = TOKEN_RE.exec(raw)) {
    const key = m[1].toLowerCase();
    hits.push({
      field: KEY_TO_FIELD[key],
      // m.index points at the leading whitespace when one was consumed.
      tokenStart: m.index,
      valueStart: m.index + m[0].length,
    });
  }

  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].tokenStart : raw.length;
    const value = raw.slice(hits[i].valueStart, end).trim();
    if (value) out[hits[i].field] = value; // duplicate key: last non-empty wins
  }
  return out;
}

/**
 * Resolve a node's effective codes: when the Polaris description carries ANY
 * codes it defines the grouping EXCLUSIVELY (removing a key from the
 * description removes the node from that group — no per-key fall-through to
 * a stale device-side copy); a description with no codes falls back to the
 * device description wholesale. The old per-key merge dated from the
 * notes-over-description era and made codes impossible to remove while the
 * device copy lagged a sync/discovery cycle. Notes are deliberately not a
 * source.
 */
/** Floor numbers run from the lowest basement to the top floor (rule 168). */
export const MIN_FLOOR = -20;
export const MAX_FLOOR = 99;

/** True when `v` is a floor number: a whole number in MIN_FLOOR..MAX_FLOOR (rule 168). */
export function isFloorNumber(v: string | null | undefined): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (!/^-?\d{1,3}$/.test(t)) return false;
  const n = Number(t);
  return n >= MIN_FLOOR && n <= MAX_FLOOR;
}

/**
 * Rule 168: a NEW floor in a description must be a number. A description
 * whose floor is unchanged (an old `f:Surface` kept as it was) passes, so
 * editing anything else on such a device still saves. Null when allowed.
 */
export function floorCodeProblem(before: string | null | undefined, after: string | null | undefined): string | null {
  const a = parseLocationCodes(after).floor;
  if (!a || isFloorNumber(a)) return null;
  const b = parseLocationCodes(before).floor;
  if (b && b.trim().toLowerCase() === a.trim().toLowerCase()) return null;
  return `A floor is a number (f:${MIN_FLOOR} to f:${MAX_FLOOR}); "f:${a}" isn't. Give the floor a name in Location regions and use its number here`;
}

/** The six location levels, outermost first. */
export const LOCATION_LEVELS = ["area", "building", "floor", "room", "rack", "junctionBox"] as const;
export type LocationLevel = (typeof LOCATION_LEVELS)[number];

/**
 * `base` with only `levels` taken from `set` (business rule 148(a)): a
 * building polygon changes the building and leaves the room, a rack view
 * changes the rack chain and leaves the junction box. A listed level `set`
 * leaves empty is cleared; an unlisted level is never touched.
 */
export function mergeLocationLevels(base: LocationCodes, set: Partial<LocationCodes>, levels: readonly LocationLevel[]): LocationCodes {
  const out: LocationCodes = { ...EMPTY, ...base };
  for (const l of levels) {
    const v = set[l];
    out[l] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  return out;
}

export function resolveEffectiveLocation(sources: {
  description?: string | null;
  deviceDescription?: string | null;
}): LocationCodes {
  const fromDescription = parseLocationCodes(sources.description);
  if (hasLocationCodes(fromDescription)) return fromDescription;
  return parseLocationCodes(sources.deviceDescription);
}

/** True when the resolved codes carry at least one value. */
export function hasLocationCodes(codes: LocationCodes): boolean {
  return codes.area !== null || codes.building !== null || codes.floor !== null ||
    codes.room !== null || codes.rack !== null || codes.junctionBox !== null;
}

/** Output order of the codes, outermost first. */
const CODE_ORDER: Array<[keyof LocationCodes, string]> = [
  ["area", "a"],
  ["building", "b"],
  ["floor", "f"],
  ["room", "r"],
  ["rack", "ra"],
  ["junctionBox", "jb"],
];

/** Longest code value setLocationCodes accepts. */
export const MAX_LOCATION_CODE_VALUE_LEN = 64;

/**
 * Why a code value cannot be written, or null when it can. A value must be
 * non-empty after trimming, short, free of control characters, and must not
 * itself contain a token (" b:…"), which would re-parse as a second code.
 */
export function locationCodeValueProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return "is empty";
  if (v.length > MAX_LOCATION_CODE_VALUE_LEN) return `is longer than ${MAX_LOCATION_CODE_VALUE_LEN} characters`;
  if (/[\u0000-\u001f\u007f]/.test(v)) return "contains a control character";
  if (/(?:^|\s)(?:jb|ra|a|b|f|r):/i.test(v)) return "contains another location code";
  return null;
}

/**
 * Rewrite the a:/b:/f:/r:/ra:/jb: codes of a description (business rule 148):
 * the free text BEFORE the first code is kept, every existing code is
 * dropped, and `codes` is appended in a: b: f: r: ra: jb: order. Free text must
 * stay in front because a code's value runs to the next code or the end of
 * the string — text after the last code would be read as part of its value.
 * A null/empty field writes no code. Throws on a value
 * locationCodeValueProblem rejects; the caller owns the 255-character cap.
 */
export function setLocationCodes(description: string | null | undefined, codes: Partial<LocationCodes>): string {
  const raw = typeof description === "string" ? description : "";
  TOKEN_RE.lastIndex = 0;
  const first = TOKEN_RE.exec(raw);
  TOKEN_RE.lastIndex = 0;
  const prefix = (first ? raw.slice(0, first.index) : raw).trim();
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  for (const [field, key] of CODE_ORDER) {
    const value = codes[field];
    if (value == null || String(value).trim() === "") continue;
    const problem = locationCodeValueProblem(String(value));
    if (problem) throw new Error(`${key}: value ${problem}`);
    parts.push(`${key}:${String(value).trim().replace(/\s+/g, " ")}`);
  }
  return parts.join(" ");
}

/**
 * Canonical grouping key for a code value: trim, collapse internal
 * whitespace, lowercase. Display surfaces keep the original trimmed casing;
 * only group membership compares via this key.
 */
export function locationGroupKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// (The device-description → Asset.notes sync and its shouldSyncDescriptionToNotes
// gate were removed 2026-07: notes are operator-only. Discovery still stamps the
// "Auto-discovered from FortiGate …" boilerplate at asset CREATION, but never
// touches notes on an existing asset.)
