/**
 * tests/unit/assetAddressesDom.test.ts — the asset-details General tab's
 * Address row (public/js/assets.js → ipViewRow / addressPillsHTML), business
 * rule 102.
 *
 * The row shows only the primary IP; every IP and MAC the asset carries sits
 * behind the "N IPs" / "N MACs" hover pills under it, click-to-copy. The IPs
 * hover stars the primary pair and offers "Set as primary" on every other;
 * the MACs hover keeps the remove x.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

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
  "_assetAddressRows", "_addressMacKey", "primaryAddressMac", "_assetAddressPinnable", "primaryAddressPinHTML",
  "formatAddressSource", "formatMacSource", "_addressTooltipRowHTML", "_macTooltipRowHTML", "_addressPillHTML", "addressPillsHTML",
  "macDeleteButtonHTML", "macEntryText", "macEntryCount", "macEntriesTotal", "ipViewRow", "ipCellHTML",
  "_addressRowHTML", "_ipv6LineHTML",
  "_confAge", "_confHours", "_addressConfidence", "_confidenceBreakdownHTML", "addressConfidenceChipHTML",
];

let canManage = true;
beforeAll(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatDate = (s: any) => String(s).slice(0, 10);
  g.canManageAssets = () => canManage;
  g.assetHaInfo = () => null;
  // eslint-disable-next-line no-eval
  (0, eval)(
    [varLine("_MAC_ROW_IPS_VISIBLE"), varLine("_ADDRESS_PRIMARY_BADGE"), varLine("_ADDRESS_PRIMARY_IPV6_BADGE"), varLine("_PIN_STALE_MS"), varLine("_CONF_BAND_LABEL"), ...FNS.map(fnSrc)].join("\n") +
      "\n" + FNS.map((n) => `globalThis.${n} = ${n};`).join("\n"),
  );
});

const ETH = "84:8B:CD:4C:45:40";
const WIFI = "B8:F7:75:25:F5:95";
const now = new Date().toISOString();
const old = new Date(Date.now() - 3 * 86_400_000).toISOString();

function hmi(over: Record<string, any> = {}) {
  return {
    id: "a1", assetType: "workstation", ipAddress: "172.23.25.235", ipSource: "ARCHMAT-101F-1", macAddress: ETH,
    macAddresses: [
      { mac: ETH, source: "intune-ethernet", lastSeen: now },
      { mac: WIFI, source: "intune-wifi", lastSeen: now },
      { mac: "DD:EE:FF:00:00:00", macEnd: "DD:EE:FF:00:00:2F", source: "monitor-interface", lastSeen: now },
    ],
    associatedIps: [
      { ip: "172.23.25.235", mac: ETH, source: "device-inventory", device: "ARCHMAT-101F-1", medium: "wired", lastSeen: now },
      { ip: "172.23.6.23", mac: ETH, source: "dhcp-lease", device: "ARCHMAT-101F-1", lastSeen: now },
      { ip: "172.23.25.236", mac: ETH, source: "arp", device: "ARCHMAT-101F-1", lastSeen: now },
      { ip: "172.23.6.40", mac: WIFI, source: "dhcp-lease", device: "ARCHMAT-101F-1", medium: "wireless", lastSeen: now },
    ],
    ...over,
  };
}

function render(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

function pill(el: HTMLElement, label: RegExp): HTMLElement {
  const trigger = [...el.querySelectorAll(".address-pills > .mac-hover-trigger")]
    .find((t) => label.test(t.querySelector(".mac-badge-count")!.textContent || ""));
  if (!trigger) throw new Error("no pill matching " + label);
  return trigger as HTMLElement;
}
const tipRows = (t: HTMLElement) => [...t.querySelectorAll(".mac-tooltip-row")] as HTMLElement[];
const firstMono = (r: HTMLElement) => r.querySelector(".mono")!.textContent;

describe("Address row", () => {
  it("is labelled Address and shows only the primary IP, the rest behind pills", () => {
    const el = render(g.ipViewRow(hmi({ macAddress: WIFI })));
    expect(el.querySelector(".detail-label")!.textContent).toBe("Address");
    const value = el.querySelector(".detail-value")!;
    // Outside the hovers, the only address drawn is the primary.
    const visible = [...value.querySelectorAll(".copy-cell")].filter((c) => !c.closest(".mac-tooltip"));
    expect(visible.map((c) => c.textContent)).toEqual(["172.23.25.235"]);
    expect(value.querySelector(".address-pills")).not.toBeNull();
    // The old "on <MAC>" sub-line is gone; the MAC lives in the hovers.
    value.querySelectorAll(".mac-tooltip").forEach((t) => t.remove());
    expect(value.textContent).not.toContain(ETH);
  });

  it("marks a pin, offers Unpin to an assets writer, and warns when the pinned address went quiet", () => {
    const a = hmi({
      ipAddress: "172.23.6.23", ipSource: "pinned", primaryAddressMac: ETH, primaryAddressIp: "172.23.6.23",
      primaryAddressPinnedBy: "dmoore",
    });
    a.associatedIps[1].lastSeen = old;
    const el = render(g.ipViewRow(a));
    expect(el.textContent).toContain("pinned");
    expect(el.textContent).toContain("not seen since");
    expect(el.querySelector(".primary-address-unpin")).not.toBeNull();
    expect(el.textContent).not.toContain("pinned pinned"); // the "pinned" source label is not repeated
  });

  it("no Unpin for a read-only viewer", () => {
    canManage = false;
    try {
      const el = render(g.ipViewRow(hmi({ primaryAddressMac: ETH, primaryAddressIp: "172.23.25.235" })));
      expect(el.querySelector(".primary-address-unpin")).toBeNull();
    } finally { canManage = true; }
  });

  it("still carries the MAC pill when the asset has no IP at all", () => {
    const el = render(g.ipViewRow(hmi({ ipAddress: null, associatedIps: [] })));
    expect(el.querySelector(".detail-label")!.textContent).toBe("Address");
    expect(pill(el, /^2 MACs$/)).toBeTruthy();
  });
});

describe("Address row with IPv6 on (business rule 128)", () => {
  const withV6 = (fn: () => void) => {
    g.polarisIpv6Enabled = true;
    try { fn(); } finally { g.polarisIpv6Enabled = false; }
  };

  it("is one unlabelled IPv4 line while IPv6 is off", () => {
    const el = render(g.ipViewRow(hmi({ ipv6Address: "2001:db8::5" })));
    expect(el.querySelector(".address-family-line")).toBeNull();
    expect(el.textContent).not.toContain("2001:db8::5");
  });

  it("labels an IPv4 line and an IPv6 line, the IPv6 marked auto", () => withV6(() => {
    const el = render(g.ipViewRow(hmi({ ipv6Address: "2001:db8::5" })));
    const lines = [...el.querySelectorAll(".address-family-line")] as HTMLElement[];
    expect(lines.map((l) => l.querySelector(".address-family-tag")!.textContent)).toEqual(["IPv4", "IPv6"]);
    expect(lines[0].textContent).toContain("172.23.25.235");
    expect(lines[1].textContent).toContain("2001:db8::5");
    expect(lines[1].textContent).toContain("auto");
    expect(lines[1].textContent).not.toContain("monitored");
  }));

  it("a pinned IPv6 offers Unpin to an assets writer only", () => withV6(() => {
    const a = hmi({ ipv6Address: "2001:db8::5", ipv6Pinned: true, ipv6PinnedBy: "dmoore" });
    expect(render(g.ipViewRow(a)).querySelector(".primary-ipv6-unpin")).not.toBeNull();
    canManage = false;
    try { expect(render(g.ipViewRow(a)).querySelector(".primary-ipv6-unpin")).toBeNull(); } finally { canManage = true; }
  }));

  it("says monitored when the asset has no IPv4 and the server can reach IPv6", () => withV6(() => {
    g.polarisIpv6Dialable = true;
    try {
      const el = render(g.ipViewRow(hmi({ ipAddress: null, associatedIps: [], ipv6Address: "2001:db8::5" })));
      expect(el.textContent).toContain("monitored");
    } finally { g.polarisIpv6Dialable = false; }
  }));

  it("says not polled when the server cannot reach IPv6", () => withV6(() => {
    const el = render(g.ipViewRow(hmi({ ipAddress: null, associatedIps: [], ipv6Address: "2001:db8::5" })));
    expect(el.textContent).toContain("not polled");
    expect(el.textContent).not.toContain("monitored");
  }));
});

describe("Address pills", () => {
  it("counts every IP and MAC, plus the port-range MACs", () => {
    const el = render(g.addressPillsHTML(hmi()));
    const labels = [...el.querySelectorAll(".address-pills > .mac-hover-trigger > .mac-badge-count")].map((b) => b.textContent);
    expect(labels).toEqual(["4 IPs", "2 MACs", "48 port MACs"]);
    expect(pill(el, /port MACs/).textContent).toContain("Port MAC ranges");
  });

  it("the IPs hover lists every address, primary first and starred, each IP and MAC click-to-copy", () => {
    const rows = tipRows(pill(render(g.addressPillsHTML(hmi())), /IPs$/));
    expect(rows.map(firstMono).slice(0, 1)).toEqual(["172.23.25.235"]);
    expect(rows.map(firstMono).sort()).toEqual(["172.23.25.235", "172.23.25.236", "172.23.6.23", "172.23.6.40"].sort());
    expect(rows.filter((r) => r.querySelector(".address-primary-badge"))).toEqual([rows[0]]);
    for (const r of rows) {
      const copies = [...r.querySelectorAll(".copy-cell")].map((c) => c.getAttribute("data-copy"));
      expect(copies[0]).toBe(firstMono(r));
      expect([ETH, WIFI]).toContain(copies[1]);
    }
    expect(rows[0]!.textContent).toContain("Detected device");
    expect(rows[0]!.textContent).toContain("wired");
  });

  it("offers Set as primary on every non-primary pair, carrying its MAC and IP", () => {
    const el = render(g.addressPillsHTML(hmi()));
    const btns = [...el.querySelectorAll(".primary-address-set")];
    expect(btns).toHaveLength(3);
    const secondary = btns.find((b) => b.getAttribute("data-ip") === "172.23.25.236")!;
    expect(secondary.getAttribute("data-mac")).toBe(ETH);
  });

  it("offers no pin on Fortinet infrastructure, or to a read-only viewer", () => {
    const infra = render(g.addressPillsHTML(hmi({ assetType: "switch", fortinetTopology: { role: "fortiswitch" } })));
    expect(infra.querySelector(".primary-address-set")).toBeNull();
    canManage = false;
    try {
      expect(render(g.addressPillsHTML(hmi())).querySelector(".primary-address-set")).toBeNull();
    } finally { canManage = true; }
  });

  it("stars the pinned pair, not the same IP on another card", () => {
    const rows = tipRows(pill(render(g.addressPillsHTML(hmi({
      ipAddress: "10.0.0.5", primaryAddressMac: WIFI, primaryAddressIp: "10.0.0.5",
      associatedIps: [
        { ip: "10.0.0.5", mac: ETH, source: "arp", lastSeen: now },
        { ip: "10.0.0.5", mac: WIFI, source: "dhcp-lease", lastSeen: old },
      ],
    }))), /IPs$/));
    const starred = rows.filter((r) => r.querySelector(".address-primary-badge"));
    expect(starred).toHaveLength(1);
    expect(starred[0]!.textContent).toContain(WIFI);
  });

  it("the MACs hover lists each card with its IPs (copyable), the primary card starred and first, removable", () => {
    const rows = tipRows(pill(render(g.addressPillsHTML(hmi())), /MACs$/));
    expect(rows.map(firstMono)).toEqual([ETH, WIFI]);
    expect(rows[0]!.querySelector(".address-primary-badge")).not.toBeNull();
    expect(rows[1]!.querySelector(".address-primary-badge")).toBeNull();
    const ethIps = [...rows[0]!.querySelectorAll(".mac-tooltip-source .copy-cell")].map((c) => c.getAttribute("data-copy"));
    expect(ethIps.sort()).toEqual(["172.23.25.235", "172.23.25.236", "172.23.6.23"].sort());
    expect(rows[0]!.querySelector(".mac-tooltip-delete")).not.toBeNull();
  });

  it("names a card's first three IPs and counts the rest", () => {
    const ips = Array.from({ length: 6 }, (_, i) => ({ ip: "10.1." + i + ".1", mac: ETH, source: "monitor-system-info", lastSeen: now }));
    const el = render(g.addressPillsHTML(hmi({ ipAddress: "10.1.0.1", associatedIps: ips })));
    const eth = tipRows(pill(el, /MACs$/))[0]!;
    expect(eth.querySelectorAll(".mac-tooltip-source .copy-cell")).toHaveLength(3);
    expect(eth.textContent).toContain("+3 more");
    // The IPs hover has every one.
    expect(tipRows(pill(el, /IPs$/))).toHaveLength(6);
  });

  it("keeps a MAC with no address, and an address with no MAC", () => {
    const el = render(g.addressPillsHTML(hmi({ associatedIps: [{ ip: "10.0.0.9", source: "manual", lastSeen: now }] })));
    const macRows = tipRows(pill(el, /MACs$/));
    expect(macRows.map(firstMono).sort()).toEqual([ETH, WIFI].sort());
    expect(macRows[0]!.textContent).toContain("no address");
    expect(macRows[0]!.querySelector(".mac-tooltip-delete")).not.toBeNull();
    const ipRows = tipRows(pill(el, /IP$/));
    expect(ipRows.map(firstMono)).toEqual(["10.0.0.9"]);
    expect(ipRows[0]!.textContent).toContain("no MAC");
  });

  it("groups an interface row under its MAC whatever the MAC's case or separator", () => {
    const el = render(g.addressPillsHTML(hmi({
      associatedIps: [
        { ip: "172.23.25.235", mac: ETH, source: "device-inventory", lastSeen: now },
        { ip: "169.254.1.7", mac: ETH.toLowerCase().replace(/:/g, "-"), source: "monitor-system-info", interfaceName: "Ethernet", lastSeen: now },
      ],
    })));
    const rows = tipRows(pill(el, /MACs$/));
    expect(rows.map(firstMono)).toEqual([ETH, WIFI]);
    expect(rows[0]!.textContent).toContain("169.254.1.7");
    expect(el.textContent).not.toContain("Not on MAC list");
  });

  it("labels a MAC only address rows carry, which has no remove button", () => {
    const LOOSE = "00:11:22:33:44:55";
    const el = render(g.addressPillsHTML(hmi({
      associatedIps: [{ ip: "10.9.9.9", mac: LOOSE, source: "monitor-system-info", interfaceName: "port9", lastSeen: now }],
    })));
    const row = tipRows(pill(el, /MACs$/)).find((r) => firstMono(r) === LOOSE)!;
    expect(row.textContent).toContain("Not on MAC list");
    expect(row.querySelector(".mac-tooltip-delete")).toBeNull();
  });

  it("draws no IPs pill when no address is reported", () => {
    const el = render(g.addressPillsHTML(hmi({ associatedIps: [] })));
    expect(() => pill(el, /IPs?$/)).toThrow();
    expect(pill(el, /^2 MACs$/)).toBeTruthy();
  });

  it("renders nothing for an asset with no MACs and no addresses", () => {
    expect(g.addressPillsHTML({ id: "x", macAddresses: [], associatedIps: [] })).toBe("");
  });
});

describe("address confidence chips (business rule 103)", () => {
  const detail = {
    "172.23.25.235": {
      score: 99, evidenceScore: 99, band: "high", evidenceBand: "high",
      parts: [
        { kind: "polling", label: "Polled OK as primary", device: null, seenAt: null, hours: 76, value: 0.91 },
        { kind: "detected-online", label: "Detected online", device: "ARCHMAT-101F-1", seenAt: now, hours: null, value: 0.9 },
      ],
      penalties: [],
    },
    "172.23.6.23": {
      score: 21, evidenceScore: 21, band: "low", evidenceBand: "low",
      parts: [{ kind: "lease-held", label: "DHCP lease held", device: "ARCHMAT-101F-1", seenAt: now, hours: null, value: 0.7 }],
      penalties: [{ kind: "alive-elsewhere", factor: 0.3, detail: "Down here, but ARCHMAT-101F-1 sees it online at 172.23.25.235" }],
    },
  };

  it("the Address row carries the primary's chip, with the breakdown in its hover", () => {
    const el = render(g.ipViewRow(hmi({ addressConfidence: detail })));
    const high = el.querySelector(".addr-conf")!;
    expect(high.textContent).toBe("99");
    expect(high.classList.contains("addr-conf-high")).toBe(true);
    const tip = high.closest(".addr-conf-trigger")!.querySelector(".mac-tooltip")!;
    expect(tip.textContent).toContain("Confidence 99 (high)");
    expect(tip.textContent).toContain("Polled OK as primary");
    expect(tip.textContent).toContain("3 d 4 h");
  });

  it("the IPs hover shows a plain chip beside each scored address (hovers can't nest)", () => {
    const el = render(g.addressPillsHTML(hmi({ addressConfidence: detail })));
    const chips = [...el.querySelectorAll(".addr-conf")];
    expect(chips.map((c) => c.textContent)).toEqual(expect.arrayContaining(["99", "21"]));
    expect(el.querySelector(".addr-conf-trigger")).toBeNull();
    const low = chips.find((c) => c.textContent === "21")!;
    expect(low.getAttribute("title")).toBe("Confidence 21 (low)");
  });

  it("the list cell shows plain chips titled with the score (no nested hover)", () => {
    const el = render(g.ipCellHTML(hmi({ addressConfidence: { "172.23.25.235": { score: 99, band: "high" }, "172.23.6.23": { score: 70, band: "medium" } } })));
    const chips = [...el.querySelectorAll(".addr-conf")];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(el.querySelector(".addr-conf-trigger")).toBeNull();
    expect(chips[0]!.getAttribute("title")).toBe("Confidence 99 (high)");
  });

  it("an address with no score gets no chip", () => {
    const el = render(g.addressPillsHTML(hmi({ addressConfidence: {} })));
    expect(el.querySelector(".addr-conf")).toBeNull();
  });
});
