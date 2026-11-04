/**
 * tests/unit/integrationFortigateRosterService.test.ts
 *
 * The Query API window's FortiGate picker lists an integration's discovered
 * gates by FortiManager device name — the name its queries take — one entry
 * per HA cluster.
 */
import { describe, it, expect } from "vitest";
import { fortigateRosterFromAssets } from "../../src/services/integrationFortigateRosterService.js";

const row = (over: Record<string, unknown>) => ({
  hostname: null, ipAddress: null, serialNumber: null, status: "active", fortinetTopology: null, ...over,
}) as any;

describe("fortigateRosterFromAssets", () => {
  it("names a gate by its FortiManager device name and keeps a differing hostname beside it", () => {
    const out = fortigateRosterFromAssets([
      row({ hostname: "gate-a.example", ipAddress: "10.0.0.1", serialNumber: "FGT1", fortinetTopology: { role: "fortigate", deviceName: "SITE-A-61F" } }),
    ]);
    expect(out).toEqual([{ deviceName: "SITE-A-61F", hostname: "gate-a.example", ipAddress: "10.0.0.1", serialNumber: "FGT1", status: "active" }]);
  });

  it("omits the hostname when it is the device name", () => {
    const [g] = fortigateRosterFromAssets([row({ hostname: "SITE-B", fortinetTopology: { deviceName: "SITE-B" } })]);
    expect(g.hostname).toBeNull();
  });

  it("falls back to the hostname when no device name was stamped", () => {
    const [g] = fortigateRosterFromAssets([row({ hostname: "LEGACY-GATE" })]);
    expect(g.deviceName).toBe("LEGACY-GATE");
  });

  it("lists an HA pair once, described by the primary", () => {
    const out = fortigateRosterFromAssets([
      row({ hostname: "hq-b", serialNumber: "S2", fortinetTopology: { deviceName: "HQ-CLUSTER", haRole: "secondary" } }),
      row({ hostname: "hq-a", serialNumber: "S1", ipAddress: "10.1.1.1", fortinetTopology: { deviceName: "HQ-CLUSTER", haRole: "primary" } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ deviceName: "HQ-CLUSTER", hostname: "hq-a", serialNumber: "S1", ipAddress: "10.1.1.1" });
  });

  it("keeps a lone standby when the primary is missing", () => {
    const out = fortigateRosterFromAssets([row({ hostname: "hq-b", fortinetTopology: { deviceName: "HQ", haRole: "secondary" } })]);
    expect(out.map((g) => g.hostname)).toEqual(["hq-b"]);
  });

  it("skips a row with no name at all, and sorts naturally ignoring case", () => {
    const out = fortigateRosterFromAssets([
      row({ fortinetTopology: { deviceName: "site-10" } }),
      row({ fortinetTopology: {} }),
      row({ fortinetTopology: { deviceName: "Site-2" } }),
    ]);
    expect(out.map((g) => g.deviceName)).toEqual(["Site-2", "site-10"]);
  });
});
