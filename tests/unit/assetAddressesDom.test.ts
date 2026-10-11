/**
 * tests/unit/assetAddressesDom.test.ts — the asset-details General tab's
 * Primary Address + Addresses rows (public/js/assets.js → ipViewRow /
 * addressesViewHTML), business rule 102.
 *
 * The separate MAC Address / All MACs rows used to show the identity MAC next
 * to an IP from a different card. Now each MAC lists the IPs bound to it, the
 * primary pair is starred, and every other pair offers "Set as primary".
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
  "_assetAddressRows", "primaryAddressMac", "_assetAddressPinnable", "primaryAddressPinHTML",
  "formatAddressSource", "formatMacSource", "_addressIpLineHTML", "_addressGroupHTML", "addressesViewHTML",
  "macDeleteButtonHTML", "macEntryText", "macEntryCount", "macEntriesTotal", "ipViewRow", "ipCellHTML",
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
    [varLine("_ADDRESS_GROUPS_VISIBLE"), varLine("_PIN_STALE_MS"), varLine("_CONF_BAND_LABEL"), ...FNS.map(fnSrc)].join("\n") +
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

describe("Primary Address row", () => {
  it("names the IP and the card it is on — the address row's MAC, not a different card", () => {
    const el = render(g.ipViewRow(hmi({ macAddress: WIFI })));
    expect(el.querySelector(".detail-label")!.textContent).toBe("Primary Address");
    expect(el.textContent).toContain("172.23.25.235");
    expect(el.textContent).toContain("on " + ETH);
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
});

describe("Addresses row", () => {
  it("lists every IP under its MAC and stars only the primary pair", () => {
    const el = render(g.addressesViewHTML(hmi()));
    expect(el.querySelector(".detail-label")!.textContent).toBe("Addresses (2 MACs, 4 IPs)");
    // Spans both columns of the details grid (styles.css → .address-list-row).
    expect(el.querySelector(".detail-row")!.classList.contains("address-list-row")).toBe(true);
    const stars = el.querySelectorAll(".address-primary-badge");
    expect(stars).toHaveLength(1);
    const starredLine = stars[0]!.closest(".address-ip-line")!;
    expect(starredLine.textContent).toContain("172.23.25.235");
    // The Ethernet card (holding the primary) is drawn first, its primary first.
    const codes = [...el.querySelectorAll("code.copy-cell")].map((c) => c.textContent);
    expect(codes[0]).toBe(ETH);
    expect(codes[1]).toBe("172.23.25.235");
    expect(codes.slice(2, 4).sort()).toEqual(["172.23.25.236", "172.23.6.23"]);
    expect(codes[4]).toBe(WIFI);
    expect(el.textContent).toContain("Detected device");
    expect(el.textContent).toContain("wired");
  });

  it("offers Set as primary on every non-primary pair, carrying its MAC and IP", () => {
    const el = render(g.addressesViewHTML(hmi()));
    const btns = [...el.querySelectorAll(".primary-address-set")];
    expect(btns).toHaveLength(3);
    const secondary = btns.find((b) => b.getAttribute("data-ip") === "172.23.25.236")!;
    expect(secondary.getAttribute("data-mac")).toBe(ETH);
  });

  it("offers no pin on Fortinet infrastructure, or to a read-only viewer", () => {
    const infra = render(g.addressesViewHTML(hmi({ assetType: "switch", fortinetTopology: { role: "fortiswitch" } })));
    expect(infra.querySelector(".primary-address-set")).toBeNull();
    canManage = false;
    try {
      expect(render(g.addressesViewHTML(hmi())).querySelector(".primary-address-set")).toBeNull();
    } finally { canManage = true; }
  });

  it("collapses port-range MACs into one line that is never a primary candidate", () => {
    const el = render(g.addressesViewHTML(hmi()));
    expect(el.textContent).toContain("48 port MACs");
    expect(el.textContent).toContain("Port MAC ranges");
  });

  it("keeps a MAC with no address visible, and an address with no MAC", () => {
    const el = render(g.addressesViewHTML(hmi({
      associatedIps: [{ ip: "10.0.0.9", source: "manual", lastSeen: now }],
    })));
    expect(el.textContent).toContain("no address reported");
    expect(el.textContent).toContain("No MAC");
    expect(el.textContent).toContain("10.0.0.9");
  });

  it("renders nothing for an asset with no MACs and no addresses", () => {
    expect(g.addressesViewHTML({ id: "x", macAddresses: [], associatedIps: [] })).toBe("");
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

  it("puts a banded chip beside each scored address, with the breakdown in its hover", () => {
    const el = render(g.addressesViewHTML(hmi({ addressConfidence: detail })));
    const chips = [...el.querySelectorAll(".addr-conf")];
    expect(chips.map((c) => c.textContent)).toEqual(expect.arrayContaining(["99", "21"]));
    const high = chips.find((c) => c.textContent === "99")!;
    expect(high.classList.contains("addr-conf-high")).toBe(true);
    const tip = high.closest(".addr-conf-trigger")!.querySelector(".mac-tooltip")!;
    expect(tip.textContent).toContain("Confidence 99 (high)");
    expect(tip.textContent).toContain("Polled OK as primary");
    expect(tip.textContent).toContain("3 d 4 h");
    const low = chips.find((c) => c.textContent === "21")!;
    expect(low.closest(".addr-conf-trigger")!.textContent).toContain("sees it online at 172.23.25.235");
  });

  it("the Primary Address row carries the primary's chip", () => {
    const el = render(g.ipViewRow(hmi({ addressConfidence: detail })));
    expect(el.querySelector(".addr-conf")!.textContent).toBe("99");
  });

  it("the list cell shows plain chips titled with the score (no nested hover)", () => {
    const el = render(g.ipCellHTML(hmi({ addressConfidence: { "172.23.25.235": { score: 99, band: "high" }, "172.23.6.23": { score: 70, band: "medium" } } })));
    const chips = [...el.querySelectorAll(".addr-conf")];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(el.querySelector(".addr-conf-trigger")).toBeNull();
    expect(chips[0]!.getAttribute("title")).toBe("Confidence 99 (high)");
  });

  it("an address with no score gets no chip", () => {
    const el = render(g.addressesViewHTML(hmi({ addressConfidence: {} })));
    expect(el.querySelector(".addr-conf")).toBeNull();
  });
});
