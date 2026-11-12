/**
 * tests/unit/graphqlOperations.test.ts
 *
 * Business rule 117: read a GraphQL document the way a server does to decide
 * whether it is query-only. graphqlBlockString.test.ts covers the block-string
 * lexing (F70) and securityPhase8.test.ts the original bypasses; this file
 * covers the remaining operation-detection shapes.
 */

import { describe, it, expect } from "vitest";
import { isQueryOnlyGraphql, graphqlHasBlockString } from "../../src/utils/graphqlOperations.js";

describe("isQueryOnlyGraphql", () => {
  it.each([
    "{ info { os } }",
    "query { info { os } }",
    "query Named($id: ID!) { node(id: $id) { id } }",
    "# leading comment\nquery { a }",
    "fragment F on Query { a } query { ...F }",
    "query A { a } query B { b }",
    "{ a(filter: \"mutation { x }\") }",
  ])("accepts a read: %s", (doc) => {
    expect(isQueryOnlyGraphql(doc)).toBe(true);
  });

  it.each([
    "mutation { reboot }",
    ", mutation { reboot }",
    "  \n\t mutation{reboot}",
    "﻿mutation { reboot }",
    "# query\nmutation { reboot }",
    "fragment F on Query { a } mutation { reboot }",
    "query { a } mutation { reboot }",
    "subscription { events { id } }",
    "query { a } { b } subscription S { c }",
  ])("refuses a write or subscription: %s", (doc) => {
    expect(isQueryOnlyGraphql(doc)).toBe(false);
  });

  it("refuses a document with no operation at all", () => {
    expect(isQueryOnlyGraphql("")).toBe(false);
    expect(isQueryOnlyGraphql("# only a comment")).toBe(false);
    expect(isQueryOnlyGraphql("fragment F on Query { a }")).toBe(false);
  });

  it("does not treat a field, argument or type condition named like a keyword as an operation", () => {
    expect(isQueryOnlyGraphql("{ mutation subscription }")).toBe(true);
    expect(isQueryOnlyGraphql("query ($mutation: String) { a }")).toBe(true);
    expect(isQueryOnlyGraphql("fragment F on mutation { a } query { ...F }")).toBe(true);
  });

  it("ignores keywords inside comments and strings", () => {
    expect(isQueryOnlyGraphql("{ a } # mutation { b }")).toBe(true);
    expect(isQueryOnlyGraphql('{ a(s: "\\" mutation { b }") }')).toBe(true);
  });

  it("refuses any block string even in a pure query", () => {
    expect(isQueryOnlyGraphql('{ a(s: """x""") }')).toBe(false);
  });

  it("never throws on junk", () => {
    expect(() => isQueryOnlyGraphql("}}}((( \"unterminated")).not.toThrow();
    expect(() => isQueryOnlyGraphql(null as unknown as string)).not.toThrow();
  });
});

describe("graphqlHasBlockString", () => {
  it("finds a block string outside comments and strings only", () => {
    expect(graphqlHasBlockString('{ a(s: """x""") }')).toBe(true);
    expect(graphqlHasBlockString('# """\n{ a }')).toBe(false);
    expect(graphqlHasBlockString('{ a(s: "no") }')).toBe(false);
  });
});
