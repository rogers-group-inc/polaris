/**
 * tests/unit/alertInterfaceLldp.test.ts
 *
 * The "interface down" alert email: no device charts, and the port's LLDP
 * neighbour in their place.
 *
 * The two halves are one change and are tested together because each is only
 * correct given the other — dropping the charts without supplying the LLDP
 * block leaves an email with a headline and nothing else, and adding the block
 * while keeping four flat graphs of a healthy device buries it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the module graph, so the spy has to be created in a
// hoisted block too or the factory closes over an uninitialized binding.
const { findMany, findUnique } = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn() }));
vi.mock("../../src/db.js", () => ({
  prisma: { assetLldpNeighbor: { findMany }, assetInterface: { findUnique } },
}));

import {
  isPortScopedAlert,
  buildAlertCharts,
  chartTokenForMetric,
  substituteChartTokens,
} from "../../src/services/alertChartService.js";
import {
  renderInterfaceLldp,
  substituteInterfaceTokens,
  interfaceTokensIn,
  isInterfaceDimensionMetric,
  buildInterfaceLldpBlocks,
  loadInterfaceLldp,
  loadInterfaceIp,
  renderInterfaceIp,
  type AlertLldpNeighbor,
} from "../../src/services/alertInterfaceService.js";
import { isDeferredToken, renderNotificationTemplate } from "../../src/utils/notificationTemplate.js";
import {
  DEFAULT_ALERT_HTML,
  DEFAULT_ALERT_TEXT,
  pruneEmptyTextLines,
  pruneEmptyRows,
  pruneEmptyChartSection,
} from "../../src/utils/alertEmailTemplate.js";

const neighbor = (over: Partial<AlertLldpNeighbor> = {}): AlertLldpNeighbor => ({
  name: "WESTON-124F-2",
  matchedType: "switch",
  port: "port1 (Uplink to core)",
  managementIp: "172.23.13.125",
  capabilities: ["bridge", "router"],
  systemDescription: "FortiSwitch-248E-FPOE v7.2.8",
  lastSeen: new Date("2026-08-18T12:36:00Z"),
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue(null);
});

describe("a port-scoped alert draws no charts", () => {
  it("names exactly the interface STATE metrics", () => {
    for (const m of ["ifOperStatus", "ifAdminStatus", "ifIpAddress", "poeStatus"]) {
      expect(isPortScopedAlert(m)).toBe(true);
    }
    // A port erroring or saturating can genuinely correlate with device load,
    // so those keep their graphs (briefly removed and restored 2026-09-26).
    for (const m of ["ifInErrorRate", "ifOutErrorRate", "ifInBps", "ifOutBps", "cpuPct", "monitorStatus", null, undefined, ""]) {
      expect(isPortScopedAlert(m)).toBe(false);
    }
  });

  it("builds nothing at all for an interface-down alert — no queries, no tokens", async () => {
    const charts = await buildAlertCharts("asset-1", ["chart.trigger", "chart.cpu", "chart.memory", "chart.responseTime", "chart.probeLoss"], {
      metric: "ifOperStatus",
      dimension: "port2",
    } as never);
    expect(charts.size).toBe(0);
    // The early return is what keeps this a zero-query path.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("takes the whole charts section — heading included — out of the real body", async () => {
    // End to end through the delivery pass: an empty chart map means every
    // token renders away, and pruneEmptyChartSection then drops the "Last hour"
    // heading that would otherwise stand over nothing.
    const charts = await buildAlertCharts("asset-1", ["chart.trigger", "chart.cpu", "chart.memory", "chart.responseTime", "chart.probeLoss"], {
      metric: "ifOperStatus",
    } as never);
    const html = pruneEmptyChartSection(substituteChartTokens(DEFAULT_ALERT_HTML, charts, { html: true }));
    expect(html).not.toContain("Last hour");
    expect(html).not.toContain("{chart.");
    // The rest of the card survives — this must not eat the buttons.
    expect(html).toContain("Acknowledge alert");
    expect(html).toContain("Open device");
  });

  it("has no chart of its own to fall back on either", () => {
    // Left null deliberately: {chart.trigger} resolves to nothing for an
    // interface field, so there is no chart to promote to the top.
    expect(chartTokenForMetric("ifOperStatus")).toBeNull();
  });
});

describe("the LLDP block", () => {
  it("names the neighbour, its port, and when it last advertised", () => {
    const text = renderInterfaceLldp("port2", [neighbor()], { html: false });
    expect(text).toContain("LLDP neighbor on port2");
    expect(text).toContain("WESTON-124F-2 (switch)");
    expect(text).toContain("port1 (Uplink to core)");
    expect(text).toContain("172.23.13.125");
    expect(text).toContain("bridge, router");
    // Always present: the entry predates the outage, so its age is the finding.
    expect(text).toContain("Last advertised");
  });

  it("renders nothing when the port advertised nothing", () => {
    expect(renderInterfaceLldp("port2", [], { html: false })).toBe("");
    expect(renderInterfaceLldp("port2", [], { html: true })).toBe("");
  });

  it("survives pruneEmptyTextLines — the heading must not use a colon", () => {
    // "LLDP neighbor on port2:" matches the "Label:" shape pruneEmptyTextLines
    // deletes, so a colon there would delete the block's own heading.
    const body = pruneEmptyTextLines(`Severity:   serious\n\n${renderInterfaceLldp("port2", [neighbor()], { html: false })}`);
    expect(body).toContain("LLDP neighbor on port2");
    expect(body).toContain("Neighbor        WESTON-124F-2 (switch)");
  });

  it("pluralizes and caps, summarizing the rest", () => {
    const many = Array.from({ length: 6 }, (_, i) => neighbor({ name: `peer-${i}`, matchedType: null }));
    const text = renderInterfaceLldp("port2", many, { html: false });
    expect(text).toContain("LLDP neighbors on port2");
    expect(text).toContain("peer-3");
    expect(text).not.toContain("peer-4");
    expect(text).toContain("and 2 more on this port");
  });

  it("emits one complete <tr> so the card needs no pruning pass", () => {
    const html = renderInterfaceLldp("port2", [neighbor()], { html: true });
    expect(html.startsWith("<tr>")).toBe(true);
    expect(html.trimEnd().endsWith("</tr>")).toBe(true);
    // pruneEmptyRows runs at COMPOSE time on rows whose value cell is empty;
    // every row here has a value, so a body carrying the block is untouched.
    expect(pruneEmptyRows(html)).toBe(html);
  });

  it("escapes what the network told us", () => {
    const html = renderInterfaceLldp("port2", [neighbor({ name: '<script>x</script>', matchedType: null })], { html: true });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back through matched asset → systemName → chassisId for the name", async () => {
    findMany.mockResolvedValue([
      { chassisId: "00:11:22:33:44:55", portId: "gi1/0/3", portDescription: null, systemName: "sw-closet-b", systemDescription: null, managementIp: null, capabilities: [], lastSeen: new Date("2026-08-18T12:00:00Z"), matchedAsset: null },
    ]);
    const rows = await loadInterfaceLldp("asset-1", "port2");
    expect(rows[0]!.name).toBe("sw-closet-b");
    expect(rows[0]!.port).toBe("gi1/0/3");
    expect(rows[0]!.matchedType).toBeNull();
  });

  it("widens the port lookup through the FortiAP lan/eth alias pair", async () => {
    findMany.mockResolvedValue([]);
    await loadInterfaceLldp("ap-1", "lan1");
    expect(findMany.mock.calls[0]![0].where.localIfName.in).toEqual(["lan1", "eth0"]);
    // A switch port is its own only spelling — nothing changes there.
    await loadInterfaceLldp("sw-1", "port2");
    expect(findMany.mock.calls[1]![0].where.localIfName.in).toEqual(["port2"]);
  });

  it("truncates a firmware-banner systemDescription instead of mailing it whole", async () => {
    findMany.mockResolvedValue([
      { chassisId: null, portId: "p1", portDescription: null, systemName: "peer", systemDescription: `Cisco IOS ${"x".repeat(300)}`, managementIp: null, capabilities: [], lastSeen: new Date(), matchedAsset: null },
    ]);
    const rows = await loadInterfaceLldp("asset-1", "port2");
    expect(rows[0]!.systemDescription!.length).toBeLessThan(120);
    expect(rows[0]!.systemDescription!.endsWith("…")).toBe(true);
  });

  it("degrades to no block when the read fails, never throwing the alert away", async () => {
    findMany.mockRejectedValue(new Error("db gone"));
    await expect(loadInterfaceLldp("asset-1", "port2")).resolves.toEqual([]);
  });
});

describe("delivery-time gating", () => {
  it("asks only for metrics whose dimension IS an interface", () => {
    for (const m of ["ifOperStatus", "ifAdminStatus", "poeStatus", "ifInBps", "ifOutBps", "ifInErrorRate", "ifOutErrorRate"]) {
      expect(isInterfaceDimensionMetric(m)).toBe(true);
    }
    // A sensor alert's dimension is "TMP1" — it would match no LLDP row.
    for (const m of ["hwSensorValue", "storageUsedPct", "monitorStatus", null]) {
      expect(isInterfaceDimensionMetric(m)).toBe(false);
    }
  });

  it("never queries for a non-interface alert", async () => {
    await expect(buildInterfaceLldpBlocks("asset-1", "hwSensorValue", "TMP1")).resolves.toEqual({ html: "", text: "", ipHtml: "", ipText: "" });
    await expect(buildInterfaceLldpBlocks("asset-1", "ifOperStatus", null)).resolves.toEqual({ html: "", text: "", ipHtml: "", ipText: "" });
    await expect(buildInterfaceLldpBlocks(null, "ifOperStatus", "port2")).resolves.toEqual({ html: "", text: "", ipHtml: "", ipText: "" });
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("renders both bodies from one read", async () => {
    findMany.mockResolvedValue([
      { chassisId: null, portId: "port1", portDescription: null, systemName: null, systemDescription: null, managementIp: "10.0.0.5", capabilities: ["bridge"], lastSeen: new Date("2026-08-18T12:00:00Z"), matchedAsset: { hostname: "CORE-1", ipAddress: "10.0.0.5", assetType: "switch" } },
    ]);
    const out = await buildInterfaceLldpBlocks("asset-1", "ifOperStatus", "port2");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(out.text).toContain("CORE-1 (switch)");
    expect(out.html).toContain("CORE-1 (switch)");
    expect(out.html).toContain("<tr>");
    expect(out.text).not.toContain("<tr>");
  });

  // Business rule 75 — a grouped alert explains up to six of its ports and
  // counts the rest. The count is off the FULL member list: capping first
  // made a 48-port storm read "and 1 more port on this alert".
  it("counts every port past the cap on a grouped alert, not just one", async () => {
    const ports = Array.from({ length: 48 }, (_, i) => `port${i + 1}`);
    findMany.mockImplementation(async (q: { where: { localIfName: { in: string[] } } }) =>
      q.where.localIfName.in.map((localIfName) => ({
        localIfName, chassisId: null, portId: "p", portDescription: null, systemName: null, systemDescription: null,
        managementIp: null, capabilities: [], lastSeen: new Date("2026-08-18T12:00:00Z"),
        matchedAsset: { hostname: `AP-${localIfName}`, ipAddress: null, assetType: "access_point" },
      })));
    const out = await buildInterfaceLldpBlocks("asset-1", "poeStatus", "port1", null, ports);
    expect(findMany).toHaveBeenCalledTimes(1);
    // Only the ports that will be SHOWN are queried.
    expect(findMany.mock.calls[0]![0].where.localIfName.in).toHaveLength(6);
    expect(out.text).toContain("and 42 more ports on this alert");
    expect(out.html).toContain("and 42 more ports on this alert");
    expect(out.text).toContain("AP-port6");
    expect(out.text).not.toContain("AP-port7");
  });

  it("names one extra port in the singular, and none at the cap", async () => {
    findMany.mockImplementation(async (q: { where: { localIfName: { in: string[] } } }) =>
      q.where.localIfName.in.map((localIfName) => ({
        localIfName, chassisId: null, portId: "p", portDescription: null, systemName: null, systemDescription: null,
        managementIp: null, capabilities: [], lastSeen: new Date("2026-08-18T12:00:00Z"),
        matchedAsset: { hostname: `AP-${localIfName}`, ipAddress: null, assetType: "access_point" },
      })));
    const seven = Array.from({ length: 7 }, (_, i) => `port${i + 1}`);
    expect((await buildInterfaceLldpBlocks("asset-1", "poeStatus", "port1", null, seven)).text).toContain("and 1 more port on this alert");
    const six = seven.slice(0, 6);
    expect((await buildInterfaceLldpBlocks("asset-1", "poeStatus", "port1", null, six)).text).not.toContain("more port");
  });

  it("drops the token when there is no block", () => {
    expect(substituteInterfaceTokens("a{interface.lldp}b", "")).toBe("ab");
    expect(substituteInterfaceTokens("a{interface.lldp}b", "<tr>x</tr>")).toBe("a<tr>x</tr>b");
  });

  it("finds the token in either body", () => {
    expect(interfaceTokensIn(DEFAULT_ALERT_TEXT).has("interface.lldp")).toBe(true);
    expect(interfaceTokensIn(DEFAULT_ALERT_HTML).has("interface.lldp")).toBe(true);
    expect(interfaceTokensIn("no tokens here").size).toBe(0);
  });
});

describe("the token is deferred, or the delivery pass finds nothing to fill", () => {
  it("is left literal by the compose pass even with unknown:blank", () => {
    expect(isDeferredToken("interface.lldp")).toBe(true);
    const out = renderNotificationTemplate("x {interface.lldp} y", {}, { unknown: "blank" });
    expect(out).toBe("x {interface.lldp} y");
  });

  it("ships in both default bodies", () => {
    expect(DEFAULT_ALERT_TEXT).toContain("{interface.lldp}");
    expect(DEFAULT_ALERT_HTML).toContain("{interface.lldp}");
  });

  it("sits above the charts, since on an interface alert the charts render away", () => {
    expect(DEFAULT_ALERT_HTML.indexOf("{interface.lldp}")).toBeLessThan(DEFAULT_ALERT_HTML.indexOf("{chart.trigger}"));
    expect(DEFAULT_ALERT_TEXT.indexOf("{interface.lldp}")).toBeLessThan(DEFAULT_ALERT_TEXT.indexOf("{chart.trigger}"));
  });
});

describe("the Interface IP row", () => {
  it("reads the port's own address on the (assetId, ifName) key", async () => {
    findUnique.mockResolvedValue({ ipAddress: "203.0.113.10/29" });
    await expect(loadInterfaceIp("asset-1", "wan1")).resolves.toBe("203.0.113.10");
    expect(findUnique.mock.calls[0]![0].where).toEqual({ assetId_ifName: { assetId: "asset-1", ifName: "wan1" } });
  });

  it("treats every unaddressed shape as no address", async () => {
    for (const ipAddress of [null, "", "0.0.0.0", "0.0.0.0 0.0.0.0"]) {
      findUnique.mockResolvedValue({ ipAddress });
      await expect(loadInterfaceIp("asset-1", "port7")).resolves.toBeNull();
    }
    findUnique.mockResolvedValue(null);
    await expect(loadInterfaceIp("asset-1", "port7")).resolves.toBeNull();
  });

  it("reads the FortiOS CMDB pair as its address", async () => {
    findUnique.mockResolvedValue({ ipAddress: "10.4.1.1 255.255.255.0" });
    await expect(loadInterfaceIp("asset-1", "vlan40")).resolves.toBe("10.4.1.1");
  });

  it("never holds up the alert when the read fails", async () => {
    findUnique.mockRejectedValue(new Error("db gone"));
    await expect(loadInterfaceIp("asset-1", "wan1")).resolves.toBeNull();
  });

  it("renders a complete row, a line, or nothing", () => {
    expect(renderInterfaceIp("10.4.1.1", { html: true })).toContain("Interface IP");
    expect(renderInterfaceIp("10.4.1.1", { html: true })).toMatch(/^<tr>.*<\/tr>$/s);
    expect(renderInterfaceIp("10.4.1.1", { html: false })).toBe("Interface IP: 10.4.1.1");
    expect(renderInterfaceIp(null, { html: true })).toBe("");
    expect(renderInterfaceIp(null, { html: false })).toBe("");
  });

  it("is filled for a port with an address even when it has no LLDP neighbour", async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({ ipAddress: "203.0.113.10" });
    const out = await buildInterfaceLldpBlocks("asset-1", "ifOperStatus", "wan1");
    expect(out.html).toBe("");
    expect(out.ipText).toBe("Interface IP: 203.0.113.10");
    expect(out.ipHtml).toContain("203.0.113.10");
  });

  it("lands in the facts table of the default body, and vanishes when empty", () => {
    const ip = renderInterfaceIp("203.0.113.10", { html: true });
    const withIp = substituteInterfaceTokens(DEFAULT_ALERT_HTML, "", ip);
    expect(withIp).toContain("203.0.113.10");
    expect(withIp).not.toContain("{interface.");
    // Inside the facts table: after the component row, before the device IP row.
    expect(withIp.indexOf("Interface IP")).toBeGreaterThan(withIp.indexOf("{dimension}"));
    expect(withIp.indexOf("Interface IP")).toBeLessThan(withIp.indexOf("{asset.ip}"));
    const without = substituteInterfaceTokens(DEFAULT_ALERT_HTML, "", "");
    expect(without).not.toContain("Interface IP");
    expect(without).not.toContain("{interface.");
  });

  it("is deferred and ships in both default bodies", () => {
    expect(isDeferredToken("interface.ip")).toBe(true);
    expect(DEFAULT_ALERT_TEXT).toContain("{interface.ip}");
    expect(DEFAULT_ALERT_HTML).toContain("{interface.ip}");
    expect(interfaceTokensIn("x {interface.ip} y").has("interface.ip")).toBe(true);
  });
});
