/**
 * tests/unit/ipNetworkFilter.test.ts — the Assets IP Address column's network
 * filter: ipv4TermToMatchPrefixes (src/utils/cidr.ts, what the list endpoint's
 * `in_networks` op matches with), its browser half TableSF.parseIpNetTerm
 * (public/js/table-sf.js), and the ipnet filter's header UI.
 *
 * The two parsers are separate implementations of one grammar, so the parity
 * block below runs every term against a spread of addresses through both and
 * fails when they disagree about which addresses a term selects.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { ipv4TermToMatchPrefixes, ipInCidr } from "../../src/utils/cidr.js";
import { sanitizeFilterState } from "../../src/services/savedFilterService.js";

const g = globalThis as Record<string, any>;

/** What the server-side where fragment selects, evaluated in JS. */
function serverMatches(term: string, ip: string): boolean {
  const m = ipv4TermToMatchPrefixes(term);
  if (!m) throw new Error("invalid term " + term);
  return m.equals.includes(ip) || m.startsWith.some((p) => ip.startsWith(p));
}

describe("ipv4TermToMatchPrefixes", () => {
  it("reads 1-3 octets as a dotted prefix that never matches a longer octet", () => {
    expect(ipv4TermToMatchPrefixes("10")).toEqual({ equals: [], startsWith: ["10."] });
    expect(ipv4TermToMatchPrefixes("10.1")).toEqual({ equals: [], startsWith: ["10.1."] });
    expect(ipv4TermToMatchPrefixes("10.1.2.")).toEqual({ equals: [], startsWith: ["10.1.2."] });
    expect(serverMatches("10.1", "10.1.4.5")).toBe(true);
    expect(serverMatches("10.1", "10.10.4.5")).toBe(false);
  });

  it("reads a full address as exact", () => {
    expect(ipv4TermToMatchPrefixes("10.1.2.3")).toEqual({ equals: ["10.1.2.3"], startsWith: [] });
    expect(serverMatches("10.1.2.3", "10.1.2.30")).toBe(false);
  });

  it("reads an octet-aligned CIDR as one prefix, ignoring host bits", () => {
    expect(ipv4TermToMatchPrefixes("10.1.0.0/16")).toEqual({ equals: [], startsWith: ["10.1."] });
    expect(ipv4TermToMatchPrefixes("10.1.2.99/24")).toEqual({ equals: [], startsWith: ["10.1.2."] });
    expect(ipv4TermToMatchPrefixes("10.1.2.3/32")).toEqual({ equals: ["10.1.2.3"], startsWith: [] });
  });

  it("expands a partial octet into every value it spans", () => {
    const m20 = ipv4TermToMatchPrefixes("10.1.16.0/20")!;
    expect(m20.startsWith).toHaveLength(16);
    expect(m20.startsWith[0]).toBe("10.1.16.");
    expect(m20.startsWith[15]).toBe("10.1.31.");
    const m25 = ipv4TermToMatchPrefixes("192.168.1.128/25")!;
    expect(m25.equals).toHaveLength(128);
    expect(m25.equals[0]).toBe("192.168.1.128");
    expect(m25.startsWith).toEqual([]);
    expect(ipv4TermToMatchPrefixes("0.0.0.0/0")!.startsWith).toHaveLength(256);
  });

  it("rejects anything that is not an IPv4 term", () => {
    for (const bad of ["", "  ", "abc", "10.1.300", "10.1.2.3.4", "10..1", "10.1/16", "10.1.2.0/33",
      "10.1.2.0/", "10.1.2.0/x", "fe80::1", "10.1.2.0/24/1", "-1", "10.%"]) {
      expect(ipv4TermToMatchPrefixes(bad), bad).toBeNull();
    }
  });

  it("selects exactly the addresses ipInCidr puts in the network", () => {
    const ips = ["10.1.15.255", "10.1.16.0", "10.1.23.7", "10.1.31.255", "10.1.32.0", "10.10.16.1"];
    for (const ip of ips) expect(serverMatches("10.1.16.0/20", ip), ip).toBe(ipInCidr(ip, "10.1.16.0/20"));
  });
});

// ─── Browser half ───────────────────────────────────────────────────────────

let win: Window;
let doc: Window["document"];
let changes: number;

function setup(): any {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  doc.body.innerHTML = `
    <table><thead><tr>
      <th data-sf-key="hostname">Hostname</th>
      <th data-sf-key="ipAddress" data-sf-type="ip" data-sf-filter="ipnet">IP Address</th>
    </tr></thead><tbody id="tb"></tbody></table>`;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  changes = 0;
  return new g.TableSF("tb", () => { changes++; });
}

function th(): Element { return doc.querySelector('th[data-sf-key="ipAddress"]')!; }
function inputs(): any[] { return Array.from(th().querySelectorAll(".sf-ipnet-input")); }
function click(el: Element | null): void { (el as any).dispatchEvent(new (win as any).Event("click", { bubbles: true })); }

