/**
 * tests/integration/assetMacRemove.test.ts
 *
 * DELETE /assets/:id/macs/:mac — the operator's correction when a MAC has been
 * associated with the wrong asset (a dock, a ZTNA-relayed identity, a merge
 * that took too much with it).
 *
 * Three things are pinned here, because all three were wrong or unproven while
 * the endpoint was effectively unreachable:
 *
 *  - **The gate is `assets:write`.** The browser gated the only button that
 *    calls this on `subnets:fullwrite` (`canManageNetworks`), so the built-in
 *    `assetsadmin` — the role whose whole job is inventory correction — could
 *    call the endpoint but never saw the control. The button now reads
 *    `canManageAssets`; this suite pins the server half so the two can't drift
 *    apart again.
 *  - **Promoting a survivor obeys `selectPrimaryMac`.** Removing the asset's
 *    primary MAC used to promote the freshest surviving row by a local sort,
 *    which honoured neither of that helper's rules: hardware-truth sources
 *    outrank network sightings, and a RANGE row is a port block, never a
 *    device identity.
 *  - **Removal is ONE-SHOT.** Nothing is suppressed — the row is deleted and a
 *    later discovery sighting may legitimately re-add it. That is the agreed
 *    contract, so the test asserts the row is simply gone rather than
 *    tombstoned.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;
const PFX = "macremove-test";
const PASSWORD = "macremove-password-not-real";

/** A role matrix: `base` everywhere, then the named overrides. */
function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  return username;
}

type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();

async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) {
    throw new Error("login as " + username + " failed (" + resp.status + "): " + JSON.stringify(resp.body));
  }
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

// The assetsadmin shape: full inventory editing, no IP-space grant at all —
// the combination the old `canManageNetworks` gate hid the button from.
let assetsWriteUser = "";
// Can read inventory, can change nothing.
let assetsReadUser = "";
let assetId = "";

const DOCK_MAC    = "AA:BB:CC:00:00:01"; // freshest, but only a network sighting
const NIC_MAC     = "AA:BB:CC:00:00:02"; // hardware truth, older
const RANGE_START = "DD:EE:FF:00:00:00"; // interface-scrape port block
const RANGE_END   = "DD:EE:FF:00:00:2F";

/** Rebuild the asset with a known MAC set. `primary` seeds Asset.macAddress. */
async function seedAsset(primary: string) {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  const asset = await prisma.asset.create({
    data: {
      hostname: PFX + "-host",
      assetType: "workstation",
      status: "active",
      ipAddress: "10.99.241.5",
      monitored: false,
      macAddress: primary,
      macAddressRows: {
        create: [
          // Freshest of the three, but a SIGHTING — the dock case.
          { mac: DOCK_MAC, source: "fortigate", lastSeen: new Date("2026-09-20T12:00:00Z"), firstSeen: new Date("2026-09-01T00:00:00Z") },
          // Older, but the device's own NIC as Intune reports it.
          { mac: NIC_MAC, source: "intune-ethernet", lastSeen: new Date("2026-09-19T12:00:00Z"), firstSeen: new Date("2026-09-01T00:00:00Z") },
          // A folded port block. Fresher than either single MAC, so a
          // freshest-wins sort would pick it.
          { mac: RANGE_START, macEnd: RANGE_END, source: "monitor-interface", lastSeen: new Date("2026-09-21T12:00:00Z"), firstSeen: new Date("2026-09-01T00:00:00Z") },
        ],
      },
    } as never,
  });
  assetId = asset.id;
  return asset.id;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  assetsWriteUser = await createRoleUser("assetswrite", matrix("none", { assets: "write" }));
  assetsReadUser  = await createRoleUser("assetsread",  matrix("none", { assets: "read" }));
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seedAsset(DOCK_MAC);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
});

