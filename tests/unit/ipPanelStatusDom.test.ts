/**
 * tests/unit/ipPanelStatusDom.test.ts — the IP panel's Status column
 * (`_ipStatusPresentation` in public/js/ip-panel.js).
 *
 * This column is the whole reason business rule 77 exists. It used to be a
 * single-winner ladder, so an address that carried more than one fact reported
 * whichever the ladder tested first: an address with a FortiGate VIP and a DHCP
 * lease read "DHCP Lease", an address with a VIP and a pending conflict read
 * "Conflict", and an operator refused a reservation because of a VIP could not
 * find the VIP anywhere in the table. Every case below is one an operator hit
 * or could hit, and none of them throws — they render the wrong sentence, which
 * is exactly what a test has to catch.
 *
 * ip-panel.js is a browser script with no module boundary, so the functions
 * under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetVipRowsDom.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panelLines = readFileSync(resolve(__dirname, "../../public/js/ip-panel.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of ip-panel.js. */
function fnSrc(name: string): string {
  const start = panelLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`ip-panel.js: function ${name} not found`);
  const end = panelLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`ip-panel.js: no end of function ${name}`);
  return panelLines.slice(start, end + 1).join("\n");
}

interface Presentation {
  dotClass: string;
  label: string;
  tooltip: string;
  warn?: boolean;
}
type StatusFn = (r: unknown, ctx?: Record<string, unknown>) => Presentation;

const status: StatusFn = new Function(
  `${fnSrc("_isLeaseBackedInfra")}
   ${fnSrc("_ipPanelTimeAgoVerbose")}
   ${fnSrc("_ipAllocationPresentation")}
   ${fnSrc("_ipStatusPresentation")}
   return _ipStatusPresentation;`,
)() as StatusFn;

/** One reservation as GET /subnets/:id/ips ships it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "r1", status: "active", sourceType: "manual", ...over };
}

/** The stored VIP snapshot discovery writes. */
function vipInfo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "web-dnat",
    device: "JEFFERSON-101F-1",
    extip: "203.0.113.10",
    role: "external",
    isVirtualServer: false,
    ...over,
  };
}

describe("addresses with no VIP keep the labels operators already read", () => {
  it("labels a DHCP lease, a DHCP reservation and a plain claim", () => {
    expect(status(row({ sourceType: "dhcp_lease" })).label).toBe("DHCP Lease");
    expect(status(row({ sourceType: "dhcp_reservation" })).label).toBe("DHCP Reservation");
    expect(status(row()).label).toBe("Active");
  });

  it("still labels an interface address, a DNS placeholder and a lease-backed AP", () => {
    expect(status(row({ sourceType: "interface_ip" })).label).toBe("Interface");
    expect(status(row({ sourceType: "dns_resolved" })).label).toBe("DNS Resolved");
    expect(status(row({ sourceType: "fortinap", dhcpBinding: "lease" })).label).toBe("FortiAP (lease)");
    expect(status(row({ sourceType: "fortiswitch", dhcpBinding: "lease" })).label).toBe("FortiSwitch (lease)");
  });

  it("labels the network and broadcast rows from the address, not the reservation", () => {
    expect(status(null, { isSpecial: true, specialType: "network" }).label).toBe("Network");
    expect(status(null, { isSpecial: true, specialType: "broadcast" }).label).toBe("Broadcast");
  });

  it("says Available when nothing holds the address", () => {
    const p = status(null);
    expect(p.label).toBe("Available");
    expect(p.dotClass).toBe("ip-dot-available");
  });
});

