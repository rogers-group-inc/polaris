/**
 * tests/integration/alertRenameFollow.test.ts
 *
 * Business rule 134: an open alert follows its device's rename. An Asset write
 * that changes the hostname (through the src/db.ts extension, so every rename
 * path — discovery projection, an accepted conflict, the asset editor) rewrites
 * the device's OPEN alerts still named the old name. Cleared alerts keep the
 * fire-time name, and so does an alert whose subject is not the device (a
 * subnet / automation fold names the subnet or the automation, rule 75).
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { followAssetRename } from "../../src/services/alertRenameService.js";

const d = dbDescribe;
const HOST = "rename-follow-test";
const OLD = `${HOST}-old`;
const NEW = `${HOST}-new`;

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  if (assets.length) {
    const aIds = assets.map((a) => a.id);
    await prisma.notification.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.asset.deleteMany({ where: { id: { in: aIds } } });
  }
}

async function alert(assetId: string, data: Record<string, unknown> = {}): Promise<string> {
  const n = await prisma.notification.create({
    data: {
      assetId, assetHostname: OLD, severity: "critical", message: `${OLD} is down`,
      templateCtx: { asset: OLD, message: `${OLD} is down` }, ...data,
    } as never,
  });
  return n.id;
}

// The follow-up is fire-and-forget after the write, so wait for it to land.
async function waitForName(id: string, name: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const n = await prisma.notification.findUnique({ where: { id }, select: { assetHostname: true } });
    if (n?.assetHostname === name) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

d("open alerts follow a device rename (business rule 134)", () => {
  let assetId = "";

  beforeEach(async () => {
    await wipe();
    const a = await prisma.asset.create({ data: { hostname: OLD, status: "active", assetType: "firewall" } as never });
    assetId = a.id;
  });

  afterAll(wipe);

  it("an asset update that renames the device renames its open alert", async () => {
    const open = await alert(assetId);
    await prisma.asset.update({ where: { id: assetId }, data: { hostname: NEW } });
    await waitForName(open, NEW);
    const n = await prisma.notification.findUniqueOrThrow({ where: { id: open } });
    expect(n.assetHostname).toBe(NEW);
    expect(n.message).toBe(`${NEW} is down`);
    expect(n.templateCtx).toEqual({ asset: NEW, message: `${NEW} is down` });
  });

  it("an upsert that renames the device renames its open alert", async () => {
    const open = await alert(assetId);
    await prisma.asset.upsert({
      where: { id: assetId },
      create: { hostname: NEW, status: "active" } as never,
      update: { hostname: NEW },
    });
    await waitForName(open, NEW);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: open } })).assetHostname).toBe(NEW);
  });

  it("leaves cleared alerts and alerts named for something else", async () => {
    const cleared = await alert(assetId, { cleared: true, clearedAt: new Date() });
    const fold = await alert(assetId, { assetHostname: "Branch LAN (10.1.0.0/24)", message: `3 hosts down — ${OLD}, a, b` });
    expect(await followAssetRename(assetId, OLD, NEW)).toBe(0);
    const c = await prisma.notification.findUniqueOrThrow({ where: { id: cleared } });
    expect(c.assetHostname).toBe(OLD);
    expect(c.message).toBe(`${OLD} is down`);
    const f = await prisma.notification.findUniqueOrThrow({ where: { id: fold } });
    expect(f.assetHostname).toBe("Branch LAN (10.1.0.0/24)");
    expect(f.message).toBe(`3 hosts down — ${OLD}, a, b`);
  });

  it("a write that keeps the name touches nothing", async () => {
    const open = await alert(assetId, { message: "custom text" });
    await prisma.asset.update({ where: { id: assetId }, data: { hostname: OLD } });
    expect(await followAssetRename(assetId, OLD, OLD)).toBe(0);
    const n = await prisma.notification.findUniqueOrThrow({ where: { id: open } });
    expect(n.assetHostname).toBe(OLD);
    expect(n.message).toBe("custom text");
  });
});
