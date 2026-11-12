/**
 * tests/unit/assetSourceTags.test.ts
 *
 * Cross-file protocol values: discovery writes these tag prefixes and conflict
 * resolution parses them back. A changed literal silently breaks the parse of
 * every tag already stored, so the values are pinned here.
 */

import { describe, it, expect } from "vitest";
import {
  ENTRA_ASSET_TAG_PREFIX,
  AD_ASSET_TAG_PREFIX,
  AD_GUID_TAG_PREFIX,
  SID_TAG_PREFIX,
} from "../../src/utils/assetSourceTags.js";

describe("asset source tag prefixes", () => {
  it("keeps the stored literals", () => {
    expect(ENTRA_ASSET_TAG_PREFIX).toBe("entra:");
    expect(AD_ASSET_TAG_PREFIX).toBe("ad:");
    expect(AD_GUID_TAG_PREFIX).toBe("ad-guid:");
    expect(SID_TAG_PREFIX).toBe("sid:");
  });

  it("no prefix is a prefix of another (a parse by startsWith stays unambiguous)", () => {
    const all = [ENTRA_ASSET_TAG_PREFIX, AD_ASSET_TAG_PREFIX, AD_GUID_TAG_PREFIX, SID_TAG_PREFIX];
    for (const a of all) {
      for (const b of all) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });
});
