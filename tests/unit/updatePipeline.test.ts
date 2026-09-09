/**
 * tests/unit/updatePipeline.test.ts
 *
 * applyUpdate — the in-app update pipeline. CLAUDE.md directs operators to use
 * this mechanism for every production deployment, and it is the highest-blast-
 * radius path in the repo: pre-update backup, git checkout/pull, npm ci, prisma
 * generate, tsc build, prisma migrate deploy, then a systemd restart. Before
 * 2026-08 the only coverage was getUpdateTrain/setUpdateTrain normalisation, so
 * the step sequencing, the fail-and-stop contract at each gate, and the
 * backup-failure branch were all unverified.
 *
 * Approach: the shell is stubbed through `_setExecRunnerForTests`, so the real
 * sequencing runs but nothing touches git, npm or systemd. Fake timers keep the
 * post-pipeline `setTimeout(restartService, 1500)` from ever firing — without
 * them this test would try to restart the host's services.
 *
 * The contract being pinned:
 *   - a failure at ANY step marks that step failed, sets state=failed, and never
 *     reaches the restart
 *   - a pre-update backup failure ABORTS by default (the 2026-08 fix: it used to
 *     mark step 0 "done" with "Backup skipped" and carry on into the
 *     irreversible migration with no rollback point)
 *   - allowWithoutBackup is the only thing that lets it continue
 *   - the release train checks out the highest tag; nightly fast-forwards
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Mocks, installed before the module under test is imported ────────────────

const settingRows = new Map<string, unknown>();
const prisma = {
  setting: {
    findUnique: vi.fn(async ({ where }: any) =>
      settingRows.has(where.key) ? { key: where.key, value: settingRows.get(where.key) } : null,
    ),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      settingRows.set(where.key, (update?.value ?? create?.value));
      return { key: where.key, value: settingRows.get(where.key) };
    }),
  },
};
vi.mock("../../src/db.js", () => ({ prisma }));

const createBackup = vi.fn(async () => ({
  record: { id: "bk-test", filename: "polaris-pre-update-test.gz", size: 4096, encrypted: false, createdAt: "" },
  path: "/tmp/bk-test",
}));
vi.mock("../../src/services/backupService.js", () => ({ createBackup }));

// nginx/proxy config sync runs late in the pipeline; stub it so the test does
// not depend on /etc being writable.
vi.mock("../../src/services/proxyConfigService.js", () => ({
  getProxyConfig: vi.fn(async () => ({ managedMode: false })),
  saveProxyConfig: vi.fn(async () => {}),
}));
vi.mock("../../src/services/nginxRenderer.js", () => ({ renderNginxConfig: vi.fn(() => "") }));

const {
  applyUpdate,
  getUpdateStatus,
  clearUpdateStatus,
  isUpdateMechanismAvailable,
  _setExecRunnerForTests,
  _resetApplyingForTests,
} = await import("../../src/services/updateService.js");

const STATUS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".update-status.json");

/** Step indexes, in the order applyUpdate declares them. */
const STEP = {
  BACKUP: 0,
  PULL: 1,
  DEPS: 2,
  GENERATE: 3,
  BUILD: 4,
  MIGRATE: 5,
  RESTART: 6,
} as const;

