/**
 * src/utils/bearerToken.ts — shared bearer-token mint format.
 *
 * Both token stores (ApiToken for external callers, the Polaris Agent's
 * enrollment/bearer tokens) mint the same shape: `polaris_` + an
 * alphanumeric tail of UP TO 32 chars (the historical format strips +/=
 * from the base64 rather than base64url-mapping them, so length varies
 * slightly), verified via a prefix-indexed argon2 walk keyed on the first
 * `polaris_xxxxxxxx` (TOKEN_INDEX_PREFIX_LEN chars). The two services
 * carried byte-identical private copies of these constants + the generator
 * until the 2026-08 audit; the FORMAT is one contract — a change here must
 * consider both stores' stored prefix indexes.
 */

import { randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "polaris_";
/** Chars of a raw token used as the indexed lookup key ("polaris_xxxxxxxx"). */
export const TOKEN_INDEX_PREFIX_LEN = TOKEN_PREFIX.length + 8;
export const TOKEN_RANDOM_BYTES = 24; // → 32 base64 chars, then + / = stripped (usually 30–31 left)

export function generateRawToken(): string {
  const tail = randomBytes(TOKEN_RANDOM_BYTES)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 32);
  return `${TOKEN_PREFIX}${tail}`;
}
