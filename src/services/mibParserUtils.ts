/**
 * src/services/mibParserUtils.ts — shared SMI text helpers.
 *
 * `stripComments` collapses ASN.1 comments to whitespace so downstream regex
 * parsers don't accidentally match keywords inside `-- ... --` blocks. It's
 * string-literal aware, so `--` inside a quoted DESCRIPTION is preserved as-is.
 *
 * Originally lived in mibService.ts and was duplicated into oidRegistry.ts to
 * avoid a circular import; now both modules consume the same helper.
 */

/** One `symbol FROM MODULE` pair out of a module's IMPORTS block. */
export interface ImportBinding {
  symbol: string;
  module: string;
}

/**
 * Read the IMPORTS block as symbol → module pairs, not just module names.
 *
 *   IMPORTS
 *       fortinet, FnBoolState            FROM FORTINET-CORE-MIB
 *       MODULE-IDENTITY, OBJECT-TYPE     FROM SNMPv2-SMI;
 *
 * yields { fortinet → FORTINET-CORE-MIB }, { FnBoolState → FORTINET-CORE-MIB },
 * …. This is the only place a file states which module defines an anchor it
 * leans on, and it is what lets the UI say "upload FORTINET-CORE-MIB" rather
 * than "something called `fortinet` is missing". Macro names (uppercase-
 * leading, `OBJECT-TYPE`) are kept — callers filter on what they need.
 *
 * Tolerant by design: a module with no IMPORTS block returns []; a malformed
 * block yields whatever pairs parse. Never throws.
 */
export function parseImportMap(text: string): ImportBinding[] {
  const stripped = stripComments(text);
  const block = /\bIMPORTS\b([\s\S]*?);/.exec(stripped);
  if (!block) return [];
  const out: ImportBinding[] = [];
  // Each segment is "<ident>, <ident>, … FROM <MODULE>"; the last segment
  // ends at the `;` the outer regex already stopped on.
  const segment = /([\s\S]*?)\bFROM\s+([A-Za-z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = segment.exec(block[1]))) {
    const module = m[2];
    for (const raw of m[1].split(",")) {
      const symbol = raw.trim();
      if (!symbol || !/^[A-Za-z][\w-]*$/.test(symbol)) continue;
      out.push({ symbol, module });
    }
  }
  return out;
}

// Strip ASN.1 comments. SMI (RFC 2578) supports two comment styles:
//   1. `-- ... <newline>` or `-- ... --` (the second `--` closes it)
//   2. line that begins with `--`
// We collapse comments to whitespace rather than dropping them so that line
// numbers in any later parser error message still line up with the source.
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // String literal — don't strip "--" inside a quoted DESCRIPTION
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n && text[i] !== '"') {
        out += text[i];
        i++;
      }
      if (i < n) {
        out += text[i];
        i++;
      }
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      // Replace with a space, then scan to either end-of-line or the next "--"
      out += "  ";
      i += 2;
      while (i < n) {
        if (text[i] === "\n" || text[i] === "\r") break;
        if (text[i] === "-" && text[i + 1] === "-") {
          out += "  ";
          i += 2;
          break;
        }
        out += text[i] === "\t" ? "\t" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
