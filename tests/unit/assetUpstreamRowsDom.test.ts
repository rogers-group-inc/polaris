/**
 * tests/unit/assetUpstreamRowsDom.test.ts — the asset-details General tab's
 * upstream rows (Last Seen Switch / AP / Firewall) and the row menu behind
 * each (`_upstreamRowHTML` / `_upstreamMenuItems` / `_upgradeUpstreamRow` in
 * public/js/assets.js).
 *
 * Three things about these rows break silently:
 *
 *  - the verbs must come from the SAME gate the Assets list and the slide-over
 *    header use (`_assetMgmtAccess`), so a FortiSwitch whose local-access
 *    policy permits HTTPS but not SSH offers exactly one verb. Re-deriving them
 *    here is how a row starts advertising a closed port;
 *  - a name that resolves to no asset must stay TEXT. Unresolved is a
 *    legitimate state (an unadopted switch, a gate another integration hasn't
 *    discovered yet), and a trigger with no items pops an empty menu;
 *  - the PORT half is not part of the trigger — "port15" is not something you
 *    can open, and folding it in would make the trigger's accessible name
 *    "SW-01/port15" instead of the device.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetRowMenu.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assetsSource } from "./_assetsSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface MenuItem { label?: string; separator?: boolean; onSelect?: () => void }

const g = globalThis as Record<string, any>;
const assetsLines = assetsSource().split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let rowHTML: (label: string, cellId: string, value: string | null) => string;
let menuItems: (ref: unknown) => MenuItem[];
let upgrade: (cellId: string, entry: unknown, kindLabel: string) => void;

let opened: string[] = [];
let menus: Array<{ label: string; items: MenuItem[] }> = [];

/** A resolved upstream device, as GET /assets/:id/upstream ships it. */
function ref(over: Record<string, unknown> = {}) {
  return {
    id: "sw1",
    hostname: "FS-248E-01",
    ipAddress: "10.0.1.20",
    assetType: "switch",
    status: "active",
    monitorStatus: "up",
    managementAccess: { mgmtIp: "10.0.1.20", protocols: ["https", "ping", "snmp"], https: true, ssh: false },
    ...over,
  };
}

const labels = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.label);

beforeEach(() => {
  opened = [];
  menus = [];
  g.escapeHtml = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  g.openViewModal = (id: string) => { opened.push(id); };
  g.showRowMenu = (_anchor: unknown, items: MenuItem[], opts: { label: string }) => { menus.push({ label: opts.label, items }); };
  g.showToast = () => {};
  g.copyTextToClipboard = () => Promise.resolve(true);
  g._sshAction = () => "uri";
  g._doSshLaunch = () => {};
  g._rdpAction = () => "file";
  g._doRdpLaunch = () => {};
  (0, eval)(fnSrc("_assetMgmtAccess"));
  (0, eval)(fnSrc("_managementAccessMenuItems"));
  (0, eval)(fnSrc("_upstreamRowHTML"));
  (0, eval)(fnSrc("_upstreamMenuItems"));
  (0, eval)(fnSrc("_upgradeUpstreamRow"));
  rowHTML = g._upstreamRowHTML;
  menuItems = g._upstreamMenuItems;
  upgrade = g._upgradeUpstreamRow;
  expect(typeof upgrade, "assets.js no longer declares _upgradeUpstreamRow").toBe("function");
  document.body.innerHTML =
    rowHTML("Last Seen Switch", "asset-last-sw-a1", "S248EPTF1/port15") +
    rowHTML("Last Seen Firewall", "asset-last-fw-a1", null);
});

const cell = (id: string) => document.getElementById(id)!;

describe("_upstreamRowHTML", () => {
  it("paints the stored string with an addressable value cell", () => {
    expect(cell("asset-last-sw-a1").textContent).toBe("S248EPTF1/port15");
    expect(document.body.textContent).toContain("Last Seen Switch");
  });
  it("renders a dash for an absent value, like every other detail row", () => {
    expect(cell("asset-last-fw-a1").textContent).toBe("-");
  });
  it("escapes the value", () => {
    document.body.innerHTML = rowHTML("Last Seen AP", "c", '<img src=x onerror=alert(1)>');
    expect(document.getElementById("c")!.querySelector("img")).toBeNull();
  });
});

describe("_upstreamMenuItems", () => {
  it("leads with Open asset, then the device's own remote-access verbs", () => {
    // HTTPS is permitted, SSH is not — the switch's local-access policy said so.
    expect(labels(menuItems(ref()))).toEqual(["Open asset", "Open HTTPS"]);
  });
  it("offers both verbs when the access list could not be read", () => {
    // protocols === null is unknown, not denied (the pre-policy switch path).
    expect(labels(menuItems(ref({ managementAccess: { mgmtIp: "10.0.1.20", protocols: null, https: false, ssh: false } }))))
      .toEqual(["Open asset", "Open HTTPS", "Open SSH"]);
  });
  it("offers Open asset alone when nothing read the device's access config", () => {
    expect(labels(menuItems(ref({ assetType: "access_point", managementAccess: null })))).toEqual(["Open asset"]);
  });
  it("nothing at all for an unresolved name", () => {
    expect(menuItems(null)).toEqual([]);
    expect(menuItems({ hostname: "SW-1" })).toEqual([]);
  });
  it("Open asset walks the slide-over to that device", () => {
    menuItems(ref())[0]!.onSelect!();
    expect(opened).toEqual(["sw1"]);
  });
});

describe("_upgradeUpstreamRow", () => {
  it("turns the device name into a trigger and leaves the port as text", () => {
    upgrade("asset-last-sw-a1", { name: "S248EPTF1", port: "port15", asset: ref() }, "switch");
    const btn = cell("asset-last-sw-a1").querySelector("button")!;
    expect(btn.className).toContain("row-menu-trigger");
    expect(btn.textContent).toBe("S248EPTF1");
    expect(cell("asset-last-sw-a1").textContent).toBe("S248EPTF1/port15");
    btn.dispatchEvent(new Event("click"));
    expect(menus).toHaveLength(1);
    expect(menus[0]!.label).toBe("Actions for S248EPTF1");
    expect(labels(menus[0]!.items)).toEqual(["Open asset", "Open HTTPS"]);
  });

  it("leaves an unresolved name as plain text — no empty menu", () => {
    upgrade("asset-last-sw-a1", { name: "SW-NOT-IN-INVENTORY", port: "port2", asset: null }, "switch");
    const c = cell("asset-last-sw-a1");
    expect(c.querySelector("button")).toBeNull();
    expect(c.textContent).toBe("SW-NOT-IN-INVENTORY/port2");
  });

  it("fills the firewall row from the server's own name", () => {
    // The sightings pass may not have run for a caller without
    // assetsQuarantine:read; when it did, both agree on the freshest gate.
    upgrade("asset-last-fw-a1", { name: "SITE-A-FGT", asset: ref({ id: "fg1", assetType: "firewall" }) }, "firewall");
    const btn = cell("asset-last-fw-a1").querySelector("button")!;
    expect(btn.textContent).toBe("SITE-A-FGT");
    // The gate's hostname differs from FMG's device name — the tooltip says so
    // without changing the value the row has always displayed.
    expect(btn.title).toBe("Actions for this firewall (FS-248E-01)");
  });

  it("no-ops on a missing entry or a missing cell", () => {
    upgrade("asset-last-fw-a1", null, "firewall");
    expect(cell("asset-last-fw-a1").textContent).toBe("-");
    expect(() => upgrade("nope", { name: "X", asset: ref() }, "switch")).not.toThrow();
  });
});
