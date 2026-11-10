import { describe, it, expect } from "vitest";
import { extractRosterIdentities } from "../../src/services/fortimanagerService.js";
import { haStandbyOfUnreadCluster } from "../../src/services/discovery/dhcp/staleFirewalls.js";

// Both functions guard the Phase 2a stale-firewall sweep against decommissioning
// an HA standby that is still perfectly configured. A standby has no identity
// outside its cluster's HA roster — no top-level FMG device name, no management
// IP of its own — so where that identity is sourced from decides whether the
// box survives a cycle in which its cluster happened not to answer.

describe("extractRosterIdentities", () => {
  it("captures the top-level name and serial of a standalone device", () => {
    const r = extractRosterIdentities([{ name: "SITE-FW", hostname: "site-fw", sn: "FGT60FTK20012345" }]);
    expect(r.names).toEqual(["SITE-FW"]);
    expect(r.serials).toEqual(["FGT60FTK20012345"]);
  });

  it("falls back to hostname when the device carries no name", () => {
    const r = extractRosterIdentities([{ hostname: "site-fw", sn: "FGT60FTK20012345" }]);
    expect(r.names).toEqual(["site-fw"]);
  });

  it("captures every ha_slave member — the standby's only identity", () => {
    const r = extractRosterIdentities([
      {
        name: "SITE-CLUSTER",
        sn: "FGT60FTK20000001",
        ha_slave: [
          { name: "SITE-FW-A", sn: "FGT60FTK20000001", idx: 0 },
          { name: "SITE-FW-B", sn: "FGT60FTK20000002", idx: 1 },
        ],
      },
    ]);
    expect(r.names).toContain("SITE-FW-B");
    expect(r.serials).toContain("FGT60FTK20000002");
  });

  it("captures HA members regardless of ha_mode — this asks 'known', not 'clustered'", () => {
    const r = extractRosterIdentities([
      { name: "C", sn: "S1", ha_mode: "standalone", ha_slave: [{ name: "B", sn: "S2" }] },
    ]);
    expect(r.serials).toContain("S2");
  });

  it("is unaffected by conn_status — an offline cluster is still configured", () => {
    const r = extractRosterIdentities([
      { name: "C", sn: "S1", conn_status: 0, ha_slave: [{ name: "B", sn: "S2" }] },
    ]);
    expect(r.serials).toEqual(expect.arrayContaining(["S1", "S2"]));
  });

  it("skips empty and non-string identities rather than emitting blanks", () => {
    const r = extractRosterIdentities([
      { name: "", hostname: "", sn: "", ha_slave: [{ name: 7, sn: null }] },
      null,
      { name: "OK", sn: "S9" },
    ] as any[]);
    expect(r.names).toEqual(["OK"]);
    expect(r.serials).toEqual(["S9"]);
  });

  it("tolerates a missing / non-array payload", () => {
    expect(extractRosterIdentities(undefined as any)).toEqual({ names: [], serials: [] });
    expect(extractRosterIdentities([{ name: "A", sn: "S1", ha_slave: "nope" }] as any[]).serials).toEqual(["S1"]);
  });
});

describe("haStandbyOfUnreadCluster", () => {
  const known = (...s: string[]) => new Set(s.map((x) => x.toUpperCase()));

  const standby = { role: "fortigate", haRole: "secondary", haPeerSerial: "FGT-PRIMARY-1" };

  it("protects a standby whose cluster is configured but published no roster", () => {
    expect(haStandbyOfUnreadCluster(standby, known("FGT-PRIMARY-1"), known())).toBe(true);
  });

  it("judges a standby whose cluster DID publish a roster it wasn't in", () => {
    expect(haStandbyOfUnreadCluster(standby, known("FGT-PRIMARY-1"), known("FGT-PRIMARY-1"))).toBe(false);
  });

  it("judges a standby whose whole cluster left the upstream", () => {
    expect(haStandbyOfUnreadCluster(standby, known("SOME-OTHER-FW"), known())).toBe(false);
  });

  it("never protects a primary — it has a roster identity of its own", () => {
    const primary = { role: "fortigate", haRole: "primary", haPeerSerial: "FGT-PRIMARY-1" };
    expect(haStandbyOfUnreadCluster(primary, known("FGT-PRIMARY-1"), known())).toBe(false);
  });

  it("never protects a standalone gate or an unstamped row", () => {
    expect(haStandbyOfUnreadCluster({ role: "fortigate" }, known("X"), known())).toBe(false);
    expect(haStandbyOfUnreadCluster(null, known("X"), known())).toBe(false);
    expect(haStandbyOfUnreadCluster(undefined, known("X"), known())).toBe(false);
  });

  it("never protects a standby with no recorded peer — nothing to vouch for it", () => {
    expect(haStandbyOfUnreadCluster({ haRole: "secondary" }, known("FGT-PRIMARY-1"), known())).toBe(false);
    expect(haStandbyOfUnreadCluster({ haRole: "secondary", haPeerSerial: "" }, known(""), known())).toBe(false);
  });

  it("matches the peer serial case-insensitively", () => {
    const lower = { haRole: "secondary", haPeerSerial: "fgt-primary-1" };
    expect(haStandbyOfUnreadCluster(lower, known("FGT-PRIMARY-1"), known())).toBe(true);
    expect(haStandbyOfUnreadCluster(lower, known("FGT-PRIMARY-1"), known("FGT-PRIMARY-1"))).toBe(false);
  });
});
