/**
 * tests/integration/deleteGuards.test.ts — business rule 167 against a real
 * database: a MIB that is still selected for a monitoring stream, and a
 * credential a Discovery still tries, cannot be deleted. Both references are
 * bare ids with no foreign key, so before this the delete went through and the
 * reference dangled. Skips when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { deleteMib, mibSelections } from "../../src/services/mibService.js";
import { createCredential, deleteCredential } from "../../src/services/credentialService.js";

const d = dbDescribe;
const PFX = "delete-guard-test";

async function cleanup() {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.monitorClassOverride.deleteMany({ where: { assetType: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.mibFile.deleteMany({ where: { moduleName: { startsWith: "DELETE-GUARD-TEST" } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
}

const mib = (suffix: string) =>
  prisma.mibFile.create({ data: { filename: `${suffix}.txt`, moduleName: `DELETE-GUARD-TEST-${suffix}`, contents: "x", size: 1, manufacturer: `${PFX}-${suffix}` } });

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("deleting a MIB (rule 167)", () => {
  it("is refused while an asset has it selected for any stream, naming the asset; allowed once cleared", async () => {
    const m = await mib("ASSET");
    const a = await prisma.asset.create({ data: { hostname: `${PFX}-sw1`, assetType: "switch", status: "active", temperatureMibId: m.id } as never });

    expect(await mibSelections(m.id)).toEqual({ assets: 1, assetNames: [`${PFX}-sw1`], classSettings: 0 });
    await expect(deleteMib(m.id)).rejects.toMatchObject({
      httpStatus: 409,
      message: `MIB DELETE-GUARD-TEST-ASSET is still selected for a monitoring stream on 1 asset: ${PFX}-sw1. Choose another MIB there first.`,
    });
    expect(await prisma.mibFile.findUnique({ where: { id: m.id } })).not.toBeNull();

    await prisma.asset.update({ where: { id: a.id }, data: { temperatureMibId: null } });
    await deleteMib(m.id);
    expect(await prisma.mibFile.findUnique({ where: { id: m.id } })).toBeNull();
  });

  it("is refused while a class monitoring setting selects it", async () => {
    const m = await mib("CLASS");
    await prisma.monitorClassOverride.create({ data: { assetType: `${PFX}-type`, interfacesMibId: m.id } as never });
    await expect(deleteMib(m.id)).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("1 class monitoring setting") });
  });

  it("counts every stream column, and caps the names", async () => {
    const m = await mib("MANY");
    const cols = ["responseTimeMibId", "cpuMemoryMibId", "temperatureMibId", "interfacesMibId", "lldpMibId", "processesMibId", "cpuMemoryMibId"];
    await Promise.all(cols.map((c, i) => prisma.asset.create({ data: { hostname: `${PFX}-m${i}`, assetType: "switch", status: "active", [c]: m.id } as never })));
    const used = await mibSelections(m.id);
    expect(used.assets).toBe(7);
    expect(used.assetNames).toHaveLength(5);
    await expect(deleteMib(m.id)).rejects.toMatchObject({ message: expect.stringContaining("(+2 more)") });
  });

  it("an unselected MIB deletes, and a missing one is a 404", async () => {
    const m = await mib("FREE");
    await deleteMib(m.id);
    await expect(deleteMib(m.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

d("deleting a credential a Discovery still tries (rule 167)", () => {
  const cred = (suffix: string) => createCredential({ name: `${PFX}-${suffix}`, type: "snmp", config: { version: "v2c", community: "public" } });

  it("is refused, naming a public Discovery and only counting a private one", async () => {
    const c = await cred("snmp");
    const pub = await prisma.networkScan.create({ data: { name: `${PFX} public sweep`, visibility: "public", methods: [{ type: "icmp" }, { type: "snmp", credentialIds: ["some-other", c.id] }] } as never });
    const priv = await prisma.networkScan.create({ data: { name: `${PFX} private sweep`, visibility: "private", methods: [{ type: "snmp", credentialIds: [c.id] }] } as never });
    await prisma.networkScan.create({ data: { name: `${PFX} unrelated`, visibility: "public", methods: [{ type: "snmp", credentialIds: ["some-other"] }] } as never });

    const err = await deleteCredential(c.id).catch((e) => e);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe(`Credential is used by Discovery "${PFX} public sweep" and 1 other Discovery; remove it from those first`);
    expect(err.message).not.toContain("private sweep");
    expect(await prisma.credential.findUnique({ where: { id: c.id } })).not.toBeNull();

    await prisma.networkScan.delete({ where: { id: pub.id } });
    await expect(deleteCredential(c.id)).rejects.toMatchObject({ httpStatus: 409, message: "Credential is used by 1 Discovery; remove it from that Discovery first" });

    await prisma.networkScan.update({ where: { id: priv.id }, data: { methods: [{ type: "icmp" }] } });
    await deleteCredential(c.id);
    expect(await prisma.credential.findUnique({ where: { id: c.id } })).toBeNull();
  });
});
