/**
 * src/utils/actionHeaderMask.ts — business rule 114(h): an api_call action's
 * custom headers are secrets (the only way such an action authenticates, so in
 * real use an API key or bearer token). They are sealed at rest
 * (configSecretFields.SECRET_MAP_KEYS) and masked in every API response that
 * carries an automation or an alert group.
 *
 * Masking is preserve-on-echo, like every other write-only secret: the edit
 * form posts the masked value back, and the save restores the stored value —
 * but only from a stored api_call action with the SAME url and the same header
 * name. A masked header on an action whose url changed has nothing to restore
 * from and is refused, so a stored token never follows an edited destination
 * (the rule-111 shape).
 *
 * Pure apart from the AppError it throws.
 */

import { AppError } from "./errors.js";
import { SECRET_MASK, isMaskedSecret } from "./secretMask.js";

type Obj = Record<string, unknown>;

function isPlain(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function isApiCall(v: unknown): v is Obj & { headers?: unknown; url?: unknown } {
  return isPlain(v) && v.type === "api_call";
}

/** Every api_call action anywhere inside `value`. */
function apiCalls(value: unknown, out: Obj[] = [], depth = 0): Obj[] {
  if (depth > 16) return out;
  if (Array.isArray(value)) { for (const v of value) apiCalls(v, out, depth + 1); return out; }
  if (!isPlain(value)) return out;
  if (isApiCall(value)) out.push(value);
  for (const v of Object.values(value)) apiCalls(v, out, depth + 1);
  return out;
}

/** A copy of `value` with every api_call action's header values replaced by the mask. */
export function maskActionHeaders<T>(value: T, depth = 0): T {
  if (depth > 16) return value;
  if (Array.isArray(value)) return value.map((v) => maskActionHeaders(v, depth + 1)) as unknown as T;
  if (!isPlain(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "headers" && isApiCall(value) && isPlain(v)) {
      const m: Obj = {};
      for (const [hk, hv] of Object.entries(v)) m[hk] = typeof hv === "string" && hv !== "" ? SECRET_MASK : hv;
      out[k] = m;
    } else {
      out[k] = maskActionHeaders(v, depth + 1);
    }
  }
  return out as T;
}

function headerKey(url: unknown, name: string): string {
  return `${String(url ?? "").trim()}\u0000${name.toLowerCase()}`;
}

/**
 * Put the stored value back wherever `input` echoes the mask (mutates
 * `input`). `stored` is the row being replaced, or null for a create. A masked
 * header with no stored value at the same url + name is a 400 naming it.
 */
export function restoreMaskedActionHeaders(input: unknown, stored: unknown): void {
  const known = new Map<string, string>();
  for (const a of apiCalls(stored)) {
    if (!isPlain(a.headers)) continue;
    for (const [name, v] of Object.entries(a.headers)) {
      if (typeof v === "string" && !isMaskedSecret(v)) known.set(headerKey(a.url, name), v);
    }
  }
  for (const a of apiCalls(input)) {
    if (!isPlain(a.headers)) continue;
    for (const [name, v] of Object.entries(a.headers)) {
      if (typeof v !== "string" || !isMaskedSecret(v)) continue;
      const kept = known.get(headerKey(a.url, name));
      if (kept === undefined) {
        throw new AppError(
          400,
          `The "${name}" header of the API call to ${String(a.url ?? "")} was left masked, but no saved value exists for that URL — enter the header value again.`,
        );
      }
      a.headers[name] = kept;
    }
  }
}
