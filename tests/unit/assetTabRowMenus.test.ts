/**
 * tests/unit/assetTabRowMenus.test.ts — the standard row gestures on the
 * asset slide-over's tables (public/js/assets.js): ARP Table, IPsec Tunnels &
 * peers, Alerts, This Asset's Automations.
 *
 * Each table gets click-selects / click-the-name-opens / double-click-opens /
 * right-click-menu from one `<tr data-row-menu-row>` marker (app.js); what is
 * pinned here is that each table keeps its marker, and the ARP menu builder,
 * which has no DOM test of its own. The IPsec and Alerts menus are pinned in
 * assetIpsecTabDom.test.ts and assetAlertsTabDom.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const LINES = SRC.split(/\r?\n/);

function fnSrc(name: string): string {
  const start = LINES.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = LINES.findIndex((l, i) => i > start && l === "}");
  return LINES.slice(start, end + 1).join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const arpRowMenuItems = new Function(fnSrc("_arpRowMenuItems") + "\nreturn _arpRowMenuItems;")();

describe("ARP table row menu", () => {
  const calls: string[] = [];
  const h = {
    openAsset: (id: string) => calls.push("open " + id),
    copy: (text: string, what: string) => calls.push("copy " + what + " " + text),
  };

  it("a matched entry opens its device — the primary — then offers the copies", () => {
    const items = arpRowMenuItems({ ipAddress: "10.0.0.5", macAddress: "aa:bb", matchedAsset: { id: "D1" } }, h);
    expect(items.map((i: any) => i.label ?? "—")).toEqual(["Open device", "—", "Copy IP address", "Copy MAC address"]);
    expect(items[0].primary).toBe(true);
    items[0].onSelect();
    items[3].onSelect();
    expect(calls.splice(0)).toEqual(["open D1", "copy MAC address aa:bb"]);
  });

  it("an unmatched entry has nothing to open, so no primary", () => {
    const items = arpRowMenuItems({ ipAddress: "10.0.0.6", macAddress: "cc:dd", matchedAsset: null }, h);
    expect(items.map((i: any) => i.label)).toEqual(["Copy IP address", "Copy MAC address"]);
    expect(items.some((i: any) => i.primary)).toBe(false);
  });
});

describe("asset slide-over tables opted into the standard row gestures", () => {
  it.each([
    ["ARP Table", /<tr class="arptable-entry" data-row-menu-row/],
    ["IPsec tunnel rows", /<tr class="ipsec-tunnel" data-row-menu-row>/],
    ["IPsec peer rows", /var rowAttrs = hasMenu \? " data-row-menu-row"/],
    ["Alerts", /'<tr' \+ \(hasMenu \? ' data-row-menu-row' : ''\) \+ '>' \+ sel/],
    ["This Asset's Automations", /'<tr' \+ \(canEdit \? ' data-row-menu-row' : ''\) \+ '><td>' \+ name/],
  ])("%s", (_name, re) => {
    expect(SRC).toMatch(re);
  });

  it("renames the automations table and drops the Alerts tab's bulk bar", () => {
    expect(SRC).toContain("This Asset\\'s Automations");
    expect(SRC).not.toContain("Automations that can trigger for this asset");
    expect(SRC).not.toContain('id="asset-alert-bulkbar"');
  });
});
