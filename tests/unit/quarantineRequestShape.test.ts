/**
 * tests/unit/quarantineRequestShape.test.ts — the quarantine write matches what
 * FortiOS actually exposes, and never damages the table it shares.
 *
 * Established by asking the device, after a production push failed with nothing
 * but "0/1 FortiGate(s) accepted the push. First error: FortiGate returned HTTP
 * 500":
 *
 *   GET /api/v2/cmdb/user/quarantine?action=schema
 *   → { "category": "complex",            ← a SINGLE object
 *       "access_group": "wifi",
 *       "children": { "quarantine": { type: option, default: "enable" },
 *                     "traffic-policy": …, "firewall-groups": …,
 *                     "targets": { category: "table", mkey: "entry",
 *                       children: { entry: {size 63, required},
 *                                   description: {size 63},
 *                                   macs: { mkey: "mac", children: {
 *                                     mac, description {size 63},
 *                                     drop: {default "disable"},
 *                                     parent: {readonly} } } } } } }
 *
 * Three defects, each invisible from outside:
 *
 *   1. The create POSTed to `/user/quarantine/targets` keyed on `name`. The mkey
 *      is `entry` — that was the 500 — and once corrected the same call answers
 *      **405**, because a child table of a COMPLEX object has no collection
 *      resource to POST to at all. Every write now goes through
 *      `PUT /api/v2/cmdb/user/quarantine` with the whole `targets` array, which
 *      is also the only way to release: `DELETE /targets/<entry>` was no more
 *      real than the POST, so create and release were broken identically.
 *   2. `macs[].drop` defaults to `disable` — "Sends quarantined device traffic
 *      to FortiGate". A quarantine omitting it lists the MAC and blocks nothing.
 *   3. Both description fields are size 63; the cap was 64.
 *
 * And the hazard the new mechanism introduces, which these tests exist mostly to
 * pin: a full-array PUT deletes every entry it omits, and that table is shared
 * with the gate's own Quarantine Host action, NAC and automation stitches.
 *
 * The device is faked at the `callFortiOs` seam and ECHOES what it is written,
 * so read-back verification runs for real. Asserting against source text would
 * not have caught any of the three.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { integrationsSource } from "./_integrationsSource";

const callFortiOs = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/reservationPushService.js", () => ({
  callFortiOs,
  buildTransportForIntegration: vi.fn(),
  normalizeMac: (m: string) => String(m).trim().toLowerCase().replace(/-/g, ":"),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/assetSightingService.js", () => ({ getQuarantineCandidates: vi.fn() }));

const { pushQuarantineToFortigate, unpushQuarantineFromFortigate } = await import(
  "../../src/services/assetQuarantineService.js"
);

/** The one object every write goes through. */
const OBJ_PATH = "/api/v2/cmdb/user/quarantine";
/** The mkey the device declares for its targets table. */
const MKEY = "entry";

type Call = { method: string; path: string; body?: any };

const calls = (): Call[] =>
  callFortiOs.mock.calls.map(([, method, path, body]) => ({ method, path, body }));
const writes = () => calls().filter((c) => c.method !== "GET");

/**
 * A fake gate holding one quarantine object. PUT replaces the targets table
 * exactly as FortiOS does, which is what lets the foreign-entry guard and the
 * rollback be tested rather than asserted.
 */
function fakeGate(opts: { targets?: any[]; enabled?: boolean; failWrite?: boolean } = {}) {
  const state = {
    quarantine: opts.enabled === false ? "disable" : "enable",
    targets: opts.targets ? JSON.parse(JSON.stringify(opts.targets)) : [],
  };
  let failNextWrite = opts.failWrite === true;
  callFortiOs.mockReset();
  callFortiOs.mockImplementation(async (_t: unknown, method: string, path: string, body?: any) => {
    if (path !== OBJ_PATH) throw new Error("unexpected path " + method + " " + path);
    if (method === "GET") return JSON.parse(JSON.stringify(state));
    if (method === "PUT") {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("device refused the write");
      }
      state.targets = JSON.parse(JSON.stringify(body.targets));
      return {};
    }
    throw new Error("unexpected method " + method);
  });
  return state;
}

const transport = { kind: "direct-fortigate", vdom: "root", fgConfig: { host: "10.0.0.1" } } as any;

const push = (over: Record<string, unknown> = {}) =>
  pushQuarantineToFortigate({
    assetId: "11112222-3333-4444-5555-666677778888",
    hostname: "WKS-1234",
    macs: ["00:11:22:33:44:55"],
    actor: "user:dmoore",
    transport,
    deviceName: "gate-1",
    ...over,
  } as any);

const OUR_ENTRY = "polaris-q-111122223333";