/** A recording exec stub. `failOn` matches a substring of the command. */
function stubExec(opts: { failOn?: string; stdout?: Record<string, string> } = {}) {
  const calls: string[] = [];
  _setExecRunnerForTests(async (cmd: string) => {
    calls.push(cmd);
    if (opts.failOn && cmd.includes(opts.failOn)) {
      throw Object.assign(new Error(`stub failure: ${cmd}`), { stderr: `stub stderr for ${cmd}` });
    }
    for (const [needle, out] of Object.entries(opts.stdout ?? {})) {
      if (cmd.includes(needle)) return { stdout: out, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return calls;
}

/** applyUpdate is fire-and-forget internally; await it then flush microtasks. */
async function runUpdate(password?: string | null, allowWithoutBackup?: boolean) {
  await applyUpdate(password ?? null, allowWithoutBackup ?? false);
  await Promise.resolve();
}

function steps() {
  return getUpdateStatus().steps ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  settingRows.clear();
  vi.useFakeTimers(); // the post-pipeline restart timer must never fire
  clearUpdateStatus();
  // On the success path applyUpdate never clears its in-flight guard (the
  // process is about to restart), so without this every test after the first
  // would return early.
  _resetApplyingForTests();
  createBackup.mockResolvedValue({
    record: { id: "bk-test", filename: "polaris-pre-update-test.gz", size: 4096, encrypted: false, createdAt: "" },
    path: "/tmp/bk-test",
  });
});

afterEach(() => {
  _setExecRunnerForTests(null);
  vi.useRealTimers();
  if (existsSync(STATUS_FILE)) { try { unlinkSync(STATUS_FILE); } catch { /* best effort */ } }
});

// The whole suite is meaningless if the environment reports updates disabled
// (no .git dir) — applyUpdate returns early in that case.
const d = isUpdateMechanismAvailable() ? describe : describe.skip;

d("applyUpdate — pre-update backup contract", () => {
  it("ABORTS when the backup fails and allowWithoutBackup is not set", async () => {
    // The 2026-08 fix. Previously this marked step 0 "done" with
    // "Backup skipped: …" and continued into `prisma migrate deploy`, which is
    // irreversible — so a bad update had no recovery point AND the UI showed a
    // green step.
    createBackup.mockRejectedValue(new Error("pg_dump not available"));
    const calls = stubExec();

    await runUpdate();

    expect(getUpdateStatus().state).toBe("failed");
    expect(steps()[STEP.BACKUP]?.status).toBe("failed");
    expect(steps()[STEP.BACKUP]?.message).toContain("Pre-update backup failed");
    // Nothing downstream ran: no git, no npm, and critically no migration.
    expect(calls.some((c) => c.includes("git"))).toBe(false);
    expect(calls.some((c) => c.includes("migrate deploy"))).toBe(false);
    expect(steps()[STEP.MIGRATE]?.status).toBe("pending");
  });

  it("continues past a failed backup ONLY when allowWithoutBackup is set", async () => {
    createBackup.mockRejectedValue(new Error("pg_dump not available"));
    const calls = stubExec();

    await runUpdate(null, true);

    // The step is marked FAILED, not "done" — the operator overrode the abort,
    // they did not get a backup.
    expect(steps()[STEP.BACKUP]?.status).toBe("failed");
    expect(steps()[STEP.BACKUP]?.message).toContain("operator override");
    expect(calls.some((c) => c.includes("migrate deploy"))).toBe(true);
    expect(getUpdateStatus().state).toBe("restarting");
  });

  it("honours the update.skip_backup Setting without calling createBackup", async () => {
    settingRows.set("update.skip_backup", true);
    stubExec();

    await runUpdate();

    expect(createBackup).not.toHaveBeenCalled();
    expect(steps()[STEP.BACKUP]?.status).toBe("done");
    expect(steps()[STEP.BACKUP]?.message).toContain("disabled in settings");
  });

  it("passes the passphrase through and records the backup filename", async () => {
    stubExec();
    await runUpdate("a-strong-backup-passphrase");
    expect(createBackup).toHaveBeenCalledWith(
      expect.objectContaining({ password: "a-strong-backup-passphrase", kind: "pre-update" }),
    );
    expect(getUpdateStatus().backupFile).toBe("polaris-pre-update-test.gz");
  });
});

d("applyUpdate — step sequencing", () => {
  it("runs the steps in order and reaches the restart on a clean run", async () => {
    const calls = stubExec();

    await runUpdate();

    // Backup happens BEFORE anything mutates the working tree.
    expect(createBackup).toHaveBeenCalled();
    const firstGit = calls.findIndex((c) => c.includes("git"));
    const npmCi = calls.findIndex((c) => c.includes("npm ci"));
    const generate = calls.findIndex((c) => c.includes("prisma generate"));
    const build = calls.findIndex((c) => c.includes("npm run build"));
    const migrate = calls.findIndex((c) => c.includes("migrate deploy"));
    expect(firstGit).toBeGreaterThanOrEqual(0);
    expect(npmCi).toBeGreaterThan(firstGit);
    expect(generate).toBeGreaterThan(npmCi);
    expect(build).toBeGreaterThan(generate);
    // The generate-before-migrate order is load-bearing: migrating first would
    // drop columns the still-stale client selects.
    expect(migrate).toBeGreaterThan(generate);

    expect(steps().slice(0, 6).every((s) => s.status === "done")).toBe(true);
    expect(getUpdateStatus().state).toBe("restarting");
  });

  it.each([
    ["git pull --ff-only", STEP.PULL, "git update failed"],
    ["npm ci", STEP.DEPS, "npm ci failed"],
    ["npm run build", STEP.BUILD, "TypeScript build failed"],
    ["migrate deploy", STEP.MIGRATE, "Migration failed"],
  ])("fails at %s, marks that step, and never restarts", async (failOn, stepIdx, message) => {
    stubExec({ failOn });

    await runUpdate();

    expect(getUpdateStatus().state).toBe("failed");
    expect(steps()[stepIdx]?.status).toBe("failed");
    expect(steps()[stepIdx]?.message).toContain(message);
    expect(getUpdateStatus().state).not.toBe("restarting");
    // Every later step is untouched.
    for (let i = stepIdx + 1; i <= STEP.RESTART; i++) {
      expect(steps()[i]?.status, `step ${i}`).toBe("pending");
    }
  });

  it("does not start a second update while one is in progress", async () => {
    stubExec();
    await runUpdate();
    const first = getUpdateStatus().startedAt;
    // _applying is only cleared on failure/completion paths; a concurrent call
    // must not restart the pipeline and clobber the in-flight status.
    createBackup.mockClear();
    await runUpdate();
    expect(createBackup).not.toHaveBeenCalled();
    expect(getUpdateStatus().startedAt).toBe(first);
  });
});

d("applyUpdate — train selection", () => {
  it("nightly fast-forwards the branch", async () => {
    settingRows.set("update.train", "nightly");
    const calls = stubExec();

    await runUpdate();

    expect(calls.some((c) => c.includes("git pull --ff-only"))).toBe(true);
    expect(calls.some((c) => c.includes("checkout --detach"))).toBe(false);
  });

  it("release checks out the highest version-sorted tag", async () => {
    settingRows.set("update.train", "release");
    const calls = stubExec({ stdout: { "git tag --list": "v1.4.0\nv1.3.9\nv1.2.0\n" } });

    await runUpdate();

    expect(calls.some((c) => c.includes("git fetch --all --tags"))).toBe(true);
    expect(calls.some((c) => c.includes("git checkout --detach v1.4.0"))).toBe(true);
    expect(calls.some((c) => c.includes("git pull --ff-only"))).toBe(false);
  });


  /**
   * Regression cover for the 2026-09-08 prod update that failed
   * undiagnosably. `npm ci` was SIGTERMed by the step's 5-minute ceiling on a
   * cold npm cache; the operator saw four EBADENGINE warnings about Node
   * versions, cut off mid-sentence, and no cause — because the step kept the
   * first 500 chars of npm's stderr, and npm writes warnings first and its real
   * errors last. Running `npm ci` by hand on that host then succeeded, which is
   * the signature of a timeout rather than a dependency problem.
   */
  describe("failure reporting", () => {
    /** exec rejects the way child_process does on a timeout kill: SIGTERM,
     *  killed=true, and whatever output had accumulated — no error text. */
    function stubTimeoutOn(needle: string, stderr: string) {
      _setExecRunnerForTests(async (cmd: string) => {
        if (cmd.includes(needle)) {
          throw Object.assign(new Error("Command failed"), {
            killed: true,
            signal: "SIGTERM",
            code: null,
            stdout: "",
            stderr,
          });
        }
        return { stdout: "", stderr: "" };
      });
    }

    it("names a timeout as a timeout, with the limit, instead of as a command failure", async () => {
      stubTimeoutOn("npm ci", "npm warn EBADENGINE Unsupported engine {\n");

      await runUpdate();

      const msg = steps()[STEP.DEPS]?.message ?? "";
      expect(getUpdateStatus().state).toBe("failed");
      expect(msg).toContain("timed out");
      expect(msg).toContain("900s"); // the named NPM_CI_TIMEOUT_MS, 15 min
      expect(msg).toContain("did not fail, it ran out of time");
    });

    it("warns that a failed npm ci left the host without dependencies", async () => {
      // npm ci deletes node_modules BEFORE installing, so a killed install
      // leaves nothing on disk while the running process serves from modules
      // already in memory. The next restart is what breaks, so the message has
      // to say so — that is the difference between a calm retry and an outage.
      stubTimeoutOn("npm ci", "npm warn EBADENGINE\n");

      await runUpdate();

      const msg = steps()[STEP.DEPS]?.message ?? "";
      expect(msg).toContain("INCOMPLETE");
      expect(msg).toContain("do not restart");
    });

    it("pings the registry BEFORE npm ci, so a dead registry cannot wipe node_modules", async () => {
      // The ordering IS the fix. npm ci deletes node_modules before it installs,
      // so without a preflight an unreachable registry destroys a working
      // dependency tree and only then fails — which is how a TLS-inspecting
      // proxy left prod unable to survive a restart on 2026-09-09.
      const calls = stubExec();

      await runUpdate();

      const ping = calls.findIndex((c) => c.includes("npm ping"));
      const npmCi = calls.findIndex((c) => c.includes("npm ci"));
      expect(ping).toBeGreaterThanOrEqual(0);
      expect(npmCi).toBeGreaterThan(ping);
    });

    it("stops before installing when the registry is unreachable, and says it is safe to restart", async () => {
      // The whole value of the preflight is the operator being told they need
      // do nothing to recover. If this message ever loses that, someone will
      // hand-repair a host that was never broken.
      const calls = stubExec({ failOn: "npm ping" });

      await runUpdate();

      expect(calls.some((c) => c.includes("npm ci"))).toBe(false);
      const msg = steps()[STEP.DEPS]?.message ?? "";
      expect(msg).toContain("Cannot reach the npm registry");
      expect(msg).toContain("safe to restart");
      expect(msg).toContain("NODE_EXTRA_CA_CERTS");
      // And it must NOT claim the host is now broken — that text belongs to the
      // post-wipe failure, and reading it here would cause the wrong response.
      expect(msg).not.toContain("INCOMPLETE");
      expect(getUpdateStatus().state).toBe("failed");
    });

    it("installs devDependencies explicitly, not via the deprecated production flag", async () => {
      // Prod sets NODE_ENV=production, which makes npm omit dev deps — and the
      // build needs TypeScript. --include=dev clears `omit` the same way
      // --production=false did, without npm 11's deprecation notice landing in
      // the operator's error output.
      const calls = stubExec();

      await runUpdate();

      const npmCi = calls.find((c) => c.includes("npm ci")) ?? "";
      expect(npmCi).toContain("--include=dev");
      expect(npmCi).not.toContain("--production");
    });

    it("keeps the TAIL of stderr, where npm puts the actual error", async () => {
      // Head-truncation is the bug: 40 warning lines then the real cause.
      const warnings = Array.from(
        { length: 40 },
        (_, i) => `npm warn EBADENGINE Unsupported engine ${i} padding padding padding padding`,
      ).join("\n");
      const cause = "npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device";
      _setExecRunnerForTests(async (cmd: string) => {
        if (cmd.includes("npm ci")) {
          throw Object.assign(new Error("Command failed"), { stderr: `${warnings}\n${cause}` });
        }
        return { stdout: "", stderr: "" };
      });

      await runUpdate();

      const msg = steps()[STEP.DEPS]?.message ?? "";
      expect(msg).toContain("ENOSPC");
      expect(msg).toContain("no space left on device");
    });

    it("still reports a plain command failure without calling it a timeout", async () => {
      stubExec({ failOn: "npm run build" });

      await runUpdate();

      const msg = steps()[STEP.BUILD]?.message ?? "";
      expect(msg).toContain("TypeScript build failed");
      expect(msg).toContain("stub stderr");
      expect(msg).not.toContain("timed out");
    });
  });

  it("fails the pull step when the release train has no tags", async () => {
    settingRows.set("update.train", "release");
    stubExec({ stdout: { "git tag --list": "\n" } });

    await runUpdate();

    expect(getUpdateStatus().state).toBe("failed");
    expect(steps()[STEP.PULL]?.status).toBe("failed");
    expect(steps()[STEP.PULL]?.message).toContain("No release tags");
  });
});
