/**
 * tests/unit/assetMacSplitDom.test.ts — the Sources tab's "MAC addresses on
 * this asset" table and its split confirmation (public/js/assets.js,
 * business rule 91(j)).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const g = globalThis as Record<string, any>;
const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}
function varLine(name: string): string {
  const line = lines.find((l) => l.startsWith(`var ${name} =`));
  if (!line) throw new Error(`assets.js: var ${name} not found`);
  return line;
}

const FNS = [
  "_macSplitRefusal", "_macSplitCanAct", "_macSplitBase", "_macSplitSuffix", "_macSplitAddrsByMac",
  "_assetMacSplitSectionHTML", "_assetMacSplitInnerHTML", "_macSplitRerender", "_macSplitToggle",
  "_macSplitClear", "_macSplitExpand", "_macSplitOriginalRenames", "openMacSplitConfirm",
  "formatMacSource", "_addressNetworkChipHTML",
];

let canEdit = true;
let modal: { title: string; body: string; footer: string } | null = null;
beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.jsArg = (v: any) => JSON.stringify(v).replace(/"/g, "&quot;");
  g.formatDate = (s: any) => String(s).slice(0, 10);
  g.canEditAsset = () => canEdit;
  g.openModal = (title: string, body: string, footer: string) => {
    modal = { title, body, footer };
    document.body.innerHTML = `<div id="m">${body}${footer}</div>`;
  };
  g.closeModal = () => {};
  (0, eval)(
    [varLine("_MAC_SPLIT_OWN_SOURCES"), varLine("_MAC_SPLIT_VISIBLE"), varLine("_macSplitState"), ...FNS.map(fnSrc)].join("\n") +
      "\n" + [...FNS, "_macSplitState"].map((n) => `globalThis.${n} = ${n};`).join("\n"),
  );
});

const P = "44:61:32:F2:BC:27";
const X = "44:61:32:71:7C:43";
const NIC = "AC:BC:32:7E:55:19";
const t = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();

function fused(over: Record<string, any> = {}) {
  return {
    id: "a1", hostname: "iPhone", hostnameOverride: null, status: "active", quarantinedAt: null, macAddress: P,
    macAddresses: [
      { mac: X, source: "device-inventory", lastSeen: t(6) },
      { mac: P, source: "device-inventory", lastSeen: t(5) },
      { mac: NIC, source: "monitor-interface", lastSeen: t(6) },
    ],
    associatedIps: [
      { ip: "10.0.200.22", mac: P, device: "CKYSMA-91G-1", medium: "wired", lastSeen: t(5), firstSeen: t(1), network: { name: "RGIGuest", cidr: "10.0.200.0/24", vlan: 12 } },
      { ip: "10.0.200.24", mac: X, device: "CKYSMA-91G-1", medium: "wired", lastSeen: t(6), firstSeen: t(2), network: { name: "RGIGuest", cidr: "10.0.200.0/24", vlan: 12 } },
    ],
    ...over,
  };
}
const SOURCES = [{ sourceKind: "fortigate-endpoint" }, { sourceKind: "manual" }];

function render(asset: any) {
  g._macSplitState.a1 = undefined;
  document.body.innerHTML = g._assetMacSplitSectionHTML(asset, SOURCES, [{ ip: "10.0.200.24" }]);
  return document.body;
}
const row = (el: HTMLElement, mac: string) => el.querySelector(`tr[data-mac="${mac}"]`) as HTMLElement;

describe("MAC addresses on this asset (rule 91(j))", () => {
  beforeEach(() => { canEdit = true; modal = null; });

  it("is not shown for an asset with one MAC", () => {
    expect(g._assetMacSplitSectionHTML(fused({ macAddresses: [{ mac: P, source: "device-inventory" }] }), SOURCES, [])).toBe("");
  });

  it("lists the primary first, with each MAC's last IP, VLAN chip and gate", () => {
    const el = render(fused());
    const macs = [...el.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-mac"));
    expect(macs[0]).toBe(P);
    const x = row(el, X);
    expect(x.textContent).toContain("10.0.200.24");
    expect(x.querySelector(".addr-net-chip")?.textContent).toBe("VLAN 12");
    expect(x.textContent).toContain("CKYSMA-91G-1");
  });

  it("offers Split on a sighted MAC, never on the primary or the device's own port", () => {
    const el = render(fused());
    expect(row(el, X).querySelector("button")?.textContent).toBe("Split");
    expect(row(el, P).querySelector("button")).toBeNull();
    expect(row(el, P).textContent).toContain("Stays");
    expect(row(el, NIC).querySelector("button")).toBeNull();
    expect(row(el, NIC).textContent).toContain("Own port");
  });

  it("offers no Split to a viewer who cannot edit the asset, or on a quarantined one", () => {
    canEdit = false;
    expect(row(render(fused()), X).querySelector("button")).toBeNull();
    canEdit = true;
    expect(row(render(fused({ quarantinedAt: t(1) })), X).querySelector("button")).toBeNull();
  });

  it("clicking a row selects it and wakes the bulk bar", () => {
    const el = render(fused());
    expect(el.querySelector(".bulk-bar")?.classList.contains("bulk-bar-idle")).toBe(true);
    g._macSplitToggle("a1", X);
    expect(row(document.body, X).classList.contains("selected")).toBe(true);
    const bar = document.body.querySelector(".bulk-bar")!;
    expect(bar.classList.contains("bulk-bar-idle")).toBe(false);
    expect(bar.textContent).toContain("1 selected");
    // The primary row carries no click handler, so it can never be selected.
    expect(row(document.body, P).getAttribute("onclick")).toBeNull();
    g._macSplitClear("a1");
    expect(document.body.querySelector(".bulk-bar-idle")).not.toBeNull();
  });

  it("the confirmation names each new asset and the original's rename", () => {
    render(fused());
    g.openMacSplitConfirm("a1", [X]);
    expect(modal!.title).toBe("Split this MAC into its own asset?");
    expect(modal!.body).toContain("iPhone-717C43");
    expect(modal!.body).toContain("1 history row");
    expect(modal!.body).toContain("iPhone-F2BC27");
    expect(modal!.footer).toContain("Split 1 MAC");
  });

  it("an operator-named asset keeps its name in the confirmation", () => {
    render(fused({ hostnameOverride: "Dave's phone", hostname: "Dave's phone" }));
    g.openMacSplitConfirm("a1", [X]);
    expect(modal!.body).toContain("keeps its name");
    expect(modal!.body).toContain("Dave's phone-717C43");
  });

  it("takes the base name off an already-suffixed asset", () => {
    expect(g._macSplitBase("iPhone-F2BC27")).toBe("iPhone");
    expect(g._macSplitBase("iPhone-Pro")).toBe("iPhone-Pro");
    expect(g._macSplitSuffix("44:61:32:71:7c:43")).toBe("717C43");
  });
});
