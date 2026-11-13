/**
 * tests/unit/agentBuildService.test.ts — agentBuildService's own suite (CQ-T010).
 *
 * Complements: agentUpgradeSkipDown.test.ts and platformLifecycleService.test.ts,
 * which only MOCK this module (goAvailable / getInventory). Nothing tested the
 * real runner, queue or prune before this file.
 *
 * Covered: goAvailable (the minimum-version gate, an unparseable version
 * accepted, a missing binary), startBuild's preflight refusals and FIFO queue
 * (depth 3), a whole build run — `go mod download`, six `go build`s with the
 * right GOOS / GOARCH / ldflags / output names, the manifest written via
 * .tmp + rename, the started / completed Events — a failed platform (stderr on
 * the step, failed Event, queue advances), cancellation while queued and
 * in-flight (SIGTERM to the child, `cancelled` phase, no failed Event),
 * getBuild / getCurrentBuildAndQueue never leaking the child handle, signing
 * (disabled, all signed, fail-open with a preflight failure), getInventory,
 * and pruneOldAgentVersions' three protections and fail-closed read.
 *
 * NOTHING is built: node:child_process.execFile is a fake that answers `go`
 * from a script, and node:fs/promises is an in-memory fake. No go, make or
 * jsign runs, and nothing is written to disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";

const h = vi.hoisted(() => {
  const state = {
    goVersionOut: "go version go1.26.2 linux/amd64" as string | null,
    /** Per `go build` platform ("linux-amd64"…): stderr to fail with, or "hang" until killed. */
    buildBehavior: new Map<string, string>(),
    modDownloadError: null as string | null,
    calls: [] as Array<{ args: string[]; env: Record<string, string | undefined>; cwd?: string }>,
    children: [] as Array<{ killed: boolean; kill: (sig: string) => void; signals: string[] }>,
    files: new Map<string, string>(),
    stats: new Map<string, { size: number; mtimeMs: number; dir?: boolean }>(),
    dirs: new Map<string, Array<{ name: string; dir: boolean }>>(),
    removed: [] as string[],
    signing: { enabled: false } as Record<string, unknown>,
    signAvail: { ok: true, jarPath: "/opt/jsign.jar" } as Record<string, unknown>,
    signFail: new Set<string>(),
  };
  return state;
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile: any = vi.fn((file: string, args: string[], opts: any, cb: (e: any, so: string, se: string) => void) => {
    h.calls.push({ args, env: opts?.env ?? {}, cwd: opts?.cwd });
    const child = { killed: false, signals: [] as string[], kill(sig: string) { this.signals.push(sig); this.killed = true; setImmediate(() => cb(Object.assign(new Error("killed"), { signal: sig }), "", "")); } };
    h.children.push(child);
    if (file !== "go") { setImmediate(() => cb(new Error("unexpected binary " + file), "", "")); return child; }
    if (args[0] === "version") {
      setImmediate(() => (h.goVersionOut === null ? cb(Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" }), "", "") : cb(null, h.goVersionOut + "\n", "")));
    } else if (args[0] === "mod") {
      setImmediate(() => (h.modDownloadError ? cb(new Error("exit 1"), "", h.modDownloadError) : cb(null, "", "")));
    } else if (args[0] === "build") {
      const key = `${opts.env.GOOS}-${opts.env.GOARCH}`;
      const b = h.buildBehavior.get(key);
      if (b === "hang") return child;
      setImmediate(() => (b ? cb(new Error("exit status 1"), "", b) : cb(null, "", "")));
    }
    return child;
  });
  execFile[promisify.custom] = (file: string, args: string[], opts: any) =>
    new Promise((res, rej) => execFile(file, args, opts, (e: any, stdout: string, stderr: string) => (e ? rej(e) : res({ stdout, stderr }))));
  return { execFile };
});

vi.mock("node:fs/promises", () => {
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const dirent = (e: { name: string; dir: boolean }) => ({ name: e.name, isDirectory: () => e.dir, isFile: () => !e.dir });
  const api = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: string, data: string) => { h.files.set(p, data); }),
    rename: vi.fn(async (a: string, b: string) => { const d = h.files.get(a); if (d === undefined) throw enoent(a); h.files.delete(a); h.files.set(b, d); }),
    readFile: vi.fn(async (p: string) => { const d = h.files.get(p); if (d === undefined) throw enoent(p); return d; }),
    stat: vi.fn(async (p: string) => {
      const s = h.stats.get(p);
      if (!s) throw enoent(p);
      return { size: s.size, mtimeMs: s.mtimeMs, mtime: new Date(s.mtimeMs), isFile: () => !s.dir, isDirectory: () => !!s.dir };
    }),
    readdir: vi.fn(async (p: string) => { const d = h.dirs.get(p); if (!d) throw enoent(p); return d.map(dirent); }),
    rm: vi.fn(async (p: string) => { h.removed.push(p); }),
  };
  return { ...api, default: api };
});

