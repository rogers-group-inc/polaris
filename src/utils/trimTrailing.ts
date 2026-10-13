/**
 * src/utils/trimTrailing.ts — business rule 116: strip trailing characters
 * without a regex.
 *
 * `s.replace(/\/+$/, "")` looks linear and is not: the engine tries the run at
 * every start position, and a long run of the character followed by anything
 * else costs time quadratic in its length. Polaris ran exactly that shape on a
 * credential's `baseUrl`, a URL host, a path-check response body (`[\r\n]+$`,
 * up to 64 KB from whatever server the check points at) and more. A loop from
 * the end is linear, always. Pure.
 */

/** `s` without any trailing characters that are in `chars` (or satisfy the predicate). */
export function trimTrailing(s: string, chars: string | ((c: string) => boolean)): string {
  const keep = typeof chars === "string" ? (c: string) => chars.includes(c) : chars;
  let end = s.length;
  while (end > 0 && keep(s[end - 1])) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Whitespace as `\s` defines it, for the predicate form. */
export function isWhitespaceChar(c: string): boolean {
  return /\s/.test(c);
}
