/**
 * tests/unit/assetRowMenu.test.ts — the Assets list row-menu item builders
 * (`_assetMenuItems` / `_quarantineMenuItems` in public/js/assets.js).
 *
 * The quarantine verbs are the reason this file exists. Quarantine pushes a MAC
 * block to every FortiGate that has seen the device, so who may reach it and
 * which devices may receive it are both load-bearing:
 *
 *  - It rides its OWN function key, `assetsQuarantine`, not `assets`. Every
 *    /assets/:id/quarantine* route gates on it. The pre-menu version of this
 *    code gated on canManageAssets() (`assets:write`) — it was never wired up,
 *    so the mismatch never shipped, and this pins it so it can't come back.
 *  - Fortinet infrastructure can never be quarantined: blocking the device that
 *    enforces the block would lock the operator out of their own network.
 *  - Release must stay available for an already-quarantined asset REGARDLESS of
 *    type, so a misclassified quarantine is always reversible.
 *  - No MAC means no target to block, so neither verb applies.
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the
 * builders are sliced out by name and eval'd — the approach in
 * assetInterfacesTableDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface MenuItem {
  label?: string;
  separator?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
}
interface AssetRow {
  id: string;
  hostname?: string;
  status?: string;
  assetType?: string;
  macAddress?: string | null;
  macAddresses?: unknown[];
  ipAddress?: string | null;
  managementAccess?: unknown;
}

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let assetMenuItems: (a: AssetRow) => MenuItem[];
let quarantineMenuItems: (a: AssetRow) => MenuItem[];
let mgmtMenuItems: (a: AssetRow) => MenuItem[];

/** Actionable labels only, separators dropped. */
const labels = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.label);

/** A quarantinable endpoint: has a MAC, ordinary type, not already quarantined. */
function endpoint(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "a1", hostname: "wks-01", status: "active", assetType: "workstation", macAddress: "aa:bb:cc:dd:ee:ff", ...over };
}

/**
 * Re-eval the builders with the two permission gates set independently, plus
 * the install-wide quarantine-push availability probe (`pushQuarantine` on some
 * enabled Fortinet integration). It defaults to available because that is also
 * what an unanswered probe reads as — the gate fails open.
 */
function withPerms(assets: boolean, quarantine: boolean, pushEnabled = true) {
  g.canManageAssets = () => assets;
  g.canQuarantineAssets = () => quarantine;
  g._quarantinePushAvailable = () => pushEnabled;
  (0, eval)(fnSrc("_quarantineMenuItems"));
  (0, eval)(fnSrc("_assetMgmtAccess"));
  (0, eval)(fnSrc("_managementAccessMenuItems"));
  (0, eval)(fnSrc("_assetMenuItems"));
  assetMenuItems = g._assetMenuItems;
  quarantineMenuItems = g._quarantineMenuItems;
  mgmtMenuItems = g._managementAccessMenuItems;
}

/**
 * A Fortinet-discovered device whose captured access list says HTTPS and SSH
 * are both open. `managementAccess` is the four-field projection the list
 * endpoint ships (shapeManagementAccess in src/api/routes/assets.ts), not the
 * full stored blob.
 */
function mgmtAsset(over: Record<string, unknown> = {}): AssetRow {
  return endpoint({
    assetType: "firewall",
    ipAddress: "10.0.0.1",
    managementAccess: { mgmtIp: "10.0.0.1", protocols: ["https", "ssh", "snmp"], https: true, ssh: true, ...over },
  });
}

beforeEach(() => {
  g.openViewModal = () => {};
  g.openEditModal = () => {};
  g.confirmDelete = () => {};
  g.quarantineAssetRow = () => {};
  g.releaseAssetQuarantine = () => {};
  g._sshAction = () => "uri";
  g._doSshLaunch = () => {};
  g._rdpAction = () => "file";
  g._doRdpLaunch = () => {};
  withPerms(true, true);
  expect(typeof assetMenuItems, "assets.js no longer declares _assetMenuItems").toBe("function");
});