vi.mock("../../src/utils/version.js", () => ({ getAgentVersion: vi.fn(() => "0.29.3"), getAgentSourceDir: vi.fn(() => "/src/agent") }));
vi.mock("../../src/services/agentInstallService.js", () => ({
  AGENT_SERVER_URL_SETTING_KEY: "agent.serverUrl",
  inferOwnServerUrl: vi.fn(async () => "https://polaris.example.test"),
  inferOwnServerUrlSync: vi.fn(() => "https://derived.example.test"),
  upgradeAllOutdated: vi.fn(async () => ({ eligible: 0, queued: 0 })),
}));
vi.mock("../../src/services/agentSigningService.js", () => {
  class SigningCancelledError extends Error {}
  return {
    SigningCancelledError,
    getSigningConfigRaw: vi.fn(async () => h.signing),
    signingAvailability: vi.fn(async () => h.signAvail),
    signFile: vi.fn(async (_s: unknown, o: { filePath: string }) => {
      if ([...h.signFail].some((f) => o.filePath.endsWith(f))) throw new Error("jsign: keystore password incorrect");
    }),
    recordSigningFailure: vi.fn(async () => undefined),
    clearSigningFailure: vi.fn(async () => undefined),
  };
});
// vi.resetModules() re-imports per test; a real pino logger would add a process
// exit listener each time (MaxListenersExceededWarning).
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

type Svc = typeof import("../../src/services/agentBuildService.js");
let svc: Svc;
let events: Array<{ action: string; level?: string; message?: string; details?: any }>;
let AGENT_BIN_DIR: string;
let prisma: any;
let signing: typeof import("../../src/services/agentSigningService.js");

async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}
async function until(pred: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await tick();
  if (!pred()) throw new Error("condition not reached");
}
const phase = (id: string) => svc.getBuild(id)?.phase;
const done = (id: string) => ["complete", "failed", "cancelled"].includes(String(phase(id)));

beforeEach(async () => {
  vi.resetModules();
  h.goVersionOut = "go version go1.26.2 linux/amd64";
  h.buildBehavior.clear();
  h.modDownloadError = null;
  h.calls.length = 0;
  h.children.length = 0;
  h.files.clear();
  h.stats.clear();
  h.dirs.clear();
  h.removed.length = 0;
  h.signing = { enabled: false };
  h.signAvail = { ok: true, jarPath: "/opt/jsign.jar" };
  h.signFail.clear();
  svc = await import("../../src/services/agentBuildService.js");
  AGENT_BIN_DIR = (await import("../../src/utils/paths.js")).AGENT_BIN_DIR;
  prisma = (await import("../../src/db.js")).prisma;
  signing = await import("../../src/services/agentSigningService.js");
  const stub = await import("./_eventLogStub.js");
  stub.resetEventLogStub();
  events = [];
  stub.eventLog.logEvent.mockImplementation(async (e: any) => { events.push(e); });
  prisma.setting.findUnique.mockResolvedValue(null);
  prisma.managedAgent.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.POLARIS_AGENT_KEEP_VERSIONS;
});

describe("goAvailable", () => {
  it("parses the toolchain and accepts the minimum line", async () => {
    await expect(svc.goAvailable()).resolves.toEqual({ ok: true, version: "go version go1.26.2 linux/amd64", versionNumber: "1.26.2", track: "1.26", meetsMinimum: true });
  });

  it("flags a toolchain below GO_MINIMUM but still reports it ran", async () => {
    h.goVersionOut = "go version go1.21.13 linux/amd64";
    await expect(svc.goAvailable()).resolves.toMatchObject({ ok: true, track: "1.21", meetsMinimum: false });
  });

  it("treats an unparseable version (a devel toolchain) as meeting the minimum", async () => {
    h.goVersionOut = "go version devel +abc123";
    await expect(svc.goAvailable()).resolves.toMatchObject({ ok: true, meetsMinimum: true, versionNumber: undefined });
  });

  it("reports a missing binary", async () => {
    h.goVersionOut = null;
    await expect(svc.goAvailable()).resolves.toEqual({ ok: false, meetsMinimum: false, error: "spawn go ENOENT" });
  });
});