describe("TableSF.parseIpNetTerm parity with ipv4TermToMatchPrefixes", () => {
  beforeEach(() => { setup(); });

  const TERMS = ["10", "10.", "10.1", "10.1.2", "10.1.2.3", "10.1.0.0/16", "10.1.16.0/20", "10.1.2.128/25",
    "10.1.2.7/31", "172.16.0.0/12", "0.0.0.0/0", "192.168.1.1/32", "010.1"];
  const IPS = ["10.0.0.1", "10.1.0.0", "10.1.2.3", "10.1.2.6", "10.1.2.7", "10.1.2.200", "10.1.17.4",
    "10.1.32.1", "10.10.1.1", "172.15.255.255", "172.16.0.1", "172.31.255.255", "172.32.0.0",
    "192.168.1.1", "8.8.8.8"];

  it("agrees on which terms are valid", () => {
    for (const t of TERMS.concat(["abc", "10.1.300", "10.1/16", "10.1.2.0/33", "fe80::1"])) {
      expect(!!g.TableSF.parseIpNetTerm(t), t).toBe(!!ipv4TermToMatchPrefixes(t));
    }
  });

  it("agrees on which addresses each term selects", () => {
    for (const t of TERMS) {
      const n = g.TableSF.parseIpNetTerm(t);
      for (const ip of IPS) {
        const v = g.TableSF.parseIpNetTerm(ip);
        const browser = (v.base & n.mask) === n.base;
        // "010.1" normalizes differently on the wire (server matches "10.1."),
        // which is the intent — the octet VALUE is what the operator typed.
        expect(browser, t + " ∋ " + ip).toBe(serverMatches(t, ip));
      }
    }
  });
});

describe("ipnet header filter", () => {
  let sf: any;
  beforeEach(() => { sf = setup(); });

  it("renders one box with ▾ and +, not the contains box", () => {
    expect(th().querySelector(".sf-filter-text")).toBeNull();
    expect(inputs()).toHaveLength(1);
    expect(th().querySelector(".sf-ipnet-add")).not.toBeNull();
    const ops = Array.from(th().querySelectorAll(".sf-op-row")).map((r) => r.getAttribute("data-op"));
    expect(ops).toEqual(["in-networks", "empty", "notempty"]);
  });

  it("+ adds a box, × removes it, and every valid box is one any-of term", async () => {
    click(th().querySelector(".sf-ipnet-add"));
    click(th().querySelector(".sf-ipnet-add"));
    expect(inputs()).toHaveLength(3);
    inputs()[0].value = "10.1";
    inputs()[1].value = "172.16.0.0/12";
    inputs()[2].value = "10.1.300";
    inputs()[2].dispatchEvent(new (win as any).Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(sf._filters.ipAddress).toEqual({ op: "in-networks", terms: ["10.1", "172.16.0.0/12"] });
    expect(inputs()[2].classList.contains("sf-filter-invalid")).toBe(true);
    expect(changes).toBe(1);

    click(inputs()[1].closest(".sf-ipnet-row").querySelector(".sf-ipnet-remove"));
    expect(inputs().map((i) => i.value)).toEqual(["10.1", "10.1.300"]);
    expect(sf._filters.ipAddress).toEqual({ op: "in-networks", terms: ["10.1"] });
  });

  it("apply() keeps only rows inside any of the networks", () => {
    sf._filters.ipAddress = { op: "in-networks", terms: ["10.1", "192.168.5.0/24"] };
    const rows = ["10.1.2.3", "10.10.2.3", "192.168.5.9", "192.168.6.1", "", "not-an-ip"].map((ip) => ({ ipAddress: ip }));
    expect(sf.apply(rows).map((r: any) => r.ipAddress)).toEqual(["10.1.2.3", "192.168.5.9"]);
  });

  it("restores saved terms into boxes, and reads a legacy contains string as one term", () => {
    sf._filters = { ipAddress: { op: "in-networks", terms: ["10.1", "10.2.0.0/16"] } };
    sf.restoreFilterUI();
    expect(inputs().map((i) => i.value)).toEqual(["10.1", "10.2.0.0/16"]);

    sf._filters = { ipAddress: "10.4" };
    sf.restoreFilterUI();
    expect(sf._filters.ipAddress).toEqual({ op: "in-networks", terms: ["10.4"] });

    sf._filters = { ipAddress: "!10.4" };
    sf.restoreFilterUI();
    expect(sf._filters.ipAddress).toBeUndefined();
    expect(inputs().map((i) => i.value)).toEqual([""]);
  });

  it("is empty collapses to one read-only box and disables +", () => {
    click(th().querySelector(".sf-ipnet-add"));
    click(th().querySelector('.sf-op-row[data-op="empty"]'));
    expect(sf._filters.ipAddress).toEqual({ op: "empty" });
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].readOnly).toBe(true);
    expect((th().querySelector(".sf-ipnet-add") as any).disabled).toBe(true);
  });
});

describe("saved presets carry the network filter", () => {
  it("sanitizeFilterState accepts in-networks and bounds its terms", () => {
    const s = sanitizeFilterState({ sfFilters: { ipAddress: { op: "in-networks", terms: ["10.1", "10.2.0.0/16"] } } });
    expect(s.sfFilters.ipAddress).toEqual({ op: "in-networks", terms: ["10.1", "10.2.0.0/16"] });
    expect(() => sanitizeFilterState({ sfFilters: { ipAddress: { op: "in-networks", terms: "10.1" } } })).toThrow();
    expect(() => sanitizeFilterState({ sfFilters: { ipAddress: { op: "in-networks", terms: [5] } } })).toThrow();
  });
});
