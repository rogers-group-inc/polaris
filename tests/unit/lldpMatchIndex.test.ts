/**
 * tests/unit/lldpMatchIndex.test.ts
 *
 * Own suite for src/services/monitoring/lldpMatchIndex.ts:
 *   - getLldpAssetMatchIndex / invalidateLldpMatchCache — the fleet-wide
 *     IP / MAC / hostname index an LLDP neighbour is resolved through, cached
 *     60 s, with rule 91's gate tie-break (gateIdByAssetId) resolved through
 *     the shared fortinetParentKey resolver (serial first, never
 *     controllerFortigate against hostname);
 *   - buildMonitorAssocIpEntries — the monitor-source address rows an
 *     interface scrape produces (rule 126: both families, reportable
 *     addresses only, loopback / link-local never land).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ ipv6: true }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/ipv6GateService.js", () => ({ ipv6Enabled: () => h.ipv6 }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getLldpAssetMatchIndex,
  invalidateLldpMatchCache,
  buildMonitorAssocIpEntries,
} from "../../src/services/monitoring/lldpMatchIndex.js";
import type { InterfaceSample } from "../../src/services/monitoring/types.js";

function assetRow(over: Record<string, unknown> = {}) {
  return {
    id: "a1", ipAddress: null, macAddress: null, hostname: null, dnsName: null,
    associatedIpRows: [], macAddressRows: [], ...over,
  };
}

function infraRow(over: Record<string, unknown> = {}) {
  return {
    id: "fw1", hostname: null, serialNumber: null, assetType: "firewall",
    controllerSerial: null, controllerFortigate: null, deviceName: null, ...over,
  };
}

function given(rows: unknown[], infra: unknown[] = []): void {
  stubbed(prisma.asset.findMany).mockResolvedValue(rows);
  stubbed(prisma.$queryRaw).mockResolvedValue(infra);
}

beforeEach(() => {
  resetDbStub();
  invalidateLldpMatchCache();
  h.ipv6 = true;
  given([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── getLldpAssetMatchIndex ────────────────────────────────────────────────

describe("getLldpAssetMatchIndex — byIp / byMac", () => {
  it("indexes the primary address and every associated address; the first holder wins a shared one", async () => {
    given([
      assetRow({ id: "a1", ipAddress: "10.0.0.1", associatedIpRows: [{ ip: "10.0.0.2" }, { ip: "2001:db8::1" }] }),
      assetRow({ id: "a2", ipAddress: "10.0.0.2", associatedIpRows: [{ ip: "10.0.0.1" }, { ip: "" }] }),
    ]);

    const idx = await getLldpAssetMatchIndex();

    expect(idx.byIp.get("10.0.0.1")).toBe("a1");
    expect(idx.byIp.get("10.0.0.2")).toBe("a1");
    expect(idx.byIp.get("2001:db8::1")).toBe("a1");
    expect(idx.byIp.has("")).toBe(false);
  });

  it("indexes the primary MAC upper-cased and every MAC row; first holder wins", async () => {
    given([
      assetRow({ id: "a1", macAddress: "aa:bb:cc:dd:ee:01", macAddressRows: [{ mac: "AA:BB:CC:DD:EE:02", macEnd: null }] }),
      assetRow({ id: "a2", macAddress: "AA:BB:CC:DD:EE:02", macAddressRows: [{ mac: "", macEnd: null }] }),
    ]);

    const idx = await getLldpAssetMatchIndex();

    expect(idx.byMac.get("AA:BB:CC:DD:EE:01")).toBe("a1");
    expect(idx.byMac.get("AA:BB:CC:DD:EE:02")).toBe("a1");
    expect(idx.byMac.size).toBe(2);
  });

  it("expands a MAC range row so any port MAC in it resolves to the asset", async () => {
    given([assetRow({ id: "sw", macAddressRows: [{ mac: "00:11:22:33:44:00", macEnd: "00:11:22:33:44:03" }] })]);
    const idx = await getLldpAssetMatchIndex();
    expect(["00:11:22:33:44:00", "00:11:22:33:44:01", "00:11:22:33:44:02", "00:11:22:33:44:03"].map((m) => idx.byMac.get(m)))
      .toEqual(["sw", "sw", "sw", "sw"]);
    expect(idx.byMac.has("00:11:22:33:44:04")).toBe(false);
  });

  it("caps a malformed huge range at 512 entries", async () => {
    given([assetRow({ id: "sw", macAddressRows: [{ mac: "00:11:22:00:00:00", macEnd: "00:11:22:FF:FF:FF" }] })]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.byMac.size).toBe(512);
  });
});

describe("getLldpAssetMatchIndex — hostnames (rule 91)", () => {
  it("indexes hostname and dnsName lower-cased, plus the leftmost label of an FQDN", async () => {
    given([assetRow({ id: "fw", hostname: "HARBOR-61F-1", dnsName: "harbor-61f-1.Example.com" })]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.byHostnameAll.get("harbor-61f-1")).toEqual(["fw"]);
    expect(idx.byHostnameAll.get("harbor-61f-1.example.com")).toEqual(["fw"]);
  });

  it("keeps EVERY asset that carries a shared hostname, not the first", async () => {
    given([assetRow({ id: "s1", hostname: "IDF-1" }), assetRow({ id: "s2", hostname: "idf-1" })]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.byHostnameAll.get("idf-1")).toEqual(["s1", "s2"]);
  });

  it("maps each firewall to itself and each managed switch / AP to its gate by controller SERIAL", async () => {
    given([], [
      infraRow({ id: "fwA", hostname: "GATE-A", serialNumber: "FGT-A" }),
      infraRow({ id: "fwB", hostname: "GATE-B", serialNumber: "FGT-B" }),
      infraRow({ id: "swA", assetType: "switch", hostname: "IDF-1", controllerSerial: "FGT-A" }),
      infraRow({ id: "swB", assetType: "switch", hostname: "IDF-1", controllerSerial: "FGT-B" }),
      infraRow({ id: "apB", assetType: "access_point", hostname: "AP-1", controllerSerial: "fgt-b" }),
    ]);

    const idx = await getLldpAssetMatchIndex();

    expect(idx.gateIdByAssetId.get("fwA")).toBe("fwA");
    expect(idx.gateIdByAssetId.get("swA")).toBe("fwA");
    expect(idx.gateIdByAssetId.get("swB")).toBe("fwB");
    expect(idx.gateIdByAssetId.get("apB")).toBe("fwB");
  });

  it("resolves a controllerFortigate stamp through the FMG device name, not the firewall's hostname", async () => {
    given([], [
      // The FMG device name differs from the configured hostname.
      infraRow({ id: "fwA", hostname: "harbor-fw", deviceName: "HARBOR-FMG-NAME" }),
      infraRow({ id: "sw1", assetType: "switch", controllerFortigate: "HARBOR-FMG-NAME" }),
    ]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.gateIdByAssetId.get("sw1")).toBe("fwA");
  });

  it("leaves a switch with no stamp, or a stamp naming no known gate, out of the gate map", async () => {
    given([], [
      infraRow({ id: "fwA", serialNumber: "FGT-A" }),
      infraRow({ id: "sw1", assetType: "switch" }),
      infraRow({ id: "sw2", assetType: "switch", controllerSerial: "FGT-NOPE" }),
    ]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.gateIdByAssetId.has("sw1")).toBe(false);
    expect(idx.gateIdByAssetId.has("sw2")).toBe(false);
  });

  it("reads the gate keys with a JSON-path projection over infra rows only", async () => {
    await getLldpAssetMatchIndex();
    const sql = (stubbed(prisma.$queryRaw).mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain(`"fortinetTopology"->>'controllerSerial'`);
    expect(sql).toContain(`"fortinetTopology"->>'controllerFortigate'`);
    expect(sql).toContain(`"fortinetTopology"->>'deviceName'`);
    expect(sql).toMatch(/IN \('firewall', 'switch', 'access_point'\)/);
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].select).not.toHaveProperty("fortinetTopology");
  });
});

describe("getLldpAssetMatchIndex — cache", () => {
  it("serves repeat calls within 60 s from one build", async () => {
    const a = await getLldpAssetMatchIndex();
    const b = await getLldpAssetMatchIndex();
    expect(b).toBe(a);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent callers into one build", async () => {
    const [a, b, c] = await Promise.all([getLldpAssetMatchIndex(), getLldpAssetMatchIndex(), getLldpAssetMatchIndex()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after invalidateLldpMatchCache", async () => {
    await getLldpAssetMatchIndex();
    invalidateLldpMatchCache();
    await getLldpAssetMatchIndex();
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
  });

  it("rebuilds once the 60 s TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    await getLldpAssetMatchIndex();
    vi.setSystemTime(new Date("2026-11-14T10:00:59Z"));
    await getLldpAssetMatchIndex();
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-14T10:01:01Z"));
    await getLldpAssetMatchIndex();
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed build — the next caller retries", async () => {
    stubbed(prisma.asset.findMany).mockRejectedValueOnce(new Error("db gone"));
    await expect(getLldpAssetMatchIndex()).rejects.toThrow("db gone");
    stubbed(prisma.asset.findMany).mockResolvedValue([assetRow({ id: "a1", ipAddress: "10.0.0.1" })]);
    const idx = await getLldpAssetMatchIndex();
    expect(idx.byIp.get("10.0.0.1")).toBe("a1");
  });
});

// ─── buildMonitorAssocIpEntries ────────────────────────────────────────────

const NOW = new Date("2026-11-14T12:00:00Z");

function iface(over: Partial<InterfaceSample> = {}): InterfaceSample {
  return { ifName: "port1", ...over };
}

describe("buildMonitorAssocIpEntries", () => {
  it("answers [] for no interfaces, or interfaces with no address", () => {
    expect(buildMonitorAssocIpEntries([], NOW)).toEqual([]);
    expect(buildMonitorAssocIpEntries([iface(), iface({ ipAddress: "", ipv6Address: null })], NOW)).toEqual([]);
  });

  it("writes one row per address with the interface, normalized MAC and timestamps", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1/24", macAddress: "aa-bb-cc-dd-ee-ff" })], NOW);
    expect(out).toEqual([{
      ip: "10.0.0.1", source: "monitor-system-info", interfaceName: "port1", mac: "AA:BB:CC:DD:EE:FF",
      interfaceRole: null, lastSeen: NOW, firstSeen: NOW,
    }]);
  });

  it("stamps the agent source when asked", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1" })], NOW, "agent-interface");
    expect(out[0].source).toBe("agent-interface");
  });

  it("reports both families under the same interface and MAC, IPv6 canonicalized", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1", ipv6Address: "2001:DB8:0:0::1/64", macAddress: "aabbccddeeff" })], NOW);
    expect(out.map((r) => r.ip)).toEqual(["10.0.0.1", "2001:db8::1"]);
    expect(new Set(out.map((r) => r.mac))).toEqual(new Set(["AA:BB:CC:DD:EE:FF"]));
  });

  it("stores no IPv6 when IPv6 is off for the install (rule 128)", () => {
    h.ipv6 = false;
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1", ipv6Address: "2001:db8::1" })], NOW);
    expect(out.map((r) => r.ip)).toEqual(["10.0.0.1"]);
  });

  it("moves an IPv6 a collector put in ipAddress into the IPv6 slot", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "2001:db8::9" })], NOW);
    expect(out.map((r) => r.ip)).toEqual(["2001:db8::9"]);
  });

  it("never lands loopback, link-local, or 0.0.0.0 (rule 126)", () => {
    const out = buildMonitorAssocIpEntries([
      iface({ ifName: "lo", ipAddress: "127.0.0.1", ipv6Address: "::1" }),
      iface({ ifName: "eth0", ipAddress: "169.254.3.4", ipv6Address: "fe80::1%eth0" }),
      iface({ ifName: "eth1", ipAddress: "0.0.0.0 0.0.0.0" }),
    ], NOW);
    expect(out).toEqual([]);
  });

  it("dedupes an address within one scrape (first interface wins)", () => {
    const out = buildMonitorAssocIpEntries([
      iface({ ifName: "port1", ipAddress: "10.0.0.1" }),
      iface({ ifName: "port2", ipAddress: "10.0.0.1/32" }),
    ], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].interfaceName).toBe("port1");
  });

  it("marks the primary and adds secondaries when the collector names them (FortiOS)", () => {
    const out = buildMonitorAssocIpEntries([iface({
      ipAddress: "10.0.0.1 255.255.255.0",
      secondaryIps: ["10.0.1.1 255.255.255.0", "10.0.2.1/24", "0.0.0.0 0.0.0.0", "10.0.0.1"],
      macAddress: "00:09:0f:00:00:01",
    })], NOW);
    expect(out.map((r) => [r.ip, r.interfaceRole])).toEqual([
      ["10.0.0.1", "primary"],
      ["10.0.1.1", "secondary"],
      ["10.0.2.1", "secondary"],
    ]);
    expect(out.every((r) => r.mac === "00:09:0F:00:00:01")).toBe(true);
  });

  it("an empty secondaryIps array still means roles are known", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1", secondaryIps: [] })], NOW);
    expect(out[0].interfaceRole).toBe("primary");
  });

  it("leaves the IPv6 row's role null even when roles are known", () => {
    const out = buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1", ipv6Address: "2001:db8::1", secondaryIps: [] })], NOW);
    expect(out.find((r) => r.ip === "2001:db8::1")!.interfaceRole).toBeNull();
  });

  it("writes a null MAC for an interface without one", () => {
    expect(buildMonitorAssocIpEntries([iface({ ipAddress: "10.0.0.1", macAddress: null })], NOW)[0].mac).toBeNull();
  });

  // Was a bug until 2026-11-14: secondary addresses skip the reportable-address filter every other
  // address goes through. A FortiOS interface whose CMDB secondary-ip list
  // holds "169.254.10.1 255.255.0.0" (or a loopback) lands that link-local
  // address in the asset's address list and IP history — the comment right
  // above the loop says "Loopback and link-local never land" (rule 126).
  // Right: the secondary is dropped like a link-local primary would be.
  it("never lands a link-local or loopback SECONDARY address either", () => {
    const out = buildMonitorAssocIpEntries([iface({
      ipAddress: "10.0.0.1",
      secondaryIps: ["169.254.10.1 255.255.0.0", "127.0.0.2/8"],
    })], NOW);
    expect(out.map((r) => r.ip)).toEqual(["10.0.0.1"]);
  });
});
