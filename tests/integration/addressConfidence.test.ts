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
import { buildAddressConfidence, checkAddressConfidence, seedPollingRuns } from "../../src/services/addressConfidenceService.js";
import { unpinPrimaryAddress } from "../../src/services/primaryAddressService.js";
import { PIN_CONTEST_WINDOW_MS } from "../../src/utils/assetInvariants.js";
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

  it("a held lease alone is medium; a 3-hour-old ARP entry alone is low", async () => {
    const s = await scores();
    expect(s.get(IP_LEASE)!.score).toBe(70);
    expect(s.get(IP_ARP)!.band).toBe("low"); // 0.6 × 0.5^(3/4) ≈ 36
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
    expect(r.evidenceScore).toBeLessThan(50);
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

d("ARP evidence, secondary addresses and contested pins (business rule 103, 2026-10-12)", () => {
  /** A gate asset holding ARP entries for the HMI's Ethernet MAC. */
  async function gateArp(ips: string[], seen = new Date()) {
    const gate = await prisma.asset.create({
      data: { hostname: PFX + "-gw", assetType: "firewall", status: "active" },
    });
    await prisma.assetArpEntry.createMany({
      data: ips.map((ip) => ({ assetId: gate.id, ipAddress: ip, macAddress: ETH, ifName: "internal", lastSeen: seen, firstSeen: seen })),
    });
  }
  /** An unpolled static device the gate DETECTED at one address. */
  async function detectedOnly(ip: string) {
    await prisma.reservation.deleteMany({ where: { ipAddress: IP_PRIMARY } });
    await prisma.assetAssociatedIp.deleteMany({ where: { assetId } });
    await prisma.assetAssociatedIp.create({
      data: { assetId, ip, mac: ETH, source: "device-inventory", device: GATE, medium: "wired", lastSeen: new Date(), firstSeen: new Date() },
    });
    await prisma.asset.update({ where: { id: assetId }, data: { ipAddress: ip, monitored: false, ipConfirmedFor: null, ipConfirmedSince: null } });
  }

  it("the gate's ARP table corroborates an address whatever source names its row", async () => {
    await detectedOnly(IP_PRIMARY);
    expect((await scores()).get(IP_PRIMARY)!.score).toBe(70);
    await gateArp([IP_PRIMARY]);
    const r = (await scores()).get(IP_PRIMARY)!;
    expect(r.parts.map((p) => p.kind).sort()).toEqual(["arp", "detected-online"]);
    expect(r.parts.find((p) => p.kind === "arp")!.device).toBe(PFX + "-gw");
    expect(r.score).toBe(88); // 1 − 0.3 × 0.4
  });

  it("a detected address ARP contradicts is halved, and the address ARP resolves out-scores it", async () => {
    // The prod shape: detected at one address, the gate's ARP has the MAC at another.
    await detectedOnly(IP_LEASE);
    await gateArp([IP_PRIMARY]);
    const s = (await buildAddressConfidence([assetId], { extraIps: new Map([[assetId, [IP_PRIMARY]]]) })).get(assetId)!;
    const detected = s.get(IP_LEASE)!;
    expect(detected.penalties.map((p) => p.kind)).toEqual(["arp-elsewhere"]);
    expect(detected.penalties[0]!.detail).toContain(IP_PRIMARY);
    expect(detected.score).toBe(35);
    expect(s.get(IP_PRIMARY)!.score).toBe(60);
  });

  it("a card ARP shows with several addresses: what the gate detected counts as ambiguous", async () => {
    await detectedOnly(IP_LEASE);
    await gateArp([IP_LEASE, IP_PRIMARY]);
    const r = (await scores()).get(IP_LEASE)!;
    expect(r.parts.map((p) => p.kind).sort()).toEqual(["arp", "detected-ambiguous"]);
    expect(r.score).toBe(68); // 1 − 0.8 × 0.4 — ARP carries it, not the detection
  });

  it("evidence does not age while polling answers on the address", async () => {
    const old = new Date(Date.now() - 18 * 3_600_000);
    await prisma.assetAssociatedIp.updateMany({ where: { assetId, ip: IP_PRIMARY }, data: { lastSeen: old } });
    await prisma.reservation.updateMany({ where: { ipAddress: IP_PRIMARY }, data: { lastSeenLeased: old } });
    const polled = (await scores()).get(IP_PRIMARY)!;
    expect(polled.sustained).toBe(true);
    expect(polled.parts.find((p) => p.kind === "detected-online")!.value).toBe(0.7);
    // The same evidence, unpolled, has faded.
    await prisma.asset.update({ where: { id: assetId }, data: { monitored: false } });
    const unpolled = (await scores()).get(IP_PRIMARY)!;
    expect(unpolled.sustained).toBe(false);
    expect(unpolled.parts.find((p) => p.kind === "detected-online")!.value).toBeLessThan(0.1);
  });

  it("the guard stamps a contest when a write tries to move a pinned asset, and the release then holds", async () => {
    // Pin the address the network backs best — releasable on the scores alone.
    await prisma.asset.update({ where: { id: assetId }, data: { primaryAddressMac: ETH, primaryAddressIp: IP_PRIMARY, ipAddress: IP_PRIMARY } });
    // Discovery tries to move it (as rule 101's ladder did in prod).
    await prisma.asset.update({ where: { id: assetId }, data: { ipAddress: IP_LEASE, ipSource: GATE } });
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipAddress: true, primaryAddressContestedAt: true } });
    expect(a.ipAddress).toBe(IP_PRIMARY);
    expect(a.primaryAddressContestedAt).not.toBeNull();

    expect((await releaseConfirmedPins()).released).toBe(0);
    // Once discovery has stopped contesting for the whole window, it may go.
    await prisma.asset.update({
      where: { id: assetId },
      data: { primaryAddressContestedAt: new Date(Date.now() - PIN_CONTEST_WINDOW_MS - 60_000) },
    });
    expect((await releaseConfirmedPins()).released).toBe(1);
  });
});

