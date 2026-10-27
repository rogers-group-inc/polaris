/**
 * tests/integration/alertGroupSubnetFold.test.ts
 *
 * Business rule 75, subnet fold: an AlertGroup with `foldBy: "subnet"` puts
 * every device it governs into ONE alert per registry subnet — the most
 * specific non-deprecated Subnet holding the device's primary IP. The case it
 * exists for is a "monitor status is down" automation: a switch failing takes
 * the hosts behind it down together, and that is one page, not one per host.
 *
 * Pinned here, end to end through the engine:
 *  - two down hosts in one subnet are one alert naming both; a host in another
 *    subnet is a second alert; a host in no subnet alerts on its own;
 *  - one host recovering leaves the alert up, naming the one still down;
 *  - the last one recovering ends it;
 *  - a device group refuses the down automation, a subnet group takes it.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup, updateGroup } from "../../src/services/alertGroupService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const HOST = "subnet-fold-test";
const NAME = "subnet-fold-test";
const TAG = "subnet-fold-test";

let channelId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
  await prisma.ipBlock.deleteMany({ where: { name: { startsWith: NAME } } });
}

/** A monitored host, down (or up), carrying the tag the test automation scopes on. */
async function seedHost(name: string, ip: string | null, monitorStatus = "down"): Promise<string> {
  const now = new Date();
  const a = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${name}`, ipAddress: ip, status: "active", monitored: true, assetType: "server",
      monitorStatus, lastSeen: now, lastMonitorAt: now, tags: [TAG],
    } as never,
    select: { id: true },
  });
  return a.id;
}

async function seedSubnets(): Promise<{ plant: string; office: string }> {
  const block = await prisma.ipBlock.create({
    data: { name: `${NAME} block`, cidr: "10.250.0.0/16", ipVersion: "v4" } as never,
    select: { id: true },
  });
  // A wider subnet over the plant one, so "most specific" is actually tested.
  await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.250.0.0/20", name: "Site wide" } as never });
  const plant = await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.250.1.0/24", name: "Plant" } as never, select: { id: true } });
  const office = await prisma.subnet.create({ data: { blockId: block.id, cidr: "10.250.2.0/24", name: "Office" } as never, select: { id: true } });
  return { plant: plant.id, office: office.id };
}

async function seedDownRule(alertGroupId: string | null): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} down`,
      enabled: true,
      severity: "critical",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      // Tag-scoped, so it outranks any all-devices down automation a seed left.
      scope: { condition: { op: "and", children: [{ field: "tag", operator: "has", value: TAG }] } },
      reset: { mode: "auto" },
      actions: [],
      channels: ["in_app"],
      alertGroupId,
    } as never,
    select: { id: true },
  });
  return r.id;
}

async function seedSubnetGroup(ruleId: string): Promise<string> {
  const g = await createGroup({
    name: `${NAME} group`,
    foldBy: "subnet",
    ruleIds: [ruleId],
    actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }],
  }, "tester");
  return g.id;
}

const membersOf = (n: { members: unknown }) => (n.members ?? []) as AlertMember[];
const activeLabels = (n: { members: unknown }) =>
  membersOf(n).filter((m) => !m.leftAt).map((m) => m.label).sort();

