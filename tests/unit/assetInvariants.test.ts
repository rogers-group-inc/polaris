import { describe, it, expect } from "vitest";
import {
  clampAcquiredToLastSeen,
  bumpLastSeen,
  stagesDecommission,
  releaseAddressOnDecommission,
  dropAddressOnDecommissioned,
  DECOMMISSION_ADDRESS_RELEASE,
} from "../../src/utils/assetInvariants.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-02-01T00:00:00Z");
const T2 = new Date("2026-03-01T00:00:00Z");

describe("clampAcquiredToLastSeen", () => {
  it("clamps acquiredAt down to lastSeen when later", () => {
    const data: Record<string, unknown> = { acquiredAt: T2, lastSeen: T1 };
    clampAcquiredToLastSeen(data);
    expect(data.acquiredAt).toEqual(T1);
  });

  it("leaves acquiredAt alone when already ≤ lastSeen", () => {
    const data: Record<string, unknown> = { acquiredAt: T0, lastSeen: T1 };
    clampAcquiredToLastSeen(data);
    expect(data.acquiredAt).toEqual(T0);
  });

  it("pulls missing side from existing", () => {
    const data: Record<string, unknown> = { lastSeen: T0 };
    clampAcquiredToLastSeen(data, { acquiredAt: T1 });
    expect(data.acquiredAt).toEqual(T0);
  });
});

describe("bumpLastSeen", () => {
  it("advances lastSeen and stamps the source", () => {
    const data: Record<string, unknown> = {};
    const applied = bumpLastSeen(data, { lastSeen: T0 }, T1, "dhcp-lease");
    expect(applied).toBe(true);
    expect(data.lastSeen).toEqual(T1);
    expect(data.lastSeenSource).toBe("dhcp-lease");
  });

  it("sets lastSeen when the row has none", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: null }, T1, "ping")).toBe(true);
    expect(data.lastSeen).toEqual(T1);
    expect(bumpLastSeen({}, null, T1, "ping")).toBe(true);
  });

  it("never regresses: older evidence is a no-op", () => {
    const data: Record<string, unknown> = {};
    const applied = bumpLastSeen(data, { lastSeen: T2 }, T1, "device-inventory");
    expect(applied).toBe(false);
    expect("lastSeen" in data).toBe(false);
    expect("lastSeenSource" in data).toBe(false);
  });

  it("equal evidence is a no-op (no source churn)", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T1 }, new Date(T1), "agent")).toBe(false);
    expect("lastSeenSource" in data).toBe(false);
  });

  it("compares against a value already staged on the payload", () => {
    const data: Record<string, unknown> = { lastSeen: T2, lastSeenSource: "agent" };
    const applied = bumpLastSeen(data, { lastSeen: T0 }, T1, "ping");
    expect(applied).toBe(false);
    expect(data.lastSeen).toEqual(T2);
    expect(data.lastSeenSource).toBe("agent");
  });

  it("accepts ISO-string evidence and string row values", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0.toISOString() }, T1.toISOString(), "probe")).toBe(true);
    expect(data.lastSeen).toEqual(T1);
  });

  it("rejects invalid evidence dates", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0 }, "not-a-date", "ping")).toBe(false);
    expect("lastSeen" in data).toBe(false);
  });

  describe("monitored assets — polling is authoritative", () => {
    it("defers discovery-origin sources on a monitored asset", () => {
      for (const source of ["discovery", "device-inventory", "dhcp-lease"]) {
        const data: Record<string, unknown> = {};
        const applied = bumpLastSeen(data, { lastSeen: T0, monitored: true }, T2, source);
        expect(applied, source).toBe(false);
        expect("lastSeen" in data, source).toBe(false);
        expect("lastSeenSource" in data, source).toBe(false);
      }
    });

    it("still lets the monitor probe advance lastSeen on a monitored asset", () => {
      const data: Record<string, unknown> = {};
      expect(bumpLastSeen(data, { lastSeen: T0, monitored: true }, T2, "probe")).toBe(true);
      expect(data.lastSeen).toEqual(T2);
      expect(data.lastSeenSource).toBe("probe");
    });

    it("lets active/operator sources through on a monitored asset", () => {
      for (const source of ["agent", "ping", "conflict-accept"]) {
        const data: Record<string, unknown> = {};
        expect(bumpLastSeen(data, { lastSeen: T0, monitored: true }, T2, source), source).toBe(true);
      }
    });

    it("does not defer discovery-origin sources on an UNmonitored asset", () => {
      const data: Record<string, unknown> = {};
      expect(bumpLastSeen(data, { lastSeen: T0, monitored: false }, T2, "device-inventory")).toBe(true);
      expect(data.lastSeen).toEqual(T2);
    });

    it("does not defer when monitored is absent (back-compat)", () => {
      const data: Record<string, unknown> = {};
      expect(bumpLastSeen(data, { lastSeen: T0 }, T2, "device-inventory")).toBe(true);
      expect(data.lastSeen).toEqual(T2);
    });
  });
});

