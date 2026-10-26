/**
 * tests/integration/interfaceTags.test.ts
 *
 * Business rule 133 end to end against a real database: the "Native VLAN"
 * device-filter field, a tag whose filter names a VLAN landing on the matching
 * switch AND on its ports on that VLAN, the manual/auto split of
 * AssetInterfaceTag, and the registry routes (rename, delete) and the
 * interface tag PUT that have to keep the port rows in step.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { resolveDeviceFilterAssetIds } from "../../src/services/deviceFilterService.js";
import { listScopeOptions } from "../../src/services/notificationRuleService.js";
import {
  previewTagFilter,
  reconcileAllTags,
  reconcileTag,
  reconcileTagsForAsset,
  stripTagAssignments,
} from "../../src/services/tagAssignmentService.js";
import { listInterfaceTags, setInterfaceTags } from "../../src/services/interfaceTagService.js";
import type { ScopeConditionGroup } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const PFX = "iftag-test-";
const TAG = `${PFX}users`;

const ids: Record<string, string> = {};

const vlanTree = (operator: string, value: string): ScopeConditionGroup =>
  ({ op: "and", children: [{ field: "nativeVlan", operator, value }] }) as ScopeConditionGroup;

/** A switch whose ports carry the given native VLANs (null = none). */
async function makeSwitch(name: string, ports: Record<string, number | null>): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: PFX + name, assetType: "switch", status: "active", monitored: true },
  });
  for (const [ifName, nativeVlan] of Object.entries(ports)) {
    await prisma.assetInterface.create({ data: { assetId: a.id, ifName, ifType: "physical", nativeVlan } });
  }
  return a.id;
}

function mine(got: Set<string>): string[] {
  return Object.entries(ids).filter(([, id]) => got.has(id)).map(([n]) => n).sort();
}

async function portTags(assetId: string): Promise<string[]> {
  const rows = await prisma.assetInterfaceTag.findMany({ where: { assetId }, orderBy: [{ ifName: "asc" }, { tag: "asc" }] });
  return rows.map((r) => `${r.ifName}:${r.tag}:${r.source}`);
}

async function assetTags(assetId: string): Promise<string[]> {
  return (await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { tags: true } })).tags;
}

async function cleanup(): Promise<void> {
  const tags = await prisma.tag.findMany({ where: { name: { startsWith: PFX } }, select: { id: true } });
  if (tags.length) {
    await prisma.tagAutoAssignment.deleteMany({ where: { tagId: { in: tags.map((t) => t.id) } } });
  }
  await prisma.tag.deleteMany({ where: { name: { startsWith: PFX } } });
  // Cascades the interfaces and the interface tags.
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
}

