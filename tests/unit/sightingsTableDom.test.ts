/**
 * tests/unit/sightingsTableDom.test.ts — the Firewall Sightings table on the
 * asset slide-over's Sources tab (and the Quarantine tab's copy of it), and
 * the click-to-copy IP / MAC values on the same tab
 * (`_sightingsTableHTML` / `_sightingGateMenuItems` /
 * `_sightingNetworkMenuItems` / `_formatSourceObservedValue` /
 * `_isCopyableAddress` in public/js/assets.js).
 *
 *  - a FortiGate name the server resolved to an asset is a row-menu trigger
 *    (click opens the gate, right click its menu) and its row a
 *    `data-row-menu-row`; an unresolved name stays text, since a trigger with
 *    no asset has nothing to open;
 *  - the VLAN cell opens its network only when the server matched one AND the
 *    viewer can read networks — otherwise it is text, not a panel that 403s;
 *  - IPs and MACs are `.copy-cell`s, which the slide-over body's copy handler
 *    acts on; a time ("12:30:45") or a free-text value is not.
 *
 * assets.js has no module boundary, so the functions are sliced out by name
 * and eval'd (tests/unit/assetUpstreamRowsDom.test.ts's approach).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface MenuItem { label?: string; separator?: boolean; primary?: boolean; onSelect?: () => void }

const g = globalThis as Record<string, any>;
const src = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const lines = src.split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}
function varSrc(name: string): string {
  const line = lines.find((l) => l.startsWith(`var ${name} =`));
  if (!line) throw new Error(`assets.js: var ${name} not found`);
  return line;
}

let opened: string[] = [];
let networks: string[] = [];
let copied: string[] = [];
let canReadSubnets = true;

beforeAll(() => {
  g.escapeHtml = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatDate = (s: string) => `D(${s})`;
  g.openViewModal = (id: string) => opened.push(id);
  g._managementAccessMenuItems = (ref: any) =>
    ref && ref.managementAccess && ref.managementAccess.https ? [{ label: "Open HTTPS", onSelect: () => {} }] : [];
  g.copyTextToClipboard = (t: string) => { copied.push(t); return Promise.resolve(true); };
  g.permAtLeast = (key: string) => key === "subnets" && canReadSubnets;
  g.PolarisPanels = { openNetwork: (id: string) => networks.push(id) };
  const code = [
    varSrc("_sightingMenuRows"), varSrc("_sightingMenuSeq"),
    varSrc("_SOURCE_IPV4_RE"), varSrc("_SOURCE_IPV6_RE"), varSrc("_SOURCE_MAC_RE"),
    fnSrc("_upstreamMenuItems"), fnSrc("_sightingsTableHTML"), fnSrc("_canOpenSightingNetwork"),
    fnSrc("_sightingGateMenuItems"), fnSrc("_sightingNetworkMenuItems"),
    fnSrc("_formatSourceObservedValue"), fnSrc("_isCopyableAddress"), fnSrc("_sourceAddressCopyHTML"),
  ].join("\n").replace(/^var /gm, "globalThis.").replace(/^function (\w+)/gm, "globalThis.$1 = function $1");
  (0, eval)(code);
});

beforeEach(() => {
  opened = []; networks = []; copied = []; canReadSubnets = true;
});

const gateRef = { id: "fgt1", hostname: "fgt-a", assetType: "firewall", managementAccess: { https: true, ssh: false } };
function sighting(over: Record<string, unknown> = {}) {
  return {
    fortigateDevice: "SITE-A-FGT", ipAddress: "10.77.5.44", subnetName: "Staff", vlan: 50, subnetId: "net1",
    source: "dhcp_lease", lastSeen: "2026-11-01T00:00:00Z", fortigateAsset: gateRef, ...over,
  };
}
function render(rows: unknown[]): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g._sightingsTableHTML(rows);
  return host;
}

describe("Firewall Sightings table", () => {
  it("makes a resolved FortiGate a row-menu trigger and its row a menu row", () => {
    const host = render([sighting()]);
    const btn = host.querySelector("[data-sighting-gate]") as HTMLElement;
    expect(btn.classList.contains("row-menu-trigger")).toBe(true);
    expect(btn.textContent).toBe("SITE-A-FGT");
    expect(host.querySelector("tbody tr")!.hasAttribute("data-row-menu-row")).toBe(true);
  });

  it("gate menu: Open asset is primary and opens the gate; HTTPS and Copy name ride along", () => {
    const host = render([sighting()]);
    const key = host.querySelector("[data-sighting-gate]")!.getAttribute("data-sighting-gate")!;
    const items: MenuItem[] = g._sightingGateMenuItems(g._sightingMenuRows[key]);
    expect(items.filter((i) => !i.separator).map((i) => i.label)).toEqual(["Open asset", "Open HTTPS", "Copy name"]);
    items[0].onSelect!();
    expect(opened).toEqual(["fgt1"]);
    items.find((i) => i.label === "Copy name")!.onSelect!();
    expect(copied).toEqual(["SITE-A-FGT"]);
  });

  it("leaves an unresolved FortiGate as text on a plain row", () => {
    const host = render([sighting({ fortigateAsset: null })]);
    expect(host.querySelector("[data-sighting-gate]")).toBeNull();
    expect(host.querySelector("tbody tr")!.hasAttribute("data-row-menu-row")).toBe(false);
    expect(host.textContent).toContain("SITE-A-FGT");
  });

  it("VLAN cell opens its network", () => {
    const host = render([sighting()]);
    const btn = host.querySelector("[data-sighting-net]") as HTMLElement;
    expect(btn.textContent).toBe("Staff · VLAN 50");
    const items: MenuItem[] = g._sightingNetworkMenuItems(g._sightingMenuRows[btn.getAttribute("data-sighting-net")!]);
    expect(items[0]).toMatchObject({ label: "Open network", primary: true });
    items[0].onSelect!();
    expect(networks).toEqual(["net1"]);
  });

  it("VLAN stays text with no matched network, or for a viewer who can't read networks", () => {
    expect(render([sighting({ subnetId: null })]).querySelector("[data-sighting-net]")).toBeNull();
    canReadSubnets = false;
    const host = render([sighting()]);
    expect(host.querySelector("[data-sighting-net]")).toBeNull();
    expect(host.textContent).toContain("Staff · VLAN 50");
  });

  it("IP is click-to-copy", () => {
    const cell = render([sighting()]).querySelector(".copy-cell") as HTMLElement;
    expect(cell.getAttribute("data-copy")).toBe("10.77.5.44");
  });
});

describe("Sources tab observed values", () => {
  it("IPs and MACs are copy cells; other strings are not", () => {
    for (const v of ["10.0.0.5", "10.0.0.0/24", "fe80::1", "2001:db8:0:0:0:0:0:1", "00:11:22:aa:bb:cc", "00-11-22-AA-BB-CC", "0011.22aa.bbcc"]) {
      expect(g._isCopyableAddress(v), v).toBe(true);
    }
    for (const v of ["12:30:45", "host-01", "999.1.1.1", "a:b", "Windows 11"]) {
      expect(g._isCopyableAddress(v), v).toBe(false);
    }
  });

  it("renders an address list as one copy cell per entry", () => {
    const host = document.createElement("div");
    host.innerHTML = g._formatSourceObservedValue(["00:11:22:aa:bb:cc", "10.0.0.5"]);
    expect(Array.from(host.querySelectorAll(".copy-cell")).map((e) => e.getAttribute("data-copy"))).toEqual(["00:11:22:aa:bb:cc", "10.0.0.5"]);
  });

  it("keeps a mixed list as JSON", () => {
    expect(g._formatSourceObservedValue(["10.0.0.5", "x"])).toContain("<code");
  });
});
