/**
 * tests/unit/agentCommandExpiry.test.ts — business rule 155: a queued agent
 * command is good for AGENT_COMMAND_TTL_MS, then it is withdrawn and never
 * runs; its script run is settled; finished command rows age out.
 *
 * The incident shape pinned here: a remediation script queued for an agent
 * that was offline must NOT be handed to that agent when it reconnects hours
 * later.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = { commands: [] as any[], runs: [] as any[], events: [] as any[] };

/** Just enough of Prisma's `where` for the shapes this service sends. */
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    const v = row[key];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return v === cond;
    const c = cond as any;
    if ("in" in c) return c.in.includes(v);
    if ("lt" in c) return v != null && v.getTime() < c.lt.getTime();
    if ("gte" in c) return v != null && v.getTime() >= c.gte.getTime();
    if ("not" in c) return v !== c.not;
    throw new Error(`unsupported where for ${key}: ${JSON.stringify(cond)}`);
  });
}

function table(rows: () => any[]) {
  return {
    findMany: vi.fn(async ({ where, take }: any = {}) => {
      const hit = rows().filter((r) => matches(r, where)).map((r) => ({ ...r }));
      return take ? hit.slice(0, take) : hit;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hit = rows().filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const all = rows();
      const keep = all.filter((r) => !matches(r, where));
      const count = all.length - keep.length;
      all.splice(0, all.length, ...keep);
      return { count };
    }),
  };
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    agentCommand: table(() => db.commands),
    automationScriptRun: table(() => db.runs),
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { db.events.push(e); }),
}));
vi.mock("../../src/services/automationScriptService.js", () => ({ SCRIPT_OUTPUT_CAP_BYTES: 65536 }));

import {
  AGENT_COMMAND_TTL_MS,
  AGENT_RUN_RESULT_GRACE_MS,
  AGENT_COMMAND_RETENTION_DAYS,
  commandExpiryCutoff,
  fetchPendingCommands,
  expireStaleAgentCommands,
  pruneOldAgentCommands,
} from "../../src/services/agentCommandService.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const DAY = 24 * 3600 * 1000;

function command(over: Record<string, unknown> = {}): any {
  const c = { id: `c${db.commands.length + 1}`, managedAgentId: "agent-1", assetId: "asset-1", action: "run_script", target: "fix.sh", payload: { body: "echo hi" }, status: "pending", requestedAt: NOW, ...over };
  db.commands.push(c);
  return c;
}
function run(over: Record<string, unknown> = {}): any {
  const r = { id: `r${db.runs.length + 1}`, runOn: "agent", status: "pending", scriptId: "s1", scriptName: "fix.sh", ruleId: "rule-1", notificationId: "n1", assetId: "asset-1", requestedBy: "system:automation", requestedAt: NOW, startedAt: null, timeoutSec: 60, agentCommandId: null, ...over };
  db.runs.push(r);
  return r;
}

beforeEach(() => {
  db.commands.length = 0;
  db.runs.length = 0;
  db.events.length = 0;
});

describe("commandExpiryCutoff", () => {
  it("is exactly the TTL before now", () => {
    expect(commandExpiryCutoff(NOW).getTime()).toBe(NOW.getTime() - AGENT_COMMAND_TTL_MS);
  });
});

describe("fetchPendingCommands (the gate)", () => {
  it("never hands an agent a command older than the TTL, swept or not", async () => {
    const fresh = command({ requestedAt: ago(AGENT_COMMAND_TTL_MS - MIN) });
    const stale = command({ requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });
    const daysOld = command({ requestedAt: ago(3 * DAY) });

    const got = await fetchPendingCommands("agent-1", NOW);

    expect(got.map((c) => c.id)).toEqual([fresh.id]);
    expect(fresh.status).toBe("sent");
    // The reconnecting host gets nothing old — and the rows were not marked sent.
    expect(stale.status).toBe("pending");
    expect(daysOld.status).toBe("pending");
  });

  it("applies to every action, a reboot included", async () => {
    command({ action: "reboot", payload: null, requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });
    expect(await fetchPendingCommands("agent-1", NOW)).toEqual([]);
  });

  it("marks a delivered script's run as running", async () => {
    const c = command();
    const r = run({ agentCommandId: c.id });
    await fetchPendingCommands("agent-1", NOW);
    expect(r.status).toBe("running");
  });
});

