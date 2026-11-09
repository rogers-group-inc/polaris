/**
 * tests/unit/adSearchFilter.test.ts — the LDAP filter behind the live AD
 * typeahead (activeDirectoryService.adSearchFilter, 2026-11-09): every word of
 * the query must appear in a name / address attribute, in any order, so
 * "John Smith" reaches a displayName of "Smith, John"; each word is escaped.
 */

import { describe, it, expect } from "vitest";
import { adSearchFilter } from "../../src/services/activeDirectoryService.js";

const ATTRS = ["cn", "mail", "displayName", "sAMAccountName", "givenName", "sn"];
const anyOf = (w: string) => `(|${ATTRS.map((a) => `(${a}=*${w}*)`).join("")})`;
const wrap = (m: string) => `(&(mail=*)(|(objectClass=user)(objectClass=group)(objectClass=contact))${m})`;

describe("adSearchFilter", () => {
  it("one word: any of the name / address attributes", () => {
    expect(adSearchFilter("jsmith")).toBe(wrap(anyOf("jsmith")));
  });

  it("several words: EVERY word, each in any attribute — \"John Smith\" and \"Smith, John\" ask the same", () => {
    const both = wrap(`(&${anyOf("John")}${anyOf("Smith")})`);
    expect(adSearchFilter("John Smith")).toBe(both);
    expect(adSearchFilter("  John   Smith ")).toBe(both);
    expect(adSearchFilter("Smith, John")).toBe(wrap(`(&${anyOf("Smith")}${anyOf("John")})`));
  });

  it("escapes each word, so a typed filter character cannot change the query", () => {
    const f = adSearchFilter("a*b (x)");
    expect(f).toContain("a\\2ab");
    expect(f).toContain("\\28x\\29");
    expect(f).not.toContain("(x)");
  });
});
