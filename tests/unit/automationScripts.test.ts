/**
 * tests/unit/automationScripts.test.ts — B5 script registry + server runner:
 *   - automationScriptService CRUD (sha256 on save, warning Events, delete
 *     refused while referenced, requestScriptRun validation),
 *   - automationScriptRunner.executeServerScript against REAL interpreters
 *     (cmd on Windows, sh elsewhere): success, non-zero exit, timeout kill,
 *     args as a single argv entry, env context vars.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── configurable fake prisma ─────────────────────────────────────────────────
const db = {
  scripts: [] as any[],
  runs: [] as any[],
  rules: [] as any[],
  agents: [] as any[],
  agentCommands: [] as any[],
};
let seq = 0;

vi.mock("../../src/db.js", () => ({
  prisma: {
    automationScript: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        const ids: string[] | undefined = where?.id?.in;
        return ids ? db.scripts.filter((s) => ids.includes(s.id)) : db.scripts;
      }),
      // Shallow-copy like real Prisma (a returned row is a snapshot, not a
      // live reference the next update mutates).
      findUnique: vi.fn(async ({ where }: any) => {
        const s = db.scripts.find((x) => x.id === where.id);
        return s ? { ...s } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const s = { id: `s${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.scripts.push(s);
        return s;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const s = db.scripts.find((x) => x.id === where.id);
        Object.assign(s, data);
        return s;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = db.scripts.findIndex((x) => x.id === where.id);
        db.scripts.splice(i, 1);
      }),
    },
    automationScriptRun: {
      create: vi.fn(async ({ data }: any) => {
        const r = { id: `run${++seq}`, status: "pending", requestedAt: new Date(), ...data };
        db.runs.push(r);
        return r;
      }),
      findMany: vi.fn(async () => db.runs),
      update: vi.fn(async ({ where, data }: any) => {
        const r = db.runs.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    notificationRule: { findMany: vi.fn(async () => db.rules) },
    managedAgent: {
      findUnique: vi.fn(async ({ where }: any) => {
        const a = db.agents.find((x) => x.assetId === where.assetId);
        return a ? { ...a } : null;
      }),
    },
    agentCommand: {
      create: vi.fn(async ({ data }: any) => {
        const c = { id: `cmd${++seq}`, status: "pending", requestedAt: new Date(), ...data };
        db.agentCommands.push(c);
        return c;
      }),
    },
  },
}));

const logEventMock = vi.fn(async () => {});
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }));

import {
  createScript,
  updateScript,
  deleteScript,
  requestScriptRun,
  sha256Hex,
  versionAtLeast,
  MIN_AGENT_SCRIPT_VERSION,
  type ScriptInput,
} from "../../src/services/automationScriptService.js";
import { executeServerScript, buildScriptEnv, buildCmdCommandLine } from "../../src/services/automationScriptRunner.js";

const WIN = process.platform === "win32";
const SHELL = WIN ? ("cmd" as const) : ("sh" as const);

function scriptInput(overrides: Partial<ScriptInput> = {}): ScriptInput {
  return {
    name: `test-script-${++seq}`,
    interpreter: SHELL,
    body: WIN ? "@echo hello" : "echo hello",
    runTarget: "server",
    ...overrides,
  };
}

beforeEach(() => {
  db.scripts.length = 0;
  db.runs.length = 0;
  db.rules.length = 0;
  db.agents.length = 0;
  db.agentCommands.length = 0;
  logEventMock.mockClear();
});

describe("automationScriptService CRUD", () => {
  it("createScript computes sha256 and stamps a warning Event", async () => {
    const s = await createScript(scriptInput({ body: "echo a" }), "operator1");
    expect(s.sha256).toBe(sha256Hex("echo a"));
    const evt = logEventMock.mock.calls[0]![0] as any;
    expect(evt.action).toBe("automation_script.created");
    expect(evt.level).toBe("warning");
  });

  it("updateScript flags a BODY change with old/new sha256 at warning level", async () => {
    const s = await createScript(scriptInput({ body: "echo a" }), "op");
    logEventMock.mockClear();
    await updateScript(s.id, scriptInput({ name: s.name, body: "echo b" }), "op");
    const evt = logEventMock.mock.calls[0]![0] as any;
    expect(evt.level).toBe("warning");
    expect(evt.details.oldSha256).toBe(sha256Hex("echo a"));
    expect(evt.details.newSha256).toBe(sha256Hex("echo b"));

    logEventMock.mockClear();
    await updateScript(s.id, scriptInput({ name: s.name, body: "echo b", description: "same body" }), "op");
    expect((logEventMock.mock.calls[0]![0] as any).level).toBe("info");
  });

  it("rejects oversized bodies and bad timeouts", async () => {
    await expect(createScript(scriptInput({ body: "x".repeat(64 * 1024 + 1) }))).rejects.toThrow(/64 KB/);
    await expect(createScript(scriptInput({ timeoutSec: 601 }))).rejects.toThrow(/timeoutSec/);
  });

  it("deleteScript refuses while an automation references the script (actions or tiers)", async () => {
    const s = await createScript(scriptInput());
    db.rules.push({
      id: "r1", name: "uses script",
      reset: { mode: "manual" },
      actions: [{ type: "script", scriptId: s.id, runOn: "server" }],
      targets: [], escalation: null, emailComposition: null, clearBehavior: "manual", clearAfterSec: null,
    });
    await expect(deleteScript(s.id)).rejects.toThrow(/used by 1 automation/);
    db.rules.length = 0;
    await expect(deleteScript(s.id)).resolves.toBeUndefined();
  });
});

describe("requestScriptRun validation", () => {
  it("creates a pending server run snapshotting name/sha/timeout", async () => {
    const s = await createScript(scriptInput({ timeoutSec: 30 }));
    const { runId } = await requestScriptRun({ scriptId: s.id, runOn: "server", args: "a b", requestedBy: "system:automation" });
    const run = db.runs.find((r) => r.id === runId)!;
    expect(run.scriptName).toBe(s.name);
    expect(run.sha256).toBe(s.sha256);
    expect(run.timeoutSec).toBe(30);
    expect(run.status).toBe("pending");
  });

  it("refuses disabled scripts and incompatible targets", async () => {
    const s = await createScript(scriptInput({ enabled: false }));
    await expect(requestScriptRun({ scriptId: s.id, runOn: "server", args: null, requestedBy: "x" })).rejects.toThrow(/disabled/);

    const serverOnly = await createScript(scriptInput());
    await expect(requestScriptRun({ scriptId: serverOnly.id, runOn: "agent", args: null, requestedBy: "x" })).rejects.toThrow(/only runs on server/);
  });

  it("agent runs preflight: asset required, agent installed + active + version-gated", async () => {
    const s = await createScript(scriptInput({ runTarget: "either" }));
    const base = { scriptId: s.id, runOn: "agent" as const, args: null, requestedBy: "x" };

    await expect(requestScriptRun(base)).rejects.toThrow(/no asset/);
    await expect(requestScriptRun({ ...base, assetId: "a1" })).rejects.toThrow(/no Polaris Agent/);

    db.agents.push({ id: "ag1", assetId: "a1", installStatus: "error", agentVersion: "0.13.0" });
    await expect(requestScriptRun({ ...base, assetId: "a1" })).rejects.toThrow(/isn't active/);

    db.agents[0].installStatus = "active";
    db.agents[0].agentVersion = "0.12.0";
    await expect(requestScriptRun({ ...base, assetId: "a1" })).rejects.toThrow(/needs 0\.13\.0/);

    // No run rows leaked from the refused attempts (preflight before create).
    expect(db.runs).toHaveLength(0);
  });

  it("agent run creates the run + a run_script AgentCommand with the verified payload, linked both ways", async () => {
    const s = await createScript(scriptInput({ runTarget: "either", timeoutSec: 45 }));
    db.agents.push({ id: "ag1", assetId: "a1", installStatus: "active", agentVersion: MIN_AGENT_SCRIPT_VERSION });

    const { runId } = await requestScriptRun({ scriptId: s.id, runOn: "agent", args: "hello", requestedBy: "system:automation", assetId: "a1", ruleId: "r1", notificationId: "n1" });

    const run = db.runs.find((r) => r.id === runId)!;
    const cmd = db.agentCommands[0]!;
    expect(cmd.action).toBe("run_script");
    expect(cmd.managedAgentId).toBe("ag1");
    expect(cmd.target).toBe(s.name);
    expect(cmd.payload).toEqual({ runId, interpreter: s.interpreter, body: s.body, sha256: s.sha256, args: "hello", timeoutSec: 45 });
    expect(run.agentCommandId).toBe(cmd.id);
    expect(run.runOn).toBe("agent");
  });
});

describe("versionAtLeast", () => {
  it("compares dotted-numeric versions", () => {
    expect(versionAtLeast("0.13.0", "0.13.0")).toBe(true);
    expect(versionAtLeast("0.13.1", "0.13.0")).toBe(true);
    expect(versionAtLeast("0.14.0", "0.13.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.13.0")).toBe(true);
    expect(versionAtLeast("0.12.9", "0.13.0")).toBe(false);
    expect(versionAtLeast("v0.13.0", "0.13.0")).toBe(true);
    expect(versionAtLeast(null, "0.13.0")).toBe(false);
    expect(versionAtLeast("garbage", "0.13.0")).toBe(false);
  });
});

describe("executeServerScript (real interpreter)", () => {
  async function makeRun(body: string, opts: { args?: string | null; timeoutSec?: number } = {}) {
    const s = await createScript(scriptInput({ body }));
    return {
      id: `run${++seq}`,
      scriptId: s.id,
      args: opts.args ?? null,
      timeoutSec: opts.timeoutSec ?? 10,
      notificationId: "n-1",
      ruleId: "r-1",
      assetId: "a-1",
    };
  }

  it("captures stdout and exit 0 on success", async () => {
    const run = await makeRun(WIN ? "@echo hello-from-script" : "echo hello-from-script");
    const res = await executeServerScript(run);
    expect(res.status).toBe("succeeded");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello-from-script");
  });

  it("reports a non-zero exit as failed with the exit code", async () => {
    const run = await makeRun(WIN ? "@exit /b 3" : "exit 3");
    const res = await executeServerScript(run);
    expect(res.status).toBe("failed");
    expect(res.exitCode).toBe(3);
  });

  it("kills a wedged script at timeoutSec and reports timeout", async () => {
    const run = await makeRun(WIN ? "@ping -n 30 127.0.0.1 >nul" : "sleep 30", { timeoutSec: 1 });
    const res = await executeServerScript(run);
    expect(res.status).toBe("timeout");
  }, 15_000);

  it("passes args as ONE argv entry and exposes the alert env vars", async () => {
    const body = WIN
      ? "@echo arg1=%1&& @echo alert=%POLARIS_ALERT_ID%"
      : 'echo "arg1=$1"; echo "alert=$POLARIS_ALERT_ID"';
    const run = await makeRun(body, { args: "two words" });
    const res = await executeServerScript(run);
    expect(res.status).toBe("succeeded");
    // "two words" must arrive as a single positional argument, not split.
    expect(res.stdout).toMatch(/arg1=.?two words.?\s/);
    expect(res.stdout).toContain("alert=n-1");
  });

  it("fails cleanly when the script vanished from the registry", async () => {
    const res = await executeServerScript({ id: "x", scriptId: "gone", args: null, timeoutSec: 5, notificationId: null, ruleId: null, assetId: null });
    expect(res.status).toBe("failed");
    expect(res.stderr).toMatch(/no longer exists/);
  });

  /**
   * args is a RENDERED TEMPLATE of alert context (renderNotificationTemplate
   * over argsTemplate), so the text below can originate from a device's own
   * hostname. cmd.exe re-parses its command line, so before this was escaped a
   * hostname of `x" & <command> & rem "` executed <command> as the service
   * user. Windows-only: the cmd interpreter does not exist elsewhere.
   */
  it.runIf(WIN)("does not let a crafted arg inject a second command through cmd.exe", async () => {
    const run = await makeRun("@echo ARG=[%~1]", { args: "safe ( a ) & echo INJECTED | echo NOPE" });
    const res = await executeServerScript(run);
    expect(res.status).toBe("succeeded");
    // Delivered verbatim as one argument...
    expect(res.stdout).toContain("ARG=[safe ( a ) & echo INJECTED | echo NOPE]");
    // ...and nothing ran on its own line.
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    expect(lines.every((l) => l.startsWith("ARG="))).toBe(true);
  });
});

