/**
 * tests/unit/fortiosEnvelope.test.ts — which half of a FortiOS REST response a
 * field lives in.
 *
 * The payloads below are VERBATIM from real FortiGates (a lab hub-and-spoke on
 * FortiOS v7.6.7 build 3704, captured 2026-09-21), because the bug these
 * readers fix was invisible to every synthetic fixture: a hand-written
 * `{ hostname, serial, version }` object satisfies both the broken code and the
 * fixed code. Only the real envelope, with `serial` and `version` OUTSIDE
 * `results`, tells them apart. Keep these shapes; do not "tidy" them.
 */

import { describe, it, expect } from "vitest";
import { readSystemStatus, readHaPeers } from "../../src/utils/fortiosEnvelope.js";

/** GET /api/v2/monitor/system/status on HUB1-a, verbatim. */
const REAL_STATUS = {
  http_method: "GET",
  results: {
    model_name: "FortiGate",
    model_number: "61F",
    model: "FGT61F",
    hostname: "HUB1-a",
    log_disk_status: "available",
  },
  vdom: "root",
  path: "system",
  name: "status",
  status: "success",
  serial: "FGT61FTK23009069",
  version: "v7.6.7",
  build: 3704,
};

/** GET /api/v2/monitor/system/ha-peer on the same box, verbatim. */
const REAL_HA_PEER = {
  http_method: "GET",
  results: [
    { serial_no: "FGT61FTK23009069", vcluster_id: 0, priority: 255, hostname: "HUB1-a", master: true, primary: true },
    { serial_no: "FGT61FTK24006008", vcluster_id: 0, priority: 128, hostname: "HUB1-b" },
  ],
  vdom: "root",
  path: "system",
  name: "ha-peer",
  status: "success",
  serial: "FGT61FTK23009069",
  version: "v7.6.7",
  build: 3704,
};

describe("readSystemStatus", () => {
  it("reads the serial and version off the ENVELOPE, not results", () => {
    const s = readSystemStatus(REAL_STATUS);
    expect(s.serial).toBe("FGT61FTK23009069");
    expect(s.version).toBe("v7.6.7");
    expect(s.build).toBe(3704);
  });

  it("reads the hostname and model out of results", () => {
    const s = readSystemStatus(REAL_STATUS);
    expect(s.hostname).toBe("HUB1-a");
    expect(s.model).toBe("FGT61F");
    expect(s.modelName).toBe("FortiGate");
  });

  it("loses the identity fields when handed an already-unwrapped payload", () => {
    // This IS the bug, pinned: `fgRequest` without `envelope: true` returns
    // exactly this, and no reader can recover what the transport discarded.
    // The assertion exists so that a future change which makes unwrapping the
    // only option fails here rather than in the field.
    const s = readSystemStatus(REAL_STATUS.results);
    expect(s.hostname).toBe("HUB1-a");
    expect(s.serial).toBeUndefined();
    expect(s.version).toBeUndefined();
  });

  it("still finds a field a build puts on the other side", () => {
    const moved = { results: { hostname: "EDGE", serial: "FG1", version: "v7.4.5" } };
    const s = readSystemStatus(moved);
    expect(s.serial).toBe("FG1");
    expect(s.version).toBe("v7.4.5");
  });

  it("treats empty and blank strings as absent, never as a value", () => {
    const s = readSystemStatus({ results: { hostname: "   " }, serial: "", version: "  " });
    expect(s.hostname).toBeUndefined();
    expect(s.serial).toBeUndefined();
    expect(s.version).toBeUndefined();
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, "", 42, [], { results: [] }]) {
      expect(() => readSystemStatus(junk)).not.toThrow();
      expect(readSystemStatus(junk).serial).toBeUndefined();
    }
  });
});

describe("readHaPeers", () => {
  it("names both members of a real active-passive pair", () => {
    const { members } = readHaPeers(REAL_HA_PEER);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.hostname)).toEqual(["HUB1-a", "HUB1-b"]);
    expect(members.map((m) => m.serial)).toEqual(["FGT61FTK23009069", "FGT61FTK24006008"]);
    expect(members.map((m) => m.priority)).toEqual([255, 128]);
  });

  it("resolves the caller from the envelope serial", () => {
    expect(readHaPeers(REAL_HA_PEER).callerSerial).toBe("FGT61FTK23009069");
  });

  it("marks only the unit the device flagged primary", () => {
    const { members } = readHaPeers(REAL_HA_PEER);
    expect(members.filter((m) => m.isPrimary).map((m) => m.hostname)).toEqual(["HUB1-a"]);
  });

  it("falls back to the flagged member when the envelope carries no serial", () => {
    // The endpoint is only reachable through the cluster address, which routes
    // to the active unit — so the member flagged primary IS the caller.
    const { results } = REAL_HA_PEER;
    expect(readHaPeers({ results }).callerSerial).toBe("FGT61FTK23009069");
  });

  it("falls back to the caller-supplied serial last", () => {
    expect(readHaPeers([{ serial_no: "X1" }, { serial_no: "X2" }], "FALLBACK").callerSerial).toBe("FALLBACK");
  });

  it("accepts a bare results array and a bare array alike", () => {
    expect(readHaPeers(REAL_HA_PEER.results).members).toHaveLength(2);
    expect(readHaPeers([...REAL_HA_PEER.results]).members).toHaveLength(2);
  });

  it("reports no members for a standalone gate", () => {
    expect(readHaPeers({ results: [], serial: "FG1" }).members).toHaveLength(0);
    expect(readHaPeers({ results: [] }).callerSerial).toBe("");
  });

  it("drops a member with no serial rather than inventing one", () => {
    const { members } = readHaPeers({ results: [{ hostname: "ghost" }, { serial_no: "REAL" }] });
    expect(members.map((m) => m.serial)).toEqual(["REAL"]);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, "", 42, {}, { results: "nope" }]) {
      expect(() => readHaPeers(junk)).not.toThrow();
      expect(readHaPeers(junk).members).toEqual([]);
    }
  });
});

describe("the caller filter that the empty serial used to defeat", () => {
  // fgtChainHa builds its member list as [caller as primary, ...peers], where
  // peers excludes the caller by serial. With callerSerial empty that filter
  // matched nothing, so the primary would have been counted twice — and the
  // `callerSerial &&` guard ahead of it meant the whole branch was skipped and
  // a real cluster was recorded as standalone instead.
  it("leaves exactly the standby once the caller is known", () => {
    const { callerSerial, members } = readHaPeers(REAL_HA_PEER);
    const peers = members.filter((m) => m.serial !== callerSerial);
    expect(peers.map((m) => m.hostname)).toEqual(["HUB1-b"]);
    expect([{ serial: callerSerial }, ...peers]).toHaveLength(2);
  });
});
