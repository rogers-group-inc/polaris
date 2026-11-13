/**
 * tests/integration/deleteGuards.test.ts — business rule 167 against a real
 * database: a credential a Discovery still tries cannot be deleted (a bare id
 * with no foreign key, so before this the delete went through and the
 * reference dangled). A MIB is no longer guarded: the per-stream pins that
 * named one are retired (rule 173), and a stale pin must not block a delete.
 * Skips when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { deleteMib } from "../../src/services/mibService.js";
import { createCredential, deleteCredential } from "../../src/services/credentialService.js";
import { deleteCheck } from "../../src/services/pathCheckService.js";
import { deleteWidget, deleteProfile } from "../../src/services/manufacturerProfileService.js";

const d = dbDescribe;
const PFX = "delete-guard-test";

async function cleanup() {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.monitorClassOverride.deleteMany({ where: { assetType: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.mibFile.deleteMany({ where: { moduleName: { startsWith: "DELETE-GUARD-TEST" } } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.manufacturerProfile.deleteMany({ where: { manufacturer: { startsWith: PFX } } });
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

d("deleting a MIB (rule 173: no stream pin holds it)", () => {
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

d("deleting a path check, widget or probe an automation is narrowed to (rule 167(a))", () => {
  const automation = (name: string, metric: string, dimensionFilter: Record<string, string>) =>
    prisma.notificationRule.create({ data: { name: `${PFX} ${name}`, trigger: { type: "asset_metric", metric, operator: "==", threshold: 0, dimensionFilter } } as never });

  it("refuses the path check, naming the automation; allowed once the automation lets go", async () => {
    const check = await prisma.pathCheck.create({ data: { name: `${PFX} portal`, kind: "http", target: "https://example.invalid/", traceroute: {}, scope: {}, definitionSha256: "x" } as never });
    await automation("any check", "pathOk", {});
    const rule = await automation("portal down", "pathOk", { checkId: check.id });

    const err = await deleteCheck(check.id, "tester").catch((e) => e);
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe(`Path check "${PFX} portal" is still named by automation "${PFX} portal down". Point it at another check, or remove the condition, first.`);
    expect(await prisma.pathCheck.findUnique({ where: { id: check.id } })).not.toBeNull();

    await prisma.notificationRule.delete({ where: { id: rule.id } });
    await deleteCheck(check.id, "tester");
    expect(await prisma.pathCheck.findUnique({ where: { id: check.id } })).toBeNull();
  });

  it("refuses a widget and a state probe, and the profile that holds them", async () => {
    const profile = await prisma.manufacturerProfile.create({ data: { manufacturer: `${PFX}-vendor` } as never });
    const widget = await prisma.manufacturerCustomWidget.create({ data: { profileId: profile.id, name: "Clients", widgetType: "value" } as never });
    const probe = await prisma.manufacturerCustomWidget.create({ data: { profileId: profile.id, name: "PSU state", widgetType: "state" } as never });
    const free = await prisma.manufacturerCustomWidget.create({ data: { profileId: profile.id, name: "Unused", widgetType: "value" } as never });
    const r1 = await automation("clients", "customWidgetValue", { widgetId: widget.id });
    const r2 = await automation("psu", "customStateValue", { stateProbeId: probe.id });

    await expect(deleteWidget(widget.id)).rejects.toMatchObject({ httpStatus: 409, message: `Widget "Clients" is still named by automation "${PFX} clients". Point it at another widget, or remove the condition, first.` });
    await expect(deleteWidget(probe.id)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(deleteProfile(profile.id)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await prisma.manufacturerCustomWidget.count({ where: { profileId: profile.id } })).toBe(3);

    await deleteWidget(free.id);
    expect(await prisma.manufacturerCustomWidget.count({ where: { profileId: profile.id } })).toBe(2);

    await prisma.notificationRule.deleteMany({ where: { id: { in: [r1.id, r2.id] } } });
    await deleteProfile(profile.id);
    expect(await prisma.manufacturerProfile.findUnique({ where: { id: profile.id } })).toBeNull();
  });
});