describe("expireStaleAgentCommands (the settlement)", () => {
  it("withdraws an expired command and fails its run with one audit Event", async () => {
    const c = command({ requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });
    const r = run({ agentCommandId: c.id, requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });

    const res = await expireStaleAgentCommands(NOW);

    expect(res).toEqual({ commands: 1, runs: 1, stuck: 0 });
    expect(c.status).toBe("failed");
    expect(c.error).toMatch(/expired/);
    expect(c.completedAt).toEqual(NOW);
    expect(r.status).toBe("failed");
    expect(r.stderr).toMatch(/withdrawn and will not run/);
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({ action: "automation.script.run", level: "warning", details: { runId: r.id, reason: "expired", ruleId: "rule-1" } });
  });

  it("leaves a command inside its window alone", async () => {
    const c = command({ requestedAt: ago(AGENT_COMMAND_TTL_MS - MIN) });
    const r = run({ agentCommandId: c.id, requestedAt: ago(AGENT_COMMAND_TTL_MS - MIN) });
    expect(await expireStaleAgentCommands(NOW)).toEqual({ commands: 0, runs: 0, stuck: 0 });
    expect(c.status).toBe("pending");
    expect(r.status).toBe("pending");
    expect(db.events).toHaveLength(0);
  });

  it("settles a pending agent run whose command row is gone or was never written", async () => {
    const r = run({ agentCommandId: null, requestedAt: ago(2 * DAY) });
    const res = await expireStaleAgentCommands(NOW);
    expect(res.runs).toBe(1);
    expect(r.status).toBe("failed");
  });

  it("never touches a server-side run — the runner owns those", async () => {
    const r = run({ runOn: "server", requestedAt: ago(2 * DAY) });
    await expireStaleAgentCommands(NOW);
    expect(r.status).toBe("pending");
  });

  it("times out a run the agent took but never reported, and fails its command", async () => {
    const c = command({ status: "sent", requestedAt: ago(30 * MIN) });
    const r = run({ agentCommandId: c.id, status: "running", timeoutSec: 60, startedAt: ago(60_000 + AGENT_RUN_RESULT_GRACE_MS + MIN) });
    const stillWithin = run({ status: "running", timeoutSec: 60, startedAt: ago(60_000 + AGENT_RUN_RESULT_GRACE_MS - MIN) });

    const res = await expireStaleAgentCommands(NOW);

    expect(res.stuck).toBe(1);
    expect(r.status).toBe("timeout");
    expect(r.stderr).toMatch(/never reported/);
    expect(c.status).toBe("failed");
    expect(stillWithin.status).toBe("running");
  });

  it("is idempotent — a second sweep finds nothing and writes no second Event", async () => {
    const c = command({ requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });
    run({ agentCommandId: c.id, requestedAt: ago(AGENT_COMMAND_TTL_MS + MIN) });
    await expireStaleAgentCommands(NOW);
    expect(await expireStaleAgentCommands(NOW)).toEqual({ commands: 0, runs: 0, stuck: 0 });
    expect(db.events).toHaveLength(1);
  });
});

describe("pruneOldAgentCommands (the retention)", () => {
  it("deletes finished commands past the window and keeps the rest", async () => {
    const old = AGENT_COMMAND_RETENTION_DAYS * DAY + DAY;
    command({ id: "old-failed", status: "failed", requestedAt: ago(old) });
    command({ id: "old-succeeded", status: "succeeded", requestedAt: ago(old) });
    command({ id: "old-sent", status: "sent", requestedAt: ago(old) });
    command({ id: "recent", status: "succeeded", requestedAt: ago(DAY) });

    expect(await pruneOldAgentCommands(NOW)).toBe(3);
    expect(db.commands.map((c) => c.id)).toEqual(["recent"]);
  });
});
