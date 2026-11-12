/**
 * tests/unit/archivedNetworksInTable.test.ts — archived networks in the
 * Networks table (public/js/subnets.js), business rules 41 and 158(d).
 *
 * An archived network is a decommissioned network that no longer holds its
 * range. It is listed beside the deprecated networks, and ONLY there:
 *
 *  - it joins the table while the Status filter is showing deprecated
 *    networks, never the unfiltered list, where it would sit beside the live
 *    network that replaced it on the same CIDR;
 *  - it carries `status: "deprecated"`, so the Status filter itself selects
 *    it, and an "archived" pill saying when and why;
 *  - its row is read-only: no favourite star, no utilization.
 *
 * subnets.js is a browser script with no module boundary, so the functions
 * are sliced out by name and eval'd (the exclusionsDialogDom.test.ts approach).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/subnets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`subnets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const ARCHIVED = {
  id: "a1", name: "DHCP: users (gate-old)", cidr: "10.4.0.0/24", purpose: null, vlan: 40, status: "available",
  tags: ["site-a"], blockName: "Site A", blockCidr: "10.4.0.0/16", integrationName: "FMG", fortigateDevice: "gate-old",
  createdBy: null, archivedAt: "2026-10-01T12:00:00.000Z", archivedBy: null, archiveReason: "chassis-replaced",
  _count: { reservations: 7 },
};

function load(filter: unknown) {
  g._subnetsData = [{ id: "s1", status: "available" }, { id: "s2", status: "deprecated" }];
  g._subnetsSF = filter === "none" ? null : { getPrefs: () => ({ sfFilters: filter === undefined ? {} : { status: filter } }) };
  (0, eval)([
    fnSrc("archivedSubnetRow"), fnSrc("archiveReasonText"), fnSrc("_statusFilterShowsDeprecated"), fnSrc("_subnetTableRows"),
  ].join("\n"));
  g._archivedSubnets = [g.archivedSubnetRow(ARCHIVED)];
}

describe("archived networks in the Networks table", () => {
  it("shapes an archive entry as a deprecated, read-only table row", () => {
    load(undefined);
    const row = g._archivedSubnets[0];
    expect(row).toMatchObject({
      id: "archived:a1", _archived: true, _archiveId: "a1", status: "deprecated", cidr: "10.4.0.0/24",
      block: { name: "Site A" }, _integration: "FMG", integration: { name: "FMG" }, fortigateDevice: "gate-old",
      _count: { reservations: 7 }, archiveReason: "chassis-replaced",
    });
    expect(g.archivedSubnetRow({ ...ARCHIVED, integrationName: null, _count: undefined })).toMatchObject({
      integration: null, _integration: "Manual", _count: { reservations: 0 },
    });
  });

  it("stays out of the unfiltered list", () => {
    load(undefined);
    expect(g._subnetTableRows().map((r: any) => r.id)).toEqual(["s1", "s2"]);
    load("none");
    expect(g._subnetTableRows().map((r: any) => r.id)).toEqual(["s1", "s2"]);
  });

  it("joins the list while the Status filter shows deprecated networks", () => {
    load(["deprecated"]);
    expect(g._subnetTableRows().map((r: any) => r.id)).toEqual(["s1", "s2", "archived:a1"]);
    load(["reserved", "Deprecated"]);
    expect(g._subnetTableRows().map((r: any) => r.id)).toContain("archived:a1");
  });

  it("stays out when the Status filter shows only other statuses, or is not a tick list", () => {
    load(["available", "reserved"]);
    expect(g._subnetTableRows().map((r: any) => r.id)).toEqual(["s1", "s2"]);
    load({ op: "not-contains", q: "deprecated" });
    expect(g._subnetTableRows().map((r: any) => r.id)).toEqual(["s1", "s2"]);
  });

  it("says why in plain words", () => {
    load(undefined);
    expect(g.archiveReasonText("chassis-replaced")).toBe("its FortiGate was replaced");
    expect(g.archiveReasonText("operator")).toBe("retired by an operator");
  });

  it("the row renderer branches on _archived: an archived pill, no star, no utilization bar", () => {
    const src = fnSrc("renderSubnetsPage");
    const branch = src.slice(src.indexOf("if (s._archived) {"), src.indexOf('starCellHTML("subnets", s.id)'));
    expect(branch).toContain('<td class="fav-col"></td>');
    expect(branch).toContain(">archived</span>");
    expect(branch).not.toContain("subnetUtilCellHTML");
    expect(branch).not.toContain("starCellHTML");
  });
});