d("Native VLAN device filter + interface tags (business rule 133)", () => {
  beforeEach(async () => {
    await cleanup();
    // port1/port2 untagged on 30; port48 is the trunk, native VLAN 1.
    ids.on30 = await makeSwitch("on30", { port1: 30, port2: 30, port48: 1 });
    ids.on40 = await makeSwitch("on40", { port1: 40, port48: 1 });
    ids.noVlans = await makeSwitch("novlans", { wan1: null });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("selects the switches with any port on the VLAN, trunks included", async () => {
    expect(mine(await resolveDeviceFilterAssetIds(vlanTree("equals", "30")))).toEqual(["on30"]);
    expect(mine(await resolveDeviceFilterAssetIds(vlanTree("equals", "1")))).toEqual(["on30", "on40"]);
    // notEquals holds for EVERY port: on30 carries 30, so it is out.
    expect(mine(await resolveDeviceFilterAssetIds(vlanTree("notEquals", "30")))).toEqual(["noVlans", "on40"]);
  });

  it("tags the switch AND its ports on the VLAN, and nothing else", async () => {
    const tag = await prisma.tag.create({ data: { name: TAG, assetCondition: vlanTree("equals", "30") as never } });
    const s = await reconcileTag(tag.id);
    expect(s.portsAdded).toBe(2);

    expect(await assetTags(ids.on30!)).toContain(TAG);
    expect(await assetTags(ids.on40!)).not.toContain(TAG);
    expect(await portTags(ids.on30!)).toEqual([`port1:${TAG}:auto`, `port2:${TAG}:auto`]);
    expect(await portTags(ids.on40!)).toEqual([]);

    // Idempotent: a second pass writes nothing.
    const again = await reconcileTag(tag.id);
    expect([again.added, again.removed, again.portsAdded, again.portsRemoved]).toEqual([0, 0, 0, 0]);
  });

  it("previews the device AND port counts", async () => {
    const p = await previewTagFilter({ condition: vlanTree("equals", "30") });
    expect(p.portCount).toBeGreaterThanOrEqual(2);
    const plain = await previewTagFilter({ condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: PFX }] } });
    expect(plain.portCount).toBe(0);
  });

  it("follows a port that moves VLAN, on the per-asset path", async () => {
    const tag = await prisma.tag.create({ data: { name: TAG, assetCondition: vlanTree("equals", "30") as never } });
    await reconcileTag(tag.id);
    await prisma.assetInterface.update({ where: { assetId_ifName: { assetId: ids.on30!, ifName: "port2" } }, data: { nativeVlan: 40 } });
    await reconcileTagsForAsset(ids.on30!);
    expect(await portTags(ids.on30!)).toEqual([`port1:${TAG}:auto`]);
    // The last port leaves VLAN 30: the switch drops the tag with it.
    await prisma.assetInterface.update({ where: { assetId_ifName: { assetId: ids.on30!, ifName: "port1" } }, data: { nativeVlan: 40 } });
    await reconcileTagsForAsset(ids.on30!);
    expect(await portTags(ids.on30!)).toEqual([]);
    expect(await assetTags(ids.on30!)).not.toContain(TAG);
  });

  it("never lands on or removes a port tag applied by hand", async () => {
    await setInterfaceTags(ids.on30!, "port1", [TAG], "tester");
    const tag = await prisma.tag.create({ data: { name: TAG, assetCondition: vlanTree("equals", "30") as never } });
    await reconcileTag(tag.id);
    expect(await portTags(ids.on30!)).toEqual([`port1:${TAG}:manual`, `port2:${TAG}:auto`]);

    // Clearing the filter strips only the engine's row.
    await prisma.tag.update({ where: { id: tag.id }, data: { assetCondition: null as never } });
    await reconcileTag(tag.id);
    expect(await portTags(ids.on30!)).toEqual([`port1:${TAG}:manual`]);
  });

  it("a manual save replaces only the manual set, and naming an auto tag converts it", async () => {
    const tag = await prisma.tag.create({ data: { name: TAG, assetCondition: vlanTree("equals", "30") as never } });
    await reconcileTag(tag.id);
    // Saving a list without the auto tag leaves it alone.
    let out = await setInterfaceTags(ids.on30!, "port1", [`${PFX}uplink`], "tester");
    expect(out.map((t) => `${t.name}:${t.auto}`)).toEqual([`${PFX}uplink:false`, `${TAG}:true`]);
    // Naming it makes it the operator's: it survives the filter going away.
    out = await setInterfaceTags(ids.on30!, "port1", [`${PFX}uplink`, TAG], "tester");
    expect(out.every((t) => !t.auto)).toBe(true);
    await stripTagAssignments(tag.id, TAG);
    expect(await portTags(ids.on30!)).toEqual([`port1:${PFX}uplink:manual`, `port1:${TAG}:manual`]);
    expect((await listInterfaceTags(ids.on30!)).get("port2")).toBeUndefined();
  });

  it("refuses an unknown interface, and the system namespaces", async () => {
    await expect(setInterfaceTags(ids.on30!, "port99", ["x"], "tester")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(setInterfaceTags(ids.on30!, "port1", ["region:Atlanta"], "tester")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("sweeps an auto port row whose tag no longer auto-assigns", async () => {
    await prisma.assetInterfaceTag.create({
      data: { assetId: ids.on30!, ifName: "port1", tag: `${PFX}gone`, source: "auto", tagId: "00000000-0000-0000-0000-000000000000" },
    });
    await reconcileAllTags();
    expect(await portTags(ids.on30!)).toEqual([]);
  });

  it("offers the fleet's native VLANs to the picker, named by the VLAN interfaces", async () => {
    const gate = await prisma.asset.create({ data: { hostname: PFX + "gate", assetType: "firewall", status: "active", monitored: true } });
    await prisma.assetInterface.create({ data: { assetId: gate.id, ifName: `${PFX}Users_VL30`, ifType: "vlan", vlanId: 30 } });
    const { nativeVlans } = await listScopeOptions();
    const opt30 = nativeVlans.find((o) => o.value === "30");
    expect(opt30?.label).toContain(`${PFX}Users_VL30`);
    expect(nativeVlans.find((o) => o.value === "40")).toBeDefined();
  });
});

d("interface tag routes (business rule 133)", () => {
  let agent: ReturnType<typeof request.agent>;
  let csrf = "";

  beforeAll(async () => {
    if (!dbReachable) return;
    await ensureTestUser();
    ({ agent, csrf } = await authedAgent(app));
  });

  beforeEach(async () => {
    await cleanup();
    ids.on30 = await makeSwitch("on30", { port1: 30, port2: 30, port48: 1 });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("PUTs the manual tags and returns them on the system-info row", async () => {
    const res = await agent
      .put(`/api/v1/assets/${ids.on30}/interfaces/port1/tags`)
      .set("X-CSRF-Token", csrf)
      .send({ tags: [`${PFX}uplink`] });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([{ name: `${PFX}uplink`, color: null, auto: false }]);

    const si = await agent.get(`/api/v1/assets/${ids.on30}/system-info`);
    expect(si.status).toBe(200);
    const port1 = si.body.interfaces.find((i: { ifName: string }) => i.ifName === "port1");
    expect(port1.tags.map((t: { name: string }) => t.name)).toEqual([`${PFX}uplink`]);
  });

  it("a registry rename rewrites the port rows, manual and auto", async () => {
    const created = await agent.post("/api/v1/server-settings/tags").set("X-CSRF-Token", csrf)
      .send({ name: TAG, category: "General", assetCondition: vlanTree("equals", "30") });
    expect(created.status).toBe(201);
    await reconcileTag(created.body.id);
    await setInterfaceTags(ids.on30!, "port48", [TAG], "tester");

    const renamed = await agent.put(`/api/v1/server-settings/tags/${created.body.id}`).set("X-CSRF-Token", csrf)
      .send({ name: `${TAG}-renamed` });
    expect(renamed.status).toBe(200);
    await reconcileTag(created.body.id);
    expect(await portTags(ids.on30!)).toEqual([
      `port1:${TAG}-renamed:auto`,
      `port2:${TAG}-renamed:auto`,
      `port48:${TAG}-renamed:manual`,
    ]);
  });

  it("a registry delete strips the auto port rows and keeps the manual one", async () => {
    const created = await agent.post("/api/v1/server-settings/tags").set("X-CSRF-Token", csrf)
      .send({ name: TAG, category: "General", assetCondition: vlanTree("equals", "30") });
    await reconcileTag(created.body.id);
    await setInterfaceTags(ids.on30!, "port48", [TAG], "tester");
    const del = await agent.delete(`/api/v1/server-settings/tags/${created.body.id}`).set("X-CSRF-Token", csrf);
    expect(del.status).toBe(204);
    expect(await portTags(ids.on30!)).toEqual([`port48:${TAG}:manual`]);
  });
});
