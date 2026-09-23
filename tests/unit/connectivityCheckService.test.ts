/**
 * tests/unit/connectivityCheckService.test.ts — agent-run connectivity checks:
 * validation (target refusal, status spec, RE2-safe regex, interval / timeout),
 * the agent-facing definition + its hash, the ETag fold, the version gate, and
 * the set-based membership reconcile (scope ∪ pins ∩ active agents).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  checks: [] as any[],
  sources: [] as any[],
  agents: [] as any[],
  settings: new Map<string, unknown>(),
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
    connectivityCheck: {
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
    connectivityCheckSource: {
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
  connectivityEtagFold,
  reconcileConnectivityCheckSources,
  agentOnline,
  normalizeTraceroute,
  MIN_AGENT_CONNECTIVITY_VERSION,
  MAX_CHECKS_PER_AGENT,
} from "../../src/services/connectivityCheckService.js";
import { parseStatusSpec, statusInRanges, agentRegexProblem } from "../../src/utils/httpCheck.js";

const base = { name: "Intranet", kind: "https" as const, target: "https://intranet.example/health", scope: { allAssets: true } };

beforeEach(() => {
  db.checks = [];
  db.sources = [];
  db.agents = [];
  db.settings.clear();
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
    await expect(normalizeCheckInput({ ...base, scope: {} })).rejects.toThrow(/Choose which agent hosts/);
    await expect(normalizeCheckInput({ ...base, scope: {}, assetIds: ["a1"] })).resolves.toBeTruthy();
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
    expect(connectivityEtagFold([{ id: "a", revision: "r1" } as any, { id: "b", revision: "r2" } as any])).toBe("a:r1\u0001b:r2");
  });
});

describe("agentConfigChecks", () => {
  function seedCheck(id: string, enabled = true, createdAt = new Date()) {
    db.checks.push({
      id, name: id, enabled, kind: "icmp", target: "10.0.0.1", intervalSec: 60, timeoutMs: 1000,
      http: null, traceroute: { enabled: false }, keepBodyExcerpt: false, definitionSha256: `h-${id}`, createdAt,
    });
    db.sources.push({ id: `s-${id}`, checkId: id, assetId: "host" });
  }
  it("ships nothing to an agent below the minimum version", async () => {
    seedCheck("c1");
    expect(await agentConfigChecks("host", "0.20.1")).toEqual([]);
    expect(await agentConfigChecks("host", null)).toEqual([]);
    expect(await agentConfigChecks("host", MIN_AGENT_CONNECTIVITY_VERSION)).toHaveLength(1);
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

describe("reconcileConnectivityCheckSources", () => {
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

    const r = await reconcileConnectivityCheckSources("c1");
    const members = db.sources.map((s) => `${s.assetId}:${s.explicit}`).sort();
    expect(members).toEqual(["a1:false", "a2:true"]);
    expect(r).toMatchObject({ added: 2, removed: 1 });
    const nudged = (publishConfigRefresh.mock.calls[0] as any)[0].sort();
    expect(nudged).toEqual(["ma1", "ma2", "ma4"]);
  });
  it("allAssets short-circuits to every active agent without loading the fleet", async () => {
    db.agents = [{ id: "ma1", assetId: "a1", installStatus: "active" }, { id: "ma9", assetId: "a9", installStatus: "pending" }];
    db.checks.push({ id: "c1", name: "c1", scope: { allAssets: true }, assetIds: [] });
    await reconcileConnectivityCheckSources("c1");
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
