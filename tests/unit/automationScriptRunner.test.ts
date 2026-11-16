/**
 * tests/unit/automationScriptRunner.test.ts — own unit suite for
 * src/services/automationScriptRunner.ts (CQ-T010).
 *
 * NO real script or child process runs here: node:child_process.execFile,
 * the temp-file writes and the interpreter existence checks are all mocked at
 * the module boundary. (automationScripts.test.ts covers buildCmdCommandLine,
 * buildScriptEnv and a real-interpreter smoke run.) This suite pins the
 * execution model the touches entry calls security-sensitive: interpreter →
 * absolute binary + discrete argv, the cmd.exe verbatim path and its refusal,
 * the 0600 temp file that is always unlinked, the stripped environment, the
 * timeout / maxBuffer / exit-code classification and the 64 KB cap — and the
 * runner tick: the throttled agent-queue sweep (rule 155), the stuck-running
 * sweep, the bounded claim, CONCURRENCY = 2, the per-run record and its
 * `automation.script.run` Event, and the idle-tick retention prune.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ExecCb = (err: unknown, stdout: string, stderr: string) => void;

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn((_p: string) => false),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  pruneOldRuns: vi.fn(async () => 0),
  expireStaleAgentCommands: vi.fn(async (_now?: Date) => 0),
  pruneOldAgentCommands: vi.fn(async () => 0),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile, default: { execFile: mocks.execFile } }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, existsSync: mocks.existsSync, default: { ...(real.default as object), existsSync: mocks.existsSync } };
});
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const over = { mkdir: mocks.mkdir, writeFile: mocks.writeFile, unlink: mocks.unlink };
  return { ...real, ...over, default: { ...(real.default as object), ...over } };
});
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/automationScriptService.js", () => ({
  pruneOldRuns: mocks.pruneOldRuns,
  SCRIPT_OUTPUT_CAP_BYTES: 64 * 1024,
}));
vi.mock("../../src/services/agentCommandService.js", () => ({
  expireStaleAgentCommands: mocks.expireStaleAgentCommands,
  pruneOldAgentCommands: mocks.pruneOldAgentCommands,
}));

import { executeServerScript, runPendingServerScripts } from "../../src/services/automationScriptRunner.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const CAP = 64 * 1024;
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });

/** What the next execFile call answers with. */
let nextExec: { err: unknown; stdout: string; stderr: string } = { err: null, stdout: "ok\n", stderr: "" };

const script = (extra: Record<string, unknown> = {}) => ({ id: "s1", name: "Restart", enabled: true, interpreter: "bash", body: "echo hi", ...extra });
const runRow = (extra: Record<string, unknown> = {}) => ({
  id: "run1", scriptId: "s1", args: "--host core-sw1", timeoutSec: 5, notificationId: "n1", ruleId: "r1", assetId: "a1", ...extra,
});

let clock = new Date("2026-01-01T00:00:00Z").getTime();

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(mocks)) f.mockReset();
  mocks.existsSync.mockReturnValue(false);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.unlink.mockResolvedValue(undefined);
  mocks.pruneOldRuns.mockResolvedValue(0);
  mocks.expireStaleAgentCommands.mockResolvedValue(0);
  mocks.pruneOldAgentCommands.mockResolvedValue(0);
  nextExec = { err: null, stdout: "ok\n", stderr: "" };
  mocks.execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: ExecCb) => {
    const { err, stdout, stderr } = nextExec;
    setTimeout(() => cb(err, stdout, stderr), 0);
    return {};
  });
  stubbed(prisma.automationScript.findUnique).mockResolvedValue(script());
  setPlatform("linux");
  // The agent-queue sweep is throttled on module state: each test starts more
  // than a minute after the last so the throttle never leaks between tests.
  clock += 10 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", realPlatform);
  vi.unstubAllEnvs();
});

const lastExec = () => {
  const c = mocks.execFile.mock.calls.at(-1)!;
  return { bin: c[0] as string, argv: c[1] as string[], opts: c[2] as Record<string, any> };
};