describe("_quarantineMenuItems — permission gate", () => {
  it("offers Quarantine with assetsQuarantine, even without assets:write", () => {
    withPerms(false, true);
    expect(labels(quarantineMenuItems(endpoint()))).toEqual(["Quarantine"]);
  });

  it("offers NOTHING without assetsQuarantine, even with assets:write", () => {
    // The old code gated on canManageAssets() — this is that bug, pinned out.
    withPerms(true, false);
    expect(quarantineMenuItems(endpoint())).toEqual([]);
    expect(quarantineMenuItems(endpoint({ status: "quarantined" }))).toEqual([]);
  });

  it("offers NOTHING when no integration has quarantine push enabled", () => {
    // config.pushQuarantine is per-integration and off by default; with it off
    // everywhere the push resolves to zero targets and 502s with "0/0
    // FortiGate(s) accepted the push", so the verb is withheld.
    withPerms(true, true, false);
    expect(quarantineMenuItems(endpoint())).toEqual([]);
  });

  it("still offers Release with push disabled", () => {
    // releaseQuarantine unpushes from the targets recorded on the asset without
    // consulting the toggle, so an asset quarantined before an operator turned
    // push off must stay releasable.
    withPerms(true, true, false);
    expect(labels(quarantineMenuItems(endpoint({ status: "quarantined" })))).toEqual(["Release quarantine"]);
  });

  it("keeps quarantine out of the row menu entirely when the key is missing", () => {
    withPerms(true, false);
    const l = labels(assetMenuItems(endpoint()));
    expect(l).not.toContain("Quarantine");
    expect(l).not.toContain("Release quarantine");
  });
});

