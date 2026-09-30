/**
 * tests/unit/pathCheckService.test.ts — agent-run path checks:
 * validation (target refusal, status spec, RE2-safe regex, interval / timeout),
 * the agent-facing definition + its hash, the ETag fold, the version gate, and
 * the set-based membership reconcile (scope ∪ pins ∩ active agents), and the
 * Polaris-server source (runOnServer): its one assetId-NULL row, and the
 * networkScan:write gate on aiming the server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  checks: [] as any[],
  sources: [] as any[],
  agents: [] as any[],
  settings: new Map<string, unknown>(),
  credentials: [] as any[],
};
let seq = 0;

const { loadScopeAssetIds, publishConfigRefresh, logEvent } = vi.hoisted(() => ({
  loadScopeAssetIds: vi.fn(async () => [] as string[]),
  publishConfigRefresh: vi.fn(async () => {}),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../../src/services/notificationEngine.js", () => ({ loadScopeAssetIds }));
vi.mock("../../src/services/agentCommandWake.js", () => ({ publishConfigRefresh }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent }));
vi.mock("../../src/services/agentInstallService.js", () => ({ AGENT_SERVER_URL_SETTING_KEY: "agent.serverUrlOverride" }));
const { runServerCheck } = vi.hoisted(() => ({
  runServerCheck: vi.fn(async (def: any, _t: any, _n: any, cap: any) => {
    if (cap) { cap.headers = { "content-type": "application/json" }; cap.body = '{"status":"UP"}'; cap.httpVersion = "1.1"; }
    return { sample: { checkId: def.id, ok: true, httpStatus: 200, latencyMs: 5 }, trace: null };
  }),
}));
vi.mock("../../src/services/pathCheckServerRunner.js", () => ({ runServerCheck }));

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && "in" in (v as any)) {
      if (!(v as any).in.includes(row[k])) return false;
    } else if (v && typeof v === "object" && "not" in (v as any)) {
      if (row[k] === (v as any).not) return false;
    } else if (k === "check") {
      const c = db.checks.find((x) => x.id === row.checkId);
      if (!c || !matchWhere(c, v)) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(async ({ where }: any) => (db.settings.has(where.key) ? { value: db.settings.get(where.key) } : null)) },
    pathCheck: {
      findMany: vi.fn(async ({ where }: any = {}) => db.checks.filter((c) => matchWhere(c, where))),
      findUnique: vi.fn(async ({ where }: any) => {
        const c = db.checks.find((x) => (where.id ? x.id === where.id : x.name === where.name));
        return c ? { ...c } : null;
      }),
      count: vi.fn(async ({ where }: any) => db.checks.filter((c) => matchWhere(c, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const c = { createdAt: new Date(Date.now() + ++seq), updatedAt: new Date(), ...data };
        db.checks.push(c);
        return c;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const c = db.checks.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(async ({ where }: any) => {
        db.checks = db.checks.filter((c) => c.id !== where.id);
        db.sources = db.sources.filter((s) => s.checkId !== where.id);
      }),
    },
    pathCheckSource: {
      findMany: vi.fn(async ({ where, select }: any = {}) => {
        const rows = db.sources.filter((s) => matchWhere(s, where));
        if (select?.check) {
          return rows.map((s) => ({ ...s, check: db.checks.find((c) => c.id === s.checkId) }));
        }
        if (select?.asset) return rows.map(() => ({ asset: { managedAgent: null } }));
        return rows;
      }),
      groupBy: vi.fn(async () => []),
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) db.sources.push({ id: `src${++seq}`, ...d });
        return { count: data.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = db.sources.length;
        db.sources = db.sources.filter((s) => !where.id.in.includes(s.id));
        return { count: before - db.sources.length };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        for (const s of db.sources) if (where.id?.in?.includes(s.id)) Object.assign(s, data);
        return { count: 0 };
      }),
    },
    managedAgent: {
      findMany: vi.fn(async ({ where }: any) => db.agents.filter((a) => a.installStatus === where.installStatus)),
    },
    credential: { findUnique: vi.fn(async ({ where }: any) => db.credentials.find((c) => c.id === where.id) ?? null) },
    asset: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  },
}));

import {
  normalizeCheckInput,
  targetHostOf,
  splitHostPort,
  definitionSha256,
  toAgentCheckDef,
  agentConfigChecks,
  pathCheckEtagFold,
  reconcilePathCheckSources,
  agentOnline,
  normalizeTraceroute,
  MIN_AGENT_PATH_CHECK_VERSION,
  MAX_CHECKS_PER_AGENT,
  createCheck,
  updateCheck,
  setCheckEnabled,
  serverCheckDefinitions,
  POLARIS_SERVER_SUBJECT,
  testCheck,
  _resetTestRunLimiter,
  TEST_RUNS_PER_MINUTE,
  normalizeHostHeader,
  requiredAgentVersion,
  MIN_AGENT_REQUEST_OPTIONS_VERSION,
} from "../../src/services/pathCheckService.js";
import { parseStatusSpec, statusInRanges, agentRegexProblem } from "../../src/utils/httpCheck.js";

const base = { name: "Intranet", kind: "https" as const, target: "https://intranet.example/health", scope: { allAssets: true } };

beforeEach(() => {
  db.checks = [];
  db.sources = [];
  db.agents = [];
  db.settings.clear();
  db.credentials = [];
  loadScopeAssetIds.mockReset().mockResolvedValue([]);
  publishConfigRefresh.mockClear();
  logEvent.mockClear();
});

describe("parseStatusSpec (server copy of the three-way mirror)", () => {
  it("defaults an empty spec to any 2xx", () => {
    expect(parseStatusSpec("")).toEqual({ ranges: [{ lo: 200, hi: 299 }], error: null });
  });
  it("parses codes and ranges", () => {
    const r = parseStatusSpec("200, 204,300-399");
    expect(r.error).toBeNull();
    expect(statusInRanges(204, r.ranges)).toBe(true);
    expect(statusInRanges(302, r.ranges)).toBe(true);
    expect(statusInRanges(201, r.ranges)).toBe(false);
  });
  it.each(["20", "200-", "599-200", "abc", "200,,204", "700"])("refuses %s", (spec) => {
    expect(parseStatusSpec(spec).error).not.toBeNull();
  });
});

describe("agentRegexProblem — the agent is RE2", () => {
  it("accepts a plain pattern", () => expect(agentRegexProblem("status\":\\s*\"ok")).toBeNull());
  it("refuses lookahead / lookbehind", () => {
    expect(agentRegexProblem("foo(?=bar)")).toMatch(/Lookahead/);
    expect(agentRegexProblem("(?<!x)y")).toMatch(/Lookahead/);
  });
  it("refuses backreferences", () => expect(agentRegexProblem("(a)\\1")).toMatch(/Backreference/));
  it("refuses an invalid pattern", () => expect(agentRegexProblem("(")).toMatch(/Invalid/));
});

describe("target parsing", () => {
  it("splits host:port and bracketed v6", () => {
    expect(splitHostPort("db01.example:5432")).toEqual({ host: "db01.example", port: 5432 });
    expect(splitHostPort("[fe80::1]:22")).toEqual({ host: "fe80::1", port: 22 });
    expect(splitHostPort("10.0.0.1")).toEqual({ host: "10.0.0.1", port: null });
  });
  it("reads the host out of a URL and refuses userinfo / scheme mismatch", () => {
    expect(targetHostOf("https", "https://intranet.example:8443/x")).toBe("intranet.example");
    expect(() => targetHostOf("https", "http://intranet.example")).toThrow(/https:\/\//);
    expect(() => targetHostOf("http", "http://u:p@intranet.example")).toThrow(/Credentials/);
    expect(() => targetHostOf("http", "not a url")).toThrow(/full URL/);
  });
  it("requires a port for tcp and forbids one for icmp", () => {
    expect(() => targetHostOf("tcp", "db01.example")).toThrow(/needs a port/);
    expect(() => targetHostOf("icmp", "10.0.0.1:22")).toThrow(/without a port/);
    expect(targetHostOf("tcp", "db01.example:5432")).toBe("db01.example");
  });
});

describe("normalizeCheckInput — refusals", () => {
  it.each([
    ["loopback", "http://127.0.0.1/"],
    ["localhost", "http://localhost/"],
    ["cloud metadata", "http://169.254.169.254/latest"],
    ["mapped loopback", "http://[::ffff:127.0.0.1]/"],
    ["ipv6", "http://[2001:db8::1]/"],
  ])("refuses %s", async (_label, target) => {
    await expect(normalizeCheckInput({ ...base, kind: "http", target })).rejects.toThrow();
  });
  it("refuses Polaris's own public host", async () => {
    const prev = process.env.POLARIS_PUBLIC_URL;
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.test";
    try {
      await expect(normalizeCheckInput({ ...base, target: "https://polaris.example.test/" })).rejects.toThrow(/this Polaris server/);
    } finally {
      if (prev === undefined) delete process.env.POLARIS_PUBLIC_URL; else process.env.POLARIS_PUBLIC_URL = prev;
    }
  });
  it("allows RFC1918 targets", async () => {
    const n = await normalizeCheckInput({ ...base, kind: "icmp", target: "10.20.30.1" });
    expect(n.target).toBe("10.20.30.1");
    expect(n.http).toBeNull();
  });
  it("requires an interval in whole minutes and a timeout ≤ half of it", async () => {
    await expect(normalizeCheckInput({ ...base, intervalSec: 90 })).rejects.toThrow(/whole number of minutes/);
    await expect(normalizeCheckInput({ ...base, intervalSec: 60, timeoutMs: 31000 })).rejects.toThrow();
    await expect(normalizeCheckInput({ ...base, intervalSec: 60, timeoutMs: 30001 })).rejects.toThrow();
    await expect(normalizeCheckInput({ ...base, intervalSec: 60, timeoutMs: 30000 })).resolves.toBeTruthy();
  });
  it("refuses a check that names no sources", async () => {
    await expect(normalizeCheckInput({ ...base, scope: {} })).rejects.toThrow(/Choose where this check runs/);
    await expect(normalizeCheckInput({ ...base, scope: {}, assetIds: ["a1"] })).resolves.toBeTruthy();
  });
  it("accepts the Polaris server as the only source", async () => {
    const n = await normalizeCheckInput({ ...base, scope: {}, runOnServer: true });
    expect(n.runOnServer).toBe(true);
    expect((await normalizeCheckInput({ ...base })).runOnServer).toBe(false);
  });
  it("refuses a JS-only body regex and a bad status spec", async () => {
    await expect(normalizeCheckInput({ ...base, http: { bodyMatch: { mode: "regex", pattern: "a(?=b)" } } })).rejects.toThrow(/RE2/);
    await expect(normalizeCheckInput({ ...base, http: { expectStatus: "2000" } })).rejects.toThrow(/Accepted status codes/);
  });
  it("defaults verifyTls ON for https and drops keepBodyExcerpt off http", async () => {
    const n = await normalizeCheckInput({ ...base });
    expect(n.http?.verifyTls).toBe(true);
    const icmp = await normalizeCheckInput({ ...base, kind: "icmp", target: "10.0.0.1", keepBodyExcerpt: true });
    expect(icmp.keepBodyExcerpt).toBe(false);
  });
  it("clamps traceroute settings into range", () => {
    expect(normalizeTraceroute({ everyNRuns: 0, maxHops: 500, probesPerHop: 9 })).toMatchObject({ everyNRuns: 1, maxHops: 64, probesPerHop: 5 });
  });
});

describe("agent definition + hash", () => {
  const row = {
    id: "c1", name: "Intranet", kind: "https", target: "https://intranet.example/", intervalSec: 60, timeoutMs: 5000,
    http: { expectStatus: "200", bodyMatch: { mode: "contains", pattern: "OK", caseSensitive: false }, verifyTls: true },
    traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000 },
    keepBodyExcerpt: false,
  };
  it("maps the stored http block to the flat wire shape", () => {
    const d = toAgentCheckDef(row);
    expect(d).toMatchObject({ expectStatus: "200", expectBody: { mode: "contains", value: "OK", caseSensitive: false }, verifyTls: true });
    expect(d.revision).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable across key order and changes when the target changes", () => {
    const reordered = { ...row, http: { verifyTls: true, bodyMatch: row.http.bodyMatch, expectStatus: "200" } };
    expect(definitionSha256(reordered)).toBe(definitionSha256(row));
    expect(definitionSha256({ ...row, target: "https://other.example/" })).not.toBe(definitionSha256(row));
  });
  it("ignores fields the agent does not receive", () => {
    expect(definitionSha256({ ...row, description: "x" } as any)).toBe(definitionSha256(row));
  });
  it("folds id + revision", () => {
    expect(pathCheckEtagFold([{ id: "a", revision: "r1" } as any, { id: "b", revision: "r2" } as any])).toBe("a:r1\u0001b:r2");
  });
});

describe("agentConfigChecks", () => {
  function seedCheck(id: string, enabled = true, createdAt = new Date()) {
    db.checks.push({
      id, name: id, enabled, kind: "icmp", target: "10.0.0.1", intervalSec: 60, timeoutMs: 1000,
      http: null, traceroute: { enabled: false }, keepBodyExcerpt: false, definitionSha256: `h-${id}`, createdAt, credentialId: null,
    });
    db.sources.push({ id: `s-${id}`, checkId: id, assetId: "host" });
  }
  it("ships nothing to an agent below the minimum version", async () => {
    seedCheck("c1");
    expect(await agentConfigChecks("host", "0.20.1")).toEqual([]);
    expect(await agentConfigChecks("host", null)).toEqual([]);
    expect(await agentConfigChecks("host", MIN_AGENT_PATH_CHECK_VERSION)).toHaveLength(1);
  });
  it("skips disabled checks and caps at MAX_CHECKS_PER_AGENT, oldest first", async () => {
    seedCheck("off", false);
    for (let i = 0; i < MAX_CHECKS_PER_AGENT + 3; i++) seedCheck(`c${i}`, true, new Date(1_000_000 + i));
    const defs = await agentConfigChecks("host", "0.21.0");
    expect(defs).toHaveLength(MAX_CHECKS_PER_AGENT);
    expect(defs[0].id).toBe("c0");
    expect(defs.some((d) => d.id === "off")).toBe(false);
  });
});

describe("reconcilePathCheckSources", () => {
  it("adds scope ∪ pins ∩ active agents, removes the rest, and nudges the changed agents", async () => {
    db.agents = [
      { id: "ma1", assetId: "a1", installStatus: "active", agentVersion: "0.21.0" },
      { id: "ma2", assetId: "a2", installStatus: "active", agentVersion: "0.21.0" },
      { id: "ma4", assetId: "a4", installStatus: "active", agentVersion: "0.21.0" },
    ];
    db.checks.push({
      id: "c1", name: "c1",
      scope: { condition: { op: "and", children: [{ field: "tag", operator: "equals", value: "branch" }] } },
      assetIds: ["a2", "a3"],
    });
    loadScopeAssetIds.mockResolvedValue(["a1", "a5"]); // a5 has no agent
    db.sources.push({ id: "old", checkId: "c1", assetId: "a4", explicit: false });

    const r = await reconcilePathCheckSources("c1");
    const members = db.sources.map((s) => `${s.assetId}:${s.explicit}`).sort();
    expect(members).toEqual(["a1:false", "a2:true"]);
    expect(r).toMatchObject({ added: 2, removed: 1 });
    const nudged = (publishConfigRefresh.mock.calls[0] as any)[0].sort();
    expect(nudged).toEqual(["ma1", "ma2", "ma4"]);
  });
  it("allAssets short-circuits to every active agent without loading the fleet", async () => {
    db.agents = [{ id: "ma1", assetId: "a1", installStatus: "active" }, { id: "ma9", assetId: "a9", installStatus: "pending" }];
    db.checks.push({ id: "c1", name: "c1", scope: { allAssets: true }, assetIds: [] });
    await reconcilePathCheckSources("c1");
    expect(loadScopeAssetIds).not.toHaveBeenCalled();
    expect(db.sources.map((s) => s.assetId)).toEqual(["a1"]);
  });
});

describe("agentOnline", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  it("is online with a live WS session", () => {
    expect(agentOnline({ wsConnectedAt: new Date(now - 1000), wsDisconnectedAt: null, lastSeenAt: null }, now)).toBe(true);
  });
  it("falls back to a recent bearer call", () => {
    expect(agentOnline({ wsConnectedAt: null, wsDisconnectedAt: null, lastSeenAt: new Date(now - 60_000) }, now)).toBe(true);
    expect(agentOnline({ wsConnectedAt: null, wsDisconnectedAt: null, lastSeenAt: new Date(now - 3_600_000) }, now)).toBe(false);
  });
});

describe("the Polaris server as a source", () => {
  it("reconciles exactly one assetId-NULL row while runOnServer, and drops it when turned off", async () => {
    db.checks.push({ id: "c1", name: "c1", scope: {}, assetIds: [], runOnServer: true });
    await reconcilePathCheckSources("c1");
    expect(db.sources.filter((s) => s.assetId === null)).toHaveLength(1);
    await reconcilePathCheckSources("c1");
    expect(db.sources.filter((s) => s.assetId === null)).toHaveLength(1);
    // The server row nudges no agent.
    expect(publishConfigRefresh).not.toHaveBeenCalled();
    db.checks[0].runOnServer = false;
    await reconcilePathCheckSources("c1");
    expect(db.sources).toHaveLength(0);
  });
  it("keeps agent membership beside the server row", async () => {
    db.agents = [{ id: "ma1", assetId: "a1", installStatus: "active" }];
    db.checks.push({ id: "c1", name: "c1", scope: { allAssets: true }, assetIds: [], runOnServer: true });
    await reconcilePathCheckSources("c1");
    expect(db.sources.map((s) => s.assetId).sort()).toEqual(["a1", null].sort());
  });
  it("uses a subject id that can never be an asset's UUID", () => {
    expect(POLARIS_SERVER_SUBJECT).not.toMatch(/^[0-9a-f]{8}-/);
  });
  it("hands the server job enabled server-run checks only, oldest first, in the agent's wire shape", async () => {
    const mk = (id: string, enabled: boolean, runOnServer: boolean, t: number) => {
      db.checks.push({
        id, name: id, enabled, runOnServer, kind: "icmp", target: "10.0.0.1", intervalSec: 60, timeoutMs: 1000,
        http: null, traceroute: { enabled: true }, keepBodyExcerpt: false, definitionSha256: `h-${id}`, createdAt: new Date(t),
      });
      db.sources.push({ id: `s-${id}`, checkId: id, assetId: null });
    };
    mk("new", true, true, 2);
    mk("old", true, true, 1);
    mk("off", false, true, 0);
    const defs = await serverCheckDefinitions();
    expect(defs.map((d) => d.id)).toEqual(["old", "new"]);
    expect(defs[0]).toMatchObject({ kind: "icmp", revision: "h-old", traceroute: { enabled: true } });
  });
});

describe("aiming the server needs networkScan:write too", () => {
  const serverInput = { ...base, scope: {}, runOnServer: true };
  it("refuses to CREATE a server-run check without it, and allows it with it", async () => {
    await expect(createCheck(serverInput, "alice")).rejects.toMatchObject({ httpStatus: 403 });
    await expect(createCheck(serverInput, "alice", { mayRunOnServer: false })).rejects.toMatchObject({ httpStatus: 403 });
    expect(db.checks).toHaveLength(0);
    await expect(createCheck(serverInput, "alice", { mayRunOnServer: true })).resolves.toMatchObject({ runOnServer: true });
  });
  it("an agent-only check needs nothing extra", async () => {
    await expect(createCheck({ ...base }, "alice")).resolves.toMatchObject({ runOnServer: false });
  });
  it("refuses to RE-AIM a server-run check without it, but allows a rename and turning the server off", async () => {
    const c = await createCheck(serverInput, "alice", { mayRunOnServer: true });
    await expect(updateCheck(c.id, { ...serverInput, target: "https://other.example/" }, "bob")).rejects.toMatchObject({ httpStatus: 403 });
    await expect(updateCheck(c.id, { ...serverInput, name: "Renamed" }, "bob")).resolves.toMatchObject({ name: "Renamed" });
    await expect(updateCheck(c.id, { ...serverInput, name: "Renamed", runOnServer: false, assetIds: ["a1"] }, "bob"))
      .resolves.toMatchObject({ runOnServer: false });
  });
  it("refuses to TURN ON the server for an existing check without it", async () => {
    const c = await createCheck({ ...base }, "alice");
    await expect(updateCheck(c.id, { ...base, runOnServer: true }, "bob")).rejects.toMatchObject({ httpStatus: 403 });
    await expect(updateCheck(c.id, { ...base, runOnServer: true }, "bob", { mayRunOnServer: true })).resolves.toMatchObject({ runOnServer: true });
  });
  it("refuses to RE-ENABLE a disabled server-run check without it", async () => {
    const c = await createCheck({ ...serverInput, enabled: false }, "alice", { mayRunOnServer: true });
    await expect(setCheckEnabled(c.id, true, "bob")).rejects.toMatchObject({ httpStatus: 403 });
    await expect(setCheckEnabled(c.id, true, "bob", { mayRunOnServer: true })).resolves.toMatchObject({ enabled: true });
    // Disabling never needs it.
    await expect(setCheckEnabled(c.id, false, "bob")).resolves.toMatchObject({ enabled: false });
  });
});

describe("testCheck — a draft run once from the server", () => {
  beforeEach(() => { _resetTestRunLimiter(); runServerCheck.mockClear(); });
  const draft = { name: "", kind: "https" as const, target: "https://intranet.example/health", scope: {} };
  it("needs networkScan:write, like aiming the server", async () => {
    await expect(testCheck(draft, "alice")).rejects.toMatchObject({ httpStatus: 403 });
    expect(runServerCheck).not.toHaveBeenCalled();
  });
  it("runs the draft with no name or Sources, keeps the excerpt, never traces, and hands back what came back", async () => {
    const r = await testCheck(draft, "alice", { mayRunOnServer: true });
    const [def, mode] = runServerCheck.mock.calls[0] as any[];
    expect(mode).toBe("never");
    expect(def).toMatchObject({ id: "test", target: "https://intranet.example/health", keepBodyExcerpt: true, traceroute: { enabled: false } });
    expect(r).toMatchObject({ source: "server", sample: { ok: true, httpStatus: 200 }, headers: { "content-type": "application/json" }, body: '{"status":"UP"}', httpVersion: "1.1" });
    expect((logEvent.mock.calls.at(-1) as any)[0]).toMatchObject({ action: "path_check.tested", actor: "alice", details: { ok: true, httpStatus: 200 } });
    expect(db.checks).toHaveLength(0); // nothing stored
  });
  it("still refuses a target the save path would refuse", async () => {
    await expect(testCheck({ ...draft, target: "http://127.0.0.1/" , kind: "http" }, "alice", { mayRunOnServer: true })).rejects.toMatchObject({ httpStatus: 400 });
  });
  it("is rate-limited per caller", async () => {
    for (let i = 0; i < TEST_RUNS_PER_MINUTE; i++) await testCheck(draft, "bob", { mayRunOnServer: true });
    await expect(testCheck(draft, "bob", { mayRunOnServer: true })).rejects.toMatchObject({ httpStatus: 429 });
    await expect(testCheck(draft, "carol", { mayRunOnServer: true })).resolves.toBeTruthy();
  });
});

describe("request options — validation and the wire", () => {
  it("accepts GET / HEAD and refuses anything that writes", async () => {
    expect((await normalizeCheckInput({ ...base, http: { method: "HEAD" } })).http).toMatchObject({ method: "HEAD" });
    await expect(normalizeCheckInput({ ...base, http: { method: "POST" as any } })).rejects.toThrow(/GET or HEAD/);
    await expect(normalizeCheckInput({ ...base, http: { method: "HEAD", bodyMatch: { mode: "contains", pattern: "ok" } } })).rejects.toThrow(/HEAD request has no body/);
  });
  it("normalizes a Host header and refuses a malformed one", () => {
    expect(normalizeHostHeader("  App.Example:8443 ")).toBe("app.example:8443");
    expect(normalizeHostHeader("")).toBeNull();
    for (const bad of ["a b", "a.example/x", "a.example\r\nX: 1", "a.example:0", "a.example:70000", "user@a.example"]) {
      expect(() => normalizeHostHeader(bad)).toThrow();
    }
  });
  it("keeps an old definition's hash: defaults are never written to the wire", async () => {
    const n = await normalizeCheckInput({ ...base, http: { method: "GET", hostHeader: "", followRedirects: false } });
    expect(Object.keys(n.http!).sort()).toEqual(["bodyMatch", "expectStatus", "verifyTls"]);
    const row = { id: "c1", name: "c", kind: "https", target: base.target, intervalSec: 60, timeoutMs: 5000, http: n.http, traceroute: {}, keepBodyExcerpt: false };
    const d = toAgentCheckDef(row);
    expect("method" in d || "hostHeader" in d || "followRedirects" in d).toBe(false);
  });
  it("ships the options, and asks for agent 0.23.0 when any is used", async () => {
    const n = await normalizeCheckInput({ ...base, http: { hostHeader: "x.example", followRedirects: true, bodyMatch: { mode: "contains", pattern: "err", negate: true } } });
    const d = toAgentCheckDef({ id: "c1", name: "c", kind: "https", target: base.target, intervalSec: 60, timeoutMs: 5000, http: n.http, traceroute: {}, keepBodyExcerpt: false });
    expect(d).toMatchObject({ hostHeader: "x.example", followRedirects: true, expectBody: { negate: true } });
    expect(requiredAgentVersion(d)).toBe(MIN_AGENT_REQUEST_OPTIONS_VERSION);
    expect(requiredAgentVersion({ expectBody: null })).toBe(MIN_AGENT_PATH_CHECK_VERSION);
  });
  it("does not ship an options-using check to an older agent", async () => {
    db.checks.push({
      id: "opt", name: "opt", enabled: true, kind: "https", target: "https://x.example/", intervalSec: 60, timeoutMs: 1000, credentialId: null,
      http: { expectStatus: "", bodyMatch: null, verifyTls: true, method: "HEAD" }, traceroute: { enabled: false }, keepBodyExcerpt: false, definitionSha256: "h", createdAt: new Date(),
    });
    db.sources.push({ id: "s-opt", checkId: "opt", assetId: "host" });
    expect(await agentConfigChecks("host", "0.22.1")).toEqual([]);
    expect((await agentConfigChecks("host", "0.23.0")).map((d) => d.id)).toEqual(["opt"]);
  });
});

describe("authentication — server-only, and only with a credential you may use", () => {
  const cred = (id: string, over: any = {}) => ({ id, type: "http", createdBy: "alice", config: { authMode: "basic", username: "u", password: "p" }, ...over });
  const input = (credentialId: string) => ({ ...base, scope: {}, credentialId });

  it("accepts an http Bearer / Basic / Digest credential and makes the check server-only", async () => {
    db.credentials = [cred("c-basic"), cred("c-digest", { config: { authMode: "digest", username: "u", password: "p" } }), cred("c-bearer", { config: { apiToken: "t" } })];
    for (const id of ["c-basic", "c-digest", "c-bearer"]) {
      expect(await normalizeCheckInput(input(id))).toMatchObject({ credentialId: id, runOnServer: true });
    }
  });
  it("refuses a missing, non-http or device-login credential, a non-HTTP kind, and agent hosts beside it", async () => {
    db.credentials = [cred("snmp", { type: "snmp" }), cred("form", { config: { authMode: "form", username: "u", password: "p" } }), cred("ok")];
    await expect(normalizeCheckInput(input("gone"))).rejects.toThrow(/no longer exists/);
    await expect(normalizeCheckInput(input("snmp"))).rejects.toThrow(/Bearer, Basic or Digest/);
    await expect(normalizeCheckInput(input("form"))).rejects.toThrow(/Bearer, Basic or Digest/);
    await expect(normalizeCheckInput({ ...input("ok"), kind: "tcp", target: "db:5432" })).rejects.toThrow(/Only an HTTP or HTTPS check/);
    await expect(normalizeCheckInput({ ...input("ok"), scope: { allAssets: true } })).rejects.toThrow(/runs only from this Polaris server/);
    await expect(normalizeCheckInput({ ...input("ok"), assetIds: ["a1"] })).rejects.toThrow(/runs only from this Polaris server/);
  });
  it("lets a caller use only a credential they created (write), or any (fullwrite), never at read", async () => {
    db.credentials = [cred("mine", { createdBy: "alice" }), cred("theirs", { createdBy: "bob" }), cred("unowned", { createdBy: null })];
    const as = (credentialAccess: any, username = "alice") => ({ mayRunOnServer: true, credentialAccess, username });
    await expect(createCheck({ ...input("mine"), name: "a" }, "alice", as("read"))).rejects.toMatchObject({ httpStatus: 403 });
    await expect(createCheck({ ...input("theirs"), name: "b" }, "alice", as("write"))).rejects.toMatchObject({ httpStatus: 403 });
    await expect(createCheck({ ...input("unowned"), name: "c" }, "alice", as("write"))).rejects.toMatchObject({ httpStatus: 403 });
    await expect(createCheck({ ...input("mine"), name: "d" }, "alice", as("write"))).resolves.toMatchObject({ credentialId: "mine" });
    await expect(createCheck({ ...input("theirs"), name: "e" }, "alice", as("fullwrite"))).resolves.toMatchObject({ credentialId: "theirs" });
  });
  it("re-checks the use when the credential changes or the check is re-aimed, not on a rename", async () => {
    db.credentials = [cred("theirs", { createdBy: "bob" })];
    const c = await createCheck({ ...input("theirs"), name: "x" }, "admin", { mayRunOnServer: true, credentialAccess: "fullwrite" });
    const alice = { mayRunOnServer: true, credentialAccess: "write" as const, username: "alice" };
    await expect(updateCheck(c.id, { ...input("theirs"), name: "renamed" }, "alice", alice)).resolves.toMatchObject({ name: "renamed" });
    await expect(updateCheck(c.id, { ...input("theirs"), name: "renamed", target: "https://attacker.example/" }, "alice", alice)).rejects.toMatchObject({ httpStatus: 403 });
  });
  it("never ships an authenticating check to an agent, even with a stray agent source row", async () => {
    db.checks.push({
      id: "auth", name: "auth", enabled: true, kind: "https", target: "https://x.example/", intervalSec: 60, timeoutMs: 1000, credentialId: "c1",
      http: { expectStatus: "", bodyMatch: null, verifyTls: true }, traceroute: { enabled: false }, keepBodyExcerpt: false, definitionSha256: "h", createdAt: new Date(),
    });
    db.sources.push({ id: "stray", checkId: "auth", assetId: "host" });
    expect(await agentConfigChecks("host", "0.23.0")).toEqual([]);
  });
  it("reconciles no agent member for an authenticating check, whatever its stored scope", async () => {
    db.agents = [{ id: "ma1", assetId: "a1", installStatus: "active" }];
    db.checks.push({ id: "auth", name: "auth", scope: { allAssets: true }, assetIds: ["a1"], runOnServer: true, credentialId: "c1" });
    await reconcilePathCheckSources("auth");
    expect(db.sources.map((s) => s.assetId)).toEqual([null]);
  });
});