describe("the write mechanism", () => {
  beforeEach(() => fakeGate());

  it("PUTs the parent object and never POSTs a child collection", async () => {
    await push();
    const w = writes();
    expect(w.length).toBe(1);
    expect(w[0]!.method).toBe("PUT");
    expect(w[0]!.path).toBe(OBJ_PATH);
    expect(calls().some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the whole targets array, since a partial PUT would truncate it", async () => {
    await push();
    expect(Array.isArray(writes()[0]!.body.targets)).toBe(true);
  });

  it("names only targets, leaving the object's other attributes alone", async () => {
    // quarantine / traffic-policy / firewall-groups are the operator's.
    await push();
    expect(Object.keys(writes()[0]!.body)).toEqual(["targets"]);
  });
});

describe("the target it writes", () => {
  beforeEach(() => fakeGate());

  const ourTarget = async () => {
    await push();
    return writes()[0]!.body.targets.find((t: any) => t[MKEY] === OUR_ENTRY);
  };

  it("is keyed on entry, not name", async () => {
    const t = await ourTarget();
    expect(t).toBeTruthy();
    expect(t).not.toHaveProperty("name");
  });

  it("blocks traffic: every MAC carries drop=enable", async () => {
    await push({ macs: ["00:11:22:33:44:55", "aa:bb:cc:dd:ee:ff"] });
    const t = writes()[0]!.body.targets.find((x: any) => x[MKEY] === OUR_ENTRY);
    expect(t.macs.length).toBe(2);
    for (const m of t.macs) expect(m.drop).toBe("enable");
  });

  it("keeps every description inside the 63-char fields", async () => {
    await push({
      hostname: "a-really-quite-long-workstation-hostname-from-a-naming-standard-that-continues",
      actor: "user:some.very.long.account.name",
    });
    const t = writes()[0]!.body.targets.find((x: any) => x[MKEY] === OUR_ENTRY);
    expect(t.description.length).toBeLessThanOrEqual(63);
    for (const m of t.macs) expect(m.description.length).toBeLessThanOrEqual(63);
  });

  it("writes every MAC in ONE call", async () => {
    await push({ macs: ["00:11:22:33:44:55", "aa:bb:cc:dd:ee:ff", "00:00:00:00:00:01"] });
    expect(writes().length).toBe(1);
  });
});

describe("entries Polaris does not own", () => {
  const foreign = [
    { entry: "NAC-quarantine-1", description: "set by nac", macs: [{ mac: "de:ad:be:ef:00:01", drop: "enable" }] },
    { entry: "gui-quarantine-host", macs: [{ mac: "de:ad:be:ef:00:02", drop: "disable" }] },
  ];

  it("are carried through the PUT, not dropped", async () => {
    fakeGate({ targets: foreign });
    await push();
    const sent = writes()[0]!.body.targets.map((t: any) => t[MKEY]);
    expect(sent).toContain("NAC-quarantine-1");
    expect(sent).toContain("gui-quarantine-host");
    expect(sent).toContain(OUR_ENTRY);
  });

  it("keep their own attributes verbatim, including a MAC we would not have set", async () => {
    fakeGate({ targets: foreign });
    await push();
    const kept = writes()[0]!.body.targets.find((t: any) => t[MKEY] === "gui-quarantine-host");
    // drop=disable is someone else's decision on someone else's entry.
    expect(kept.macs[0].drop).toBe("disable");
    const described = writes()[0]!.body.targets.find((t: any) => t[MKEY] === "NAC-quarantine-1");
    expect(described.description).toBe("set by nac");
  });

  it("have device-owned readonly fields stripped, which FortiOS refuses on write", async () => {
    fakeGate({
      targets: [
        {
          entry: "NAC-quarantine-1",
          q_origin_key: "NAC-quarantine-1",
          macs: [{ mac: "de:ad:be:ef:00:01", parent: "NAC-quarantine-1", q_origin_key: "de:ad:be:ef:00:01" }],
        },
      ],
    });
    await push();
    const t = writes()[0]!.body.targets.find((x: any) => x[MKEY] === "NAC-quarantine-1");
    expect(t).not.toHaveProperty("q_origin_key");
    expect(t.macs[0]).not.toHaveProperty("parent");
    expect(t.macs[0]).not.toHaveProperty("q_origin_key");
    // The MAC itself obviously survives.
    expect(t.macs[0].mac).toBe("de:ad:be:ef:00:01");
  });

  it("losing one fails the push and restores the table", async () => {
    // A gate that silently drops an entry on write — the shape of a concurrent
    // writer clobbering us, which is the failure mode read-modify-write has.
    const state = fakeGate({ targets: foreign });
    callFortiOs.mockImplementation(async (_t: unknown, method: string, _p: string, body?: any) => {
      if (method === "GET") return JSON.parse(JSON.stringify(state));
      state.targets = JSON.parse(JSON.stringify(body.targets)).filter(
        (t: any) => t.entry !== "NAC-quarantine-1",
      );
      return {};
    });
    await expect(push()).rejects.toThrow(/Polaris does not own/);
    // The last write is the restore, and it carries the entry back.
    const last = writes().at(-1)!;
    expect(last.body.targets.map((t: any) => t[MKEY])).toContain("NAC-quarantine-1");
  });
});

describe("idempotence", () => {
  it("costs no write when the device already says what we would say", async () => {
    fakeGate({
      targets: [
        {
          entry: OUR_ENTRY,
          description: "whatever the operator retitled it to",
          macs: [{ mac: "00:11:22:33:44:55", drop: "enable" }],
        },
      ],
    });
    await push();
    expect(writes().length).toBe(0);
  });

  it("rewrites when the existing entry is not dropping traffic", async () => {
    // The pre-fix state: entry present, drop defaulted, nothing blocked.
    fakeGate({ targets: [{ entry: OUR_ENTRY, macs: [{ mac: "00:11:22:33:44:55" }] }] });
    await push();
    expect(writes().length).toBe(1);
    const t = writes()[0]!.body.targets.find((x: any) => x[MKEY] === OUR_ENTRY);
    expect(t.macs[0].drop).toBe("enable");
  });

  it("reconciles a stale MAC away", async () => {
    fakeGate({
      targets: [{ entry: OUR_ENTRY, macs: [{ mac: "99:99:99:99:99:99", drop: "enable" }] }],
    });
    await push();
    const t = writes()[0]!.body.targets.find((x: any) => x[MKEY] === OUR_ENTRY);
    expect(t.macs.map((m: any) => m.mac)).toEqual(["00:11:22:33:44:55"]);
  });

  it("replaces in place, so the table keeps its order", async () => {
    fakeGate({
      targets: [
        { entry: "first", macs: [{ mac: "de:ad:be:ef:00:01" }] },
        { entry: OUR_ENTRY, macs: [{ mac: "99:99:99:99:99:99" }] },
        { entry: "last", macs: [{ mac: "de:ad:be:ef:00:02" }] },
      ],
    });
    await push();
    expect(writes()[0]!.body.targets.map((t: any) => t[MKEY])).toEqual([
      "first",
      OUR_ENTRY,
      "last",
    ]);
  });
});

describe("a disabled quarantine feature", () => {
  it("refuses the push instead of writing an entry that would never apply", async () => {
    fakeGate({ enabled: false });
    await expect(push()).rejects.toThrow(/quarantine disabled/);
    expect(writes().length).toBe(0);
  });

  it("treats an absent flag as enabled, per the schema default", async () => {
    const state = fakeGate();
    delete (state as any).quarantine;
    await expect(push()).resolves.toMatchObject({ targetName: OUR_ENTRY });
  });
});

describe("rollback", () => {
  it("restores the exact array that was read", async () => {
    const before = [{ entry: "NAC-quarantine-1", macs: [{ mac: "de:ad:be:ef:00:01", drop: "enable" }] }];
    fakeGate({ targets: before, failWrite: true });
    await expect(push()).rejects.toThrow(/device refused the write/);
    // The failing write threw, so the restore is the only write that landed.
    const last = writes().at(-1)!;
    expect(last.body.targets.map((t: any) => t[MKEY])).toEqual(["NAC-quarantine-1"]);
    expect(last.body.targets.map((t: any) => t[MKEY])).not.toContain(OUR_ENTRY);
  });
});

describe("release", () => {
  const unpush = () =>
    unpushQuarantineFromFortigate({
      assetId: "11112222-3333-4444-5555-666677778888",
      transport,
    } as any);

  it("goes through the same PUT — there is no DELETE to make", async () => {
    fakeGate({ targets: [{ entry: OUR_ENTRY, macs: [{ mac: "00:11:22:33:44:55", drop: "enable" }] }] });
    await expect(unpush()).resolves.toEqual({ removed: true, alreadyAbsent: false });
    expect(calls().some((c) => c.method === "DELETE")).toBe(false);
    expect(writes()[0]!.path).toBe(OBJ_PATH);
  });

  it("removes only our entry", async () => {
    fakeGate({
      targets: [
        { entry: "NAC-quarantine-1", macs: [{ mac: "de:ad:be:ef:00:01" }] },
        { entry: OUR_ENTRY, macs: [{ mac: "00:11:22:33:44:55", drop: "enable" }] },
      ],
    });
    await unpush();
    expect(writes()[0]!.body.targets.map((t: any) => t[MKEY])).toEqual(["NAC-quarantine-1"]);
  });

  it("reports an already-absent entry as success, with no write", async () => {
    fakeGate({ targets: [{ entry: "someone-elses", macs: [{ mac: "de:ad:be:ef:00:01" }] }] });
    await expect(unpush()).resolves.toEqual({ removed: false, alreadyAbsent: true });
    expect(writes().length).toBe(0);
  });
});

describe("the tab copy names the group the schema names", () => {
  const js = integrationsSource();
  const fn = js.split("function quarantinePushFormHTML(")[1]!.slice(0, 4000);

  it("asks for WiFi & Switch Controller, per access_group: wifi", () => {
    expect(fn).toContain("WiFi &amp; Switch Controller");
  });

  it("no longer asks for User & Device as the grant", () => {
    // It survives only inside the explanation of which group is NOT the one.
    expect(fn).toContain("not User &amp; Device");
    expect(fn).not.toMatch(/<strong>User &amp; Device<\/strong> &rarr; Read-Write/);
  });

  it("tells the operator how to ask the device instead of trusting the page", () => {
    const helper = js.split("function _fortigateAccessProfileHTML(")[1]!.slice(0, 3000);
    expect(helper).toContain("action=schema");
    expect(helper).toContain("access_group");
  });
});