describe("_quarantineMenuItems — which devices", () => {
  it("offers Quarantine for an ordinary endpoint with a MAC", () => {
    const items = quarantineMenuItems(endpoint());
    expect(items[0]!.label).toBe("Quarantine");
    expect(items[0]!.danger).toBe(true);
  });

  it("offers nothing when the asset has no MAC — there is no target to block", () => {
    expect(quarantineMenuItems(endpoint({ macAddress: null }))).toEqual([]);
    expect(quarantineMenuItems(endpoint({ macAddress: undefined, macAddresses: [] }))).toEqual([]);
  });

  it("accepts a MAC from the macAddresses list when the primary is empty", () => {
    const items = quarantineMenuItems(endpoint({ macAddress: null, macAddresses: [{ macAddress: "aa:bb:cc:00:11:22" }] }));
    expect(labels(items)).toEqual(["Quarantine"]);
  });

  it("never offers Quarantine for Fortinet infrastructure", () => {
    // Blocking the device that enforces the block locks the operator out.
    for (const t of ["firewall", "switch", "access_point"]) {
      expect(quarantineMenuItems(endpoint({ assetType: t })), t).toEqual([]);
    }
  });

  it("offers Release for an already-quarantined asset", () => {
    const items = quarantineMenuItems(endpoint({ status: "quarantined" }));
    expect(items[0]!.label).toBe("Release quarantine");
    // A restore, not a destructive act.
    expect(items[0]!.danger).toBeFalsy();
  });

  it("offers Release even on infrastructure, so a misclassification is reversible", () => {
    for (const t of ["firewall", "switch", "access_point"]) {
      expect(labels(quarantineMenuItems(endpoint({ assetType: t, status: "quarantined" }))), t)
        .toEqual(["Release quarantine"]);
    }
  });

  it("never offers both verbs at once", () => {
    for (const status of ["active", "quarantined", "maintenance", "storage"]) {
      expect(quarantineMenuItems(endpoint({ status })).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("_managementAccessMenuItems", () => {
  it("offers both verbs when the access list permits both", () => {
    expect(labels(mgmtMenuItems(mgmtAsset()))).toEqual(["Open HTTPS", "Open SSH"]);
  });

  it("offers only what the device actually permits", () => {
    expect(labels(mgmtMenuItems(mgmtAsset({ ssh: false, protocols: ["https"] })))).toEqual(["Open HTTPS"]);
    expect(labels(mgmtMenuItems(mgmtAsset({ https: false, protocols: ["ssh"] })))).toEqual(["Open SSH"]);
    expect(mgmtMenuItems(mgmtAsset({ https: false, ssh: false, protocols: [] }))).toEqual([]);
  });

  it("offers both when the access list could NOT be read", () => {
    // protocols == null is the best-effort switch path: unknown, not denied.
    // Withholding the verbs there would hide management access on every
    // FortiSwitch, so the slide-over renders them optimistically and so does
    // the row menu.
    expect(labels(mgmtMenuItems(mgmtAsset({ protocols: null, https: false, ssh: false }))))
      .toEqual(["Open HTTPS", "Open SSH"]);
  });

  it("offers nothing for an asset with no captured access list", () => {
    // Every endpoint, and every asset from a non-Fortinet discovery.
    expect(mgmtMenuItems(endpoint())).toEqual([]);
    expect(mgmtMenuItems(endpoint({ managementAccess: null }))).toEqual([]);
  });

  it("offers nothing when there is no address to dial", () => {
    const noIp = mgmtAsset({ mgmtIp: null });
    noIp.ipAddress = null;
    expect(mgmtMenuItems(noIp)).toEqual([]);
  });

  it("falls back to the asset's own IP when the blob carries no mgmtIp", () => {
    const items = mgmtMenuItems(mgmtAsset({ mgmtIp: undefined }));
    expect(labels(items)).toEqual(["Open HTTPS", "Open SSH"]);
    expect(items[0]!.title).toContain("10.0.0.1");
  });

  it("performs the operator's stored SSH default rather than a second menu", () => {
    // The slide-over's split button owns the ssh://-vs-copy choice; a flat row
    // menu has no room for a caret, so it obeys whatever that choice was.
    const launched: Array<[string, string]> = [];
    g._doSshLaunch = (ip: string, act: string) => { launched.push([ip, act]); };
    g._sshAction = () => "copy";
    withPerms(true, true);
    const ssh = mgmtMenuItems(mgmtAsset()).find((i) => i.label === "Open SSH")!;
    expect(ssh.title).toContain("Copy an ssh command");
    ssh.onSelect!();
    expect(launched).toEqual([["10.0.0.1", "copy"]]);
  });

  it("is not gated on assets:write — reaching a device is not editing it", () => {
    withPerms(false, false);
    expect(labels(mgmtMenuItems(mgmtAsset()))).toEqual(["Open HTTPS", "Open SSH"]);
  });

  it("offers a server RDP + SSH off its TYPE, with no access list to read", () => {
    // Nothing reads a Windows or Linux host's management surface, so the verbs
    // come from the asset type — and HTTPS is not among them: a server's :443
    // is the application, not a management UI.
    const srv = endpoint({ assetType: "server", ipAddress: "10.0.0.9" });
    expect(labels(mgmtMenuItems(srv))).toEqual(["Open RDP", "Open SSH"]);
    // Still needs an address to dial.
    expect(mgmtMenuItems(endpoint({ assetType: "server", ipAddress: null }))).toEqual([]);
    // And no other type inherits it — a workstation menu is unchanged.
    expect(mgmtMenuItems(endpoint())).toEqual([]);
  });

  it("never offers RDP for a Fortinet device", () => {
    expect(labels(mgmtMenuItems(mgmtAsset()))).not.toContain("Open RDP");
    expect(labels(mgmtMenuItems(mgmtAsset({ protocols: null })))).not.toContain("Open RDP");
  });

  it("performs the operator's stored RDP default rather than a second menu", () => {
    const launched: Array<[string, string]> = [];
    g._doRdpLaunch = (ip: string, act: string) => { launched.push([ip, act]); };
    g._rdpAction = () => "copy";
    withPerms(true, true);
    const rdp = mgmtMenuItems(endpoint({ assetType: "server", ipAddress: "10.0.0.9" }))
      .find((i) => i.label === "Open RDP")!;
    expect(rdp.title).toContain("Copy an mstsc command");
    rdp.onSelect!();
    expect(launched).toEqual([["10.0.0.9", "copy"]]);
  });
});

describe("_assetMenuItems", () => {
  it("always offers Open, so a read-only viewer still gets a working menu", () => {
    withPerms(false, false);
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open"]);
  });

  it("adds Edit and Delete with assets:write", () => {
    withPerms(true, false);
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open", "Edit", "Delete"]);
  });

  it("orders the full menu Open, Edit, Quarantine, Delete", () => {
    expect(labels(assetMenuItems(endpoint()))).toEqual(["Open", "Edit", "Quarantine", "Delete"]);
  });

  it("puts the remote-access verbs between Edit and the quarantine group", () => {
    // A firewall is never quarantinable, so this shape shows the access verbs
    // sitting on their own between the edit and delete groups.
    expect(labels(assetMenuItems(mgmtAsset())))
      .toEqual(["Open", "Edit", "Open HTTPS", "Open SSH", "Delete"]);
  });

  it("leaves an ordinary endpoint's menu untouched", () => {
    // The gate is the captured access list, not the asset type — a row without
    // one must not grow two dead verbs.
    expect(labels(assetMenuItems(endpoint()))).not.toContain("Open HTTPS");
    expect(labels(assetMenuItems(endpoint()))).not.toContain("Open SSH");
  });

  it("marks Delete destructive and puts it last", () => {
    const items = assetMenuItems(endpoint());
    const last = items[items.length - 1]!;
    expect(last.label).toBe("Delete");
    expect(last.danger).toBe(true);
  });

  it("never renders a leading, trailing, or doubled separator", () => {
    // A divider with nothing after it looks like a broken menu. Exercised across
    // every permission × asset-shape combination.
    for (const [ma, qa] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      withPerms(ma, qa);
      for (const shape of [endpoint(), endpoint({ macAddress: null }), endpoint({ status: "quarantined" }), endpoint({ assetType: "switch" }), mgmtAsset(), mgmtAsset({ https: false, protocols: ["ssh"] })]) {
        const items = assetMenuItems(shape);
        expect(items[0]!.separator, JSON.stringify([ma, qa, shape.assetType, shape.status])).toBeFalsy();
        expect(items[items.length - 1]!.separator).toBeFalsy();
        items.forEach((it, i) => {
          if (it.separator) expect(items[i + 1] && !items[i + 1]!.separator).toBe(true);
        });
      }
    }
  });

  it("is never empty for any permission combination", () => {
    for (const [ma, qa] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      withPerms(ma, qa);
      expect(labels(assetMenuItems(endpoint())).length).toBeGreaterThan(0);
    }
  });

  it("a right click's selection verbs sit as their own group before quarantine and delete", () => {
    withPerms(true, true);
    const items = (g._assetMenuItems as (a: AssetRow, extra: MenuItem[]) => MenuItem[])(
      endpoint(), [{ label: "Tags", onSelect: () => {} }]);
    const l = labels(items);
    expect(l.indexOf("Tags")).toBeGreaterThan(l.indexOf("Edit"));
    expect(l.indexOf("Tags")).toBeLessThan(l.indexOf("Quarantine"));
    expect(items[items.findIndex((i) => i.label === "Tags") - 1]!.separator).toBe(true);
  });
});

// The bulk bar is never shown: a right click on a row offers its verbs in the
// row menu (`_assetsBulkMenuItems`), read off the bar's real markup so every
// gate that hides or greys a bar button still decides the menu. Built against
// the bar as assets.html ships it, so a renamed or added button is caught here.
describe("_assetsBulkMenuItems — the selection's verbs in the row menu", () => {
  const html = readFileSync(resolve(__dirname, "../../public/assets.html"), "utf8").replace(/\r\n/g, "\n");
  const barStart = html.indexOf('<div id="assets-bulk-bar"');
  const barHtml = html.slice(barStart, html.indexOf("\n      </div>", barStart) + "\n      </div>".length);
  const constStart = assetsLines.findIndex((l) => l.startsWith("var _ASSETS_BULK_MENU = {"));
  const constEnd = assetsLines.findIndex((l, i) => i > constStart && l === "};");

  type Item = MenuItem & { heading?: string };
  let win: InstanceType<typeof Window>;
  let bar: HTMLElement;
  let sub: { items: Item[]; opts: Record<string, unknown> } | null;
  let build: (bar: unknown, anchor: unknown, at: unknown, single: boolean) => Item[];

  beforeEach(() => {
    win = new Window();
    win.document.body.innerHTML = barHtml;
    bar = win.document.getElementById("assets-bulk-bar") as unknown as HTMLElement;
    // Type entries as _renderBulkTypeMenu draws them.
    (win.document.getElementById("assets-bulk-type-menu") as unknown as HTMLElement).innerHTML =
      '<div class="dropdown-heading">Change type</div><button type="button">Switch</button><button type="button">Server</button>';
    sub = null;
    g.showRowMenu = (_a: unknown, items: Item[], opts: Record<string, unknown>) => { sub = { items, opts }; };
    g._assetsSelected = new Set(["a1", "a2", "a3"]);
    (0, eval)(assetsLines.slice(constStart, constEnd + 1).join("\n"));
    (0, eval)(fnSrc("_assetsBulkMenuItems"));
    build = g._assetsBulkMenuItems;
  });
  const btn = (id: string) => win.document.getElementById(id) as unknown as HTMLButtonElement;
  const actionable = (items: Item[]) => items.filter((i) => i.label).map((i) => i.label);

  it("finds the bar in assets.html, never shown", () => {
    expect(constStart).toBeGreaterThan(0);
    expect(barStart).toBeGreaterThan(0);
    expect(bar.style.display).toBe("none");
  });

  it("multi: offers every bar verb but Edit, grouped verbs / red / Clear selection", () => {
    btn("assets-bulk-merge-btn").style.display = "";
    btn("assets-bulk-quarantine-btn").style.display = "";
    const items = build(bar, {}, { x: 1, y: 2 }, false);
    expect(items[0]!.heading).toBe("3 selected");
    expect(actionable(items)).toEqual([
      "Compare", "Merge", "Change type", "Change state", "Monitoring", "Tags",
      "Deploy agent", "Maintenance", "Upgrade firmware",
      "Quarantine", "Delete",
      "Clear selection",
    ]);
    expect(items.filter((i) => i.separator)).toHaveLength(2);
    expect(items.find((i) => i.label === "Delete")!.danger).toBe(true);
  });

  it("multi: a greyed bar button stays, disabled, with the bar's reason", () => {
    btn("assets-bulk-compare-btn").disabled = true;
    btn("assets-bulk-compare-btn").title = "Compare supports up to 10 assets";
    const cmp = build(bar, {}, {}, false).find((i) => i.label === "Compare")!;
    expect(cmp.disabled).toBe(true);
    expect(cmp.title).toBe("Compare supports up to 10 assets");
  });

  it("a button the role gate hid (display:none on it or its wrapper) is not offered", () => {
    btn("assets-bulk-delete-btn").style.display = "none";
    (btn("assets-bulk-type-btn").parentElement as HTMLElement).style.display = "none";
    const got = actionable(build(bar, {}, {}, false));
    expect(got).not.toContain("Delete");
    expect(got).not.toContain("Change type");
  });

  it("single: only the verbs that make sense for one asset and the row menu lacks", () => {
    btn("assets-bulk-merge-btn").style.display = "";
    btn("assets-bulk-quarantine-btn").style.display = "";
    btn("assets-bulk-compare-btn").disabled = true;
    btn("assets-bulk-firmware-btn").disabled = true; // a non-Fortinet asset
    const items = build(bar, {}, {}, true);
    expect(items.some((i) => i.heading)).toBe(false);
    expect(actionable(items)).toEqual([
      "Change type", "Change state", "Monitoring", "Tags", "Deploy agent", "Maintenance",
    ]);
  });

  it("single: Upgrade firmware joins when the bar enables it (a Fortinet device)", () => {
    btn("assets-bulk-firmware-btn").disabled = false;
    expect(actionable(build(bar, {}, {}, true))).toContain("Upgrade firmware");
  });

  it("a verb clicks its bar button; a dropdown opens its entries as a second menu at the same point", () => {
    let tags = 0;
    btn("assets-bulk-tags-btn").addEventListener("click", () => { tags++; });
    const items = build(bar, {}, { x: 7, y: 9 }, false);
    items.find((i) => i.label === "Tags")!.onSelect!();
    expect(tags).toBe(1);

    let picked = "";
    win.document.querySelectorAll("#assets-bulk-type-menu button").forEach((b) =>
      b.addEventListener("click", () => { picked = b.textContent || ""; }));
    items.find((i) => i.label === "Change type")!.onSelect!();
    expect(sub!.opts.menuAt).toEqual({ x: 7, y: 9 });
    expect(sub!.items.map((i) => i.heading || i.label)).toEqual(["Change type", "Switch", "Server"]);
    sub!.items[2]!.onSelect!();
    expect(picked).toBe("Server");
  });
});