describe("startBuild — preflight", () => {
  it("refuses without Go, naming the minimum", async () => {
    h.goVersionOut = null;
    await expect(svc.startBuild({ actor: "alice" })).rejects.toThrow(new RegExp(`Install Go ${svc.GO_MINIMUM.replace(".", "\\.")}\\+`));
    await expect(svc.startBuild({ actor: "alice" })).rejects.toBeInstanceOf(svc.GoUnavailableError);
  });

  it("refuses a too-old Go before any compile", async () => {
    h.goVersionOut = "go version go1.21.0 linux/amd64";
    await expect(svc.startBuild({ actor: "alice" })).rejects.toThrow(/Go 1\.21 is installed .* requires Go 1\.26\+/);
    expect(h.calls.some((c) => c.args[0] === "build")).toBe(false);
  });
});

describe("a whole build", () => {
  it("downloads modules, builds six targets with the right env and names, writes the manifest, logs start + completion", async () => {
    const { buildId, version, queuePosition } = await svc.startBuild({ actor: "alice" });
    expect({ version, queuePosition }).toEqual({ version: "0.29.3", queuePosition: 0 });
    await until(() => done(buildId));
    expect(phase(buildId)).toBe("complete");

    expect(h.calls.map((c) => c.args[0])).toEqual(["version", "mod", "build", "build", "build", "build", "build", "build"]);
    const builds = h.calls.filter((c) => c.args[0] === "build");
    expect(builds.map((c) => `${c.env.GOOS}-${c.env.GOARCH}`)).toEqual(["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64", "windows-arm64"]);
    expect(builds[0].cwd).toBe("/src/agent");
    expect(builds[0].env.CGO_ENABLED).toBe("0");
    expect(builds[0].args).toContain("-ldflags=-s -w -X main.version=0.29.3");
    expect(builds[4].args[builds[4].args.indexOf("-o") + 1]).toBe(resolve(AGENT_BIN_DIR, "0.29.3", "polaris-agent-windows-amd64.exe"));

    const manifest = JSON.parse(h.files.get(resolve(AGENT_BIN_DIR, "manifest.json"))!);
    expect(manifest).toEqual({
      currentVersion: "0.29.3", minimumCompatible: "0.29.3",
      binaries: {
        "linux-amd64": "polaris-agent-linux-amd64", "linux-arm64": "polaris-agent-linux-arm64",
        "darwin-amd64": "polaris-agent-darwin-amd64", "darwin-arm64": "polaris-agent-darwin-arm64",
        "windows-amd64": "polaris-agent-windows-amd64.exe", "windows-arm64": "polaris-agent-windows-arm64.exe",
      },
    });
    expect(h.files.has(resolve(AGENT_BIN_DIR, "manifest.json.tmp"))).toBe(false);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["agent.build.started", "agent.build.completed"]));
    expect(events.find((e) => e.action === "agent.build.completed")!.details.signed).toBe("disabled");
    expect(svc.getBuild(buildId)!.steps.every((s) => s.status === "success")).toBe(true);
    expect(svc.getCurrentBuildAndQueue()).toEqual({ current: null, queue: [] });
  });

  it("a failing platform fails the build with its stderr, stops there, and logs a warning", async () => {
    h.buildBehavior.set("darwin-amd64", "cmd/polaris-agent/main.go:12: undefined: foo");
    const { buildId } = await svc.startBuild({ actor: "alice" });
    await until(() => done(buildId));
    const b = svc.getBuild(buildId)!;
    expect(b.phase).toBe("failed");
    expect(b.error).toBe("go build failed for darwin/amd64: cmd/polaris-agent/main.go:12: undefined: foo");
    expect(b.steps.map((s) => s.status)).toEqual(["success", "success", "failed", "pending", "pending", "pending"]);
    expect(events.find((e) => e.action === "agent.build.failed")).toMatchObject({ level: "warning" });
    expect(h.files.has(resolve(AGENT_BIN_DIR, "manifest.json"))).toBe(false);
  });

  it("a failed module download aborts before any go build", async () => {
    h.modDownloadError = "dial tcp: lookup proxy.golang.org: no such host";
    const { buildId } = await svc.startBuild({ actor: "alice" });
    await until(() => done(buildId));
    expect(svc.getBuild(buildId)!.error).toBe("go mod download failed: dial tcp: lookup proxy.golang.org: no such host");
    expect(h.calls.some((c) => c.args[0] === "build")).toBe(false);
  });
});