/**
 * cmd.exe is the one interpreter with no argv: `cmd /c` re-parses the raw
 * command line. Each expectation below was verified against a real cmd.exe.
 */
describe("buildCmdCommandLine", () => {
  const S = "C:\\state\\run.cmd";

  it("wraps the whole command in the extra quote pair /s requires", () => {
    expect(buildCmdCommandLine(S, null)).toBe(`/d /s /c ""${S}""`);
    expect(buildCmdCommandLine(S, "hello")).toBe(`/d /s /c ""${S}" "hello""`);
  });

  it("caret-escapes every cmd metacharacter — quoting alone does not stop a pipe", () => {
    expect(buildCmdCommandLine(S, "a & b")).toBe(`/d /s /c ""${S}" "a ^& b""`);
    expect(buildCmdCommandLine(S, "a | b")).toBe(`/d /s /c ""${S}" "a ^| b""`);
    expect(buildCmdCommandLine(S, "a > b")).toBe(`/d /s /c ""${S}" "a ^> b""`);
    expect(buildCmdCommandLine(S, "a ( b )")).toBe(`/d /s /c ""${S}" "a ^( b ^)""`);
    expect(buildCmdCommandLine(S, "a ^ b")).toBe(`/d /s /c ""${S}" "a ^^ b""`);
  });

  it("refuses what cmd.exe cannot be told literally, rather than mangling it", () => {
    expect(buildCmdCommandLine(S, 'x" & rem ')).toBeNull();   // ends the quoted token
    expect(buildCmdCommandLine(S, "x %USERNAME%")).toBeNull(); // expanded at parse time
    expect(buildCmdCommandLine(S, "x !DELAYED!")).toBeNull();
    expect(buildCmdCommandLine(S, "x\r\ny")).toBeNull();       // control chars end the line
    expect(buildCmdCommandLine(S, "x\u001ay")).toBeNull();     // 0x1A is still EOF to cmd
  });

  it("leaves ordinary operator input untouched", () => {
    for (const arg of ["core-sw-01", "AP-1234.example.local", "bldg A floor 2", "C:\\some\\path\\"]) {
      expect(buildCmdCommandLine(S, arg)).toBe(`/d /s /c ""${S}" "${arg}""`);
    }
  });
});