d("an AlertGroup folding by SUBNET (business rule 75)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({
      data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} },
      select: { id: true },
    });
    channelId = ch.id;
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("refuses a down automation in a device group and takes it in a subnet group", async () => {
    const ruleId = await seedDownRule(null);
    await expect(createGroup({ name: `${NAME} device`, ruleIds: [ruleId] }, "tester")).rejects.toThrow(/per automation, per device \+ automation or per subnet/);
    const g = await createGroup({ name: `${NAME} subnet`, foldBy: "subnet", ruleIds: [ruleId] }, "tester");
    expect(g.foldBy).toBe("subnet");
    // ...and will not quietly keep it when switched back to per-device.
    await expect(updateGroup(g.id, { name: `${NAME} subnet`, foldBy: "device" }, "tester")).rejects.toThrow(/per automation, per device \+ automation or per subnet/);
  });

  it("folds the down hosts of one subnet into one alert, and keeps subnets apart", async () => {
    const sn = await seedSubnets();
    await seedHost("plc-01", "10.250.1.11");
    await seedHost("plc-02", "10.250.1.12");
    await seedHost("pc-01", "10.250.2.21");
    await seedHost("lone", "192.0.2.50"); // in no registry subnet
    const ruleId = await seedDownRule(null);
    const groupId = await seedSubnetGroup(ruleId);

    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(3);

    const plant = alerts.find((a) => a.groupKey === `grp:${groupId}|subnet:${sn.plant}`);
    expect(plant).toBeTruthy();
    expect(plant!.alertGroupId).toBe(groupId);
    expect(plant!.dimensionCount).toBe(2);
    expect(activeLabels(plant!)).toEqual([`${HOST}-plc-01`, `${HOST}-plc-02`]);
    // Named for the MOST specific subnet, not the /20 around it.
    expect(plant!.assetHostname).toBe("Plant (10.250.1.0/24)");
    expect(plant!.message).toContain("2 devices in Plant (10.250.1.0/24)");

    const office = alerts.find((a) => a.groupKey === `grp:${groupId}|subnet:${sn.office}`);
    expect(office?.dimensionCount).toBe(1);

    // No subnet: its own alert, still delivered by the group.
    const lone = alerts.find((a) => a.assetHostname === `${HOST}-lone`);
    expect(lone?.alertGroupId).toBe(groupId);
    expect(lone?.groupKey).toBe(`grp:${groupId}|${lone?.assetId}`);

    // One state row per host — detection is untouched.
    expect(await prisma.notificationRuleState.count({ where: { ruleId, state: "firing" } })).toBe(4);
  });

  it("a later host in the same subnet joins the alert instead of opening one", async () => {
    await seedSubnets();
    await seedHost("plc-01", "10.250.1.11");
    const late = await seedHost("plc-02", "10.250.1.12", "up");
    const ruleId = await seedDownRule(null);
    await seedSubnetGroup(ruleId);

    await evaluateAllNotificationRules();
    await prisma.asset.update({ where: { id: late }, data: { monitorStatus: "down" } });
    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(1);
    expect(activeLabels(alerts[0]!)).toEqual([`${HOST}-plc-01`, `${HOST}-plc-02`]);
  });

  it("stays up while any host is down, and ends with the last one", async () => {
    await seedSubnets();
    const a = await seedHost("plc-01", "10.250.1.11");
    const b = await seedHost("plc-02", "10.250.1.12");
    const ruleId = await seedDownRule(null);
    await seedSubnetGroup(ruleId);
    await evaluateAllNotificationRules();

    await prisma.asset.update({ where: { id: a }, data: { monitorStatus: "up" } });
    await evaluateAllNotificationRules();
    const mid = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(mid).toHaveLength(1);
    expect(mid[0]!.dimensionCount).toBe(1);
    expect(activeLabels(mid[0]!)).toEqual([`${HOST}-plc-02`]);
    // The departed host stays in the snapshot, stamped.
    expect(membersOf(mid[0]!).find((m) => m.assetId === a)?.leftAt).toBeTruthy();

    await prisma.asset.update({ where: { id: b }, data: { monitorStatus: "up" } });
    await evaluateAllNotificationRules();
    expect(await prisma.notification.count({ where: { ruleId, cleared: false } })).toBe(0);
  });

  it("retires the group's open alerts when the fold changes", async () => {
    await seedSubnets();
    await seedHost("plc-01", "10.250.1.11");
    const ruleId = await seedDownRule(null);
    const groupId = await seedSubnetGroup(ruleId);
    await evaluateAllNotificationRules();
    expect(await prisma.notification.count({ where: { alertGroupId: groupId, cleared: false } })).toBe(1);

    // Drop the down automation and switch to per-device in one save.
    await updateGroup(groupId, { name: `${NAME} group`, foldBy: "device", ruleIds: [] }, "tester");
    expect(await prisma.notification.count({ where: { ruleId, cleared: false, alertGroupId: groupId } })).toBe(0);
  });
});
