import { describe, expect, it } from "vitest";
import {
  buildTagFilter,
  sortIdsByTags,
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