describe("a VIP is reported beside the allocation, not instead of it", () => {
  it("reads VIP / Leased for a VIP address a client is also leasing", () => {
    const p = status(row({ sourceType: "dhcp_lease", vipInfo: vipInfo() }));
    expect(p.label).toBe("VIP / Leased");
  });

  it("reads VIP / Reserved once the operator saves a reservation on it", () => {
    const p = status(row({ sourceType: "manual", vipInfo: vipInfo() }));
    expect(p.label).toBe("VIP / Reserved");
  });

  it("reads VIP / Reserved for a gate-side DHCP reservation at a VIP address", () => {
    expect(status(row({ sourceType: "dhcp_reservation", vipInfo: vipInfo() })).label).toBe("VIP / Reserved");
  });

  it("reads the VIP row's OWN dhcpBinding, which is where the discover pass records it", () => {
    expect(status(row({ sourceType: "vip", vipInfo: vipInfo(), dhcpBinding: "lease" })).label).toBe("VIP / Leased");
    expect(status(row({ sourceType: "vip", vipInfo: vipInfo(), dhcpBinding: "reservation" })).label).toBe("VIP / Reserved");
  });

  it("reads plain VIP when the address carries no allocation at all", () => {
    const p = status(row({ sourceType: "vip", vipInfo: vipInfo() }));
    expect(p.label).toBe("VIP");
    expect(p.dotClass).toBe("ip-dot-device-config");
  });

  it("marks a load-balance virtual server VS, matching the badge", () => {
    const p = status(row({ sourceType: "dhcp_lease", vipInfo: vipInfo({ isVirtualServer: true }) }));
    expect(p.label).toBe("VS / Leased");
  });

  it("names the VIP, its role and its gate in the tooltip", () => {
    const p = status(row({ sourceType: "dhcp_lease", vipInfo: vipInfo({ role: "mapped" }) }));
    expect(p.tooltip).toContain("web-dnat");
    expect(p.tooltip).toContain("mapped");
    expect(p.tooltip).toContain("JEFFERSON-101F-1");
    expect(p.tooltip).toContain("203.0.113.10");
  });
});

describe("the states that need an operator outrank the VIP dot but not its label", () => {
  it("keeps the conflict red and still says there is a VIP", () => {
    const p = status(row({ sourceType: "dhcp_lease", vipInfo: vipInfo(), conflictMessage: "two sources claim this" }));
    expect(p.label).toBe("VIP / Conflict");
    expect(p.dotClass).toBe("ip-dot-conflict");
    expect(p.tooltip).toContain("two sources claim this");
  });

  it("keeps a permanently failed push red and still says there is a VIP", () => {
    const p = status(row({ vipInfo: vipInfo(), pushStatus: "failed_permanent", pushError: "entry exists" }));
    expect(p.label).toBe("VIP / Push failed");
    expect(p.dotClass).toBe("ip-dot-conflict");
  });

  it("reports a queued push, which the panel could not show at all before", () => {
    const p = status(row({ pushStatus: "pending", pushAttempts: 3, pushError: "gate unreachable" }));
    expect(p.label).toBe("Queued for push");
    expect(p.tooltip).toContain("Retry attempts: 3");
    expect(p.tooltip).toContain("gate unreachable");
  });

  it("composes the queued push with a VIP", () => {
    expect(status(row({ vipInfo: vipInfo(), pushStatus: "pending" })).label).toBe("VIP / Queued");
  });
});

describe("the warning triangle marks a state that needs acting on, not a tooltip", () => {
  // The renderer hangs a red ⚠ off `warn`. Before composition it keyed off
  // "does this row have a tooltip at all", which composition would have made
  // true for every healthy VIP address on the page.
  it("does not warn on an address that merely carries a VIP", () => {
    expect(status(row({ sourceType: "manual", vipInfo: vipInfo() })).warn).toBe(false);
    expect(status(row({ sourceType: "dhcp_lease", vipInfo: vipInfo() })).warn).toBe(false);
    expect(status(row({ sourceType: "vip", vipInfo: vipInfo() })).warn).toBe(false);
    expect(status(row({ sourceType: "vip", vipInfo: vipInfo(), dhcpBinding: "lease" })).warn).toBe(false);
  });

  it("warns on a conflict and on a permanently failed push, VIP or not", () => {
    expect(status(row({ conflictMessage: "two sources claim this" })).warn).toBe(true);
    expect(status(row({ vipInfo: vipInfo(), conflictMessage: "two sources claim this" })).warn).toBe(true);
    expect(status(row({ pushStatus: "failed_permanent" })).warn).toBe(true);
    expect(status(row({ vipInfo: vipInfo(), pushStatus: "failed_permanent" })).warn).toBe(true);
  });

  it("does not warn on a queued push — it is in progress, not broken", () => {
    expect(status(row({ pushStatus: "pending" })).warn).toBe(false);
  });

  it("still carries the explanatory tooltip on the rows it does not warn about", () => {
    const p = status(row({ sourceType: "manual", vipInfo: vipInfo() }));
    expect(p.warn).toBe(false);
    expect(p.tooltip).toContain("web-dnat");
  });
});

describe("a VIP on a row that is not active is not reported", () => {
  it("ignores the snapshot on an expired row", () => {
    // A released row is nulled out by the caller before this runs; an expired
    // one still arrives, and its VIP is history rather than a current fact.
    const p = status(row({ status: "expired", vipInfo: vipInfo() }));
    expect(p.label).toBe("Expired");
  });
});
