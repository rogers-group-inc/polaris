/**
 * tests/unit/ipContextDom.test.ts — the Add Asset IP cross-reference panel's
 * pure halves (public/js/assets-ipcontext.js, window.PolarisIpContext).
 *
 * Two properties carry the feature and are what these lock down:
 *
 *   - buildFindings never renders a hidden section as an absent one. A role
 *     without subnets:read must read "not shown", because "no network found"
 *     would be a confident wrong answer.
 *   - applicableSuggestions never overwrites what the operator typed, and
 *     treats latitude/longitude as one indivisible pair — getAssetFormData
 *     refuses a half-filled one, so half a suggestion is a save error.
 *
 * Loaded by eval into a happy-dom Window, the massPinDom pattern.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

interface Finding { kind: string; level: string; label: string; text: string }
interface IpCtxApi {
  buildFindings: (ctx: unknown) => Finding[];
  applicableSuggestions: (ctx: unknown, current: unknown) => Record<string, unknown>;
  suggestionLabels: (applicable: Record<string, unknown>) => string[];
  panelHTML: (id: string) => string;
}

const g = globalThis as Record<string, unknown>;
let IPC: IpCtxApi;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  // The module reads api.js's shared display helpers at render time.
  (win as unknown as Record<string, unknown>).escapeHtml = (s: string) => s;
  (win as unknown as Record<string, unknown>).timeAgo = () => "2m ago";
  g.escapeHtml = (s: string) => s;
  g.timeAgo = () => "2m ago";
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/assets-ipcontext.js"), "utf8"));
  IPC = (win as unknown as Record<string, IpCtxApi>).PolarisIpContext;
});

function ctx(over: Record<string, unknown> = {}) {
  return {
    ip: "10.4.12.63",
    subnet: null,
    reservation: null,
    arp: [],
    sightings: [],
    switchPorts: [],
    existingAssets: [],
    firewall: null,
    suggestions: {},
    visibility: { subnets: true, reservations: true },
    ...over,
  };
}

const SUBNET = {
  id: "s1", cidr: "10.4.12.0/24", name: "Plant Floor", vlan: 12, status: "available",
  tags: [], fortigateDevice: "CENTRALFMG1", lastDiscoveredAt: null,
  block: { id: "b1", name: "Corp", cidr: "10.0.0.0/8" }, integration: null,
};

function kinds(f: Finding[]) { return f.map((x) => x.kind); }
function byKind(f: Finding[], kind: string) { return f.find((x) => x.kind === kind); }

describe("buildFindings", () => {
  it("returns nothing for an unparseable address", () => {
    expect(IPC.buildFindings({ ip: "10.4", unparseable: true })).toEqual([]);
  });

  it("reports a containing network with its block and VLAN", () => {
    const f = IPC.buildFindings(ctx({ subnet: SUBNET }));
    const net = byKind(f, "subnet")!;
    expect(net.text).toContain("10.4.12.0/24");
    expect(net.text).toContain("VLAN 12");
    expect(net.text).toContain("Corp");
  });

  it("says no network contains the address when it could look and found none", () => {
    const f = IPC.buildFindings(ctx());
    expect(byKind(f, "subnet")!.text).toMatch(/No network on record/);
  });

  it("distinguishes a hidden section from an empty one", () => {
    const f = IPC.buildFindings(ctx({ visibility: { subnets: false, reservations: false } }));
    const hidden = f.filter((x) => x.kind === "hidden");
    expect(hidden).toHaveLength(2);
    expect(hidden[0].text).toMatch(/Not shown/);
    // And it must NOT also claim there is no network.
    expect(byKind(f, "subnet")).toBeUndefined();
  });

  it("warns when the address is already an asset's primary IP", () => {
    const f = IPC.buildFindings(ctx({
      existingAssets: [{ id: "a1", hostname: "plv-cam-04", assetType: "other", status: "active", ipAddress: "10.4.12.63", primary: true }],
    }));
    const hit = byKind(f, "asset")!;
    expect(hit.level).toBe("warn");
    expect(hit.text).toContain("primary IP");
  });

  it("keeps a secondary-address match informational", () => {
    const f = IPC.buildFindings(ctx({
      existingAssets: [{ id: "a1", hostname: "srv-01", assetType: "server", status: "active", ipAddress: "10.4.12.9", primary: false }],
    }));
    expect(byKind(f, "asset")!.level).toBe("info");
  });

  it("names the gate and why it believes it, per source", () => {
    const viaArp = IPC.buildFindings(ctx({
      arp: [{ macAddress: "AA:BB:CC:DD:EE:FF", ifName: "internal3", ageSec: 12, lastSeen: "2026-08-20T00:00:00Z", gate: { id: "fw1", hostname: "plv-fgt" }, matched: null }],
      firewall: { deviceName: "plv-fgt", source: "arp", asset: { id: "fw1", hostname: "plv-fgt", location: "Plant", learnedLocation: null, latitude: null, longitude: null } },
    }));
    expect(byKind(viaArp, "firewall")!.text).toContain("ARP table");
    expect(byKind(viaArp, "firewall")!.text).toContain("internal3");

    const viaSubnet = IPC.buildFindings(ctx({
      subnet: SUBNET,
      firewall: { deviceName: "CENTRALFMG1", source: "subnet", asset: null },
    }));
    const line = byKind(viaSubnet, "firewall")!.text;
    expect(line).toContain("serves DHCP");
    expect(line).toContain("no matching firewall asset");
  });

  it("warns on an address already in use and names how the gate hands it out", () => {
    const f = IPC.buildFindings(ctx({
      subnet: SUBNET,
      reservation: {
        id: "r1", hostname: "ap-shop-2", macAddress: "AA:BB:CC:00:11:22", owner: null,
        createdBy: null, sourceType: "fortinap", dhcpBinding: "lease", pushStatus: null,
        expiresAt: null, lastSeenLeased: "2026-08-20T00:00:00Z", lastSeenArp: null, notes: null,
      },
    }));
    const r = byKind(f, "reservation")!;
    expect(r.level).toBe("warn");
    expect(r.text).toContain("managed FortiAP");
    expect(r.text).toContain("leases it dynamically");
  });

  it("calls a free address free, but only inside a known network", () => {
    const inNet = IPC.buildFindings(ctx({ subnet: SUBNET }));
    expect(byKind(inNet, "reservation")!.text).toMatch(/^Free/);
    // No containing network means nothing can be said about the address's status.
    expect(byKind(IPC.buildFindings(ctx()), "reservation")).toBeUndefined();
  });

  it("does not repeat the gate the firewall line already named", () => {
    const f = IPC.buildFindings(ctx({
      firewall: { deviceName: "CENTRALFMG1", source: "sighting", asset: null },
      sightings: [
        { fortigateDevice: "CENTRALFMG1", source: "dhcp_lease", lastSeen: "2026-08-20T00:00:00Z", asset: null },
        { fortigateDevice: "OTHERGATE", source: "dhcp_lease", lastSeen: "2026-08-19T00:00:00Z", asset: null },
      ],
    }));
    const extra = f.filter((x) => x.kind === "sighting");
    expect(extra).toHaveLength(1);
    expect(extra[0].text).toContain("OTHERGATE");
  });

  it("reports the switch port a resolved MAC was learned on", () => {
    const f = IPC.buildFindings(ctx({
      switchPorts: [{ macAddress: "AA:BB:CC:DD:EE:FF", ifName: "port12", vlanId: 12, lastSeen: "2026-08-20T00:00:00Z", switchAsset: { id: "sw1", hostname: "plv-sw-01" } }],
    }));
    const p = byKind(f, "port")!;
    expect(p.text).toContain("plv-sw-01 port12");
    expect(p.text).toContain("VLAN 12");
  });

  it("reports the access point a station on the address is associated to", () => {
    const f = IPC.buildFindings(ctx({
      apStations: [{ macAddress: "AA:BB:CC:DD:EE:FF", ssid: "Corp", band: "5GHz", lastSeen: "2026-08-20T00:00:00Z", matchedBy: "mac", apAsset: { id: "ap1", hostname: "plv-ap-03" } }],
    }));
    const a = byKind(f, "ap")!;
    expect(a.text).toContain("plv-ap-03 has station AA:BB:CC:DD:EE:FF on Corp (5GHz)");
  });

  it("says so when the AP was reached by its own recorded address rather than a MAC", () => {
    const f = IPC.buildFindings(ctx({
      apStations: [{ macAddress: "AA:BB:CC:DD:EE:FF", ssid: null, band: null, lastSeen: "2026-08-20T00:00:00Z", matchedBy: "ip", apAsset: null }],
    }));
    const a = byKind(f, "ap")!;
    expect(a.text).toContain("an access point reports this address for AA:BB:CC:DD:EE:FF");
  });

  it("orders the duplicate-asset warning first", () => {
    const f = IPC.buildFindings(ctx({
      subnet: SUBNET,
      existingAssets: [{ id: "a1", hostname: "dup", assetType: "server", status: "active", ipAddress: "10.4.12.63", primary: true }],
    }));
    expect(kinds(f)[0]).toBe("asset");
  });
});

describe("applicableSuggestions", () => {
  const suggestions = {
    hostname: "plv-cam-04",
    macAddress: "AA:BB:CC:DD:EE:FF",
    location: "Pleasant View Plant",
    latitude: 40.7128,
    longitude: -74.0060,
  };

  it("offers every suggestion into an empty form", () => {
    const out = IPC.applicableSuggestions(ctx({ suggestions }), {});
    expect(out).toEqual(suggestions);
  });

  it("never overwrites a value the operator typed", () => {
    const out = IPC.applicableSuggestions(ctx({ suggestions }), {
      hostname: "my-own-name", macAddress: "", location: "  ",
    });
    expect(out.hostname).toBeUndefined();
    expect(out.macAddress).toBe("AA:BB:CC:DD:EE:FF");
    // Whitespace-only counts as blank.
    expect(out.location).toBe("Pleasant View Plant");
  });

  it("withholds coordinates when either one is already filled", () => {
    const out = IPC.applicableSuggestions(ctx({ suggestions }), { latitude: "36.0" });
    expect(out.latitude).toBeUndefined();
    expect(out.longitude).toBeUndefined();
  });

  it("offers nothing when the server suggested nothing", () => {
    expect(IPC.applicableSuggestions(ctx(), {})).toEqual({});
  });
});

describe("suggestionLabels", () => {
  it("names the coordinate pair once", () => {
    expect(IPC.suggestionLabels({ latitude: 1, longitude: 2 })).toEqual(["Coordinates"]);
  });

  it("labels fields in a form the operator recognises", () => {
    expect(IPC.suggestionLabels({ hostname: "h", macAddress: "m", latitude: 1, longitude: 2 }))
      .toEqual(["Hostname", "MAC Address", "Coordinates"]);
  });

  it("is empty when nothing applies", () => {
    expect(IPC.suggestionLabels({})).toEqual([]);
  });
});

describe("panelHTML", () => {
  it("renders a hidden container the form can place before any lookup runs", () => {
    const html = IPC.panelHTML("f-ip-context");
    expect(html).toContain('id="f-ip-context"');
    expect(html).toContain("display:none");
  });
});
