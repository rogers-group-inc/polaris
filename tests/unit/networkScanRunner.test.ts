/**
 * tests/unit/networkScanRunner.test.ts — the pure + mockable halves of
 * src/services/networkScanRunner.ts.
 *
 * `runScan` itself owns run-row transitions and needs a DB, so what's pinned
 * here is the decision-making around it:
 *
 *  - **the stored-shape normalizers**, because `targets` and `methods` are JSON
 *    columns: a hand-edited or imported blob must degrade to "fewer targets"
 *    rather than crashing a background worker;
 *  - **`identifyAddress`'s ordering contract** — the operator's method order is
 *    a priority order, and the FIRST method that answers with a credential owns
 *    the identity. A later method still records that it answered, but must not
 *    overwrite what a higher-priority method established;
 *  - **credentials are tried in order and the first that works wins**, with the
 *    others not attempted — an SNMP list is a community list, and continuing
 *    past a success is both slower and more IDS-visible;
 *  - **an address that answered SOMETHING keeps the failure reasons of the
 *    methods that didn't.** "Answered ICMP, refused every community" is the
 *    single most common shape and names the credential to fix;
 *  - **a method with no credential says so** rather than reporting the address
 *    as silent on a method nothing ever asked it about;
 *  - **nothing answering yields null**, which is the common case for most of a
 *    range and the reason this returns instead of throwing.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** The two monitoringService entry points the runner uses, mocked. */
const probeMock = vi.fn();
const walkMock = vi.fn();

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/monitoringService.js", () => ({
  probeCredentialAgainstHost: (...args: unknown[]) => probeMock(...args),
  snmpWalkRaw: (...args: unknown[]) => walkMock(...args),
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: async () => {} }));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: async () => { throw new Error("unused"); } }));

const {
  parseStoredTargets,
  parseStoredMethods,
  identifyAddress,
  checkLiveness,
  isNoReply,
  SCAN_METHODS,
  SCAN_PING_ATTEMPTS,
} = await import("../../src/services/networkScanRunner.js");

type Cred = { id: string; name: string; type: string; config: Record<string, unknown> };
const creds = (...list: Cred[]) => new Map(list.map((c) => [c.id, c]));
const cred = (id: string, name = id): Cred => ({ id, name, type: "snmp", config: { community: name } });

const ok = (ms = 5) => ({ success: true, responseTimeMs: ms });
const bad = (error: string) => ({ success: false, responseTimeMs: 1, error });

beforeEach(() => {
  probeMock.mockReset();
  walkMock.mockReset();
  // Default: every walk answers nothing, so the SNMP detail pass is inert
  // unless a test says otherwise.
  walkMock.mockResolvedValue({ rows: [], truncated: false, durationMs: 1 });
});

describe("parseStoredTargets", () => {
  it("keeps well-formed rows and drops the rest", () => {
    expect(
      parseStoredTargets([
        { kind: "cidr", value: "10.4.0.0/24" },
        { kind: "range", value: "10.4.1.1-10.4.1.9" },
        { kind: "single", value: "10.4.2.7" },
        { kind: "nonsense", value: "10.4.3.0/24" },
        { kind: "cidr", value: 42 },
        { kind: "cidr" },
        null,
        "10.4.4.0/24",
      ]),
    ).toEqual([
      { kind: "cidr", value: "10.4.0.0/24" },
      { kind: "range", value: "10.4.1.1-10.4.1.9" },
      { kind: "single", value: "10.4.2.7" },
    ]);
  });

  it("returns nothing for a non-array column", () => {
    // The column is JSON: a hand-edited or imported blob must not crash a
    // background worker.
    expect(parseStoredTargets(null)).toEqual([]);
    expect(parseStoredTargets({})).toEqual([]);
    expect(parseStoredTargets("10.0.0.0/8")).toEqual([]);
  });
});

describe("parseStoredMethods", () => {
  it("preserves the operator's order — it is a priority order", () => {
    const m = parseStoredMethods([
      { type: "icmp" },
      { type: "snmp", credentialIds: ["c1", "c2"] },
      { type: "ssh", credentialIds: ["c3"] },
    ]);
    expect(m.map((x) => x.type)).toEqual(["icmp", "snmp", "ssh"]);
    expect(m[1].credentialIds).toEqual(["c1", "c2"]);
  });

  it("drops unknown methods and keeps the first entry per method", () => {
    const m = parseStoredMethods([
      { type: "http", credentialIds: ["c9"] },
      { type: "snmp", credentialIds: ["first"] },
      { type: "snmp", credentialIds: ["second"] },
    ]);
    expect(m).toEqual([{ type: "snmp", credentialIds: ["first"] }]);
  });

  it("normalizes a missing or dirty credentialIds list", () => {
    const m = parseStoredMethods([
      { type: "icmp" },
      { type: "ssh", credentialIds: ["ok", "", 7, null] },
    ]);
    expect(m[0].credentialIds).toEqual([]);
    expect(m[1].credentialIds).toEqual(["ok"]);
  });

  it("offers exactly the five documented methods", () => {
    expect([...SCAN_METHODS]).toEqual(["icmp", "snmp", "restapi", "ssh", "winrm"]);
  });
});

