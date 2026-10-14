/**
 * tests/unit/graphqlBlockString.test.ts — re-scan F70 (business rule 117).
 * Inside a GraphQL block string only `\"""` is an escape. The guard used to
 * treat `\` as escaping the next character, so the document below closed its
 * first block string one `"""` early, saw the trailing `mutation` as string
 * text and called the whole thing a query; graphql-js reads one fragment and
 * one anonymous mutation. The scan now follows the spec, and the query tool
 * refuses any document carrying a block string.
 */

import { describe, it, expect } from "vitest";
import { graphqlHasBlockString, graphqlOperationKinds, isQueryOnlyGraphql } from "../../src/utils/graphqlOperations.js";

// The finding's own document (two backslashes before the first closing
// quotes). graphql-js: the first backslash is ordinary, the second plus `"""`
// is the escape, so the string runs on to `x """` and `) } mutation { … }` is
// code. The old guard let the first backslash "escape" the second, closed the
// string at `\\"""`, read `query { x`, then opened a block string at `""")`
// that swallowed the mutation.
const EXPLOIT = 'fragment F on VmMutations { stop(id: """\\\\""" ) } query { x """) } mutation { vm { ...F real: stop(id: "vm-1") } }';

describe("block strings", () => {
  it("reads the F70 document as the server does: a mutation is present", () => {
    expect(graphqlOperationKinds(EXPLOIT)).toContain("mutation");
    expect(isQueryOnlyGraphql(EXPLOIT)).toBe(false);
  });

  it("treats only \\\"\"\" as an escape inside a block string", () => {
    // `\"""` does not close the string, so the mutation inside is still text.
    expect(graphqlOperationKinds('{ a(q: """ \\""" mutation { x } """) }')).toEqual(["query"]);
    // A lone backslash before an ordinary character is just a character.
    expect(graphqlOperationKinds('{ a(q: """ \\n """) } mutation { b }')).toEqual(["query", "mutation"]);
  });

  it("the query tool refuses any document containing a block string", () => {
    expect(graphqlHasBlockString('{ a(q: """x""") }')).toBe(true);
    expect(isQueryOnlyGraphql('{ a(q: """x""") }')).toBe(false);
    // An ordinary string with quotes in it is not a block string.
    expect(graphqlHasBlockString('{ a(q: "say \\"hi\\"") }')).toBe(false);
    expect(isQueryOnlyGraphql('{ a(q: "say \\"hi\\"") }')).toBe(true);
    // Nor is `"""` inside a comment.
    expect(graphqlHasBlockString('# """\n{ a }')).toBe(false);
  });
});