/**
 * A script's stdout is STORED on AutomationScriptRun and rendered in the
 * Scripts tab, so anything reachable in its environment is effectively
 * copied into a displayed, backed-up column by a one-line script.
 */
describe("buildScriptEnv", () => {
  const BASE = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/polaris",
    LANG: "en_US.UTF-8",
    HTTPS_PROXY: "http://proxy:3128",
    DATABASE_URL: "postgresql://u:p@localhost/polaris",
    POLARIS_SECRET_KEY: "deadbeef",
    SESSION_SECRET: "s3cret",
    HEALTH_TOKEN: "ht",
    METRICS_TOKEN: "mt",
    SMTP_PASSWORD: "pw",
    AWS_SECRET_ACCESS_KEY: "ak",
  };

  it("strips every secret-shaped key", () => {
    const env = buildScriptEnv(BASE, {});
    for (const k of ["DATABASE_URL", "POLARIS_SECRET_KEY", "SESSION_SECRET", "HEALTH_TOKEN", "METRICS_TOKEN", "SMTP_PASSWORD", "AWS_SECRET_ACCESS_KEY"]) {
      expect(env[k], `${k} must not reach an operator script`).toBeUndefined();
    }
  });

  it("keeps the operational vars a script legitimately needs", () => {
    const env = buildScriptEnv(BASE, {});
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/polaris");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
  });

  it("adds the alert context", () => {
    const env = buildScriptEnv(BASE, { POLARIS_ALERT_ID: "n-1", POLARIS_RULE: "r-1", POLARIS_ASSET: "" });
    expect(env.POLARIS_ALERT_ID).toBe("n-1");
    expect(env.POLARIS_RULE).toBe("r-1");
    expect(env.POLARIS_ASSET).toBe("");
  });

  it("does not mutate the environment it was handed", () => {
    const copy = { ...BASE };
    buildScriptEnv(copy, { POLARIS_ALERT_ID: "n-1" });
    expect(copy).toEqual(BASE);
  });
});
