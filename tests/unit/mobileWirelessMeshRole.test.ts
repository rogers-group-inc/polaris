/**
 * tests/unit/mobileWirelessMeshRole.test.ts — the phone Wireless sheet's mesh
 * role line (public/js/mobile/asset-detail.js, wirelessMeshRoleHtml).
 *
 * Parity with the desktop Wireless strip's label (tests/unit/
 * assetWirelessTreeDom.test.ts): root = another inventory AP associated as a
 * client, leaf = the controller reports the uplink as mesh, both on a mesh hop,
 * nothing otherwise. A phone has no hover, so what the desktop puts in the
 * tooltip — the leaves served, the parent's serial — is pinned as visible text.
 *
 * The function is nested inside the module's IIFE, so it is sliced out by its
 * two-space indent and eval'd.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const lines = readFileSync(resolve(__dirname, "../../public/js/mobile/asset-detail.js"), "utf8").split(/\r?\n/);

function nestedFnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`  function ${name}(`));
  if (start < 0) throw new Error(`asset-detail.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  if (end < 0) throw new Error(`asset-detail.js: no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // eslint-disable-next-line no-eval
  (0, eval)(nestedFnSrc("wirelessMeshRoleHtml").replace(/^  function /, "globalThis.wirelessMeshRoleHtml = function "));
});

const AP = { id: "ap-1", assetType: "access_point" };
const LEAF_AP_STATION = {
  staMacAddr: "AA:AA:AA:AA:AA:01",
  matchedAsset: { id: "ap-2", hostname: "FAP-LEAF-<2>", assetType: "access_point" },
};
const LAPTOP_STATION = {
  staMacAddr: "11:11:11:11:11:11",
  matchedAsset: { id: "laptop-1", hostname: "LAPTOP-JD", assetType: "workstation" },
};

describe("wirelessMeshRoleHtml", () => {
  it("names a mesh root and the leaves it serves, inline", () => {
    const html = g.wirelessMeshRoleHtml(AP, [LEAF_AP_STATION, LAPTOP_STATION]);
    expect(html).toContain("Mesh root");
    expect(html).toContain("serving FAP-LEAF-&lt;2&gt;");
    expect(html).not.toContain("LAPTOP-JD");
    expect(html).not.toContain("Mesh leaf");
  });

  it("names a mesh leaf and its parent serial, inline", () => {
    const html = g.wirelessMeshRoleHtml(
      { ...AP, fortinetTopology: { meshUplink: "mesh", parentApSerial: "FP231FTF00000001" } },
      [LAPTOP_STATION],
    );
    expect(html).toContain("Mesh leaf");
    expect(html).toContain("FP231FTF00000001");
    expect(html).not.toContain("Mesh root");
  });

  it("shows both on a mesh hop", () => {
    const html = g.wirelessMeshRoleHtml(
      { ...AP, fortinetTopology: { meshUplink: "mesh" } },
      [LEAF_AP_STATION],
    );
    expect(html).toContain("Mesh root");
    expect(html).toContain("Mesh leaf");
  });

  it("renders nothing for a wired AP with no AP clients, or before the asset is cached", () => {
    expect(g.wirelessMeshRoleHtml({ ...AP, fortinetTopology: { meshUplink: "ethernet" } }, [LAPTOP_STATION])).toBe("");
    expect(g.wirelessMeshRoleHtml(undefined, [])).toBe("");
  });
});
