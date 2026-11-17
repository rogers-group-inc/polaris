/**
 * tests/unit/automationScriptService.test.ts — own suite for
 * src/services/automationScriptService.ts (CQ-T010).
 *
 * automationScripts.test.ts drives the registry against an in-memory fake and
 * runs real interpreters. This file pins the service's own contract call by
 * call on the shared Prisma stub:
 *
 *  - validation: every 400 (name, interpreter, run target, body, the 64 KB
 *    byte cap counted in UTF-8, timeout bounds);
 *  - sha256 recomputed server-side on every save; creation and a BODY change
 *    are warning Events carrying the hashes; a non-body edit is info;
 *  - delete: 404, the rule-167 409 naming the referrers, the warning Event;
 *  - requestScriptRun: disabled 409, run-target 400, the agent preflight
 *    (no asset / no agent / not active / too old → 409, and no run row),
 *    the run snapshot, the timeout cap, the run_script command + link + wake;
 *  - getRun / listRuns / pruneOldRuns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ referrers: vi.fn(), wake: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/actionReferenceService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  scriptReferrers: h.referrers,
}));
vi.mock("../../src/services/agentCommandWake.js", () => ({ publishCommandWake: h.wake }));

import { createHash } from "node:crypto";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  MAX_SCRIPT_BODY_BYTES,
  MAX_SCRIPT_TIMEOUT_SEC,
  MIN_AGENT_SCRIPT_VERSION,
  SCRIPT_RUN_TARGET_VALUES,
  createScript,
  deleteScript,
  getRun,
  getScript,
  listRuns,
  listScripts,
  pruneOldRuns,
  requestScriptRun,
  MAX_SCRIPT_EMAIL_RECIPIENTS,
  sha256Hex,
  updateScript,
  type ScriptInput,
} from "../../src/services/automationScriptService.js";

const input = (over: Partial<ScriptInput> = {}): ScriptInput => ({
  name: "restart-spooler", interpreter: "powershell", body: "Restart-Service Spooler", runTarget: "agent", ...over,
});

const STORED = {
  id: "s1", name: "restart-spooler", description: null, interpreter: "powershell", body: "Restart-Service Spooler",
  runTarget: "either", timeoutSec: 120, sha256: sha256Hex("Restart-Service Spooler"), enabled: true,
};

async function rejects(p: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0];

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.referrers.mockReset().mockResolvedValue([]);
  h.wake.mockReset().mockResolvedValue(undefined);
  stubbed(prisma.automationScript.create).mockImplementation(async ({ data }: { data: object }) => ({ id: "s-new", ...data }));
  stubbed(prisma.automationScript.update).mockImplementation(async ({ where, data }: { where: { id: string }; data: object }) => ({ ...STORED, id: where.id, ...data }));
  stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED });
  stubbed(prisma.automationScriptRun.create).mockImplementation(async ({ data }: { data: object }) => ({ id: "run-1", ...data }));
  stubbed(prisma.agentCommand.create).mockResolvedValue({ id: "cmd-1" });
});

describe("sha256Hex and the constants", () => {
  it("hashes the UTF-8 body as lowercase hex", () => {
    expect(sha256Hex("é")).toBe(createHash("sha256").update(Buffer.from("é", "utf8")).digest("hex"));
    expect(sha256Hex("")).toMatch(/^e3b0c442/);
  });

  it("caps body at 64 KB and timeout at 600 s, with three run targets", () => {
    expect(MAX_SCRIPT_BODY_BYTES).toBe(65_536);
    expect(MAX_SCRIPT_TIMEOUT_SEC).toBe(600);
    expect([...SCRIPT_RUN_TARGET_VALUES]).toEqual(["server", "agent", "either"]);
    expect(MIN_AGENT_SCRIPT_VERSION).toBe("0.13.0");
  });
});

describe("validation (create and update)", () => {
  it.each([
    ["a blank name", { name: "   " }, /name is required/],
    ["an unknown interpreter", { interpreter: "ruby" as never }, /Unknown interpreter "ruby"/],
    ["an unknown run target", { runTarget: "cluster" as never }, /Unknown run target "cluster"/],
    ["an empty body", { body: "" }, /body is required/],
    ["a whitespace body", { body: " \n\t" }, /body is required/],
    ["a zero timeout", { timeoutSec: 0 }, /timeoutSec must be 1–600/],
    ["a timeout over the cap", { timeoutSec: 601 }, /timeoutSec/],
    ["a fractional timeout", { timeoutSec: 1.5 }, /timeoutSec/],
  ])("refuses %s with 400 and writes nothing", async (_l, over, msg) => {
    await rejects(createScript(input(over)), 400, msg);
    expect(prisma.automationScript.create).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("counts the body cap in UTF-8 bytes, not characters", async () => {
    await expect(createScript(input({ body: "a".repeat(MAX_SCRIPT_BODY_BYTES) }))).resolves.toBeTruthy();
    // 32 769 two-byte characters = 65 538 bytes, though only 32 769 chars.
    await rejects(createScript(input({ body: "é".repeat(32_769) })), 400, /exceeds 64 KB/);
  });

  it("accepts the timeout bounds and a null timeout (the 60 s default)", async () => {
    for (const t of [1, 600, null, undefined]) await expect(createScript(input({ timeoutSec: t }))).resolves.toBeTruthy();
  });

  it("validates an update too, after confirming the script exists", async () => {
    await rejects(updateScript("s1", input({ body: "" })), 400);
    expect(prisma.automationScript.update).not.toHaveBeenCalled();
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    await rejects(updateScript("nope", input({ body: "" })), 404, /not found/);
  });
});

describe("createScript", () => {
  it("trims the name, defaults timeout / enabled / description, hashes server-side and stamps the creator", async () => {
    const s = await createScript(input({ name: "  restart-spooler  " }), "alice");
    expect(stubbed(prisma.automationScript.create).mock.calls[0]![0].data).toEqual({
      name: "restart-spooler", description: null, interpreter: "powershell", body: "Restart-Service Spooler",
      runTarget: "agent", timeoutSec: 60, sha256: sha256Hex("Restart-Service Spooler"), enabled: true, createdBy: "alice",
    });
    expect(s.id).toBe("s-new");
  });

  it("writes a WARNING Event carrying the hash (RCE surface)", async () => {
    await createScript(input({ enabled: false, timeoutSec: 30 }));
    expect(lastEvent()).toMatchObject({
      action: "automation_script.created", resourceType: "automation-script", resourceId: "s-new",
      resourceName: "restart-spooler", level: "warning",
      message: 'Automation script "restart-spooler" created (powershell, agent)',
      details: { interpreter: "powershell", runTarget: "agent", sha256: sha256Hex("Restart-Service Spooler") },
    });
    expect(stubbed(prisma.automationScript.create).mock.calls[0]![0].data).toMatchObject({ enabled: false, timeoutSec: 30, createdBy: null });
  });
});

describe("updateScript", () => {
  it("a BODY change is a warning Event with the old and new hash", async () => {
    await updateScript("s1", input({ body: "Stop-Service Spooler" }), "bob");
    expect(stubbed(prisma.automationScript.update).mock.calls[0]![0].data.sha256).toBe(sha256Hex("Stop-Service Spooler"));
    expect(lastEvent()).toMatchObject({
      action: "automation_script.updated", level: "warning", actor: "bob",
      message: 'Automation script "restart-spooler" BODY changed',
      details: { oldSha256: STORED.sha256, newSha256: sha256Hex("Stop-Service Spooler") },
    });
  });

  it("an edit that leaves the body alone is info, and keeps the stored timeout / enabled when omitted", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED, enabled: false });
    await updateScript("s1", input({ name: "renamed", description: "d" }));
    expect(stubbed(prisma.automationScript.update).mock.calls[0]![0]).toEqual({
      where: { id: "s1" },
      data: {
        name: "renamed", description: "d", interpreter: "powershell", body: STORED.body, runTarget: "agent",
        timeoutSec: 120, sha256: STORED.sha256, enabled: false,
      },
    });
    expect(lastEvent()).toMatchObject({ level: "info", message: 'Automation script "renamed" updated', details: { sha256: STORED.sha256 } });
  });

  it("recomputes the hash rather than trusting the stored one", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED, sha256: "tampered" });
    await updateScript("s1", input());
    expect(stubbed(prisma.automationScript.update).mock.calls[0]![0].data.sha256).toBe(STORED.sha256);
    expect(lastEvent()).toMatchObject({ level: "warning", details: { oldSha256: "tampered", newSha256: STORED.sha256 } });
  });
});

describe("getScript / listScripts", () => {
  it("lists by name", async () => {
    stubbed(prisma.automationScript.findMany).mockResolvedValue([STORED]);
    expect(await listScripts()).toEqual([STORED]);
    expect(stubbed(prisma.automationScript.findMany).mock.calls[0]![0]).toEqual({ orderBy: { name: "asc" } });
  });

  it("404s an unknown id", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    await rejects(getScript("x"), 404, /Automation script not found/);
  });
});

describe("deleteScript", () => {
  it("deletes an unreferenced script with a warning Event carrying its hash", async () => {
    await deleteScript("s1", "carol");
    expect(h.referrers).toHaveBeenCalledWith("s1");
    expect(prisma.automationScript.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(lastEvent()).toMatchObject({
      action: "automation_script.deleted", resourceId: "s1", resourceName: "restart-spooler", actor: "carol",
      level: "warning", details: { sha256: STORED.sha256 },
    });
  });

  it("refuses with 409 naming the one referrer (rule 167)", async () => {
    h.referrers.mockResolvedValue(['automation "Spooler down"']);
    await rejects(deleteScript("s1"), 409, /still used by automation "Spooler down"\. Remove it from that first\./);
    expect(prisma.automationScript.delete).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("summarises many referrers and says 'those'", async () => {
    h.referrers.mockResolvedValue(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]);
    await rejects(deleteScript("s1"), 409, /a1, a2, a3, a4, a5, … \(\+2 more\)\. Remove it from those first\./);
  });

  it("404s an unknown id before asking who references it", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    await rejects(deleteScript("x"), 404);
    expect(h.referrers).not.toHaveBeenCalled();
  });
});

describe("requestScriptRun — server", () => {
  const req = { scriptId: "s1", runOn: "server" as const, args: "--fast", requestedBy: "automation:r1" };

  it("creates a pending run snapshotting name / hash and the script's timeout, with no command", async () => {
    expect(await requestScriptRun({ ...req, notificationId: "n1", ruleId: "r1", assetId: "a1" })).toEqual({ runId: "run-1" });
    expect(stubbed(prisma.automationScriptRun.create).mock.calls[0]![0].data).toEqual({
      scriptId: "s1", scriptName: "restart-spooler", sha256: STORED.sha256, notificationId: "n1", ruleId: "r1",
      assetId: "a1", runOn: "server", args: "--fast", timeoutSec: 120, requestedBy: "automation:r1",
    });
    expect(prisma.agentCommand.create).not.toHaveBeenCalled();
    expect(prisma.managedAgent.findUnique).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("takes the action's timeout override but caps it at 600 s, and nulls absent links", async () => {
    await requestScriptRun({ ...req, timeoutSec: 30 });
    expect(stubbed(prisma.automationScriptRun.create).mock.calls[0]![0].data).toMatchObject({ timeoutSec: 30, notificationId: null, ruleId: null, assetId: null });
    await requestScriptRun({ ...req, timeoutSec: 9999 });
    expect(stubbed(prisma.automationScriptRun.create).mock.calls[1]![0].data.timeoutSec).toBe(600);
  });

  it("reads a timeout override of zero, below zero or non-finite as no override", async () => {
    // Was a bug until 2026-11-16: `??` kept a 0 (or negative) override, queuing a zero-second run.
    for (const [i, t] of [0, -10, Number.NaN].entries()) {
      await requestScriptRun({ ...req, timeoutSec: t });
      expect(stubbed(prisma.automationScriptRun.create).mock.calls[i]![0].data.timeoutSec).toBe(STORED.timeoutSec);
    }
  });

  it("refuses a disabled script with 409 and a target mismatch with 400, creating nothing", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED, enabled: false });
    await rejects(requestScriptRun(req), 409, /is disabled/);
    stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED, runTarget: "agent" });
    await rejects(requestScriptRun(req), 400, /only runs on agent; action requested server/);
    expect(prisma.automationScriptRun.create).not.toHaveBeenCalled();
  });

  it("404s an unknown script", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    await rejects(requestScriptRun(req), 404);
  });

  it("snapshots the email channels and resolved To / Cc / Bcc, de-duplicated across the lists (rule 190(a))", async () => {
    await requestScriptRun({
      ...req,
      email: {
        channelIds: ["c1", "c1", "c2"],
        to: [" Certs@Example.com ", "certs@example.com", "ops@example.com"],
        cc: ["ops@example.com", "audit@example.com"],
        bcc: ["AUDIT@example.com", "hidden@example.com"],
      },
    });
    expect(stubbed(prisma.automationScriptRun.create).mock.calls[0]![0].data).toMatchObject({
      emailChannelIds: ["c1", "c2"],
      emailTo: ["certs@example.com", "ops@example.com"],
      emailCc: ["audit@example.com"],
      emailBcc: ["hidden@example.com"],
    });
  });

  it("refuses an email block whose To is empty, or that resolved past the recipient cap, creating nothing", async () => {
    await rejects(requestScriptRun({ ...req, email: { channelIds: ["c1"], to: [], cc: ["a@example.com"] } }), 422, /resolved to no address/);
    const many = Array.from({ length: MAX_SCRIPT_EMAIL_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`);
    await rejects(requestScriptRun({ ...req, email: { channelIds: ["c1"], to: many } }), 422, /at most 200/);
    expect(prisma.automationScriptRun.create).not.toHaveBeenCalled();
  });
});

describe("requestScriptRun — agent", () => {
  const req = { scriptId: "s1", runOn: "agent" as const, args: null, assetId: "a1", requestedBy: "alice" };
  const agent = (over: Record<string, unknown> = {}) => ({ id: "ma-1", installStatus: "active", agentVersion: "0.30.2", ...over });

  it.each([
    ["no asset on the alert", { assetId: null }, null, /this alert has no asset/],
    ["no agent on the asset", {}, null, /has no Polaris Agent/],
    ["an inactive agent", {}, agent({ installStatus: "pending" }), /isn't active/],
    ["an agent too old for run_script", {}, agent({ agentVersion: "0.12.9" }), /is 0\.12\.9 — script execution needs 0\.13\.0\+/],
    ["an agent with no version", {}, agent({ agentVersion: null }), /is unknown — script execution needs/],
  ])("refuses %s with 409 BEFORE creating a run row", async (_l, over, row, msg) => {
    stubbed(prisma.managedAgent.findUnique).mockResolvedValue(row);
    await rejects(requestScriptRun({ ...req, ...over }), 409, msg);
    expect(prisma.automationScriptRun.create).not.toHaveBeenCalled();
    expect(prisma.agentCommand.create).not.toHaveBeenCalled();
  });

  it("refuses a server-only script on the agent with 400", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue({ ...STORED, runTarget: "server" });
    await rejects(requestScriptRun(req), 400);
  });

  it("accepts exactly the minimum version", async () => {
    stubbed(prisma.managedAgent.findUnique).mockResolvedValue(agent({ agentVersion: "0.13.0" }));
    await expect(requestScriptRun(req)).resolves.toEqual({ runId: "run-1" });
  });

  it("enqueues run_script with the verified payload, links it to the run, and wakes the agent", async () => {
    stubbed(prisma.managedAgent.findUnique).mockResolvedValue(agent());
    await requestScriptRun({ ...req, timeoutSec: 45 });
    expect(stubbed(prisma.managedAgent.findUnique).mock.calls[0]![0]).toMatchObject({ where: { assetId: "a1" } });
    expect(stubbed(prisma.agentCommand.create).mock.calls[0]![0].data).toEqual({
      assetId: "a1", managedAgentId: "ma-1", action: "run_script", target: "restart-spooler",
      payload: { runId: "run-1", interpreter: "powershell", body: STORED.body, sha256: STORED.sha256, args: "", timeoutSec: 45 },
      requestedBy: "alice",
    });
    expect(prisma.automationScriptRun.update).toHaveBeenCalledWith({ where: { id: "run-1" }, data: { agentCommandId: "cmd-1" } });
    expect(h.wake).toHaveBeenCalledWith("ma-1");
  });
});

describe("getRun / listRuns / pruneOldRuns", () => {
  afterEach(() => vi.useRealTimers());

  it("getRun returns the row or 404s", async () => {
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValue({ id: "run-1" });
    expect(await getRun("run-1")).toEqual({ id: "run-1" });
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValue(null);
    await rejects(getRun("x"), 404, /Script run not found/);
  });

  it("listRuns filters only on what was given, newest first, 100 by default and 500 at most", async () => {
    stubbed(prisma.automationScriptRun.findMany).mockResolvedValue([]);
    await listRuns({});
    expect(stubbed(prisma.automationScriptRun.findMany).mock.calls[0]![0]).toEqual({ where: {}, orderBy: { requestedAt: "desc" }, take: 100 });
    await listRuns({ scriptId: "s1", notificationId: "n1", status: "failed", limit: 9999 });
    expect(stubbed(prisma.automationScriptRun.findMany).mock.calls[1]![0]).toEqual({
      where: { scriptId: "s1", notificationId: "n1", status: "failed" }, orderBy: { requestedAt: "desc" }, take: 500,
    });
    await listRuns({ limit: 7 });
    expect(stubbed(prisma.automationScriptRun.findMany).mock.calls[2]![0].take).toBe(7);
  });

  it("listRuns clamps a negative limit to 1 and reads a non-finite one as the default", async () => {
    // Was a bug until 2026-11-16: a negative or NaN limit reached Prisma as `take` unchanged.
    stubbed(prisma.automationScriptRun.findMany).mockResolvedValue([]);
    await listRuns({ limit: -5 });
    expect(stubbed(prisma.automationScriptRun.findMany).mock.calls[0]![0].take).toBe(1);
    await listRuns({ limit: Number.NaN });
    expect(stubbed(prisma.automationScriptRun.findMany).mock.calls[1]![0].take).toBe(100);
  });

  it("pruneOldRuns deletes only FINISHED runs older than 90 days and returns the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
    stubbed(prisma.automationScriptRun.deleteMany).mockResolvedValue({ count: 4 });
    expect(await pruneOldRuns()).toBe(4);
    expect(stubbed(prisma.automationScriptRun.deleteMany).mock.calls[0]![0]).toEqual({
      where: { requestedAt: { lt: new Date("2026-08-16T00:00:00Z") }, status: { in: ["succeeded", "failed", "timeout"] } },
    });
  });
});