describe("the queue", () => {
  it("queues behind a running build, caps at three waiting, and runs them in order", async () => {
    h.buildBehavior.set("linux-amd64", "hang");
    const first = await svc.startBuild({ actor: "a" });
    const q1 = await svc.startBuild({ actor: "b" });
    const q2 = await svc.startBuild({ actor: "c" });
    const q3 = await svc.startBuild({ actor: "d" });
    expect([q1.queuePosition, q2.queuePosition, q3.queuePosition]).toEqual([1, 2, 3]);
    await expect(svc.startBuild({ actor: "e" })).rejects.toBeInstanceOf(svc.BuildQueueFullError);
    const snap = svc.getCurrentBuildAndQueue();
    expect(snap.current?.buildId).toBe(first.buildId);
    expect(snap.queue.map((s) => s.buildId)).toEqual([q1.buildId, q2.buildId, q3.buildId]);
    expect(events.filter((e) => e.action === "agent.build.queued").map((e) => e.message)).toEqual([
      "Agent build v0.29.3 queued (position 1)", "Agent build v0.29.3 queued (position 2)", "Agent build v0.29.3 queued (position 3)",
    ]);

    await svc.cancelBuild(q2.buildId, "ops"); // queued: plucked, nothing killed
    expect(phase(q2.buildId)).toBe("cancelled");
    expect(svc.getBuild(q2.buildId)!.error).toBe("Cancelled while queued");

    h.buildBehavior.delete("linux-amd64");
    await until(() => h.children.length > 2 && h.calls.some((c) => c.args[0] === "build"));
    await svc.cancelBuild(first.buildId, "ops"); // in flight: SIGTERM
    await until(() => done(first.buildId));
    expect(phase(first.buildId)).toBe("cancelled");
    await until(() => done(q1.buildId) && done(q3.buildId));
    expect([phase(q1.buildId), phase(q3.buildId)]).toEqual(["complete", "complete"]);
    expect(events.some((e) => e.action === "agent.build.failed")).toBe(false);
  });

  it("cancelling in flight SIGTERMs the running child and records the phase it was in", async () => {
    h.buildBehavior.set("linux-arm64", "hang");
    const { buildId } = await svc.startBuild({ actor: "a" });
    await until(() => phase(buildId) === "building:linux-arm64");
    const child = h.children.at(-1)!;
    await svc.cancelBuild(buildId, "bob");
    expect(child.signals).toEqual(["SIGTERM"]);
    await until(() => done(buildId));
    const b = svc.getBuild(buildId)!;
    expect(b).toMatchObject({ phase: "cancelled", error: "Build cancelled by operator" });
    expect(b).not.toHaveProperty("activeChild");
    expect(events.find((e) => e.action === "agent.build.cancelled")).toMatchObject({ actor: "bob", details: { wasQueued: false, phase: "building:linux-arm64" } });
    expect(h.calls.filter((c) => c.args[0] === "build")).toHaveLength(2);
  });

  it("cancelBuild refuses an unknown or finished build", async () => {
    await expect(svc.cancelBuild("nope", "x")).rejects.toBeInstanceOf(svc.BuildNotFoundError);
    const { buildId } = await svc.startBuild({ actor: "a" });
    await until(() => done(buildId));
    await expect(svc.cancelBuild(buildId, "x")).rejects.toBeInstanceOf(svc.BuildAlreadyFinishedError);
  });

  it("drops a finished build's state an hour after it finished", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const first = await svc.startBuild({ actor: "a" });
    await until(() => done(first.buildId));
    vi.setSystemTime(new Date("2026-03-01T11:00:01Z"));
    const second = await svc.startBuild({ actor: "a" });
    await until(() => done(second.buildId));
    expect(svc.getBuild(first.buildId)).toBeNull();
    expect(svc.getBuild(second.buildId)).not.toBeNull();
  });
});