d("DELETE /assets/:id/macs/:mac is reachable by an assets administrator", () => {
  it("assets=write with NO subnets grant can remove a MAC", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(200);
    const rows = await prisma.assetMacAddress.findMany({ where: { assetId } });
    expect(rows.map((r) => r.mac).sort()).toEqual([NIC_MAC, RANGE_START]);
  });

  it("assets=read cannot", async () => {
    const s = await loginAs(assetsReadUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(403);
    expect(await prisma.assetMacAddress.count({ where: { assetId } })).toBe(3);
  });

  it("a MAC the asset does not carry is a 404, not a silent success", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent("11:22:33:44:55:66"))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(404);
  });

  it("accepts the hyphen-separated and lower-case spellings of a stored MAC", async () => {
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent("aa-bb-cc-00-00-01"))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(200);
    expect(await prisma.assetMacAddress.findFirst({ where: { assetId, mac: DOCK_MAC } })).toBeNull();
  });
});

d("removing the primary MAC promotes a survivor through selectPrimaryMac", () => {
  it("prefers the hardware-truth NIC over the fresher sighting", async () => {
    // Seed with the dock as primary, then remove it: the freshest SURVIVING
    // row is the interface range, and the freshest surviving SINGLE row is the
    // NIC. Both of the helper's rules point at the NIC.
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(200);
    expect(res.body.macAddress).toBe(NIC_MAC);
    const after = await prisma.asset.findUnique({ where: { id: assetId }, select: { macAddress: true } });
    expect(after?.macAddress).toBe(NIC_MAC);
  });

  it("never promotes an interface-scrape RANGE row, even when it is the only survivor", async () => {
    const s = await loginAs(assetsWriteUser);
    // Clear both single MACs; the port block is all that is left.
    for (const mac of [NIC_MAC, DOCK_MAC]) {
      const res = await s.agent
        .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(mac))
        .set("X-CSRF-Token", s.csrf);
      expect(res.status).toBe(200);
    }
    const after = await prisma.asset.findUnique({ where: { id: assetId }, select: { macAddress: true } });
    // Null, NOT the range's start key: a port block is not a device identity.
    expect(after?.macAddress).toBeNull();
    expect(await prisma.assetMacAddress.count({ where: { assetId } })).toBe(1);
  });

  it("leaves the primary alone when some other MAC is removed", async () => {
    await seedAsset(NIC_MAC);
    const s = await loginAs(assetsWriteUser);
    const res = await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf);
    expect(res.status).toBe(200);
    expect(res.body.macAddress).toBe(NIC_MAC);
  });
});

d("the removal is audited and one-shot", () => {
  it("writes an asset.mac_removed Event naming the address", async () => {
    const s = await loginAs(assetsWriteUser);
    await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf)
      .expect(200);
    expect(await waitForEventCount("asset.mac_removed", 1, assetId)).toBeGreaterThanOrEqual(1);
    const ev = await prisma.event.findFirst({
      where: { action: "asset.mac_removed", resourceId: assetId },
      orderBy: { timestamp: "desc" },
    });
    expect(ev?.message).toContain(DOCK_MAC);
  });

  it("names the whole block when the removed row was a range", async () => {
    const s = await loginAs(assetsWriteUser);
    await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(RANGE_START))
      .set("X-CSRF-Token", s.csrf)
      .expect(200);
    await waitForEventCount("asset.mac_removed", 1, assetId);
    const ev = await prisma.event.findFirst({
      where: { action: "asset.mac_removed", resourceId: assetId },
      orderBy: { timestamp: "desc" },
    });
    // "Removed MAC DD:EE:FF:00:00:00" would understate an act that took 48
    // addresses with it.
    expect(ev?.message).toContain(RANGE_START);
    expect(ev?.message).toContain(RANGE_END);
  });

  it("deletes the row outright — nothing is left behind to suppress a re-sighting", async () => {
    const s = await loginAs(assetsWriteUser);
    await s.agent
      .delete("/api/v1/assets/" + assetId + "/macs/" + encodeURIComponent(DOCK_MAC))
      .set("X-CSRF-Token", s.csrf)
      .expect(200);
    // No tombstone: the contract is a one-shot correction, so discovery is
    // free to re-add the address if the network reports it again.
    expect(await prisma.assetMacAddress.count({ where: { assetId, mac: DOCK_MAC } })).toBe(0);
  });
});
