/**
 * tests/unit/topologyFcLinks.test.ts
 *
 * Fibre-channel links on the Device Map (business rule 162), drawn by
 * buildTopologyElements(data, { shownTypes }) from the payload's `fcLinks`:
 *
 *   - a link is drawn only while its FC switch is a shown node;
 *   - a matched host joins as a node when its type is shown, even when it
 *     hangs off none of this site's Ethernet switches, and not when hidden;
 *   - an unmatched login is a ghost node named for what it registered;
 *   - an FC link takes no Ethernet speed class, and lights its own legend row;
 *   - without shownTypes (the phone, the widget) nothing FC is drawn.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

let R: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const health = { up: "#1", degraded: "#2", down: "#3", maintenance: "#4", passive: "#5", unknown: "#6", unmonitored: "#7" };
  const sb: Record<string, any> = {
    window: { addEventListener() {}, removeEventListener() {}, POLARIS_HEALTH_COLORS: health },
    setTimeout, clearTimeout, console,
  };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  R = sb.window.PolarisTopologyRender;
});

const payload = () => ({
  fortigate: { id: "fg", hostname: "FG", monitored: true, monitorHealth: "up" },
  switches: [{ id: "sw1", hostname: "SW1", monitored: true, monitorHealth: "up" }],
  aps: [],
  edges: [{ source: "fg", target: "sw1", verifiedUplink: true, label: "port1" }],
  endpoints: [
    { id: "mds", hostname: "MDS-A", assetType: "other", switchId: "sw1", port: "port3", monitored: true, monitorHealth: "up", status: "active" },
    { id: "esx07", hostname: "ESX07", assetType: "hypervisor", switchId: "sw1", port: "port8", monitored: true, monitorHealth: "up", status: "active" },
  ],
  fcLinks: [
    { switchId: "mds", port: "fc1/1", vsan: 101, portWwn: "10:00:00:00:00:00:00:01", label: "esx07", matchMethod: "wwn",
      host: { id: "esx07", hostname: "ESX07", assetType: "hypervisor", status: "active", monitored: true, monitorHealth: "up" } },
    // A host on no switch of this site — joins as its own node when shown.
    { switchId: "mds", port: "fc1/10", vsan: 101, portWwn: "10:00:00:00:00:00:00:02", label: "lnx01.example.com", matchMethod: "name",
      host: { id: "lnx01", hostname: "lnx01", assetType: "server", status: "active", monitored: false } },
    // An array port with no asset — a ghost.
    { switchId: "mds", port: "fc1/8", vsan: 101, portWwn: "52:4a:93:00:00:00:30:09", label: "PURE01-ct0", matchMethod: null, host: null },
  ],
});

const ALL = ["firewall", "switch", "other", "hypervisor", "server"];
function nodes(els: any[]) { return els.filter((e) => !e.data.source).map((e) => e.data.id).sort(); }
function fcEdges(els: any[]) {
  return els.filter((e) => e.data.isFcLink).map((e) => `${e.data.source}>${e.data.target}@${e.data.label}`).sort();
}

describe("fibre-channel links (rule 162)", () => {
  it("draws every login from a shown FC switch: matched hosts, an off-site host, and an array ghost", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ALL });
    expect(nodes(els)).toEqual(["esx07", "fc:52:4a:93:00:00:00:30:09", "fg", "lnx01", "mds", "sw1"]);
    expect(fcEdges(els)).toEqual([
      "mds>esx07@fc1/1",
      "mds>fc:52:4a:93:00:00:00:30:09@fc1/8",
      "mds>lnx01@fc1/10",
    ]);
    const ghost = els.find((e: any) => e.data.id === "fc:52:4a:93:00:00:00:30:09").data;
    expect(ghost).toMatchObject({ role: "fcport", label: "PURE01-ct0" });
    const wwnLink = els.find((e: any) => e.data.id === "fc-mds-10:00:00:00:00:00:00:01").data;
    expect(wwnLink.reason).toContain("Matched by the WWN the host reports");
    expect(wwnLink.linkSpeed).toBeUndefined();
  });

  it("draws nothing FC while the FC switch's type is hidden", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ["firewall", "switch", "hypervisor", "server"] });
    expect(fcEdges(els)).toEqual([]);
    expect(nodes(els)).not.toContain("fc:52:4a:93:00:00:00:30:09");
  });

  it("leaves out a matched host whose type is hidden, keeping the rest", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ["firewall", "switch", "other", "hypervisor"] });
    expect(nodes(els)).not.toContain("lnx01");
    expect(fcEdges(els)).toEqual(["mds>esx07@fc1/1", "mds>fc:52:4a:93:00:00:00:30:09@fc1/8"]);
  });

  it("draws nothing FC without shownTypes (the phone, the widget)", () => {
    expect(fcEdges(R.buildTopologyElements(payload()))).toEqual([]);
  });

  it("styles the link and lists it in the legend", () => {
    const fam = "dark";
    const spec = R.topologyLegendSpec(fam);
    const row = spec.edges.find((e: any) => e.key === "edge:fc");
    expect(row).toBeTruthy();
    expect(spec.nodes.find((n: any) => n.key === "role:fcport")).toBeTruthy();
    expect(R.edgeLineStyle({ isFcLink: 1 }, fam)).toEqual({ color: row.color, width: 2.2, dash: null });
    const sheet = R.topologyStylesheet(fam);
    expect(sheet.some((s: any) => s.selector === "edge[isFcLink = 1]")).toBe(true);
    expect(sheet.some((s: any) => s.selector === 'node[role="fcport"]')).toBe(true);
  });
});