describe("identifyAddress — ordering", () => {
  it("returns null when nothing answers", () => {
    probeMock.mockResolvedValue(bad("No response"));
    return expect(
      identifyAddress("10.4.0.9", [{ type: "snmp", credentialIds: ["c1"] }], creds(cred("c1"))),
    ).resolves.toBeNull();
  });

  it("keeps an ICMP-only hit from the liveness pass", async () => {
    const hit = await identifyAddress("10.4.0.9", [{ type: "icmp" }], creds(), {
      icmpAlreadyAnswered: true,
    });
    expect(hit).toMatchObject({ address: "10.4.0.9", respondedTo: ["icmp"] });
    expect(hit!.identifiedBy).toBeUndefined();
    expect(probeMock).not.toHaveBeenCalled(); // ICMP is not re-probed here
  });

  it("lets the FIRST answering method own the identity", async () => {
    // snmp before ssh: both answer, but the identity is snmp's.
    probeMock.mockImplementation(async (_host: string, type: string) =>
      type === "snmp" || type === "ssh" ? ok() : bad("No response"),
    );
    const hit = await identifyAddress(
      "10.4.0.9",
      [
        { type: "snmp", credentialIds: ["snmp1"] },
        { type: "ssh", credentialIds: ["ssh1"] },
      ],
      creds(cred("snmp1", "public"), cred("ssh1", "root")),
    );
    expect(hit!.respondedTo).toEqual(["snmp", "ssh"]);
    expect(hit!.identifiedBy).toBe("snmp");
    expect(hit!.credentialName).toBe("public");
  });

  it("honours the reverse order too — the config decides, not the code", async () => {
    probeMock.mockImplementation(async () => ok());
    const hit = await identifyAddress(
      "10.4.0.9",
      [
        { type: "ssh", credentialIds: ["ssh1"] },
        { type: "snmp", credentialIds: ["snmp1"] },
      ],
      creds(cred("snmp1", "public"), cred("ssh1", "root")),
    );
    expect(hit!.identifiedBy).toBe("ssh");
    expect(hit!.credentialName).toBe("root");
  });
});

describe("identifyAddress — credentials", () => {
  it("tries credentials in order and stops at the first that works", async () => {
    probeMock.mockImplementation(async (_h: string, _t: string, config: Record<string, unknown>) =>
      config.community === "second" ? ok() : bad("Auth failed"),
    );
    const hit = await identifyAddress(
      "10.4.0.9",
      [{ type: "snmp", credentialIds: ["a", "b", "c"] }],
      creds(cred("a", "first"), cred("b", "second"), cred("c", "third")),
    );
    expect(hit!.credentialName).toBe("second");
    // Two attempts, not three — continuing past a success is slower and more
    // visible on an IDS for no gain.
    expect(probeMock).toHaveBeenCalledTimes(2);
  });

  it("records the last failure reason when every credential is refused", async () => {
    probeMock.mockImplementation(async (_h: string, type: string) =>
      type === "snmp" ? bad("SNMP timed out") : ok(),
    );
    const hit = await identifyAddress(
      "10.4.0.9",
      [
        { type: "snmp", credentialIds: ["a", "b"] },
        { type: "ssh", credentialIds: ["s"] },
      ],
      creds(cred("a"), cred("b"), cred("s")),
    );
    // The address DID answer (ssh), so the snmp reason survives on the hit —
    // this is the "answered ICMP, refused every community" shape.
    expect(hit!.errors?.snmp).toBe("SNMP timed out");
    expect(hit!.respondedTo).toEqual(["ssh"]);
  });

  it("says a method had no credential rather than calling it silent", async () => {
    const hit = await identifyAddress(
      "10.4.0.9",
      [{ type: "snmp", credentialIds: [] }],
      creds(),
      { icmpAlreadyAnswered: true },
    );
    expect(hit!.errors?.snmp).toMatch(/No credential/i);
    expect(probeMock).not.toHaveBeenCalled();
  });

  it("reports a credential that no longer exists", async () => {
    const hit = await identifyAddress(
      "10.4.0.9",
      [{ type: "snmp", credentialIds: ["deleted"] }],
      creds(),
      { icmpAlreadyAnswered: true },
    );
    expect(hit!.errors?.snmp).toMatch(/not found/i);
  });
});