describe("signing (fail-open)", () => {
  it("signs both Windows binaries and stamps signed: true", async () => {
    h.signing = { enabled: true, keystorePath: "/k.p12", keystorePassword: "placeholder", alias: "", tsaUrl: "http://tsa.example.test" };
    const { buildId } = await svc.startBuild({ actor: "a" });
    await until(() => done(buildId));
    const signSteps = svc.getBuild(buildId)!.steps.filter((s) => s.platform === "sign");
    expect(signSteps.map((s) => [s.arch, s.status])).toEqual([["windows-amd64", "success"], ["windows-arm64", "success"]]);
    expect(events.find((e) => e.action === "agent.build.completed")!.details.signed).toBe(true);
    expect(signing.clearSigningFailure).toHaveBeenCalled();
  });

  it("one file failing ships the build UNSIGNED: completes, records the failure, warns", async () => {
    h.signing = { enabled: true, keystorePath: "/k.p12", keystorePassword: "placeholder", tsaUrl: "" };
    h.signFail.add("polaris-agent-windows-arm64.exe");
    const { buildId } = await svc.startBuild({ actor: "a" });
    await until(() => done(buildId));
    expect(phase(buildId)).toBe("complete");
    expect(events.find((e) => e.action === "agent.build.sign_failed")?.message).toMatch(/shipped UNSIGNED \(polaris-agent-windows-arm64\.exe\)/);
    expect(vi.mocked(signing.recordSigningFailure).mock.calls[0][0]).toMatchObject({ buildId, files: ["polaris-agent-windows-arm64.exe"] });
    expect(events.find((e) => e.action === "agent.build.completed")!.details.signed).toBe(false);
  });

  it("an unavailable signer is a failed preflight step, not a failed build", async () => {
    h.signing = { enabled: true };
    h.signAvail = { ok: false, error: "jsign jar not found" };
    const { buildId } = await svc.startBuild({ actor: "a" });
    await until(() => done(buildId));
    expect(phase(buildId)).toBe("complete");
    expect(svc.getBuild(buildId)!.steps.at(-1)).toEqual({ platform: "sign", arch: "windows", status: "failed", error: "jsign jar not found" });
    expect(signing.signFile).not.toHaveBeenCalled();
  });
});

