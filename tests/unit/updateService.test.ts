/**
 * tests/unit/updateService.test.ts — the update check, the repo override, the
 * applied-commit history and the restart handshake (CQ-T010).
 *
 * Complements, does not repeat:
 *   - updatePipeline.test.ts — applyUpdate end to end, plus checkForUpdates'
 *     running-commit vs checkout comparison and getUpdateActivity
 *   - updateTrain.test.ts — getUpdateTrain / setUpdateTrain, isSafeGitRef,
 *     isSafeRepoUrl
 *   - imageUpdateCheck.test.ts — checkImageForUpdates, updateCheckIntervalMs
 *   - integration/serverRestartContainer + firmwareAbortRestartGuard — restartService
 *
 * What was unreached: getUpdateRepoInfo (POLARIS_UPDATE_REPO vs origin, and an
 * override the shell would act on being ignored); the origin repoint before a
 * fetch (set-url only when it differs, add when there is no origin, never
 * fatal); the release train with no tags and with an unsafe highest tag; the
 * nightly ref fallback chain; a failed fetch reporting `failed`;
 * getRecentCommits' parse and its limit clamp; initUpdateStatus — the restart
 * handshake that turns a saved `restarting` into `complete` and writes the
 * server.update.completed Event; clearUpdateStatus removing the file; and
 * isImageUpdateMode on a host with a git tree.
 *
 * Nothing real runs: the shell goes through _setExecRunnerForTests, the status
 * file is an in-memory map behind a partial node:fs mock, and the version
 * helpers are fixed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const isStatusFile = (p: unknown) => typeof p === "string" && p.endsWith(".update-status.json");
  return {
    ...real,
    existsSync: (p: any) => (isStatusFile(p) ? h.files.has(p) : real.existsSync(p)),
    readFileSync: (p: any, ...rest: any[]) => (isStatusFile(p) ? h.files.get(p)! : (real.readFileSync as any)(p, ...rest)),
    writeFileSync: (p: any, data: any, ...rest: any[]) => {
      if (isStatusFile(p)) { h.files.set(p, String(data)); return; }
      return (real.writeFileSync as any)(p, data, ...rest);
    },
    unlinkSync: (p: any) => {
      if (isStatusFile(p)) { h.files.delete(p); return; }
      return real.unlinkSync(p);
    },
  };
});
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/version.js", () => ({
  getAppVersion: () => "0.99.500",
  getRunningCommit: () => null,
}));
vi.mock("../../src/services/backupService.js", () => ({ createBackup: vi.fn() }));
vi.mock("../../src/services/proxyConfigService.js", () => ({ getProxyConfig: vi.fn(), saveProxyConfig: vi.fn() }));
vi.mock("../../src/services/nginxRenderer.js", () => ({ renderNginxConfig: vi.fn(() => "") }));

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  _setExecRunnerForTests,
  _setRunningCommitForTests,
  checkForUpdates,
  clearUpdateStatus,
  getRecentCommits,
  getUpdateRepoInfo,
  getUpdateStatus,
  initUpdateStatus,
  isImageUpdateMode,
  isUpdateMechanismAvailable,
} from "../../src/services/updateService.js";

type Rule = { match: string | RegExp; out?: string; fail?: boolean };
let calls: string[] = [];

/** First matching rule wins; anything unmatched answers empty stdout. */
function shell(rules: Rule[]): void {
  calls = [];
  _setExecRunnerForTests(async (cmd: string) => {
    calls.push(cmd);
    for (const r of rules) {
      const hit = typeof r.match === "string" ? cmd.includes(r.match) : r.match.test(cmd);
      if (!hit) continue;
      if (r.fail) throw Object.assign(new Error(`fail: ${cmd}`), { stderr: "" });
      return { stdout: r.out ?? "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

const savedRepo = process.env.POLARIS_UPDATE_REPO;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.files.clear();
  clearUpdateStatus();
  delete process.env.POLARIS_UPDATE_REPO;
  _setRunningCommitForTests(undefined);
  stubbed(prisma.setting.findUnique).mockResolvedValue(null); // nightly train
});

afterEach(() => {
  _setExecRunnerForTests(null);
  _setRunningCommitForTests(undefined);
  if (savedRepo === undefined) delete process.env.POLARIS_UPDATE_REPO;
  else process.env.POLARIS_UPDATE_REPO = savedRepo;
});

it("this host has a git tree, so updates are available and not image-mode", () => {
  expect(isUpdateMechanismAvailable()).toBe(true);
  expect(isImageUpdateMode()).toBe(false);
});

describe("getUpdateRepoInfo", () => {
  it("POLARIS_UPDATE_REPO wins, trimmed, and git is never asked", async () => {
    process.env.POLARIS_UPDATE_REPO = "  https://git.example.com/mirror/polaris.git ";
    shell([]);
    await expect(getUpdateRepoInfo()).resolves.toEqual({ url: "https://git.example.com/mirror/polaris.git", source: "env" });
    expect(calls).toEqual([]);
  });

  it("unset: the existing origin, read from git", async () => {
    shell([{ match: "git remote get-url origin", out: "git@github.com:owner/polaris.git\n" }]);
    await expect(getUpdateRepoInfo()).resolves.toEqual({ url: "git@github.com:owner/polaris.git", source: "origin" });
  });

  it("an override the shell would act on is ignored in favour of origin", async () => {
    process.env.POLARIS_UPDATE_REPO = "https://x/$(id).git";
    shell([{ match: "git remote get-url origin", out: "https://github.com/a/b.git" }]);
    await expect(getUpdateRepoInfo()).resolves.toEqual({ url: "https://github.com/a/b.git", source: "origin" });
  });

  it("no origin at all reads null, not an error", async () => {
    shell([{ match: "get-url", fail: true }]);
    await expect(getUpdateRepoInfo()).resolves.toEqual({ url: null, source: "origin" });
  });
});

describe("checkForUpdates — remote, train and ref selection", () => {
  const SHA = "abcdef0123456789abcdef0123456789abcdef01";

  it("repoints origin only when it differs from POLARIS_UPDATE_REPO, before fetching", async () => {
    process.env.POLARIS_UPDATE_REPO = "https://git.example.com/m.git";
    shell([
      { match: "get-url", out: "https://github.com/old/polaris.git" },
      { match: "git rev-list -n 1", out: SHA },
    ]);
    await checkForUpdates();
    const setUrl = calls.findIndex((c) => c === 'git remote set-url origin "https://git.example.com/m.git"');
    const fetch = calls.findIndex((c) => c.startsWith("git fetch"));
    expect(setUrl).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThan(setUrl);

    shell([{ match: "get-url", out: "https://git.example.com/m.git" }, { match: "git rev-list -n 1", out: SHA }]);
    await checkForUpdates();
    expect(calls.some((c) => c.includes("set-url"))).toBe(false);
  });

  it("adds origin when set-url fails, and a failed add is still not fatal", async () => {
    process.env.POLARIS_UPDATE_REPO = "https://git.example.com/m.git";
    shell([{ match: "get-url", fail: true }, { match: "set-url", fail: true }, { match: "git rev-list -n 1", out: SHA }]);
    await checkForUpdates();
    expect(calls).toContain('git remote add origin "https://git.example.com/m.git"');

    shell([{ match: "get-url", fail: true }, { match: "set-url", fail: true }, { match: "remote add", fail: true }, { match: "git rev-list -n 1", out: SHA }]);
    const s = await checkForUpdates();
    expect(s.state).toBe("up-to-date");
    expect(calls.some((c) => c.startsWith("git fetch"))).toBe(true);
  });

  it("nightly falls back origin/HEAD → origin/main → origin/master", async () => {
    shell([
      { match: "--verify --quiet origin/HEAD", fail: true },
      { match: "--verify --quiet origin/main", fail: true },
      { match: "git rev-list -n 1", out: SHA },
    ]);
    const s = await checkForUpdates();
    expect(s.train).toBe("nightly");
    expect(calls).toContain("git rev-list -n 1 origin/master");
  });

  it("release train with no tags is up to date with a note, never an error", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ key: "update.train", value: "release" });
    shell([{ match: "git tag --list", out: "\n" }]);
    const s = await checkForUpdates();
    expect(s).toMatchObject({ state: "up-to-date", train: "release", commitsBehind: 0, currentVersion: "0.99.500" });
    expect(s.note).toMatch(/No published releases yet/);
  });

  it("release train skips a tag the shell would act on and compares against the next one", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ key: "update.train", value: "release" });
    shell([
      { match: "git tag --list", out: "v9.9.9;id\nv1.2.0\nv1.1.0\n" },
      { match: "git rev-list -n 1", out: SHA },
    ]);
    const s = await checkForUpdates();
    expect(s.releaseTag).toBe("v1.2.0");
    expect(calls.some((c) => c.includes("v9.9.9"))).toBe(false);
    expect(calls).toContain("git rev-list -n 1 v1.2.0");
  });

  it("an available update carries the version computed from the target's package.json and commit count", async () => {
    _setRunningCommitForTests("1111111");
    shell([
      { match: "git rev-list -n 1 HEAD", out: "1111111aaaa" },
      { match: "git rev-list -n 1 origin/HEAD", out: "2222222bbbb" },
      { match: "git rev-list --count 1111111..origin/HEAD", out: "3\n" },
      { match: "git log --oneline", out: "2222222 c\n2222221 b\n2222220 a\n" },
      { match: "git show origin/HEAD:package.json", out: JSON.stringify({ version: "0.42.0" }) },
      { match: "git rev-list --count origin/HEAD", out: "1234\n" },
    ]);
    const s = await checkForUpdates();
    expect(s).toMatchObject({ state: "available", latestVersion: "0.42.1234", commitsBehind: 3, currentCommit: "1111111", latestCommit: "2222222" });
    expect(s.changes).toHaveLength(3);
    expect(s.note).toBeUndefined();
  });

  it("a failed fetch reports failed with the reason, and the status reads it back", async () => {
    shell([{ match: "git fetch", fail: true }]);
    const s = await checkForUpdates();
    expect(s.state).toBe("failed");
    expect(s.error).toMatch(/^Failed to check for updates: fail: git fetch/);
    expect(getUpdateStatus().state).toBe("failed");
  });
});