describe("executeServerScript — refusals before anything runs", () => {
  it("fails a run whose script left the registry, or that names none", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    expect(await executeServerScript(runRow())).toEqual({ status: "failed", exitCode: null, stdout: "", stderr: "script no longer exists in the registry" });
    stubbed(prisma.automationScript.findUnique).mockClear();
    expect((await executeServerScript(runRow({ scriptId: null }))).stderr).toBe("script no longer exists in the registry");
    expect(prisma.automationScript.findUnique).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("fails a disabled script", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ enabled: false }));
    expect((await executeServerScript(runRow())).stderr).toBe("script is disabled");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("fails an unknown interpreter, and cmd off Windows, without writing the body", async () => {
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "perl" }));
    expect((await executeServerScript(runRow())).stderr).toBe('interpreter "perl" is not available on this platform');
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "cmd" }));
    expect((await executeServerScript(runRow())).stderr).toBe('interpreter "cmd" is not available on this platform');
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("refuses cmd arguments it cannot deliver safely, with an actionable message", async () => {
    setPlatform("win32");
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "cmd" }));
    for (const args of ['x" & calc & rem "', "100%", "hi!", "a\r\nb"]) {
      const res = await executeServerScript(runRow({ args }));
      expect(res.status).toBe("failed");
      expect(res.stderr).toMatch(/POLARIS_ALERT_ID/);
    }
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("executeServerScript — how the interpreter is invoked", () => {
  it("runs bash from its absolute path with the body and the args as discrete argv entries", async () => {
    mocks.existsSync.mockImplementation((p: string) => p === "/usr/bin/bash");
    const res = await executeServerScript(runRow());
    expect(res).toEqual({ status: "succeeded", exitCode: 0, stdout: "ok\n", stderr: "" });
    const { bin, argv, opts } = lastExec();
    expect(bin).toBe("/usr/bin/bash");
    expect(argv).toHaveLength(2);
    expect(argv[0]).toMatch(/run-run1-[0-9a-f]{8}\.sh$/);
    expect(argv[1]).toBe("--host core-sw1");
    expect(opts).toMatchObject({ timeout: 5000, killSignal: "SIGKILL", maxBuffer: CAP, windowsHide: true, windowsVerbatimArguments: false });
  });

  it("falls back to the bare name (PATH lookup) when no standard path exists", async () => {
    await executeServerScript(runRow());
    expect(lastExec().bin).toBe("bash");
  });

  it("passes no argument entry at all for null or empty args", async () => {
    await executeServerScript(runRow({ args: null }));
    expect(lastExec().argv).toHaveLength(1);
    await executeServerScript(runRow({ args: "" }));
    expect(lastExec().argv).toHaveLength(1);
  });

  it("never shell-splits an argument carrying shell metacharacters", async () => {
    await executeServerScript(runRow({ args: "x; rm -rf / && $(whoami)" }));
    expect(lastExec().argv[1]).toBe("x; rm -rf / && $(whoami)");
  });

  it("uses the right binary and file extension per interpreter", async () => {
    mocks.existsSync.mockImplementation((p: string) => ["/bin/sh", "/usr/bin/python3", "/usr/bin/pwsh"].includes(p));
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "sh" }));
    await executeServerScript(runRow());
    expect(lastExec().bin).toBe("/bin/sh");
    expect(lastExec().argv[0]).toMatch(/\.sh$/);
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "python3" }));
    await executeServerScript(runRow());
    expect(lastExec().bin).toBe("/usr/bin/python3");
    expect(lastExec().argv[0]).toMatch(/\.py$/);
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "powershell" }));
    await executeServerScript(runRow());
    const ps = lastExec();
    expect(ps.bin).toBe("/usr/bin/pwsh");
    expect(ps.argv.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
    expect(ps.argv[5]).toMatch(/\.ps1$/);
    expect(ps.argv[6]).toBe("--host core-sw1");
  });

  it("uses powershell.exe on Windows", async () => {
    setPlatform("win32");
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "powershell" }));
    await executeServerScript(runRow());
    expect(lastExec().bin).toMatch(/powershell\.exe$/);
  });

  it("hands cmd.exe ONE pre-escaped command line, verbatim", async () => {
    setPlatform("win32");
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(script({ interpreter: "cmd" }));
    await executeServerScript(runRow({ args: "a & b" }));
    const { bin, argv, opts } = lastExec();
    expect(bin).toBe("cmd.exe");
    expect(argv).toHaveLength(1);
    expect(argv[0]).toMatch(/^\/d \/s \/c ""[^"]+\.cmd" "a \^& b""$/);
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("writes the body to a 0600 temp file and always deletes it", async () => {
    await executeServerScript(runRow());
    expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringMatching(/automation-scripts-tmp$/), { recursive: true });
    const [path, body, opts] = mocks.writeFile.mock.calls[0]! as unknown as [string, string, Record<string, unknown>];
    expect(body).toBe("echo hi");
    expect(opts).toEqual({ encoding: "utf8", mode: 0o600 });
    expect(mocks.unlink).toHaveBeenCalledWith(path);
    expect(lastExec().argv[0]).toBe(path);
  });

  it("deletes the temp file even when the write fails, and reports the error", async () => {
    mocks.writeFile.mockRejectedValue(new Error("disk full"));
    const res = await executeServerScript(runRow());
    expect(res).toEqual({ status: "failed", exitCode: null, stdout: "", stderr: "disk full" });
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("ignores an unlink failure", async () => {
    mocks.unlink.mockRejectedValue(new Error("ENOENT"));
    expect((await executeServerScript(runRow())).status).toBe("succeeded");
  });

  it("strips secret-shaped variables from the child environment and adds the alert context", async () => {
    vi.stubEnv("POLARIS_SECRET_KEY", "s3cret");
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("POLARIS_TEST_HARMLESS", "yes");
    await executeServerScript(runRow());
    const env = lastExec().opts.env as Record<string, string>;
    expect(env.POLARIS_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.POLARIS_TEST_HARMLESS).toBe("yes");
    expect(env).toMatchObject({ POLARIS_ALERT_ID: "n1", POLARIS_RULE: "r1", POLARIS_ASSET: "a1" });
    await executeServerScript(runRow({ notificationId: null, ruleId: null, assetId: null }));
    expect(lastExec().opts.env).toMatchObject({ POLARIS_ALERT_ID: "", POLARIS_RULE: "", POLARIS_ASSET: "" });
  });

  it("hands an email-enabled run its pass and the loopback API URL, storing only the hash (rule 190)", async () => {
    const { createHash } = await import("node:crypto");
    stubbed(prisma.automationScriptRun.update).mockResolvedValue({} as never);
    await executeServerScript(runRow({ emailChannelId: "ch1" }));
    const env = lastExec().opts.env as Record<string, string>;
    expect(env.POLARIS_RUN_ID).toBe("run1");
    expect(env.POLARIS_RUN_TOKEN).toMatch(/^prun_[A-Za-z0-9_-]{40,}$/);
    expect(env.POLARIS_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
    const stored = stubbed(prisma.automationScriptRun.update).mock.calls.at(-1)![0] as { where: { id: string }; data: Record<string, unknown> };
    expect(stored.where).toEqual({ id: "run1" });
    expect(stored.data.emailTokenHash).toBe(createHash("sha256").update(env.POLARIS_RUN_TOKEN).digest("hex"));
    expect(JSON.stringify(stored.data)).not.toContain(env.POLARIS_RUN_TOKEN);
  });

  it("gives a run without email no pass and no API URL", async () => {
    await executeServerScript(runRow());
    const env = lastExec().opts.env as Record<string, string>;
    expect(env.POLARIS_RUN_TOKEN).toBeUndefined();
    expect(env.POLARIS_API_URL).toBeUndefined();
    expect(env.POLARIS_RUN_ID).toBe("run1");
  });
});

describe("executeServerScript — classifying the result", () => {
  it("reports a non-zero exit as failed with its code and stderr", async () => {
    nextExec = { err: Object.assign(new Error("Command failed"), { code: 3 }), stdout: "partial", stderr: "bad thing" };
    expect(await executeServerScript(runRow())).toEqual({ status: "failed", exitCode: 3, stdout: "partial", stderr: "bad thing" });
  });

  it("falls back to the error message when stderr is empty", async () => {
    nextExec = { err: Object.assign(new Error("spawn bash ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" };
    expect(await executeServerScript(runRow())).toEqual({ status: "failed", exitCode: null, stdout: "", stderr: "spawn bash ENOENT" });
  });

  it("reports a kill as a timeout", async () => {
    nextExec = { err: Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL", code: null }), stdout: "", stderr: "" };
    expect((await executeServerScript(runRow())).status).toBe("timeout");
    nextExec = { err: Object.assign(new Error("term"), { signal: "SIGTERM" }), stdout: "", stderr: "" };
    expect((await executeServerScript(runRow())).status).toBe("timeout");
  });

  it("reports an output-cap kill as a failure, not a timeout", async () => {
    nextExec = { err: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }), stdout: "x", stderr: "" };
    expect(await executeServerScript(runRow())).toEqual({ status: "failed", exitCode: null, stdout: "x", stderr: "output exceeded the 64 KB cap" });
  });

  it("caps captured output at 64 KB", async () => {
    nextExec = { err: null, stdout: "a".repeat(CAP + 500), stderr: "b".repeat(CAP + 1) };
    const res = await executeServerScript(runRow());
    expect(res.stdout).toHaveLength(CAP);
    expect(res.stderr).toHaveLength(CAP);
  });
});

// ─── The runner tick ────────────────────────────────────────────────────────

type Row = Record<string, any>;
let rows: Row[] = [];
/** Runs right after the claim pass's candidate read — a second process acting in between. */
let afterCandidates: (() => void) | null = null;

function matches(r: Row, where: Row): boolean {
  if (where.status !== undefined && r.status !== where.status) return false;
  if (where.runOn !== undefined && r.runOn !== where.runOn) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.id === "string" && r.id !== where.id) return false;
  if (where.startedAt?.not === null && r.startedAt == null) return false;
  return true;
}

function installRunTable(): void {
  stubbed(prisma.automationScriptRun.findMany).mockImplementation(async (args: Row) => {
    let out = rows.filter((r) => matches(r, args.where));
    if (args.take) out = out.slice(0, args.take);
    const snapshot = out.map((r) => (args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])) : { ...r }));
    if (args.where.status === "pending" && afterCandidates) { afterCandidates(); afterCandidates = null; }
    return snapshot;
  });
  stubbed(prisma.automationScriptRun.updateMany).mockImplementation(async (args: Row) => {
    const hit = rows.filter((r) => matches(r, args.where));
    for (const r of hit) Object.assign(r, args.data);
    return { count: hit.length };
  });
  stubbed(prisma.automationScriptRun.update).mockImplementation(async (args: Row) => {
    const r = rows.find((x) => matches(x, args.where));
    if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
    Object.assign(r, args.data);
    return { ...r };
  });
}

const pending = (id: string, extra: Row = {}): Row => ({
  id, status: "pending", runOn: "server", scriptId: "s1", scriptName: "Restart", args: null, timeoutSec: 5,
  notificationId: "n1", ruleId: "r1", assetId: "a1", requestedBy: "dave", startedAt: null, requestedAt: new Date(clock - 1000), ...extra,
});

describe("runPendingServerScripts", () => {
  beforeEach(() => {
    rows = [];
    afterCandidates = null;
    installRunTable();
  });

  it("prunes old runs on an idle tick and starts nothing", async () => {
    expect(await runPendingServerScripts()).toEqual({ started: 0, completed: 0 });
    expect(mocks.pruneOldRuns).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("swallows a failed retention prune", async () => {
    mocks.pruneOldRuns.mockRejectedValue(new Error("db"));
    expect(await runPendingServerScripts()).toEqual({ started: 0, completed: 0 });
  });

  it("sweeps the agent command queue at most once a minute (rule 155)", async () => {
    await runPendingServerScripts();
    expect(mocks.expireStaleAgentCommands).toHaveBeenCalledTimes(1);
    expect(mocks.pruneOldAgentCommands).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 30_000);
    await runPendingServerScripts();
    expect(mocks.expireStaleAgentCommands).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 61_000);
    await runPendingServerScripts();
    expect(mocks.expireStaleAgentCommands).toHaveBeenCalledTimes(2);
    expect(mocks.expireStaleAgentCommands.mock.calls[1]![0]).toEqual(new Date(clock + 61_000));
  });

  it("never lets a failed agent sweep stop server scripts", async () => {
    mocks.expireStaleAgentCommands.mockRejectedValue(new Error("agent table locked"));
    rows = [pending("p1")];
    expect(await runPendingServerScripts()).toEqual({ started: 1, completed: 1 });
    expect(mocks.pruneOldAgentCommands).not.toHaveBeenCalled();
  });

  it("flips a run stuck past its timeout plus 60 s grace to timeout, and leaves one inside it", async () => {
    rows = [
      pending("old", { status: "running", startedAt: new Date(clock - (5_000 + 61_000)) }),
      pending("young", { status: "running", startedAt: new Date(clock - (5_000 + 59_000)) }),
    ];
    await runPendingServerScripts();
    expect(rows[0]).toMatchObject({ status: "timeout", completedAt: new Date(clock) });
    expect(rows[0]!.stderr).toMatch(/swept by the runner/);
    expect(rows[0]!.emailTokenHash).toBeNull();
    expect(rows[1]!.status).toBe("running");
    expect(stubbed(prisma.automationScriptRun.updateMany).mock.calls[0]![0].where).toEqual({ id: "old", status: "running" });
  });

  it("skips a stuck row that settled between the sweep's read and its flip, and still claims pending runs", async () => {
    // Was a bug until 2026-11-16: the guarded update threw P2025 uncaught and aborted the whole tick.
    rows = [pending("old", { status: "running", startedAt: new Date(clock - 120_000) }), pending("p1")];
    stubbed(prisma.automationScriptRun.updateMany).mockResolvedValueOnce({ count: 0 } as never);
    expect(await runPendingServerScripts()).toEqual({ started: 1, completed: 1 });
    expect(rows[1]!.status).toBe("succeeded");
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("writes one automation.script.run Event per run the stuck sweep flips, in one batch", async () => {
    // Was a bug until 2026-11-16: swept runs flipped to timeout with no audit Event.
    rows = [
      pending("a", { status: "running", startedAt: new Date(clock - 120_000) }),
      pending("b", { status: "running", startedAt: new Date(clock - 120_000), requestedBy: null }),
    ];
    await runPendingServerScripts();
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    const evs = eventLog.logEventsBatch.mock.calls[0]![0];
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ action: "automation.script.run", level: "warning", actor: "dave", resourceId: "s1", details: { runId: "a", status: "timeout", runOn: "server" } });
    expect(evs[1]).toMatchObject({ actor: "system:automation", details: { runId: "b" } });
  });

  it("records a run whose execution throws as failed, without stranding the others", async () => {
    // Was a bug until 2026-11-16: one rejected executeServerScript rejected Promise.all, leaving every claimed run "running".
    rows = [pending("p1", { scriptId: "bad" }), pending("p2")];
    stubbed(prisma.automationScript.findUnique).mockImplementation(async (args: Row) => {
      if (args.where.id === "bad") throw new Error("lookup exploded");
      return { id: "s1", enabled: true, interpreter: "bash", body: "echo ok" } as never;
    });
    expect(await runPendingServerScripts()).toEqual({ started: 2, completed: 2 });
    expect(rows[0]).toMatchObject({ status: "failed", stderr: "lookup exploded" });
    expect(rows[1]!.status).toBe("succeeded");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(2);
  });

  it("claims pending server runs oldest first, at most ten per tick", async () => {
    rows = Array.from({ length: 12 }, (_, i) => pending(`p${i}`));
    rows.push(pending("agent", { runOn: "agent" }));
    const out = await runPendingServerScripts();
    expect(out).toEqual({ started: 10, completed: 10 });
    const cand = stubbed(prisma.automationScriptRun.findMany).mock.calls.find((c) => c[0].where.status === "pending")![0];
    expect(cand).toMatchObject({ where: { status: "pending", runOn: "server" }, orderBy: { requestedAt: "asc" }, take: 10 });
    expect(rows.filter((r) => r.status === "pending").map((r) => r.id)).toEqual(["p10", "p11", "agent"]);
    const claim = stubbed(prisma.automationScriptRun.updateMany).mock.calls[0]![0];
    expect(claim.where.status).toBe("pending");
    expect(claim.data).toEqual({ status: "running", startedAt: new Date(clock) });
  });

  it("runs at most two scripts at once", async () => {
    let active = 0;
    let peak = 0;
    mocks.execFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: ExecCb) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => { active--; cb(null, "", ""); }, 0);
      return {};
    });
    rows = [pending("p1"), pending("p2"), pending("p3"), pending("p4"), pending("p5")];
    expect(await runPendingServerScripts()).toEqual({ started: 5, completed: 5 });
    expect(peak).toBe(2);
  });

  it("records each run's outcome and writes one automation.script.run Event per run", async () => {
    rows = [pending("p1")];
    await runPendingServerScripts();
    expect(rows[0]).toMatchObject({ status: "succeeded", exitCode: 0, stdout: "ok\n", stderr: "" });
    expect(rows[0]!.completedAt).toEqual(new Date(clock));
    // Rule 190: the run's email pass dies with it.
    expect(rows[0]!.emailTokenHash).toBeNull();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toEqual({
      action: "automation.script.run",
      resourceType: "automation-script",
      resourceId: "s1",
      resourceName: "Restart",
      actor: "dave",
      level: "info",
      message: 'Automation script "Restart" succeeded on server (exit 0)',
      details: { runId: "p1", scriptId: "s1", ruleId: "r1", notificationId: "n1", exitCode: 0, runOn: "server", status: "succeeded" },
    });
  });

  it("logs a failed or timed-out run at warning, as the system actor when nobody requested it", async () => {
    nextExec = { err: Object.assign(new Error("killed"), { killed: true }), stdout: "", stderr: "" };
    rows = [pending("p1", { requestedBy: null, scriptId: null })];
    stubbed(prisma.automationScript.findUnique).mockResolvedValue(null);
    await runPendingServerScripts();
    const ev = eventLog.logEvent.mock.calls[0]![0];
    expect(ev).toMatchObject({ level: "warning", actor: "system:automation", resourceId: undefined });
    expect(ev.message).toBe('Automation script "Restart" failed on server (exit n/a)');
  });

  it("does not let an Event failure stop the tick", async () => {
    eventLog.logEvent.mockRejectedValue(new Error("event table gone"));
    rows = [pending("p1"), pending("p2")];
    expect(await runPendingServerScripts()).toEqual({ started: 2, completed: 2 });
  });

  // Was a bug until 2026-11-14: the claim's comment and the touches invariant say "updateMany with a
  // status re-check so concurrent processes can't double-run", but the claimed
  // set is re-read as `{ id in ids, status: "running" }` — which also matches a
  // row ANOTHER process claimed between this tick's candidate read and its
  // updateMany. Input: p1 pending; a second runner claims it (status running)
  // right after this tick reads its candidates. Actual: this tick's updateMany
  // claims 0 rows, yet it executes p1 anyway (started 1, a second execFile).
  // Expected: started 0 and no execution — only rows this tick's own updateMany
  // flipped may run.
  it("never executes a run a concurrent runner claimed first", async () => {
    rows = [pending("p1")];
    afterCandidates = () => { Object.assign(rows[0]!, { status: "running", startedAt: new Date(clock - 500) }); };
    const out = await runPendingServerScripts();
    expect(out.started).toBe(0);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
