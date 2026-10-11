/**
 * tests/integration/addressConfidence.test.ts — business rule 103 against a
 * real database: the evidence the service gathers for each address, the two
 * penalties, the API shapes (detail with breakdown, list compact), the
 * pre-apply check, and the polling run the probe path keeps.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { buildAddressConfidence, checkAddressConfidence } from "../../src/services/addressConfidenceService.js";
import { recordProbeResult } from "../../src/services/monitoringService.js";
import { flushProbePatchBuffer } from "../../src/services/probePatchBuffer.js";
import { releaseConfirmedPins } from "../../src/services/primaryAddressService.js";

const d = dbDescribe;
const PFX = "addrconf-test";
const PASSWORD = "addrconf-password-not-real";
const ETH = "AA:BB:CC:03:03:40";
const WIFI = "AA:BB:CC:03:03:95";
const GATE = "ADDRCONF-GW";
const IP_PRIMARY = "10.93.25.235";
const IP_LEASE = "10.93.6.23";
const IP_ARP = "10.93.25.236";
let assetId = "";
let blockId = "";
let writeUser = "";
let readUser = "";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}
async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({ data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
  return username;
}
type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();
async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error("login failed " + resp.status);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  const blocks = await prisma.ipBlock.findMany({ where: { name: PFX }, select: { id: true } });
  if (blocks.length) {
    const subnets = await prisma.subnet.findMany({ where: { blockId: { in: blocks.map((b) => b.id) } }, select: { id: true } });
    await prisma.reservation.deleteMany({ where: { subnetId: { in: subnets.map((s) => s.id) } } });
    await prisma.subnet.deleteMany({ where: { id: { in: subnets.map((s) => s.id) } } });
    await prisma.ipBlock.deleteMany({ where: { id: { in: blocks.map((b) => b.id) } } });
  }
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  writeUser = await createRoleUser("w", matrix("none", { assets: "write" }));
  readUser = await createRoleUser("r", matrix("none", { assets: "read" }));
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const now = new Date();
  blockId = (await prisma.ipBlock.create({ data: { name: PFX, cidr: "10.93.0.0/16", ipVersion: "v4" } as any })).id;
  const subnet = await prisma.subnet.create({ data: { blockId, cidr: "10.93.25.0/24", name: PFX + "-net", fortigateDevice: GATE } });
  await prisma.reservation.create({
    data: { subnetId: subnet.id, ipAddress: IP_PRIMARY, macAddress: ETH, sourceType: "dhcp_reservation", status: "active", lastSeenLeased: now },
  });
  assetId = (await prisma.asset.create({
    data: {
      hostname: PFX + "-hmi", assetType: "workstation", status: "active", macAddress: ETH,
      ipAddress: IP_PRIMARY, monitored: true, monitorStatus: "up",
      ipConfirmedFor: IP_PRIMARY, ipConfirmedSince: new Date(now.getTime() - 72 * 3_600_000),
      macAddressRows: { create: [
        { mac: ETH, source: "intune-ethernet", lastSeen: now, firstSeen: now },
        { mac: WIFI, source: "intune-wifi", lastSeen: now, firstSeen: now },
      ] },
      associatedIpRows: { create: [
        { ip: IP_PRIMARY, mac: ETH, source: "device-inventory", device: GATE, medium: "wired", lastSeen: now, firstSeen: now },
        { ip: IP_LEASE, mac: WIFI, source: "dhcp-lease", device: GATE, medium: "wireless", lastSeen: now, firstSeen: now },
        { ip: IP_ARP, mac: ETH, source: "arp", device: GATE, lastSeen: new Date(now.getTime() - 3 * 3_600_000), firstSeen: now },
      ] },
    },
  })).id;
});

const scores = async () => (await buildAddressConfidence([assetId])).get(assetId)!;

d("address confidence evidence (business rule 103)", () => {
  it("the primary corroborated by a detected device, a held reservation and 3 days of polling is high", async () => {
    const r = (await scores()).get(IP_PRIMARY)!;
    expect(r.score).toBeGreaterThanOrEqual(99);
    expect(r.parts.map((p) => p.kind).sort()).toEqual(
      ["detected-online", "polling", "reservation-configured", "reservation-held"].sort());
  });

  it("a held lease alone is medium; a 3-hour-old ARP entry alone is very low", async () => {
    const s = await scores();
    expect(s.get(IP_LEASE)!.score).toBe(70);
    expect(s.get(IP_ARP)!.band).toBe("very-low");
  });

  it("a reservation for ANOTHER device's MAC is not evidence for this one", async () => {
    await prisma.reservation.updateMany({ where: { ipAddress: IP_PRIMARY }, data: { macAddress: "AA:BB:CC:99:99:99" } });
    const r = (await scores()).get(IP_PRIMARY)!;
    expect(r.parts.some((p) => p.kind.startsWith("reservation"))).toBe(false);
  });

  it("polling credit stops while the device is down — and alive-elsewhere cuts the score", async () => {
    // Down on the primary, while the gate sees it online at the lease address.
    await prisma.asset.update({ where: { id: assetId }, data: { monitorStatus: "down" } });
    await prisma.assetAssociatedIp.update({
      where: { assetId_ip: { assetId, ip: IP_LEASE } },
      data: { source: "device-inventory", lastSeen: new Date() },
    });
    const r = (await scores()).get(IP_PRIMARY)!;
    expect(r.parts.some((p) => p.kind === "polling")).toBe(false);
    expect(r.penalties.map((p) => p.kind)).toContain("alive-elsewhere");
    expect(r.penalties[0]!.detail).toContain(IP_LEASE);
  });

  it("another present device holding the address more recently halves it", async () => {
    await prisma.asset.create({
      data: { hostname: PFX + "-other", assetType: "workstation", status: "active", ipAddress: IP_LEASE, lastSeen: new Date(Date.now() + 1000) },
    });
    const r = (await scores()).get(IP_LEASE)!;
    expect(r.penalties.map((p) => p.kind)).toEqual(["claimed-elsewhere"]);
    expect(r.score).toBe(35);
  });

  it("a pin counts in the score but not the evidence score", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { primaryAddressMac: ETH, primaryAddressIp: IP_ARP, ipAddress: IP_ARP } });
    const r = (await scores()).get(IP_ARP)!;
    expect(r.parts.some((p) => p.kind === "operator")).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.evidenceScore).toBeLessThan(20);
  });

  it("the check scores an address never seen on the device as 0, and warns", async () => {
    const c = await checkAddressConfidence(assetId, "10.93.99.99");
    expect(c.evidenceScore).toBe(0);
    expect(c.warn).toBe(true);
    expect(c.probe).toBeNull();
    const strong = await checkAddressConfidence(assetId, IP_PRIMARY);
    expect(strong.warn).toBe(false);
  });
});

d("address confidence API (business rule 103)", () => {
  it("GET /assets/:id carries every address's score with its breakdown", async () => {
    const { agent } = await loginAs(readUser);
    const r = await agent.get(`/api/v1/assets/${assetId}`);
    expect(r.status).toBe(200);
    expect(r.body.addressConfidence[IP_PRIMARY].score).toBeGreaterThanOrEqual(99);
    expect(Array.isArray(r.body.addressConfidence[IP_PRIMARY].parts)).toBe(true);
  });

  it("the asset list carries score and band only", async () => {
    const { agent } = await loginAs(readUser);
    const r = await agent.get(`/api/v1/assets?search=${PFX}-hmi`);
    expect(r.status).toBe(200);
    const rows = Array.isArray(r.body) ? r.body : r.body.assets ?? r.body.items ?? r.body.data;
    const row = rows.find((a: any) => a.id === assetId);
    expect(row.addressConfidence[IP_LEASE]).toEqual({ score: 70, band: "medium" });
  });

  it("POST /address-check needs assets:write, validates the address, and can probe", async () => {
    const ro = await loginAs(readUser);
    expect((await ro.agent.post(`/api/v1/assets/${assetId}/address-check`).set("X-CSRF-Token", ro.csrf).send({ ip: IP_PRIMARY })).status).toBe(403);
    const w = await loginAs(writeUser);
    expect((await w.agent.post(`/api/v1/assets/${assetId}/address-check`).set("X-CSRF-Token", w.csrf).send({ ip: "not-an-ip" })).status).toBe(400);
    const r = await w.agent.post(`/api/v1/assets/${assetId}/address-check`).set("X-CSRF-Token", w.csrf).send({ ip: "127.0.0.1", probe: true });
    expect(r.status).toBe(200);
    expect(r.body.warn).toBe(true);
    expect(r.body.probe).toHaveProperty("answered");
  }, 20_000);
});

d("a pin the network comes to back is released (business rule 103(a))", () => {
  const pin = (ip: string, mac: string) =>
    prisma.asset.update({ where: { id: assetId }, data: { primaryAddressMac: mac, primaryAddressIp: ip, ipAddress: ip, ipSource: "pinned", ipConfirmedFor: ip } });
  const readPin = () => prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { primaryAddressIp: true, ipAddress: true, ipSource: true } });

  it("releases a pin whose address out-scores every other on discovery evidence alone", async () => {
    // IP_PRIMARY: detected online + held reservation (~99); the lease 70; ARP very low.
    await pin(IP_PRIMARY, ETH);
    const r = await releaseConfirmedPins();
    expect(r.released).toBe(1);
    const after = await readPin();
    expect(after.primaryAddressIp).toBeNull();
    expect(after.ipAddress).toBe(IP_PRIMARY); // the address stays; only the pin goes
    expect(after.ipSource).toBe(GATE);
    const ev = await prisma.event.findFirst({ where: { resourceId: assetId, action: "asset.primary_address.released" } });
    expect(ev).not.toBeNull();
  });

  it("holds a pin on an address the network backs less than another", async () => {
    await pin(IP_LEASE, WIFI);
    expect((await releaseConfirmedPins()).released).toBe(0);
    expect((await readPin()).primaryAddressIp).toBe(IP_LEASE);
  });

  it("polling credit alone never releases a pin", async () => {
    // The ARP address pinned and polled for weeks: its own evidence is weak, so
    // it is not "backed" however long monitoring has relied on it.
    await pin(IP_ARP, ETH);
    await prisma.asset.update({ where: { id: assetId }, data: { ipConfirmedSince: new Date(Date.now() - 30 * 86_400_000) } });
    await prisma.assetAssociatedIp.deleteMany({ where: { assetId, ip: { in: [IP_PRIMARY, IP_LEASE] } } });
    await prisma.reservation.deleteMany({ where: { ipAddress: IP_PRIMARY } });
    expect((await releaseConfirmedPins()).released).toBe(0);
    expect((await readPin()).primaryAddressIp).toBe(IP_ARP);
  });
});

d("the polling run the probe path keeps (business rule 103)", () => {
  it("starts on a new address, holds across ordinary successes, ignores failures", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { ipConfirmedFor: null, ipConfirmedSince: null } });
    await recordProbeResult(assetId, { success: true, responseTimeMs: 3 } as any);
    await flushProbePatchBuffer();
    const first = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipConfirmedFor: true, ipConfirmedSince: true } });
    expect(first.ipConfirmedFor).toBe(IP_PRIMARY);
    expect(first.ipConfirmedSince).not.toBeNull();

    await recordProbeResult(assetId, { success: true, responseTimeMs: 4 } as any);
    await recordProbeResult(assetId, { success: false, responseTimeMs: 0, error: "timeout" } as any);
    await flushProbePatchBuffer();
    const held = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipConfirmedFor: true, ipConfirmedSince: true } });
    expect(held.ipConfirmedSince?.toISOString()).toBe(first.ipConfirmedSince?.toISOString());

    await prisma.asset.update({ where: { id: assetId }, data: { ipAddress: IP_LEASE } });
    await recordProbeResult(assetId, { success: true, responseTimeMs: 5 } as any);
    await flushProbePatchBuffer();
    const moved = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipConfirmedFor: true } });
    expect(moved.ipConfirmedFor).toBe(IP_LEASE);
  });
});