describe("getRecentCommits", () => {
  it("parses hash / date / subject, keeping tabs inside the subject", async () => {
    shell([{ match: "git log -n", out: "abc1234\t2026-11-12\tFix: a\tb\ndef5678\t2026-11-11\tAdd thing\n" }]);
    await expect(getRecentCommits(2)).resolves.toEqual([
      { hash: "abc1234", date: "2026-11-12", subject: "Fix: a\tb" },
      { hash: "def5678", date: "2026-11-11", subject: "Add thing" },
    ]);
  });

  it("a line without the two tabs keeps the line as the hash", async () => {
    shell([{ match: "git log -n", out: "weird line\n" }]);
    await expect(getRecentCommits()).resolves.toEqual([{ hash: "weird line", date: "", subject: "" }]);
  });

  it.each([[0, 20], [-5, 1], [7.9, 7], [500, 100], [Number.NaN, 20]])("limit %s → git log -n %s", async (limit, n) => {
    shell([]);
    await getRecentCommits(limit);
    expect(calls[0]).toMatch(new RegExp(`^git log -n ${n} `));
  });

  it("git failing reads as no history", async () => {
    shell([{ match: "git log", fail: true }]);
    await expect(getRecentCommits()).resolves.toEqual([]);
  });
});

describe("initUpdateStatus — the restart handshake", () => {
  // The app root, as the service resolves it (src/services/../..).
  const STATUS_KEY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".update-status.json");
  const putStatus = (s: unknown) => {
    clearUpdateStatus();
    h.files.set(STATUS_KEY, JSON.stringify(s));
  };

  it("a saved `restarting` becomes `complete`: steps finished, file rewritten, Event written", async () => {
    putStatus({
      state: "restarting", currentVersion: "0.99.400", currentCommit: "aaaaaaa", latestCommit: "bbbbbbb",
      startedAt: "2026-11-12T10:00:00.000Z", train: "nightly",
      steps: [{ name: "Pull", status: "done" }, { name: "Restart", status: "running" }, { name: "Later", status: "pending" }, { name: "Odd", status: "failed" }],
    });
    initUpdateStatus();
    const s = getUpdateStatus();
    expect(s.state).toBe("complete");
    expect(s.latestVersion).toBe("0.99.500");
    expect(s.completedAt).toEqual(expect.any(String));
    expect(s.steps!.map((x) => x.status)).toEqual(["done", "done", "done", "failed"]);
    expect(JSON.parse(h.files.get(STATUS_KEY)!).state).toBe("complete");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "server.update.completed",
      actor: "system:update",
      message: "Update completed: v0.99.400 → v0.99.500 is running",
      details: expect.objectContaining({ fromVersion: "0.99.400", toVersion: "0.99.500", fromCommit: "aaaaaaa", toCommit: "bbbbbbb", train: "nightly" }),
    });
  });

  it("a saved `complete` or `failed` is shown again, without an Event", () => {
    putStatus({ state: "failed", error: "npm ci timed out" });
    initUpdateStatus();
    expect(getUpdateStatus()).toMatchObject({ state: "failed", error: "npm ci timed out" });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("any other saved state, a missing file or unreadable JSON leaves the status idle", () => {
    putStatus({ state: "applying" });
    initUpdateStatus();
    expect(getUpdateStatus().state).toBe("idle");
    h.files.set(STATUS_KEY, "{not json");
    initUpdateStatus();
    expect(getUpdateStatus().state).toBe("idle");
    h.files.clear();
    initUpdateStatus();
    expect(getUpdateStatus().state).toBe("idle");
  });

  it("clearUpdateStatus deletes the file and returns to idle", () => {
    putStatus({ state: "complete" });
    initUpdateStatus();
    expect(getUpdateStatus().state).toBe("complete");
    clearUpdateStatus();
    expect(h.files.has(STATUS_KEY)).toBe(false);
    expect(getUpdateStatus().state).toBe("idle");
  });

  it("getUpdateStatus hands out a copy of the steps", () => {
    putStatus({ state: "complete", steps: [{ name: "A", status: "done" }] });
    initUpdateStatus();
    getUpdateStatus().steps!.push({ name: "B", status: "done" });
    expect(getUpdateStatus().steps).toHaveLength(1);
  });
});
