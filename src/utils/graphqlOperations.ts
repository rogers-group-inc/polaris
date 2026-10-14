/**
 * src/utils/graphqlOperations.ts — business rule 117: which operations a
 * GraphQL document defines, read the way a GraphQL server reads it.
 *
 * The Unraid Query API modal is a READ tool, and its guard used to be a
 * prefix regex refusing a document that *started* with `mutation`. GraphQL
 * ignores commas, whitespace and comments, and lets fragment definitions come
 * before the operation, so `, mutation { … }` or `fragment F on Query { … }
 * mutation { … }` sailed through with the stored API key.
 *
 * This walks the document as GraphQL's lexer does — skipping ignored tokens,
 * strings and block strings, tracking brace and paren depth — and reports
 * every top-level operation. An anonymous `{ … }` at the top level is a query.
 * One pass, no regex over the document (rule 116), never throws. Pure.
 *
 * Block strings (2026-10-14, re-scan F70): inside `"""` GraphQL's only escape
 * is the four characters `\"""`; every other backslash is an ordinary
 * character. This lexer used to treat `\` as escaping the next character, so
 * `"""\\"""` closed here but not in graphql-js, and from then on the two
 * disagreed about what was string and what was code — a `mutation` sat where
 * the guard thought it was still inside a string. The scan now follows the
 * spec, AND the query tool refuses any document containing a block string
 * (`isQueryOnlyGraphql`): a read console has no use for them, and refusing
 * them removes the whole class of lexer disagreement rather than one instance.
 */

export type GraphqlOperationKind = "query" | "mutation" | "subscription";

const isNameStart = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isNameChar = (c: string) => isNameStart(c) || (c >= "0" && c <= "9");

export function graphqlOperationKinds(doc: string): GraphqlOperationKind[] {
  return scanGraphql(doc).kinds;
}

/** True when the document contains a `"""` block string anywhere outside a comment or string. */
export function graphqlHasBlockString(doc: string): boolean {
  return scanGraphql(doc).blockString;
}

function scanGraphql(doc: string): { kinds: GraphqlOperationKind[]; blockString: boolean } {
  const s = String(doc ?? "");
  let blockString = false;
  const out: GraphqlOperationKind[] = [];
  let depth = 0;
  let parens = 0;
  // A top-level definition keyword was read and its `{` has not come yet.
  let pendingDefinition = false;
  let prevWord = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "﻿") { i++; continue; }
    if (c === "#") { while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (c === '"') {
      if (s[i + 1] === '"' && s[i + 2] === '"') {
        blockString = true;
        i += 3;
        // Spec: only `\"""` is an escape inside a block string.
        while (i < s.length && !(s[i] === '"' && s[i + 1] === '"' && s[i + 2] === '"')) {
          i += s[i] === "\\" && s[i + 1] === '"' && s[i + 2] === '"' && s[i + 3] === '"' ? 4 : 1;
        }
        i += 3;
      } else {
        i++;
        while (i < s.length && s[i] !== '"' && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
        i++;
      }
      continue;
    }
    if (c === "(") { parens++; i++; continue; }
    if (c === ")") { parens = Math.max(0, parens - 1); i++; continue; }
    if (c === "{") {
      if (depth === 0 && parens === 0) {
        if (!pendingDefinition) out.push("query"); // anonymous query shorthand
        pendingDefinition = false;
      }
      depth++;
      i++;
      continue;
    }
    if (c === "}") { depth = Math.max(0, depth - 1); i++; continue; }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < s.length && isNameChar(s[j])) j++;
      const word = s.slice(i, j);
      if (depth === 0 && parens === 0 && prevWord !== "on") {
        if (word === "query" || word === "mutation" || word === "subscription") {
          out.push(word);
          pendingDefinition = true;
        } else if (word === "fragment") {
          pendingDefinition = true;
        }
      }
      if (depth === 0) prevWord = word;
      i = j;
      continue;
    }
    i++;
  }
  return { kinds: out, blockString };
}

/**
 * True when every operation the document defines is a query (and it defines
 * at least one) and the document contains no block string (see the header).
 */
export function isQueryOnlyGraphql(doc: string): boolean {
  const { kinds, blockString } = scanGraphql(doc);
  return !blockString && kinds.length > 0 && kinds.every((k) => k === "query");
}
