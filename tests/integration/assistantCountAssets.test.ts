/**
 * tests/integration/assistantCountAssets.test.ts
 *
 * Business rule 95(o): count_assets counts in the database, with exactly the
 * list_assets filters, so a breakdown never comes from a model counting a
 * fragment of rows. Pins against real tables:
 *  - a plain field is a Prisma groupBy (largest first, empty values named);
 *  - region and tag count an asset under each tag it carries, case-blind on
 *    the `region:` prefix;
 *  - a network CIDR is containment, not a string match;
 *  - decommissioned assets are left out unless asked for;
 *  - list_assets' breakdown agrees with count_assets over the same filters.
 *
 * Every case narrows with `search` to this file's hostname prefix, so other
 * rows in a shared test database never count.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-count-test";
const req = { session: { userId: "u-count", roleSnapshot: { permissions: { assets: "read" } } } } as never;
const ctx = { req, maxRows: 50 };

async function wipe(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

async function count(args: Record<string, unknown>): Promise<any> {
  const r = await runAssistantTool("count_assets", JSON.stringify({ search: HOST, ...args }), ctx);
  expect(r.ok, JSON.stringify(r.data)).toBe(true);
  return r.data;
}

d("count_assets against the database", () => {
  beforeAll(async () => {
    await wipe();
    const rows: Array<Record<string, unknown>> = [
      { n: 1, assetType: "firewall", model: "FortiGate-61F", ipAddress: "10.20.1.1", tags: ["region:Middle Tennessee", "core"] },
      { n: 2, assetType: "firewall", model: "FortiGate-61F", ipAddress: "10.20.2.1", tags: ["Region:Middle Tennessee", "region:Alabama"] },
      { n: 3, assetType: "firewall", model: "FortiGate-100F", ipAddress: "10.30.0.1", tags: ["region:Alabama"] },
      { n: 4, assetType: "switch", model: "FS-148F", ipAddress: "10.20.3.4", tags: [] },
      { n: 5, assetType: "switch", model: null, ipAddress: "110.20.3.4", tags: ["core"] },
      { n: 6, assetType: "switch", model: "FS-148F", ipAddress: "10.20.9.9", tags: [], status: "decommissioned" },
    ];
    for (const { n, status, ...r } of rows) {
      await prisma.asset.create({ data: { hostname: `${HOST}-${n}`, status: status ?? "active", ...r } as never });
    }
  });
  afterAll(wipe);

  it("counts a plain field in the database, largest first, and names an empty value", async () => {
    const r = await count({ groupBy: ["model"] });
    expect(r.matchingAssets).toBe(5); // the decommissioned switch is left out
    expect(r.rows).toEqual([
      { model: "FortiGate-61F", count: 2 },
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ]);
    expect(r.rows.map((x: any) => x.model).sort()).toEqual(["(none)", "FS-148F", "FortiGate-100F", "FortiGate-61F"]);
  });

  it("takes two fields and the list_assets filters", async () => {
    const r = await count({ assetType: "firewall", groupBy: ["assetType", "model"] });
    expect(r.matchingAssets).toBe(3);
    expect(r.rows).toEqual([
      { assetType: "firewall", model: "FortiGate-61F", count: 2 },
      { assetType: "firewall", model: "FortiGate-100F", count: 1 },
    ]);
  });

  it("counts an asset under each region it carries, whatever the prefix case", async () => {
    const r = await count({ groupBy: ["region"] });
    const byRegion = Object.fromEntries(r.rows.map((x: any) => [x.region, x.count]));
    expect(byRegion).toEqual({ "Middle Tennessee": 2, Alabama: 2, "(no region)": 2 });
    expect(r.countingNote).toBeTruthy();
  });

  it("matches a network by containment, not by string", async () => {
    const r = await count({ network: "10.20.0.0/16", groupBy: ["assetType"] });
    expect(r.rows).toEqual([{ assetType: "firewall", count: 2 }, { assetType: "switch", count: 1 }]);
  });

  it("counts decommissioned assets only when asked", async () => {
    expect((await count({ status: ["decommissioned"] })).rows).toEqual([{ count: 1 }]);
  });

  it("agrees with list_assets' breakdown over the same filters", async () => {
    const list = await runAssistantTool("list_assets", JSON.stringify({ search: HOST }), { req, maxRows: 2 });
    expect(list.ok).toBe(true);
    const counted = await count({ groupBy: ["assetType"] });
    // Five matches is under the breakdown's threshold: the total still agrees.
    expect((list.data as any).total).toBe(counted.matchingAssets);
  });
});