describe("identifyAddress — SNMP detail", () => {
  it("walks the system group and inventory once SNMP answers", async () => {
    probeMock.mockResolvedValue(ok());
    walkMock.mockImplementation(async (_h: string, _c: unknown, baseOid: string) => {
      if (baseOid === "1.3.6.1.2.1.1") {
        return {
          rows: [
            { oid: "1.3.6.1.2.1.1.5.0", value: "SW-ASHFIELD-01" },
            { oid: "1.3.6.1.2.1.1.2.0", value: "1.3.6.1.4.1.12356.106.1.1" },
          ],
          truncated: false,
          durationMs: 3,
        };
      }
      if (baseOid === "1.3.6.1.2.1.31.1.1.1.1") {
        return { rows: [{ oid: "1.3.6.1.2.1.31.1.1.1.1.1", value: "port1" }], truncated: false, durationMs: 2 };
      }
      if (baseOid === "1.3.6.1.2.1.25.2.3.1.3") {
        return { rows: [{ oid: "1.3.6.1.2.1.25.2.3.1.3.1", value: "/" }], truncated: false, durationMs: 2 };
      }
      return { rows: [], truncated: false, durationMs: 1 };
    });

    const hit = await identifyAddress("10.4.0.9", [{ type: "snmp", credentialIds: ["c"] }], creds(cred("c")));
    expect(hit!.identity).toMatchObject({ hostname: "SW-ASHFIELD-01", manufacturer: "Fortinet" });
    expect(hit!.interfaces).toEqual([{ ifName: "port1", ifType: null, operStatus: null }]);
    expect(hit!.storage).toEqual([{ mountPath: "/" }]);
  });

  it("keeps the hit when every walk fails", async () => {
    // The device answered the probe; a refused walk (no view scope, ACL) means
    // less to show, never a lost responder.
    probeMock.mockResolvedValue(ok());
    walkMock.mockRejectedValue(new Error("SNMP gate timeout"));
    const hit = await identifyAddress("10.4.0.9", [{ type: "snmp", credentialIds: ["c"] }], creds(cred("c")));
    expect(hit).toMatchObject({ address: "10.4.0.9", respondedTo: ["snmp"], identifiedBy: "snmp" });
    expect(hit!.identity).toBeUndefined();
    expect(hit!.interfaces).toBeUndefined();
  });

  it("does not walk for a non-SNMP method", async () => {
    probeMock.mockResolvedValue(ok());
    await identifyAddress("10.4.0.9", [{ type: "winrm", credentialIds: ["c"] }], creds(cred("c")));
    expect(walkMock).not.toHaveBeenCalled();
  });

  it("records the response time of the first answering method", async () => {
    probeMock.mockResolvedValue(ok(42));
    const hit = await identifyAddress("10.4.0.9", [{ type: "ssh", credentialIds: ["c"] }], creds(cred("c")));
    expect(hit!.responseTimeMs).toBe(42);
  });
});

describe("checkLiveness — the ICMP liveness pass", () => {
  /** A scripted ping: each call returns the next result in the list. */
  const scripted = (...results: { success: boolean; error?: string }[]) =>
    vi.fn(async () => results.shift() ?? { success: false, error: "ping exit 1" });

  it("retries a silent address once — the first echo is lost while the gateway ARPs", async () => {
    // The field report: a host that answered its ICMP monitor was missing from
    // a Discovery of its own subnet, because the sweep's only echo was the one
    // the router dropped while it resolved the host.
    expect(SCAN_PING_ATTEMPTS).toBe(2);
    const ping = scripted({ success: false, error: "ping exit 1" }, { success: true });
    expect(await checkLiveness("10.4.0.7", ping)).toEqual({ alive: true });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("does not retry an address that answered", async () => {
    const ping = scripted({ success: true });
    expect(await checkLiveness("10.4.0.7", ping)).toEqual({ alive: true });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("calls an address silent only after every attempt went unanswered", async () => {
    const ping = scripted({ success: false, error: "ping exit 1" }, { success: false, error: "ping timed out" });
    expect(await checkLiveness("10.4.0.7", ping)).toEqual({ alive: false });
    expect(ping).toHaveBeenCalledTimes(SCAN_PING_ATTEMPTS);
  });

  it("reports a ping that could not RUN apart from a silent address, without retrying", async () => {
    // No CAP_NET_RAW / no binary / no route: a fact about the server, which a
    // sweep must say rather than reporting an empty network.
    const ping = scripted({ success: false, error: "spawn ping EPERM" });
    expect(await checkLiveness("10.4.0.7", ping)).toEqual({ alive: false, toolError: "spawn ping EPERM" });
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("classifies exit 1 and the wall-clock timeout as no-reply, everything else as a tool failure", () => {
    expect(isNoReply("ping exit 1")).toBe(true);
    expect(isNoReply("ping timed out")).toBe(true);
    expect(isNoReply("ping exit 2")).toBe(false);
    expect(isNoReply("spawn ping ENOENT")).toBe(false);
    expect(isNoReply(undefined)).toBe(false);
  });
});
