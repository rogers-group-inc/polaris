/**
 * src/utils/jsonPath.ts — the path language the Generic API integration maps
 * an arbitrary JSON response with.
 *
 * Deliberately a small, total subset of JSONPath — dotted keys, quoted keys,
 * array indexes and the `*` wildcard — because the operator types it into a
 * form and the Preview has to explain exactly what it picked. No filters, no
 * recursive descent, no script expressions: nothing in it can execute, loop
 * or reach outside the document it is given.
 *
 *   $.data.devices[*]        every element of data.devices
 *   data.devices             the same (leading `$` / `$.` optional)
 *   nics[*].mac              every NIC's mac
 *   nics[0].mac              the first NIC's mac
 *   ['serial number']        a key with a space in it
 *   attributes.*             every value of an object
 *
 * Evaluation never throws on data: a path that walks off the document yields
 * no matches. A path that does not PARSE throws `JsonPathError`, so the route
 * layer can reject it at save time instead of at the next discovery run.
 */

export class JsonPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonPathError";
  }
}

export type JsonPathSegment =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

const MAX_PATH_LENGTH = 512;

/** Parse a path into segments. An empty path, `$` or `$.` is the root (no segments). */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (typeof path !== "string") throw new JsonPathError("Path must be a string");
  if (path.length > MAX_PATH_LENGTH) throw new JsonPathError(`Path is longer than ${MAX_PATH_LENGTH} characters`);
  let s = path.trim();
  if (s.startsWith("$")) s = s.slice(1);
  const out: JsonPathSegment[] = [];
  let i = 0;
  // A leading dot is optional ("$.a" and "a" are the same path).
  if (s[i] === ".") i++;
  if (i >= s.length) return out;

  const readBareKey = (): string => {
    const start = i;
    while (i < s.length && s[i] !== "." && s[i] !== "[") i++;
    const key = s.slice(start, i).trim();
    if (!key) throw new JsonPathError(`Empty key at position ${start} in "${path}"`);
    // A stray bracket or quote in a bare key is a typo, not a key name — a
    // key that really contains one is written ['like]this'].
    if (/[\]'"]/.test(key)) throw new JsonPathError(`Unexpected bracket or quote in "${key}" — quote the key as ['…'] if it really contains one`);
    return key;
  };

  // First segment may be a bare key (no leading dot).
  if (s[i] !== "[") {
    const key = readBareKey();
    out.push(key === "*" ? { kind: "wildcard" } : { kind: "key", key });
  }

  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      i++;
      if (i >= s.length) throw new JsonPathError(`Path "${path}" ends with a dot`);
      const key = readBareKey();
      out.push(key === "*" ? { kind: "wildcard" } : { kind: "key", key });
    } else if (c === "[") {
      i++;
      const q = s[i];
      if (q === "'" || q === '"') {
        i++;
        let key = "";
        while (i < s.length && s[i] !== q) {
          // Backslash escapes the quote (or another backslash) inside a quoted key.
          if (s[i] === "\\" && i + 1 < s.length) { key += s[i + 1]; i += 2; continue; }
          key += s[i++];
        }
        if (s[i] !== q) throw new JsonPathError(`Unclosed quote in "${path}"`);
        i++;
        if (s[i] !== "]") throw new JsonPathError(`Expected "]" after quoted key in "${path}"`);
        i++;
        out.push({ kind: "key", key });
      } else {
        const start = i;
        while (i < s.length && s[i] !== "]") i++;
        if (s[i] !== "]") throw new JsonPathError(`Unclosed "[" in "${path}"`);
        const inner = s.slice(start, i).trim();
        i++;
        if (inner === "*") out.push({ kind: "wildcard" });
        else if (/^-?\d+$/.test(inner)) out.push({ kind: "index", index: parseInt(inner, 10) });
        else throw new JsonPathError(`"[${inner}]" is not an index, * or a quoted key in "${path}"`);
      }
    } else {
      throw new JsonPathError(`Unexpected "${c}" at position ${i} in "${path}"`);
    }
  }
  return out;
}

/** True when the path parses. */
export function isValidJsonPath(path: string): boolean {
  try { parseJsonPath(path); return true; } catch { return false; }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every value the path reaches, in document order. `undefined` is never
 * returned (a missing key is no match); `null` is, because a present-but-null
 * field is information the Preview should show.
 */
export function evaluateJsonPath(doc: unknown, path: string | JsonPathSegment[]): unknown[] {
  const segments = typeof path === "string" ? parseJsonPath(path) : path;
  let current: unknown[] = [doc];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const node of current) {
      if (seg.kind === "key") {
        if (isPlainObject(node) && Object.prototype.hasOwnProperty.call(node, seg.key)) {
          const v = node[seg.key];
          if (v !== undefined) next.push(v);
        }
      } else if (seg.kind === "index") {
        if (Array.isArray(node)) {
          const idx = seg.index < 0 ? node.length + seg.index : seg.index;
          if (idx >= 0 && idx < node.length && node[idx] !== undefined) next.push(node[idx]);
        }
      } else if (Array.isArray(node)) {
        for (const v of node) if (v !== undefined) next.push(v);
      } else if (isPlainObject(node)) {
        for (const v of Object.values(node)) if (v !== undefined) next.push(v);
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

/**
 * The record list a response holds at `path`. A path that lands on ONE array
 * yields its elements (`data.devices`); a wildcard path yields its matches
 * (`data.devices[*]`). Only objects are records — a scalar in the list is
 * skipped, and the caller reports how many were.
 */
export function selectRecords(doc: unknown, path: string): { records: Record<string, unknown>[]; skipped: number } {
  const matches = evaluateJsonPath(doc, path);
  const items = matches.length === 1 && Array.isArray(matches[0]) ? matches[0] as unknown[] : matches;
  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const it of items) {
    if (isPlainObject(it)) records.push(it);
    else skipped++;
  }
  return { records, skipped };
}

function scalarToString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

/** The first non-empty scalar the path reaches, as a string; null when none. */
export function readJsonPathString(doc: unknown, path: string | null | undefined): string | null {
  if (!path || !path.trim()) return null;
  for (const v of evaluateJsonPath(doc, path)) {
    // A leaf that is an array of scalars ("ips": ["10.0.0.1"]) counts.
    if (Array.isArray(v)) {
      for (const inner of v) {
        const s = scalarToString(inner);
        if (s !== null) return s;
      }
      continue;
    }
    const s = scalarToString(v);
    if (s !== null) return s;
  }
  return null;
}

/** Every non-empty scalar the path reaches, as strings, de-duplicated in order. */
export function readJsonPathStrings(doc: unknown, path: string | null | undefined): string[] {
  if (!path || !path.trim()) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = scalarToString(v);
    if (s !== null && !out.includes(s)) out.push(s);
  };
  for (const v of evaluateJsonPath(doc, path)) {
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  }
  return out;
}
