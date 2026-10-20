/**
 * tests/integration/subnetSupersedeDeprecated.test.ts
 *
 * A dead subnet must not squat on its CIDR (business rule 41), driven through
 * the REAL Phase 1 of syncDhcpSubnets against a real database — because the
 * bug this covers lived entirely in the wiring, not in the decision.
 *
 * WHAT WENT WRONG. Rule 41 shipped with the chassis comparison inside Phase 1's
 * `if (existing)` branch, and `existing` comes from `subnetByCidr`, which
 * EXCLUDES deprecated rows. So for a subnet that was already deprecated — every
 * subnet on an install that had a gate replaced before the feature existed —
 * the comparison never ran at all: the lookup missed, the create path was
 * reached, and the committed-state overlap check refused it on the dead row.
 * The operator saw the same "skipped subnet" event as before, on a build that
 * supposedly fixed it, and the only remedy was an API call with no UI behind
 * it. Unit tests could not catch that: `classifyDeprecatedSupersede` was right,
 * it just wasn't reachable.
 *
 * The other half is what must NOT happen. An operator who deprecates a subnet
 * that its own gate still serves gets it re-reported on every cycle, and
 * archiving there would silently hand a retired range back as active.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;

// Synthetic serials — never paste real fleet serials into tests.
const OLD_SN = "FGT60FTK00000001";
const NEW_SN = "FGT81FTK00000002";
const CIDR = "10.79.5.0/24";

let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.archivedSubnet.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();
  await prisma.integration.deleteMany();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "supersede-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/** A block plus one DEPRECATED subnet holding CIDR, as an old gate left it. */
async function deadSubnet(opts: { device: string; serial: string | null }) {
  const block = await prisma.ipBlock.create({
    data: { name: "Supersede Block", cidr: "10.79.0.0/16", ipVersion: "v4" },
  });
  const subnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr: CIDR,
      name: `DHCP: lan (${opts.device})`,
      status: "deprecated",
      discoveredBy: integrationId,
      fortigateDevice: opts.device,
      fortigateSerial: opts.serial,
    },
  });
  await prisma.reservation.create({
    data: {
      subnetId: subnet.id, ipAddress: "10.79.5.20", hostname: "old-printer",
      sourceType: "manual", status: "active",
    },
  });
  return { block, subnet };
}

/** A DiscoveryResult carrying one subnet from `device`, and nothing else. */
function resultWith(device: string, serial: string) {
  return {
    subnets: [{ cidr: CIDR, name: "lan", fortigateDevice: device, fortigateSerial: serial, dhcpServerId: "1" }],
    devices: [{ name: device, hostname: device, serial, model: "", mgmtIp: "", haMode: "standalone", haMembers: [] }],
    interfaceIps: [], dhcpEntries: [], deviceInventory: [],
    inventoryDevices: [device],
    knownDeviceNames: [device],
    knownDeviceSerials: [serial],
    fortiSwitches: [], fortiAps: [], vips: [],
    macTable: [], arpEntries: [],
  } as any;
}

const run = (device: string, serial: string) =>
  syncDhcpSubnets(
    integrationId, "supersede-test", "fortimanager",
    resultWith(device, serial), "tester", "full",
  );

// Each case drives the real Phase 1 (the last one twice), which runs past the
// 5 s default on a loaded CI runner as well as on Windows/WSL podman.
d("Phase 1 — a dead subnet does not squat on its CIDR", { timeout: 60_000 }, () => {
  it("retires it and creates the new gate's subnet when a DIFFERENT gate serves the range", async () => {
    // The reported failure, end to end: subnet deprecated with no serial (it
    // predates the column), a differently-named gate now reports the range.
    await deadSubnet({ device: "old-gate", serial: null });

    const out = await run("new-gate", NEW_SN);

    expect(out.created).toContain(CIDR);
    expect(out.skipped.join(" ")).not.toContain(CIDR);

    const live = await prisma.subnet.findMany({ where: { cidr: CIDR } });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      status: "available",
      fortigateDevice: "new-gate",
      fortigateSerial: NEW_SN,
    });

    // The dead one is in the archive, with what it held.
    const archived = await prisma.archivedSubnet.findMany({ include: { reservations: true } });
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ cidr: CIDR, fortigateDevice: "old-gate" });
    expect(archived[0]!.reservations).toHaveLength(1);
    expect(archived[0]!.reservations[0]).toMatchObject({ hostname: "old-printer" });
  });

  it("retires it on a serial change even when the gate NAME is reused (an RMA swap)", async () => {
    await deadSubnet({ device: "gate-a", serial: OLD_SN });

    const out = await run("gate-a", NEW_SN);

    expect(out.created).toContain(CIDR);
    const live = await prisma.subnet.findFirstOrThrow({ where: { cidr: CIDR } });
    expect(live).toMatchObject({ status: "available", fortigateSerial: NEW_SN });
    expect(await prisma.archivedSubnet.count()).toBe(1);
  });

  it("LEAVES it deprecated when the same chassis still serves it", async () => {
    // An operator retired a range its own gate still hands out. Reactivating it
    // would silently undo that decision.
    await deadSubnet({ device: "gate-a", serial: OLD_SN });

    const out = await run("gate-a", OLD_SN);

    expect(out.created.join(" ")).not.toContain(CIDR);
    expect(out.skipped.join(" ")).toContain(CIDR);
    const rows = await prisma.subnet.findMany({ where: { cidr: CIDR } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("deprecated");
    expect(await prisma.archivedSubnet.count()).toBe(0);
  });

  it("leaves it deprecated when the name matches and there is no stored serial", async () => {
    // Genuinely ambiguous — a same-name RMA swap and a deliberate deprecation
    // look identical with no serial to compare, so the operator's call stands.
    await deadSubnet({ device: "gate-a", serial: null });

    const out = await run("gate-a", NEW_SN);

    expect(out.skipped.join(" ")).toContain(CIDR);
    const rows = await prisma.subnet.findMany({ where: { cidr: CIDR } });
    expect(rows[0]!.status).toBe("deprecated");
  });

  it("the skip names the fix instead of reporting a self-overlap", async () => {
    // The old message was `Subnet X overlaps with existing subnet X` — true,
    // useless, and the reason this went unnoticed for a whole release.
    await deadSubnet({ device: "gate-a", serial: OLD_SN });
    const out = await run("gate-a", OLD_SN);
    const reason = out.skipped.find((sk: string) => sk.startsWith(CIDR)) || "";
    expect(reason).toContain("deprecated network still holds this range");
    expect(reason).not.toContain("overlaps with existing subnet");
  });

  it("a second run after the retirement is a no-op, not a re-archive", async () => {
    await deadSubnet({ device: "old-gate", serial: null });
    await run("new-gate", NEW_SN);
    const out = await run("new-gate", NEW_SN);
    expect(out.updated).toContain(CIDR);
    expect(await prisma.archivedSubnet.count()).toBe(1);
    expect(await prisma.subnet.count({ where: { cidr: CIDR } })).toBe(1);
  });
});