describe("bumpLastSeen — arc evidence source", () => {
  const T0 = new Date("2026-07-01T00:00:00Z");
  const T2 = new Date("2026-07-02T00:00:00Z");

  it("is deferred on a monitored asset (probe owns presence)", () => {
    // An Arc agent happily reaching Azure over a WAN link must not mask a
    // device that is failing its Polaris probe.
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0, monitored: true }, T2, "arc")).toBe(false);
    expect(data.lastSeen).toBeUndefined();
  });

  it("advances lastSeen on an unmonitored asset (Connected is a live heartbeat)", () => {
    // status="Connected" read AT SCRAPE TIME is a live liveness statement,
    // unlike Entra's lastSyncDateTime or AD's lastLogonTimestamp (stored
    // historical timestamps, which never write lastSeen at all).
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0, monitored: false }, T2, "arc")).toBe(true);
    expect(data.lastSeen).toEqual(T2);
    expect(data.lastSeenSource).toBe("arc");
  });

  it("cannot regress lastSeen with a stale evidence date", () => {
    // Guards the trap this source invites: properties.lastStatusChange records
    // when the status last CHANGED, so a machine Connected for 90 days carries
    // a 90-day-old value. The sync passes RUN TIME, but no-regress is the
    // backstop if anyone ever wires the wrong field.
    const data: Record<string, unknown> = {};
    const stale = new Date("2026-04-01T00:00:00Z");
    expect(bumpLastSeen(data, { lastSeen: T2, monitored: false }, stale, "arc")).toBe(false);
    expect("lastSeen" in data).toBe(false);
  });
});

describe("bumpLastSeen — vcenter evidence source", () => {
  const T0 = new Date("2026-07-01T00:00:00Z");
  const T2 = new Date("2026-07-02T00:00:00Z");

  it("is deferred on a monitored asset (probe owns presence)", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0, monitored: true }, T2, "vcenter")).toBe(false);
    expect(data.lastSeen).toBeUndefined();
  });

  it("advances lastSeen on an unmonitored asset (power_state is real-time hypervisor truth)", () => {
    const data: Record<string, unknown> = {};
    expect(bumpLastSeen(data, { lastSeen: T0, monitored: false }, T2, "vcenter")).toBe(true);
    expect(data.lastSeen).toEqual(T2);
    expect(data.lastSeenSource).toBe("vcenter");
  });
});

describe("rule 40(k) — a decommissioned asset holds no address", () => {
  it("stagesDecommission reads the plain and nested shapes", () => {
    expect(stagesDecommission({ status: "decommissioned" })).toBe(true);
    expect(stagesDecommission({ status: { set: "decommissioned" } })).toBe(true);
    expect(stagesDecommission({ status: "disabled" })).toBe(false);
    expect(stagesDecommission({ ipAddress: "10.0.0.1" })).toBe(false);
    expect(stagesDecommission(null)).toBe(false);
  });

  it("releaseAddressOnDecommission clears the address and every pin, whatever the write staged", () => {
    const data: Record<string, unknown> = {
      status: "decommissioned",
      ipAddress: "10.0.0.1",
      ipOverride: "10.0.0.1",
      primaryAddressIp: "10.0.0.1",
    };
    expect(releaseAddressOnDecommission(data)).toBe(true);
    expect(data).toMatchObject({ status: "decommissioned", ...DECOMMISSION_ADDRESS_RELEASE });
    expect(data.ipAddress).toBeNull();
    expect(data.ipBlankPinned).toBe(false);
  });

  it("releaseAddressOnDecommission leaves any other status alone", () => {
    const data: Record<string, unknown> = { status: "active", ipAddress: "10.0.0.1" };
    expect(releaseAddressOnDecommission(data)).toBe(false);
    expect(data).toEqual({ status: "active", ipAddress: "10.0.0.1" });
  });

  it("dropAddressOnDecommissioned drops a re-staged address on a decommissioned row", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.1", ipSource: "fortimanager", hostname: "sw1" };
    expect(dropAddressOnDecommissioned(data, "decommissioned")).toBe("10.0.0.1");
    expect(data).toEqual({ hostname: "sw1" });
  });

  it("dropAddressOnDecommissioned lets a reactivating write, a live row, or a clear through", () => {
    const reactivate: Record<string, unknown> = { status: "active", ipAddress: "10.0.0.1" };
    expect(dropAddressOnDecommissioned(reactivate, "decommissioned")).toBeNull();
    expect(reactivate.ipAddress).toBe("10.0.0.1");

    const live: Record<string, unknown> = { ipAddress: "10.0.0.1" };
    expect(dropAddressOnDecommissioned(live, "active")).toBeNull();
    expect(live.ipAddress).toBe("10.0.0.1");

    const clear: Record<string, unknown> = { ipAddress: null };
    expect(dropAddressOnDecommissioned(clear, "decommissioned")).toBeNull();
    expect(clear).toEqual({ ipAddress: null });
  });
});