d("infra and history evidence (business rule 103, 2026-10-11)", () => {
  it("a FortiAP with no address rows scores from its controller record's management IP", async () => {
    const ap = await prisma.asset.create({
      data: {
        hostname: PFX + "-ap", assetType: "access_point", status: "active", ipAddress: "10.93.128.12",
        sources: { create: [{ sourceKind: "fortiap", externalId: PFX + "-AP-SERIAL", observed: { mgmtIp: "10.93.128.12" }, lastSeen: new Date() }] },
      } as any,
    });
    const r = (await buildAddressConfidence([ap.id])).get(ap.id)!.get("10.93.128.12")!;
    expect(r.parts.map((p) => p.kind)).toContain("controller");
    expect(r.score).toBe(90);
  });

  it("seeds the polling run from probe history: since the later of the last failure and the address's first sighting", async () => {
    const now = Date.now();
    await prisma.asset.update({ where: { id: assetId }, data: { ipConfirmedFor: null, ipConfirmedSince: null } });
    const lastFail = new Date(now - 5 * 86_400_000);
    await prisma.assetMonitorSample.createMany({ data: [
      { assetId, timestamp: new Date(now - 9 * 86_400_000), success: true, responseTimeMs: 3 },
      { assetId, timestamp: lastFail, success: false, responseTimeMs: null },
      { assetId, timestamp: new Date(now - 60_000), success: true, responseTimeMs: 3 },
    ] as any });
    await prisma.assetIpHistory.upsert({
      where: { assetId_ip: { assetId, ip: IP_PRIMARY } },
      create: { assetId, ip: IP_PRIMARY, source: GATE, firstSeen: new Date(now - 20 * 86_400_000), lastSeen: new Date() },
      update: { firstSeen: new Date(now - 20 * 86_400_000) },
    });
    expect(await seedPollingRuns()).toBeGreaterThanOrEqual(1);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipConfirmedFor: true, ipConfirmedSince: true } });
    expect(a.ipConfirmedFor).toBe(IP_PRIMARY);
    expect(a.ipConfirmedSince?.toISOString()).toBe(lastFail.toISOString());
    // Idempotent: a row with a run is left alone.
    await prisma.assetMonitorSample.create({ data: { assetId, timestamp: new Date(now - 30_000), success: false } as any });
    await seedPollingRuns();
    const again = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipConfirmedSince: true } });
    expect(again.ipConfirmedSince?.toISOString()).toBe(lastFail.toISOString());
  });

  it("unpinning moves to the listed address with the highest evidence, never to an address off the list", async () => {
    // A FortiGate endpoint record still carries an address the list no longer has.
    await prisma.assetSource.create({
      data: { assetId, sourceKind: "fortigate-endpoint", externalId: ETH, observed: { ipAddress: "10.93.200.200" }, lastSeen: new Date() } as any,
    });
    await prisma.asset.update({ where: { id: assetId }, data: { primaryAddressMac: WIFI, primaryAddressIp: IP_LEASE, ipAddress: IP_LEASE } });
    const r = await unpinPrimaryAddress({ assetId, actor: "tester" });
    expect(r.ipAddress).toBe(IP_PRIMARY);
    const a = await prisma.asset.findUniqueOrThrow({ where: { id: assetId }, select: { ipAddress: true, ipSource: true, primaryAddressIp: true } });
    expect(a).toMatchObject({ ipAddress: IP_PRIMARY, ipSource: GATE, primaryAddressIp: null });
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
