/**
 * tests/unit/defaultPollingProxyAware.test.ts
 *
 * Source-default polling per (source, stream), now aware of whether a FortiOS
 * REST call is possible at all.
 *
 * The condition is NOT "proxy mode". It is "FortiManager on the proxy transport
 * with no FortiGate API token" — the one pairing where `rest_api` cannot
 * succeed, because every FortiOS collector goes through buildFortinetConfig(),
 * which has no useProxy branch and requires that token. A proxy-mode
 * integration WITH a token is a legitimate configuration (discovery and writes
 * ride FMG, monitoring reaches the gates directly) and keeps the normal REST
 * defaults.
 *
 * The critical assertions here are the NEGATIVE ones: bypass mode, standalone
 * FortiGate, and every non-Fortinet source must be byte-identical to the
 * pre-change behaviour, because a source default silently repoints every asset
 * that never had an explicit method set.
 */

import { describe, it, expect } from "vitest";
import { defaultPollingForSource } from "../../src/services/monitoring/monitorSettings.js";
import type { Stream } from "../../src/utils/pollingCompatibility.js";

const SIX: Stream[] = ["responseTime", "cpuMemory", "temperature", "interfaces", "lldp", "storage"];

// The pre-change table, asserted literally. If a future edit to the
// REST-unavailable branch leaks into the normal path, this fails.
const FORTINET_DEFAULTS: Record<string, string> = {
  responseTime: "icmp",
  cpuMemory: "rest_api",
  temperature: "rest_api",
  interfaces: "rest_api",
  lldp: "disabled",
  storage: "disabled",
};

describe("defaultPollingForSource — REST reachable: defaults unchanged", () => {
  it("FortiManager in bypass mode", () => {
    for (const s of SIX) {
      expect(
        defaultPollingForSource("fortimanager", s, { fortiosRestUnavailable: false, assetType: "firewall" }),
        s,
      ).toBe(FORTINET_DEFAULTS[s]);
    }
  });

  // Proxy mode WITH a token resolves fortiosRestUnavailable to false, so it
  // lands here — this is the case that must not regress when the transport
  // toggle says proxy.
  it("FortiManager in proxy mode that has a FortiGate API token", () => {
    for (const s of SIX) {
      expect(
        defaultPollingForSource("fortimanager", s, { fortiosRestUnavailable: false, assetType: "firewall" }),
        s,
      ).toBe(FORTINET_DEFAULTS[s]);
    }
  });

  // The shape every pre-existing caller used.
  it("no opts passed at all", () => {
    for (const s of SIX) {
      expect(defaultPollingForSource("fortimanager", s), s).toBe(FORTINET_DEFAULTS[s]);
    }
  });

  // A standalone FortiGate has no proxy to be behind, so the flag must not
  // reach it even if a caller sets it.
  it("standalone FortiGate ignores the flag entirely", () => {
    for (const s of SIX) {
      expect(
        defaultPollingForSource("fortigate", s, { fortiosRestUnavailable: true, assetType: "firewall" }),
        s,
      ).toBe(FORTINET_DEFAULTS[s]);
    }
  });
});

describe("defaultPollingForSource — REST unreachable (FMG proxy, no token)", () => {
  const OPTS = { fortiosRestUnavailable: true, assetType: "firewall" };

  // Response time stays ICMP. Moving it would change how up/down is decided for
  // every gate on every affected install — the new `fortimanager` native method
  // is opt-in for exactly that reason.
  it("leaves a firewall's response time on icmp", () => {
    expect(defaultPollingForSource("fortimanager", "responseTime", OPTS)).toBe("icmp");
  });

  // These three were rest_api and 409'd every tick. "disabled" is the honest
  // state, not a capability regression: supplying the token flips the condition
  // off and the REST defaults return.
  it("stops defaulting a firewall's REST streams to a call that cannot succeed", () => {
    for (const s of ["cpuMemory", "temperature", "interfaces"] as Stream[]) {
      expect(defaultPollingForSource("fortimanager", s, OPTS), s).toBe("disabled");
    }
  });

  it("keeps lldp and storage disabled", () => {
    for (const s of ["lldp", "storage"] as Stream[]) {
      expect(defaultPollingForSource("fortimanager", s, OPTS), s).toBe("disabled");
    }
  });

  // The one FortiOS read the proxy serves with no direct token: a managed
  // switch/AP's up/down comes off the PARENT gate's controller table through
  // fetchViaFortinetTransport, which IS transport-aware. Downgrading these to
  // icmp would be a real regression — plenty of FortiLink-managed devices are
  // not directly pingable.
  it("keeps managed switch / AP response time on the controller table", () => {
    for (const t of ["switch", "access_point"]) {
      expect(
        defaultPollingForSource("fortimanager", "responseTime", { fortiosRestUnavailable: true, assetType: t }),
        t,
      ).toBe("rest_api");
    }
  });

  it("still disables the heavy streams for managed children", () => {
    for (const s of ["cpuMemory", "temperature", "interfaces", "lldp", "storage"] as Stream[]) {
      expect(
        defaultPollingForSource("fortimanager", s, { fortiosRestUnavailable: true, assetType: "switch" }),
        s,
      ).toBe("disabled");
    }
  });

  // Cross-transport streams are opt-in on every source and must not be
  // reachable by this branch at all.
  it("leaves processes / eventLog disabled", () => {
    expect(defaultPollingForSource("fortimanager", "processes", OPTS)).toBe("disabled");
    expect(defaultPollingForSource("fortimanager", "eventLog", OPTS)).toBe("disabled");
  });
});

describe("defaultPollingForSource — non-Fortinet sources are untouched", () => {
  it("directory sources: icmp for response time, not-delivered elsewhere", () => {
    for (const src of ["activedirectory", "entraid", "windowsserver", "azurearc"] as const) {
      expect(defaultPollingForSource(src, "responseTime"), src).toBe("icmp");
      expect(defaultPollingForSource(src, "cpuMemory"), src).toBeNull();
    }
  });

  it("vcenter answers for its four streams", () => {
    for (const s of ["responseTime", "cpuMemory", "interfaces", "storage"] as Stream[]) {
      expect(defaultPollingForSource("vcenter", s), s).toBe("vcenter");
    }
    expect(defaultPollingForSource("vcenter", "temperature")).toBeNull();
    expect(defaultPollingForSource("vcenter", "lldp")).toBeNull();
  });

  it("manual: icmp for response time only", () => {
    expect(defaultPollingForSource("manual", "responseTime")).toBe("icmp");
    expect(defaultPollingForSource("manual", "interfaces")).toBeNull();
  });
});
