import { describe, expect, it } from "vitest";
import { computeBulkTags, normalizeBulkTags } from "../../src/services/assetBulkTagService.js";

describe("normalizeBulkTags", () => {
  it("trims, drops empties and dedupes exact matches", () => {
    expect(normalizeBulkTags([" a ", "", "b", "a", "  "])).toEqual(["a", "b"]);
  });
  it("keeps case variants distinct (asset tags are case-sensitive)", () => {
    expect(normalizeBulkTags(["Lab", "lab"])).toEqual(["Lab", "lab"]);
  });
});

describe("computeBulkTags", () => {
  it("add unions onto existing tags without disturbing them", () => {
    expect(computeBulkTags("add", ["x", "y"], ["y", "z"])).toEqual(["x", "y", "z"]);
  });
  it("add onto an untagged asset", () => {
    expect(computeBulkTags("add", [], ["z"])).toEqual(["z"]);
  });
  it("remove strips only the named tags", () => {
    expect(computeBulkTags("remove", ["x", "y", "z"], ["y", "q"])).toEqual(["x", "z"]);
  });
  it("remove strips an explicitly named region tag", () => {
    expect(computeBulkTags("remove", ["region:East", "x"], ["region:East"])).toEqual(["x"]);
  });
  it("replace sets exactly the chosen tags", () => {
    expect(computeBulkTags("replace", ["x", "y"], ["a", "b"])).toEqual(["a", "b"]);
  });
  it("replace keeps region: and discovery breadcrumb tags", () => {
    expect(
      computeBulkTags("replace", ["x", "Region:East", "prev-entra:abc", "prev-ad:def", "y"], ["a"]),
    ).toEqual(["Region:East", "prev-entra:abc", "prev-ad:def", "a"]);
  });
  it("replace does not duplicate a preserved tag that was also selected", () => {
    expect(computeBulkTags("replace", ["region:East", "x"], ["region:East"])).toEqual(["region:East"]);
  });
  it("replace with no tags clears everything but the preserved namespaces", () => {
    expect(computeBulkTags("replace", ["x", "region:East"], [])).toEqual(["region:East"]);
  });
});
