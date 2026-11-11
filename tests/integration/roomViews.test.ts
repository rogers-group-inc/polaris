/**
 * tests/integration/roomViews.test.ts — Room views (business rule 156).
 *
 *   - the conversion migration folds every Rack and Wall view of one room into
 *     ONE Room view (oldest name kept, racks first then junction boxes, a
 *     wall's Rack item becomes a rack, a one-rack / one-wall view takes its
 *     region's name, racked wins over a second placement, the region keeps
 *     only its room chain) and writes one Event per Room view;
 *   - a Room view created for a room is filled from existing ra: / jb: codes;
 *   - a device can be in one place in a room; a rack never sits in a box.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "roomviews-test";
let fgId = "";
let swA = "";
let swB = "";
let apC = "";

const MIGRATION = readFileSync(
  resolve(__dirname, "../../prisma/migrations/20261111120000_room_views/migration.sql"),
  "utf8",
);

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  const fg = await prisma.asset.create({
    data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active", serialNumber: `${PFX}-FGSN` },
  });
  fgId = fg.id;
  const mk = async (hostname: string, assetType: string, description: string) =>
    (await prisma.asset.create({
      data: { hostname, assetType, status: "active", description, fortinetTopology: { controllerSerial: `${PFX}-FGSN` } },
    })).id;
  swA = await mk(`${PFX}-swA`, "switch", "b:Plant r:MDF ra:R1");
  swB = await mk(`${PFX}-swB`, "switch", "b:Plant r:MDF ra:R2");
  apC = await mk(`${PFX}-apC`, "access_point", "b:Plant r:MDF jb:JB-7");
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.topologyView.deleteMany({ where: { siteId: fgId } });
  await prisma.event.deleteMany({ where: { resourceId: fgId } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
});

const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

d("Room views (rule 156)", () => {
  it("the migration folds a room's Rack and Wall views into one Room view", async () => {
    const t0 = new Date(Date.now() - 60_000);
    const rackView = await prisma.topologyView.create({
      data: {
        siteId: fgId, name: "MDF racks", mode: "rack", createdAt: t0,
        region: { building: "Plant", room: "MDF", rack: "R1" },
        racks: [{ id: "r1", name: "Rack 1", units: 42, order: 0, face: "front" }],
        rackPlacements: [{ id: "p1", kind: "asset", assetId: swA, label: null, rackId: "r1", face: "front", startU: 1, heightU: 1, fullDepth: false }],
      },
    });
    const wallView = await prisma.topologyView.create({
      data: {
        siteId: fgId, name: "MDF wall", mode: "wall",
        region: { building: "plant", room: " mdf ", junctionBox: "JB-7" },
        walls: [{ id: "w1", name: "Wall 1", width: 96, height: 48, order: 0 }],
        wallPlacements: [
          { id: "q1", kind: "asset", assetId: apC, label: null, wallId: "w1", points: rect(1, 1, 12, 8), units: null, linkedViewId: null },
          { id: "q2", kind: "asset", assetId: swA, label: null, wallId: "w1", points: rect(20, 1, 12, 8), units: null, linkedViewId: null },
          { id: "q3", kind: "rack", assetId: null, label: "Wall rack", wallId: "w1", points: rect(40, 1, 24, 24), units: 12, linkedViewId: rackView.id },
        ],
      },
    });
    const lone = await prisma.topologyView.create({
      data: { siteId: fgId, name: "Spare", mode: "rack", racks: [{ id: "rx", name: "Rack 1", units: 24, order: 0, face: "front" }] },
    });
    await prisma.topologyLayout.create({ data: { siteId: fgId, view: `v:${wallView.id}|x`, positions: {} } });

    await prisma.$executeRawUnsafe(MIGRATION);

    const views = await prisma.topologyView.findMany({ where: { siteId: fgId }, orderBy: { name: "asc" } });
    expect(views.map((v) => [v.name, v.mode])).toEqual([["MDF racks", "room"], ["Spare", "room"]]);
    const room = views.find((v) => v.id === rackView.id)!;
    expect(room.region).toMatchObject({ building: "Plant", room: "MDF", rack: null, junctionBox: null });
    const racks = room.racks as Array<{ name: string; units: number; order: number }>;
    expect(racks.map((r) => [r.name, r.units, r.order])).toEqual([["R1", 42, 0], ["Wall rack", 12, 1]]);
    expect((room.walls as Array<{ name: string }>).map((w) => w.name)).toEqual(["JB-7"]);
    expect((room.rackPlacements as Array<{ assetId: string }>).map((p) => p.assetId)).toEqual([swA]);
    // swA was racked AND on the wall: racked wins; the wall's Rack item left the box.
    expect((room.wallPlacements as Array<{ assetId: string | null; kind: string }>).map((p) => [p.kind, p.assetId])).toEqual([["asset", apC]]);
    expect(await prisma.topologyView.findUnique({ where: { id: wallView.id } })).toBeNull();
    expect(await prisma.topologyLayout.count({ where: { siteId: fgId } })).toBe(0);
    expect(views.find((v) => v.id === lone.id)!.region).toBeNull();

    const ev = await prisma.event.findMany({ where: { action: "map.topology.views_converted", resourceId: fgId }, orderBy: { message: "asc" } });
    expect(ev).toHaveLength(2);
    const merged = ev.find((e) => e.message.startsWith("2 Rack"))!;
    expect(merged.level).toBe("warning");
    expect((merged.details as { droppedPlacements: Array<{ assetId: string }> }).droppedPlacements).toEqual([{ assetId: swA, from: "MDF wall" }]);

    // Run twice: nothing left to convert, nothing changes.
    await prisma.$executeRawUnsafe(MIGRATION);
    expect(await prisma.event.count({ where: { action: "map.topology.views_converted", resourceId: fgId } })).toBe(2);
    await prisma.topologyView.deleteMany({ where: { siteId: fgId } });
  });

  it("a Room view created for a room is filled from the codes devices carry", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf)
      .send({ name: "MDF", mode: "room", region: { building: "Plant", room: "MDF", rack: "ignored" } });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("room");
    expect(res.body.region).toMatchObject({ building: "Plant", room: "MDF", rack: null });
    expect(res.body.racks.map((r: { name: string }) => r.name)).toEqual(["R1", "R2"]);
    expect(res.body.walls.map((w: { name: string }) => w.name)).toEqual(["JB-7"]);
    expect(res.body.autoPlaced.placed.sort()).toEqual([apC, swA, swB].sort());

    // A device in a rack AND a junction box is refused.
    const v = res.body;
    const both = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${v.id}`).set("X-CSRF-Token", csrf).send({
      wallPlacements: [...v.wallPlacements, { id: "dup", kind: "asset", assetId: swA, wallId: v.walls[0].id, points: rect(40, 20, 12, 8) }],
    });
    expect(both.status).toBe(400);
    expect(both.body.error ?? both.body.message ?? "").toMatch(/one place/);

    // A rack never goes in a junction box.
    const rackInBox = await agent.put(`/api/v1/map/sites/${fgId}/topology/views/${v.id}`).set("X-CSRF-Token", csrf).send({
      wallPlacements: [{ id: "rk", kind: "rack", wallId: v.walls[0].id, units: 6, points: rect(40, 20, 24, 14) }],
    });
    expect(rackInBox.status).toBe(400);

    // "Start with nothing": no fill.
    const empty = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf)
      .send({ name: "MDF empty", mode: "room", region: { building: "Plant", room: "MDF" }, fill: false });
    expect(empty.status).toBe(201);
    expect(empty.body.racks).toEqual([]);
    expect(empty.body.autoPlaced.placed).toEqual([]);

    // Rack / Wall are no longer modes.
    const old = await agent.post(`/api/v1/map/sites/${fgId}/topology/views`).set("X-CSRF-Token", csrf).send({ name: "Old", mode: "rack" });
    expect(old.status).toBe(400);
  });
});
