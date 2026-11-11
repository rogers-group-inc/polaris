/**
 * tests/unit/topologyShownTypes.test.ts
 *
 * The Device Map topology's Device-types toggles (business rule 147):
 * buildTopologyElements(data, { shownTypes }) draws exactly the shown asset
 * types — a switched-on endpoint type becomes nodes hung off their switch by
 * a port-labelled link; a hidden backbone type disappears with its links; the
 * FortiGate always stays. Without opts (the phone, the dashboard widget) the
 * backbone is unchanged. siteDeviceTypes lists what the toggles offer.
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
  aps: [{ id: "ap1", hostname: "AP1", stations: [] }],
  edges: [
    { source: "fg", target: "sw1", verifiedUplink: true, label: "port1 ↔ port5" },
    { source: "sw1", target: "ap1", label: "port9" },
  ],
  endpoints: [
    { id: "srv1", hostname: "SRV1", assetType: "server", switchId: "sw1", port: "port7", monitored: true, monitorHealth: "down", status: "active" },
    { id: "rt1", hostname: "RT1", assetType: "router", switchId: "sw1", port: "port2", monitored: false, status: "active" },
    { id: "pc1", hostname: "PC1", assetType: "workstation", switchId: "sw1", port: "unknown", monitored: false, status: "active" },
  ],
});

function nodes(els: any[]) { return els.filter((e) => !e.data.source).map((e) => e.data.id).sort(); }
function edges(els: any[]) { return els.filter((e) => e.data.source).map((e) => `${e.data.source}>${e.data.target}`).sort(); }

describe("buildTopologyElements shownTypes", () => {
  it("without opts draws the backbone only, as before", () => {
    const els = R.buildTopologyElements(payload());
    expect(nodes(els)).toEqual(["ap1", "fg", "sw1"]);
  });

  it("the default set draws routers hung off their switch with the port", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ["firewall", "router", "switch", "access_point"] });
    expect(nodes(els)).toEqual(["ap1", "fg", "rt1", "sw1"]);
    const link = els.find((e: any) => e.data.id === "ep-rt1").data;
    expect(link).toMatchObject({ source: "sw1", target: "rt1", label: "port2", isEndpointLink: 1 });
    const rt = els.find((e: any) => e.data.id === "rt1").data;
    expect(rt).toMatchObject({ role: "endpoint", assetId: "rt1", assetType: "router" });
  });

  it("switching a type on adds its devices; an unknown port leaves the link unlabelled", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ["switch", "workstation", "server"] });
    expect(nodes(els)).toEqual(["fg", "pc1", "srv1", "sw1"]);
    expect(els.find((e: any) => e.data.id === "ep-pc1").data.label).toBe("");
    // A down server paints the down colour.
    expect(els.find((e: any) => e.data.id === "srv1").data.nodeColor).toBe("#3");
  });

  it("hiding switches drops them, their links and their endpoints' links; the FortiGate stays", () => {
    const els = R.buildTopologyElements(payload(), { shownTypes: ["access_point", "server"] });
    expect(nodes(els)).toEqual(["ap1", "fg", "srv1"]);
    expect(edges(els)).toEqual([]);
  });

  it("never duplicates a node an endpoint shares an id with", () => {
    const data = payload();
    data.endpoints.push({ id: "sw1", hostname: "dup", assetType: "server", switchId: "sw1", port: "x", monitored: false, status: "active" });
    const els = R.buildTopologyElements(data, { shownTypes: ["switch", "server"] });
    expect(nodes(els).filter((id) => id === "sw1")).toHaveLength(1);
  });
});

describe("siteDeviceTypes", () => {
  it("lists firewall, router, switch, AP first, then endpoint types by count", () => {
    const data = payload();
    data.endpoints.push({ id: "pc2", hostname: "PC2", assetType: "workstation", switchId: "sw1", port: "p", monitored: false, status: "active" });
    expect(R.siteDeviceTypes(data)).toEqual([
      { type: "firewall", count: 1 },
      { type: "router", count: 1 },
      { type: "switch", count: 1 },
      { type: "access_point", count: 1 },
      { type: "workstation", count: 2 },
      { type: "server", count: 1 },
    ]);
  });
});
