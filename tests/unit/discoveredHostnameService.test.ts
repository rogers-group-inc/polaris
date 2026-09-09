/**
 * tests/unit/discoveredHostnameService.test.ts
 *
 * The discovery-projected hostname behind an operator hostname pin — the value
 * the assets list prints as a second line under an overridden hostname.
 *
 * Covers the pure grouping/projection core (which source wins per asset, and
 * the three "nothing to show" cases) plus the batched DB wrapper's contract:
 * no query for an empty id set, and ids with no sources absent from the map.
 *
 * Plus the reverse read used by search / the Hostname column filter: the pure
 * matcher that decides which candidate ids actually matched on the PROJECTED
 * name, and the wrapper's refusal to project anything when the SQL narrow came
 * back empty.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "../../src/db.js";
import {
  projectHostnamesFromSourceRows,
  getDiscoveredHostnames,
  getDiscoveredHostname,
  type HostnameSourceRow,
  matchProjectedHostnames,
  findAssetIdsByDiscoveredHostname,
} from "../../src/services/discoveredHostnameService.js";

const findMany = prisma.assetSource.findMany as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<HostnameSourceRow> & { assetId: string }): HostnameSourceRow {
  return { sourceKind: "ad", inferred: false, observed: {}, ...over };
}

describe("projectHostnamesFromSourceRows", () => {
  it("groups by asset and projects each independently", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", observed: { dnsHostName: "PC-ONE.corp.local" } }),
      row({ assetId: "a2", sourceKind: "ad", observed: { dnsHostName: "PC-TWO.corp.local" } }),
    ]);
    expect(out.get("a1")).toBe("PC-ONE.corp.local");
    expect(out.get("a2")).toBe("PC-TWO.corp.local");
  });

  it("honors the projection priority — agent host-truth beats a directory record", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", observed: { dnsHostName: "OLD-NAME.corp.local" } }),
      row({ assetId: "a1", sourceKind: "polaris-agent", observed: { hostname: "REAL-NAME" } }),
    ]);
    expect(out.get("a1")).toBe("REAL-NAME");
  });

  it("returns null when no source has a hostname opinion", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "manual", observed: {} }),
    ]);
    expect(out.get("a1")).toBeNull();
  });

  it("ignores inferred phase-1 skeleton rows", () => {
    const out = projectHostnamesFromSourceRows([
      row({ assetId: "a1", sourceKind: "ad", inferred: true, observed: { dnsHostName: "GHOST.corp.local" } }),
    ]);
    expect(out.get("a1")).toBeNull();
  });

  it("omits assets it was given no rows for", () => {
    const out = projectHostnamesFromSourceRows([]);
    expect(out.size).toBe(0);
  });
});

describe("getDiscoveredHostnames", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("issues no query for an empty id set", async () => {
    const out = await getDiscoveredHostnames([]);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the read to the requested ids", async () => {
    findMany.mockResolvedValue([
      { assetId: "a1", sourceKind: "entra", inferred: false, observed: { displayName: "LAPTOP-7" } },
    ]);
    const out = await getDiscoveredHostnames(["a1", "a2"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["a1", "a2"] } });
    expect(out.get("a1")).toBe("LAPTOP-7");
    // a2 reported no sources — absent, which the caller reads as "nothing to show".
    expect(out.has("a2")).toBe(false);
  });

  it("single-asset helper flattens a miss to null", async () => {
    findMany.mockResolvedValue([]);
    expect(await getDiscoveredHostname("a1")).toBeNull();
  });
});

describe("matchProjectedHostnames", () => {
  const projected = new Map<string, string | null>([
    ["a1", "axis-b8a44f47d582"],
    ["a2", "WKS-OLD.corp.local"],
    ["a3", null],
  ]);

  it("matches case-insensitive substrings of the projected name", () => {
    expect(Array.from(matchProjectedHostnames(projected, ["B8A44F47"]).keys())).toEqual(["a1"]);
    expect(matchProjectedHostnames(projected, ["B8A44F47"]).get("a1")).toBe("axis-b8a44f47d582");
  });

  it("requires every term (multi-word searches are match-all)", () => {
    expect(matchProjectedHostnames(projected, ["axis", "d582"]).size).toBe(1);
    expect(matchProjectedHostnames(projected, ["axis", "corp"]).size).toBe(0);
  });

  it("drops candidates with no projected name, and no-term calls", () => {
    // a3 was narrowed in on some other field of its blob — there is no
    // discovered name, so there is nothing it could have matched.
    expect(matchProjectedHostnames(projected, ["a"]).has("a3")).toBe(false);
    expect(matchProjectedHostnames(projected, ["  "]).size).toBe(0);
    expect(matchProjectedHostnames(projected, []).size).toBe(0);
  });
});

describe("findAssetIdsByDiscoveredHostname", () => {
  const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryRaw.mockReset();
    findMany.mockReset();
  });

  it("issues nothing at all for an empty term list", async () => {
    expect((await findAssetIdsByDiscoveredHostname(["  "])).size).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("skips the projection read when the narrow found no pinned candidates", async () => {
    queryRaw.mockResolvedValue([]);
    expect((await findAssetIdsByDiscoveredHostname(["axis"])).size).toBe(0);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("confirms candidates against the projection, not the raw blob", async () => {
    // Both rows' blobs mention "axis"; only a1's projected HOSTNAME does.
    queryRaw.mockResolvedValue([{ assetId: "a1" }, { assetId: "a2" }]);
    findMany.mockResolvedValue([
      { assetId: "a1", sourceKind: "ad", inferred: false, observed: { dnsHostName: "axis-b8a44f47d582" } },
      { assetId: "a2", sourceKind: "ad", inferred: false, observed: { dnsHostName: "cam-lobby", description: "axis dome" } },
    ]);
    const out = await findAssetIdsByDiscoveredHostname(["axis"]);
    expect(Array.from(out.entries())).toEqual([["a1", "axis-b8a44f47d582"]]);
    expect(findMany.mock.calls[0][0].where).toEqual({ assetId: { in: ["a1", "a2"] } });
  });
});
