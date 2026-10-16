import { describe, expect, it } from "vitest";
import {
  buildTagFilter,
  parseTagPickValue,
  sortIdsByTags,
  TAG_PICK_MAX,
  tagFilterNeedsLookup,
  tagSortKey,
} from "../../src/services/assetTagListService.js";

describe("tagFilterNeedsLookup", () => {
  it("is true only for a term-bearing op with a term", () => {
    expect(tagFilterNeedsLookup("prod", undefined)).toBe(true);
    expect(tagFilterNeedsLookup("prod", "contains")).toBe(true);
    expect(tagFilterNeedsLookup("prod", "not_contains")).toBe(true);
    expect(tagFilterNeedsLookup("  ", "contains")).toBe(false);
    expect(tagFilterNeedsLookup(undefined, "empty")).toBe(false);
    expect(tagFilterNeedsLookup("prod", "is_not_empty")).toBe(false);
  });
});

describe("buildTagFilter", () => {
  it("empty / is_not_empty use isEmpty and ignore the term", () => {
    expect(buildTagFilter("x", "empty", [])).toEqual({ tags: { isEmpty: true } });
    expect(buildTagFilter(undefined, "is_not_empty", [])).toEqual({ NOT: { tags: { isEmpty: true } } });
  });
  it("contains folds the matching ids in, even when there are none", () => {
    expect(buildTagFilter("prod", undefined, ["a", "b"])).toEqual({ id: { in: ["a", "b"] } });
    expect(buildTagFilter("prod", "contains", [])).toEqual({ id: { in: [] } });
  });
  it("not_contains excludes the matching ids; no matches is a no-op", () => {
    expect(buildTagFilter("prod", "not_contains", ["a"])).toEqual({ id: { notIn: ["a"] } });
    expect(buildTagFilter("prod", "not_contains", [])).toBeUndefined();
  });
  it("a blank term is a no-op", () => {
    expect(buildTagFilter("   ", "contains", ["a"])).toBeUndefined();
  });
  it("any_of / all_of match exact names with hasSome / hasEvery", () => {
    const v = JSON.stringify(["prod", "dc,1"]);
    expect(buildTagFilter(v, "any_of", [])).toEqual({ tags: { hasSome: ["prod", "dc,1"] } });
    expect(buildTagFilter(v, "all_of", [])).toEqual({ tags: { hasEvery: ["prod", "dc,1"] } });
  });
  it("any_of with the untagged row ORs in isEmpty; alone it is just isEmpty", () => {
    expect(buildTagFilter(JSON.stringify(["prod"]), "any_of", [], true)).toEqual({
      OR: [{ tags: { hasSome: ["prod"] } }, { tags: { isEmpty: true } }],
    });
    expect(buildTagFilter("[]", "any_of", [], true)).toEqual({ tags: { isEmpty: true } });
    // all_of ignores it: a row cannot be untagged and carry every tag.
    expect(buildTagFilter(JSON.stringify(["prod"]), "all_of", [], true)).toEqual({ tags: { hasEvery: ["prod"] } });
  });
  it("an empty or malformed pick is a no-op, never a throw", () => {
    expect(buildTagFilter("[]", "any_of", [])).toBeUndefined();
    expect(buildTagFilter("not json", "all_of", [])).toBeUndefined();
    expect(buildTagFilter('{"a":1}', "any_of", [])).toBeUndefined();
    expect(buildTagFilter(undefined, "any_of", [])).toBeUndefined();
  });
});

describe("parseTagPickValue", () => {
  it("keeps non-empty strings, de-duplicated, capped", () => {
    expect(parseTagPickValue(JSON.stringify(["a", "a", "", 3, null, "b"]))).toEqual(["a", "b"]);
    const many = Array.from({ length: TAG_PICK_MAX + 10 }, (_, i) => "t" + i);
    expect(parseTagPickValue(JSON.stringify(many))).toHaveLength(TAG_PICK_MAX);
  });
  it("pick ops never need the substring lookup", () => {
    expect(tagFilterNeedsLookup('["prod"]', "any_of")).toBe(false);
    expect(tagFilterNeedsLookup('["prod"]', "all_of")).toBe(false);
  });
});

describe("tagSortKey", () => {
  it("is null for no tags", () => {
    expect(tagSortKey([])).toBeNull();
    expect(tagSortKey(null)).toBeNull();
  });
  it("is order- and case-insensitive", () => {
    expect(tagSortKey(["Zeta", "alpha"])).toBe(tagSortKey(["ALPHA", "zeta"]));
  });
});

describe("sortIdsByTags", () => {
  const rows = [
    { id: "1", tags: [] },
    { id: "2", tags: ["prod", "Beta"] },
    { id: "3", tags: ["alpha"] },
    { id: "4", tags: ["Zulu"] },
  ];
  it("ascending by alphabetically-first tag, untagged last", () => {
    expect(sortIdsByTags(rows, "asc")).toEqual(["3", "2", "4", "1"]);
  });
  it("descending keeps untagged rows last", () => {
    expect(sortIdsByTags(rows, "desc")).toEqual(["4", "2", "3", "1"]);
  });
  it("favorites lead, each bucket sorted the same way", () => {
    expect(sortIdsByTags(rows, "asc", new Set(["4", "1"]))).toEqual(["4", "1", "3", "2"]);
  });
  it("ties break on id", () => {
    expect(sortIdsByTags([{ id: "b", tags: ["x"] }, { id: "a", tags: ["X"] }], "desc")).toEqual(["a", "b"]);
  });
});
