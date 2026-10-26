/**
 * tests/integration/assistantDependencies.test.ts
 *
 * The assistant's get_dependencies tool (business rule 95) against real
 * AssetDependencyParent rows:
 *  - upstream is walked hop by hop to the top, each link saying how it was
 *    learned;
 *  - a device's `override` parents replace its computed ones — on the way up
 *    AND when deciding what hangs off a device on the way down (the
 *    precedence dependencyTreeService's suppression walk uses);
 *  - a cycle in hand-made overrides ends the walk instead of looping;
 *  - downstream counts every device behind, and how many are down or
 *    suppressed.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-deps-test";
const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as never;
const ids: Record<string, string> = {};

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const list = assets.map((a) => a.id);
  if (!list.length) return;
  await prisma.assetDependencyParent.deleteMany({ where: { OR: [{ assetId: { in: list } }, { parentAssetId: { in: list } }] } });
  await prisma.asset.deleteMany({ where: { id: { in: list } } });
}

async function node(name: string, over: Record<string, unknown> = {}): Promise<void> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch", monitorStatus: "up", ...over } as never,
  });
  ids[name] = a.id;
}

async function edge(child: string, parent: string, source = "computed", detectedVia = "lldp"): Promise<void> {
  await prisma.assetDependencyParent.create({ data: { assetId: ids[child], parentAssetId: ids[parent], source, detectedVia } });
}

const run = async (hostname: string) =>
  (await runAssistantTool("get_dependencies", JSON.stringify({ hostname: `${HOST}-${hostname}` }), { req, maxRows: 50 })).data as any;

d("get_dependencies", () => {
  beforeEach(async () => {
    await wipe();
    // gw ← core ← access ← ap1, ap2 (ap2 down); alt is a second gate that
    // access ALSO has a computed edge to, overridden away.
    await node("gw", { assetType: "firewall" });
    await node("alt", { assetType: "firewall" });
    await node("core");
    await node("access");
    await node("ap1", { assetType: "access_point" });
    await node("ap2", { assetType: "access_point", monitorStatus: "down" });
    await edge("core", "gw", "computed", "controller");
    await edge("access", "alt", "computed", "interface");
    await edge("access", "core", "override", "manual");
    await edge("ap1", "access");
    await edge("ap2", "access");
  });
  afterAll(wipe);

  it("walks up hop by hop, with an override replacing the computed parent", async () => {
    const r = await run("ap1");
    expect(r.found).toBe(true);
    expect(r.upstream.map((u: any) => [u.hop, u.hostname, u.detectedVia])).toEqual([
      [1, `${HOST}-access`, "lldp"],
      [2, `${HOST}-core`, "manual"],
      [3, `${HOST}-gw`, "controller"],
    ]);
    expect(r.upstream.some((u: any) => u.hostname === `${HOST}-alt`)).toBe(false);
  });

  it("counts what is behind a device, and the overridden edge does not put anything behind the other gate", async () => {
    const core = await run("core");
    expect(core.downstream).toMatchObject({ directChildCount: 1, totalDevicesBehind: 3, downBehind: 1, suppressedBehind: 0 });
    expect(core.downstream.directChildren.map((c: any) => c.hostname)).toEqual([`${HOST}-access`]);
    const alt = await run("alt");
    expect(alt.downstream).toMatchObject({ directChildCount: 0, totalDevicesBehind: 0 });
    expect(alt.topOfTree).toMatch(/no upstream/);
  });

  it("ends the walk on a cycle in overrides", async () => {
    await edge("gw", "access", "override", "manual");
    const r = await run("ap1");
    expect(r.upstream.map((u: any) => u.hostname)).toEqual([`${HOST}-access`, `${HOST}-core`, `${HOST}-gw`]);
    expect(r.upstreamTruncated).toBe(false);
  });

  it("answers found:false for an unknown device", async () => {
    expect(await run("nope")).toEqual({ found: false });
  });
});
