/**
 * tests/integration/assistantFindEndpoint.test.ts
 *
 * The assistant's find_endpoint tool (business rule 95) against real ARP /
 * MAC-table / wireless-station rows:
 *  - a MAC is found on the access port AND every uplink; the access port
 *    (fewest MACs on the port) leads and is flagged;
 *  - an IP resolves through the gateways' ARP tables to its MAC, and from
 *    there to the switch port;
 *  - a wireless client names its AP, SSID and signal; found by MAC or IP;
 *  - a device + port lists what is connected there; device + VLAN alone does
 *    not dump the device's ARP table;
 *  - MAC input in any format, and a 3-octet prefix as a vendor search.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-ep-test";
const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as never;
const ids: Record<string, string> = {};
const PC = "0A:11:22:33:44:55";
const LAPTOP = "0A:11:22:99:88:77";

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const list = assets.map((a) => a.id);
  if (!list.length) return;
  await prisma.assetMacTableEntry.deleteMany({ where: { assetId: { in: list } } });
  await prisma.assetArpEntry.deleteMany({ where: { assetId: { in: list } } });
  await prisma.assetWirelessStation.deleteMany({ where: { apAssetId: { in: list } } });
  await prisma.asset.deleteMany({ where: { id: { in: list } } });
}

async function node(name: string, assetType: string, ipAddress?: string): Promise<void> {
  const a = await prisma.asset.create({ data: { hostname: `${HOST}-${name}`, status: "active", assetType, ipAddress } as never });
  ids[name] = a.id;
}

const run = async (args: Record<string, unknown>) =>
  (await runAssistantTool("find_endpoint", JSON.stringify(args), { req, maxRows: 50 })).data as any;
const h = (n: string) => `${HOST}-${n}`;

d("find_endpoint", () => {
  beforeAll(async () => {
    await wipe();
    await node("gw", "firewall", "10.250.0.1");
    await node("core", "switch");
    await node("access", "switch", "10.250.0.3");
    await node("ap", "access_point");
    await node("pc", "workstation");
    const fill = Array.from({ length: 20 }, (_, i) => `0A:FF:00:00:00:${String(i).padStart(2, "0")}`);
    await prisma.assetMacTableEntry.createMany({
      data: [
        // The core learns the PC on its uplink to the access switch, among many others.
        { assetId: ids.core, macAddress: PC, vlanId: 20, ifName: "port48", status: "learned" },
        ...fill.map((m) => ({ assetId: ids.core, macAddress: m, vlanId: 20, ifName: "port48", status: "learned" })),
        // The access switch learns it on the port it is plugged into.
        { assetId: ids.access, macAddress: PC, vlanId: 20, ifName: "port12", status: "learned", matchedAssetId: ids.pc },
        { assetId: ids.access, macAddress: "0A:EE:00:00:00:01", vlanId: 30, ifName: "port7", status: "learned" },
      ],
    });
    await prisma.assetArpEntry.createMany({
      data: [
        { assetId: ids.gw, ipAddress: "10.250.20.15", macAddress: PC, ifName: "vlan20", matchedAssetId: ids.pc },
        { assetId: ids.access, ipAddress: "10.250.30.9", macAddress: "0A:EE:00:00:00:01", ifName: "port7" },
      ],
    });
    await prisma.assetWirelessStation.create({
      data: { apAssetId: ids.ap, staMacAddr: LAPTOP, staIpAddr: "10.250.40.22", ssid: "Corp", band: "5GHz", vlanId: 40, signalStrength: -61, source: "snmp" },
    });
  });
  afterAll(wipe);

  it("a MAC (any format) leads with the access port, the uplink after it", async () => {
    const r = await run({ mac: "0a-11-22-33-44-55" });
    expect(r.switchPorts.map((p: any) => [p.switch, p.port, p.macsOnPort, p.likelyAccessPort])).toEqual([
      [h("access"), "port12", 1, true],
      [h("core"), "port48", 21, false],
    ]);
    expect(r.switchPorts[0]).toMatchObject({ vlan: 20, knownAs: h("pc"), knownAsId: ids.pc, switchId: ids.access });
    expect(r.arp).toEqual([expect.objectContaining({ ip: "10.250.20.15", seenBy: h("gw"), interface: "vlan20" })]);
  });

  it("an IP goes through ARP to the MAC, then to the switch port", async () => {
    const r = await run({ ip: "10.250.20.15" });
    expect(r.arp[0]).toMatchObject({ mac: PC, seenBy: h("gw") });
    expect(r.switchPorts[0]).toMatchObject({ switch: h("access"), port: "port12" });
  });

  it("a wireless client names its AP, SSID, band and signal — by MAC or by IP", async () => {
    for (const q of [{ mac: LAPTOP }, { ip: "10.250.40.22" }]) {
      const r = await run(q);
      expect(r.wireless).toEqual([expect.objectContaining({ accessPoint: h("ap"), accessPointId: ids.ap, ssid: "Corp", band: "5GHz", signalDbm: -61 })]);
    }
  });

  it("device + port lists what is connected there; device + VLAN alone reads no ARP table", async () => {
    const port = await run({ device: h("access"), port: "port7" });
    expect(port.switchPorts.map((p: any) => p.mac)).toEqual(["0A:EE:00:00:00:01"]);
    expect(port.arp.map((x: any) => x.ip)).toEqual(["10.250.30.9"]);
    const vlan = await run({ device: "10.250.0.3", vlan: 20 });
    expect(vlan.switchPorts.map((p: any) => p.mac)).toEqual([PC]);
    expect(vlan.arp).toEqual([]);
  });

  it("a 3-octet prefix searches by vendor; nonsense and a bare device are refused", async () => {
    const r = await run({ mac: "0A:11:22" });
    expect(new Set(r.switchPorts.map((p: any) => p.mac))).toEqual(new Set([PC]));
    expect(r.wireless.map((w: any) => w.mac)).toEqual([LAPTOP]);
    const bad = await runAssistantTool("find_endpoint", '{"mac":"zz"}', { req, maxRows: 50 });
    expect(bad.ok).toBe(false);
    const bare = await runAssistantTool("find_endpoint", JSON.stringify({ device: h("access") }), { req, maxRows: 50 });
    expect(JSON.stringify(bare.data)).toMatch(/Invalid arguments/);
  });

  it("says nothing was learned rather than returning empty lists silently", async () => {
    const r = await run({ mac: "0A:00:00:00:00:99" });
    expect(r.note).toMatch(/No switch, gateway or access point/);
  });
});