describe("getInventory", () => {
  it("reports the manifest, which binaries are present, older versions newest-first, and the server URL trio", async () => {
    h.files.set(resolve(AGENT_BIN_DIR, "manifest.json"), JSON.stringify({ currentVersion: "0.29.3", binaries: {} }));
    h.stats.set(resolve(AGENT_BIN_DIR, "0.29.3", "polaris-agent-linux-amd64"), { size: 100, mtimeMs: Date.parse("2026-03-01T00:00:00Z") });
    h.dirs.set(AGENT_BIN_DIR, [{ name: "0.29.3", dir: true }, { name: "0.28.0", dir: true }, { name: "0.29.0", dir: true }, { name: "tmp", dir: true }, { name: "manifest.json", dir: false }]);
    h.dirs.set(resolve(AGENT_BIN_DIR, "0.28.0"), [{ name: "a", dir: false }]);
    h.dirs.set(resolve(AGENT_BIN_DIR, "0.29.0"), [{ name: "a", dir: false }, { name: "b", dir: false }]);
    h.stats.set(resolve(AGENT_BIN_DIR, "0.28.0", "a"), { size: 10, mtimeMs: Date.parse("2026-01-01T00:00:00Z") });
    h.stats.set(resolve(AGENT_BIN_DIR, "0.29.0", "a"), { size: 20, mtimeMs: Date.parse("2026-02-01T00:00:00Z") });
    h.stats.set(resolve(AGENT_BIN_DIR, "0.29.0", "b"), { size: 5, mtimeMs: Date.parse("2026-02-02T00:00:00Z") });
    prisma.setting.findUnique.mockResolvedValue({ value: { url: " https://override.example.test/ " } });

    const inv = await svc.getInventory();
    expect(inv).toMatchObject({ goAvailable: true, goTooOld: false, goMinimum: svc.GO_MINIMUM, agentSourceVersion: "0.29.3", manifest: { currentVersion: "0.29.3" } });
    expect(inv.files.filter((f) => f.present).map((f) => [f.filename, f.sizeBytes])).toEqual([["polaris-agent-linux-amd64", 100]]);
    expect(inv.files).toHaveLength(6);
    expect(inv.oldVersions).toEqual([
      { version: "0.29.0", bytes: 25, mtime: "2026-02-02T00:00:00.000Z" },
      { version: "0.28.0", bytes: 10, mtime: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(inv.serverUrl).toEqual({ effective: "https://polaris.example.test", override: "https://override.example.test", derived: "https://derived.example.test" });
  });

  it("no manifest, no directory, too-old Go: renders as 'no builds yet'", async () => {
    h.goVersionOut = "go version go1.20.1 linux/amd64";
    const inv = await svc.getInventory();
    expect(inv).toMatchObject({ manifest: null, oldVersions: [], goTooOld: true, serverUrl: { override: null } });
    expect(inv.files.every((f) => !f.present)).toBe(true);
  });
});

describe("pruneOldAgentVersions", () => {
  function seedVersions(names: string[]): void {
    h.dirs.set(AGENT_BIN_DIR, names.map((name) => ({ name, dir: true })));
    names.forEach((name, i) => {
      const dir = resolve(AGENT_BIN_DIR, name);
      h.stats.set(dir, { size: 0, mtimeMs: 1_000_000 * (names.length - i), dir: true }); // first = newest
      h.dirs.set(dir, [{ name: "bin", dir: false }]);
      h.stats.set(resolve(dir, "bin"), { size: 1000 + i, mtimeMs: 0 });
    });
  }

  it("keeps current, in-use and the newest N; removes the rest, naming each protection by priority", async () => {
    seedVersions(["0.30.0", "0.29.0", "0.28.0", "0.27.0", "0.26.0", "0.25.0", "not-a-version"]);
    h.files.set(resolve(AGENT_BIN_DIR, "manifest.json"), JSON.stringify({ currentVersion: "0.27.0" }));
    prisma.managedAgent.findMany.mockResolvedValue([{ agentVersion: "0.29.0" }, { agentVersion: "0.25.0" }, { agentVersion: null }]);
    const r = await svc.pruneOldAgentVersions();
    expect(prisma.managedAgent.findMany.mock.calls[0][0].where).toEqual({ installStatus: { not: "revoked" } });
    expect(r.scanned).toBe(6);
    expect(r.keepLastN).toBe(3);
    expect(Object.fromEntries(r.protected.map((p) => [p.version, p.reason]))).toEqual({
      "0.30.0": "keep-last-n", "0.29.0": "in-use", "0.28.0": "keep-last-n", "0.27.0": "current", "0.25.0": "in-use",
    });
    expect(r.removed).toEqual([{ version: "0.26.0", bytes: 1004 }]);
    expect(h.removed).toEqual([resolve(AGENT_BIN_DIR, "0.26.0")]);
  });

  it("honours POLARIS_AGENT_KEEP_VERSIONS (0 allowed) and ignores a bad value", async () => {
    seedVersions(["0.30.0", "0.29.0"]);
    process.env.POLARIS_AGENT_KEEP_VERSIONS = "0";
    expect((await svc.pruneOldAgentVersions()).removed.map((x) => x.version)).toEqual(["0.30.0", "0.29.0"]);
    h.removed.length = 0;
    process.env.POLARIS_AGENT_KEEP_VERSIONS = "-4";
    expect((await svc.pruneOldAgentVersions()).keepLastN).toBe(3);
  });

  it("fails CLOSED when the agent table cannot be read, and is a no-op with no directory", async () => {
    seedVersions(["0.30.0", "0.29.0", "0.28.0", "0.27.0"]);
    prisma.managedAgent.findMany.mockRejectedValue(new Error("db down"));
    await expect(svc.pruneOldAgentVersions()).resolves.toEqual({ scanned: 0, protected: [], keepLastN: 3, removed: [] });
    expect(h.removed).toEqual([]);
    h.dirs.clear();
    prisma.managedAgent.findMany.mockResolvedValue([]);
    await expect(svc.pruneOldAgentVersions()).resolves.toMatchObject({ scanned: 0, removed: [] });
  });
});
