/**
 * tests/unit/alertInterfaceService.test.ts — the own suite for
 * src/services/alertInterfaceService.ts (CQ-T010).
 *
 * Complements alertInterfaceLldp.test.ts (the default-body wiring, the
 * single-port block, the 6-port cap's trailer, the Interface IP row) with what
 * it leaves out:
 *   - the row → neighbour mapping (port / management-IP fallbacks, the
 *     description flattening and its exact 100-char cut);
 *   - the text stanza's layout (padded labels, blank line between neighbours,
 *     facts dropped when empty, "Last advertised" always last in the
 *     recipient's zone);
 *   - the GROUPED read (business rule 75): one query over the unioned FortiAP
 *     alias sets, rows grouped back under the REQUESTED name, the per-port
 *     cap, a failed read degrading to nothing;
 *   - the fibre-channel login block (rule 159a): read only for an FC counter
 *     alert, decommissioned matches unnamed, the WWN fallback, its own render;
 *   - substituteInterfaceTokens' `$&`-safety and the IP token;
 *   - buildInterfaceLldpBlocks' gating and its primary-port IP read.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logger } from "../../src/utils/logger.js";
import { formatLocalTime } from "../../src/utils/notificationTemplate.js";
import {
  INTERFACE_DIMENSION_METRICS,
  isInterfaceDimensionMetric,
  loadInterfaceLldp,
  renderInterfaceLldp,
  renderInterfaceIp,
  renderInterfaceFcLogins,
  interfaceTokensIn,
  substituteInterfaceTokens,
  buildInterfaceLldpBlocks,
  type AlertLldpNeighbor,
  type AlertFcLogin,
} from "../../src/services/alertInterfaceService.js";

const lldp = stubbed(prisma.assetLldpNeighbor.findMany);
const iface = stubbed(prisma.assetInterface.findUnique);
const fc = stubbed(prisma.assetFcLogin.findMany);

const SEEN = new Date("2026-08-18T12:36:00Z");

const row = (over: Record<string, unknown> = {}) => ({
  chassisId: null, portId: null, portDescription: null, systemName: null, systemDescription: null,
  managementIp: null, capabilities: [], lastSeen: SEEN, matchedAsset: null, ...over,
});

const neighbor = (over: Partial<AlertLldpNeighbor> = {}): AlertLldpNeighbor => ({
  name: "SW-1", matchedType: null, port: null, managementIp: null, capabilities: [], systemDescription: null, lastSeen: SEEN, ...over,
});

const login = (over: Partial<AlertFcLogin> = {}): AlertFcLogin => ({
  name: "ESX-1", matchedType: null, matchMethod: null, portWwn: "10:00:00:00:c9:00:00:01", vsan: 10, hba: null, lastSeen: SEEN, ...over,
});

beforeEach(() => {
  resetDbStub();
  lldp.mockResolvedValue([]);
  iface.mockResolvedValue(null);
  fc.mockResolvedValue([]);
});

describe("isInterfaceDimensionMetric", () => {
  it("covers the state quartet, the rate quartet and the five FC counters", () => {
    expect(INTERFACE_DIMENSION_METRICS.size).toBe(13);
    for (const m of ["ifOperStatus", "poeStatus", "ifInBps", "ifOutErrorRate", "fcCrcErrorRate", "fcInvalidTxWordRate"]) {
      expect(isInterfaceDimensionMetric(m)).toBe(true);
    }
  });

  it("is false for null, empty and a sensor metric", () => {
    expect(isInterfaceDimensionMetric(null)).toBe(false);
    expect(isInterfaceDimensionMetric(undefined)).toBe(false);
    expect(isInterfaceDimensionMetric("")).toBe(false);
    expect(isInterfaceDimensionMetric("hwSensorValue")).toBe(false);
  });
});

describe("loadInterfaceLldp — the row → neighbour mapping", () => {
  it("asks for the freshest five rows on the asset's port", async () => {
    await loadInterfaceLldp("a1", "port7");
    const q = lldp.mock.calls[0]![0];
    expect(q.where).toEqual({ assetId: "a1", localIfName: { in: ["port7"] } });
    expect(q.orderBy).toEqual({ lastSeen: "desc" });
    expect(q.take).toBe(5);
  });

  it("joins portId and portDescription, or takes whichever exists", async () => {
    lldp.mockResolvedValue([
      row({ portId: "p1", portDescription: "Uplink" }),
      row({ portId: "p2" }),
      row({ portDescription: "only desc" }),
      row({}),
    ]);
    const out = await loadInterfaceLldp("a1", "port1");
    expect(out.map((n) => n.port)).toEqual(["p1 (Uplink)", "p2", "only desc", null]);
  });

  it("prefers the advertised management IP over the matched asset's", async () => {
    lldp.mockResolvedValue([
      row({ managementIp: "10.0.0.1", matchedAsset: { hostname: "h", ipAddress: "10.9.9.9", assetType: "switch" } }),
      row({ managementIp: "", matchedAsset: { hostname: "h", ipAddress: "10.9.9.9", assetType: "switch" } }),
      row({}),
    ]);
    const out = await loadInterfaceLldp("a1", "port1");
    expect(out.map((n) => n.managementIp)).toEqual(["10.0.0.1", "10.9.9.9", null]);
  });

  it("names an unidentifiable neighbour, and reads no matched type without a match", async () => {
    lldp.mockResolvedValue([row({})]);
    const [n] = await loadInterfaceLldp("a1", "port1");
    expect(n!.name).toBe("unidentified neighbor");
    expect(n!.matchedType).toBeNull();
  });

  it("collapses whitespace in the description and reads a blank one as none", async () => {
    lldp.mockResolvedValue([row({ systemDescription: "  FortiSwitch\n  248E \t v7 " }), row({ systemDescription: " \n " })]);
    const out = await loadInterfaceLldp("a1", "port1");
    expect(out[0]!.systemDescription).toBe("FortiSwitch 248E v7");
    expect(out[1]!.systemDescription).toBeNull();
  });

  it("keeps a description of exactly 100 characters whole and cuts 101 with an ellipsis", async () => {
    lldp.mockResolvedValue([row({ systemDescription: "x".repeat(100) }), row({ systemDescription: "y".repeat(101) })]);
    const out = await loadInterfaceLldp("a1", "port1");
    expect(out[0]!.systemDescription).toBe("x".repeat(100));
    expect(out[1]!.systemDescription).toBe(`${"y".repeat(100)}…`);
  });

  it("defaults null capabilities to an empty list", async () => {
    lldp.mockResolvedValue([row({ capabilities: null })]);
    expect((await loadInterfaceLldp("a1", "port1"))[0]!.capabilities).toEqual([]);
  });
});

describe("renderInterfaceLldp — text stanza", () => {
  it("pads labels to 16 columns and puts Last advertised last, in the recipient's zone", () => {
    const out = renderInterfaceLldp("port2", [neighbor({ matchedType: "switch", port: "p1", managementIp: "10.0.0.1", capabilities: ["bridge", "router"], systemDescription: "FS-248E" })], { html: false, timeZone: "UTC" });
    expect(out.split("\n")).toEqual([
      "LLDP neighbor on port2",
      "  Neighbor        SW-1 (switch)",
      "  Neighbor port   p1",
      "  Management IP   10.0.0.1",
      "  Capabilities    bridge, router",
      "  Neighbor system FS-248E",
      `  Last advertised ${formatLocalTime(SEEN, "UTC")}`,
    ]);
  });

  it("drops every empty fact but never the Last advertised line", () => {
    const lines = renderInterfaceLldp("port2", [neighbor()], { html: false }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("  Neighbor        SW-1");
    expect(lines[2]).toMatch(/^ {2}Last advertised /);
  });

  it("separates neighbours with a blank line", () => {
    const out = renderInterfaceLldp("port2", [neighbor({ name: "A" }), neighbor({ name: "B" })], { html: false });
    expect(out).toContain("LLDP neighbors on port2");
    const lines = out.split("\n");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("  Neighbor        B");
  });

  it("separates neighbours in HTML with a ruled spacer row, never before the first", () => {
    const out = renderInterfaceLldp("port2", [neighbor({ name: "A" }), neighbor({ name: "B" })], { html: true });
    expect(out.match(/border-top:1px solid #e5e7eb/g)).toHaveLength(1);
    expect(out.indexOf("border-top")).toBeGreaterThan(out.indexOf("A"));
    expect(out.startsWith("<tr><td")).toBe(true);
    expect(out.endsWith("</td></tr>")).toBe(true);
  });

  it("escapes the port name in the heading", () => {
    expect(renderInterfaceLldp("<p>", [neighbor()], { html: true })).toContain("LLDP neighbor on &lt;p&gt;");
  });
});

describe("renderInterfaceIp", () => {
  it("renders nothing for an empty string", () => {
    expect(renderInterfaceIp("", { html: true })).toBe("");
  });

  it("escapes the value in the HTML row", () => {
    expect(renderInterfaceIp("<x>", { html: true })).toContain("&lt;x&gt;");
    expect(renderInterfaceIp("<x>", { html: false })).toBe("Interface IP: <x>");
  });
});

describe("interface tokens", () => {
  it("finds each token independently and skips empty templates", () => {
    expect([...interfaceTokensIn(null, "{interface.ip}")]).toEqual(["interface.ip"]);
    expect([...interfaceTokensIn("{interface.lldp}", undefined, "{interface.ip}")].sort()).toEqual(["interface.ip", "interface.lldp"]);
    expect(interfaceTokensIn("{interface.mac}").size).toBe(0);
  });

  it("returns an empty body untouched", () => {
    expect(substituteInterfaceTokens("", "x", "y")).toBe("");
  });

  it("fills the IP token, defaulting to removing it", () => {
    expect(substituteInterfaceTokens("[{interface.ip}]", "", "IP")).toBe("[IP]");
    expect(substituteInterfaceTokens("[{interface.ip}]", "x")).toBe("[]");
  });

  it("inserts network-supplied `$&` and `$'` literally rather than as replacement patterns", () => {
    expect(substituteInterfaceTokens("[{interface.lldp}]tail", "a $& b $' c")).toBe("[a $& b $' c]tail");
    expect(substituteInterfaceTokens("[{interface.ip}]", "", "$&")).toBe("[$&]");
  });
});

describe("renderInterfaceFcLogins (rule 159a)", () => {
  it("renders nothing for a port with no logins", () => {
    expect(renderInterfaceFcLogins("fc1/5", [], { html: false })).toBe("");
    expect(renderInterfaceFcLogins("fc1/5", [], { html: true })).toBe("");
  });

  it("heads the stanza with no colon and lists device, WWN, VSAN and when last seen", () => {
    const out = renderInterfaceFcLogins("fc1/5", [login()], { html: false, timeZone: "UTC" });
    expect(out.split("\n")).toEqual([
      "Logged in to fc1/5",
      "  Device          ESX-1",
      "  Port WWN        10:00:00:00:c9:00:00:01",
      "  VSAN            10",
      `  Last seen       ${formatLocalTime(SEEN, "UTC")}`,
    ]);
  });

  it("names the HBA and how the device was matched", () => {
    const wwn = renderInterfaceFcLogins("fc1/5", [login({ matchedType: "server", hba: "QLE2692", matchMethod: "wwn" })], { html: false });
    expect(wwn).toContain("ESX-1 (server)");
    expect(wwn).toContain("  HBA             QLE2692");
    expect(wwn).toContain("Matched by      the WWN the host reports");
    const byName = renderInterfaceFcLogins("fc1/5", [login({ matchMethod: "hostname" })], { html: false });
    expect(byName).toContain("the host name the HBA registered");
  });

  it("caps at four logins and counts the rest", () => {
    const five = Array.from({ length: 5 }, (_, i) => login({ name: `H${i}` }));
    const text = renderInterfaceFcLogins("fc1/5", five, { html: false });
    expect(text).toContain("H3");
    expect(text).not.toContain("H4");
    expect(text).toContain("  and 1 more on this port");
    expect(renderInterfaceFcLogins("fc1/5", five, { html: true })).toContain("and 1 more on this port</div>");
  });

  it("emits one complete, escaped <tr> in HTML", () => {
    const out = renderInterfaceFcLogins("fc<1>", [login({ name: "<h>" })], { html: true });
    expect(out.startsWith("<tr><td")).toBe(true);
    expect(out.endsWith("</td></tr>")).toBe(true);
    expect(out).toContain("Logged in to fc&lt;1&gt;");
    expect(out).toContain("&lt;h&gt;");
  });
});

describe("buildInterfaceLldpBlocks — gating", () => {
  const empty = { html: "", text: "", ipHtml: "", ipText: "" };

  it("returns nothing when every grouped dimension is blank", async () => {
    await expect(buildInterfaceLldpBlocks("a1", "ifOperStatus", null, null, ["", ""])).resolves.toEqual(empty);
    expect(lldp).not.toHaveBeenCalled();
  });

  it("falls back to the single dimension when the grouped list is empty", async () => {
    await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port3", null, []);
    expect(lldp.mock.calls[0]![0].where.localIfName.in).toEqual(["port3"]);
  });

  it("reads the Interface IP of the alert's primary port, once, on a grouped alert", async () => {
    iface.mockResolvedValue({ ipAddress: "10.1.1.1/24" });
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port9", null, ["port1", "port2"]);
    expect(iface).toHaveBeenCalledTimes(1);
    expect(iface.mock.calls[0]![0].where).toEqual({ assetId_ifName: { assetId: "a1", ifName: "port9" } });
    expect(out.ipText).toBe("Interface IP: 10.1.1.1");
  });

  it("uses the first grouped port as primary when the alert carries no dimension", async () => {
    await buildInterfaceLldpBlocks("a1", "ifOperStatus", null, null, ["port4", "port5"]);
    expect(iface.mock.calls[0]![0].where.assetId_ifName.ifName).toBe("port4");
  });

  it("never reads FC logins for a non-FC metric", async () => {
    await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1");
    expect(fc).not.toHaveBeenCalled();
  });
});

describe("buildInterfaceLldpBlocks — the grouped LLDP read (rule 75)", () => {
  it("asks once over the union of every port's FortiAP aliases", async () => {
    await buildInterfaceLldpBlocks("a1", "ifOperStatus", "lan1", null, ["lan1", "eth0", "lan2"]);
    expect(lldp).toHaveBeenCalledTimes(1);
    const q = lldp.mock.calls[0]![0];
    expect([...q.where.localIfName.in].sort()).toEqual(["eth0", "eth1", "lan1", "lan2"]);
    expect(q.select.localIfName).toBe(true);
    expect(q).not.toHaveProperty("take");
  });

  it("files each row under the REQUESTED port name, whichever spelling it was stored under", async () => {
    lldp.mockResolvedValue([
      { ...row({ systemName: "SW-A" }), localIfName: "eth0" },
      { ...row({ systemName: "SW-B" }), localIfName: "port2" },
    ]);
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "lan1", null, ["lan1", "port2"]);
    expect(out.html).toContain("LLDP neighbor on lan1");
    expect(out.html).toContain("SW-A");
    expect(out.html).toContain("LLDP neighbor on port2");
    expect(out.html.indexOf("SW-A")).toBeLessThan(out.html.indexOf("port2"));
  });

  it("skips a port with no neighbour and keeps the requested order", async () => {
    lldp.mockResolvedValue([{ ...row({ systemName: "SW-C" }), localIfName: "port3" }, { ...row({ systemName: "SW-A" }), localIfName: "port1" }]);
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1", null, ["port1", "port2", "port3"]);
    expect(out.html).not.toContain("on port2");
    expect(out.html.indexOf("on port1")).toBeLessThan(out.html.indexOf("on port3"));
  });

  it("caps each port at five neighbours before rendering, so the block says 'and 1 more'", async () => {
    lldp.mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({ ...row({ systemName: `N${i}` }), localIfName: "port1" })));
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1", null, ["port1", "port2"]);
    expect(out.html).toContain("and 1 more on this port");
    expect(out.html).not.toContain("N4");
  });

  it("degrades to no LLDP block when the grouped read fails, keeping the IP row", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    lldp.mockRejectedValue(new Error("boom"));
    iface.mockResolvedValue({ ipAddress: "10.2.2.2" });
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1", null, ["port1", "port2"]);
    expect(out.html).toBe("");
    expect(out.ipText).toBe("Interface IP: 10.2.2.2");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // BUG: the text body joins each port's stanza with "" — a stanza ends on its
  // "Last advertised" line with no newline, so on a grouped alert with two
  // ports that both have a neighbour the next port's heading is glued onto the
  // previous port's timestamp: "…  Last advertised Aug 18, 2026, 12:36 PM UTCLLDP
  // neighbor on port2". The HTML body is fine (each block is a whole <tr>).
  it.fails("starts each port's text stanza on its own line", async () => {
    lldp.mockResolvedValue([
      { ...row({ systemName: "SW-A" }), localIfName: "port1" },
      { ...row({ systemName: "SW-B" }), localIfName: "port2" },
    ]);
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1", "UTC", ["port1", "port2"]);
    expect(out.text.split("\n")).toContain("LLDP neighbor on port2");
  });

  // BUG: same join on the trailer — `blocks.join("") + "  and N more ports…"`
  // appends the count to the last stanza's "Last advertised" line rather than
  // on a line of its own, so the 7th-port count reads as part of a timestamp.
  it.fails("puts the more-ports trailer on its own text line", async () => {
    lldp.mockImplementation(async (q: any) => q.where.localIfName.in.map((n: string) => ({ ...row({ systemName: `SW-${n}` }), localIfName: n })));
    const ports = Array.from({ length: 7 }, (_, i) => `port${i + 1}`);
    const out = await buildInterfaceLldpBlocks("a1", "ifOperStatus", "port1", "UTC", ports);
    expect(out.text.split("\n")).toContain("  and 1 more port on this alert");
  });
});

describe("buildInterfaceLldpBlocks — fibre-channel logins (rule 159a)", () => {
  const fcRow = (over: Record<string, unknown> = {}) => ({
    ifName: "fc1/5", vsan: 10, portWwn: "10:00:00:00:c9:00:00:01", hostName: null, hbaModel: null, matchMethod: "wwn", lastSeen: SEEN, matchedAsset: null, ...over,
  });

  it("reads the logins of the shown ports for an FC counter alert, in one ordered query", async () => {
    await buildInterfaceLldpBlocks("a1", "fcCrcErrorRate", "fc1/5", null, ["fc1/5", "fc1/6"]);
    const q = fc.mock.calls[0]![0];
    expect(q.where).toEqual({ assetId: "a1", ifName: { in: ["fc1/5", "fc1/6"] } });
    expect(q.orderBy).toEqual([{ ifIndex: "asc" }, { vsan: "asc" }, { portWwn: "asc" }]);
  });

  it("shows an FC port with logins even when it has no LLDP neighbour", async () => {
    fc.mockResolvedValue([fcRow({ matchedAsset: { hostname: "ESX-7", assetType: "server", status: "active" } })]);
    const out = await buildInterfaceLldpBlocks("a1", "fcLinkFailureRate", "fc1/5");
    expect(out.text).toContain("Logged in to fc1/5");
    expect(out.text).toContain("ESX-7 (server)");
    expect(out.text).toContain("the WWN the host reports");
    expect(out.html).toContain("Logged in to fc1/5");
  });

  it("does not name a decommissioned match, nor say how it matched", async () => {
    fc.mockResolvedValue([fcRow({ hostName: "hba-registered", matchedAsset: { hostname: "OLD", assetType: "server", status: "decommissioned" } })]);
    const out = await buildInterfaceLldpBlocks("a1", "fcSyncLossRate", "fc1/5");
    expect(out.text).toContain("hba-registered");
    expect(out.text).not.toContain("OLD");
    expect(out.text).not.toContain("Matched by");
  });

  it("falls back to the port WWN when nothing names the device, and skips rows with no port", async () => {
    fc.mockResolvedValue([fcRow({ matchMethod: null }), fcRow({ ifName: null, hostName: "orphan" })]);
    const out = await buildInterfaceLldpBlocks("a1", "fcSignalLossRate", "fc1/5");
    expect(out.text).toContain("  Device          10:00:00:00:c9:00:00:01");
    expect(out.text).not.toContain("orphan");
  });

  it("separates a port's LLDP and FC stanzas with a newline in the text body", async () => {
    lldp.mockResolvedValue([row({ systemName: "SW-A" })]);
    fc.mockResolvedValue([fcRow()]);
    const out = await buildInterfaceLldpBlocks("a1", "fcCrcErrorRate", "fc1/5");
    expect(out.text.split("\n")).toContain("Logged in to fc1/5");
  });

  it("degrades to no FC block when the login read fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    fc.mockRejectedValue(new Error("boom"));
    const out = await buildInterfaceLldpBlocks("a1", "fcCrcErrorRate", "fc1/5");
    expect(out.text).toBe("");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
