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

// The audit trail. Recorded rather than swallowed so the tests can assert that
// an update leaves Events behind — the 2026-09-09 gap.
const logEvent = vi.fn(async () => {});
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent }));

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
  _setRunningCommitForTests,
  checkForUpdates,
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

/**
 * A recording exec stub. `failOn` matches a substring of the command and fails
 * every time; `failOnce` fails only the first matching call (a transient
 * blip); `errorProps` is merged into the thrown error (e.g. `{ killed: true }`
 * to look like exec's SIGTERM on timeout, or a `stderr` carrying E404).
 */
function stubExec(
  opts: { failOn?: string; failOnce?: string; stdout?: Record<string, string>; errorProps?: Record<string, unknown> } = {},
) {
  const calls: string[] = [];
  let onceFired = false;
  _setExecRunnerForTests(async (cmd: string) => {
    calls.push(cmd);
    const failNow =
      (opts.failOn && cmd.includes(opts.failOn)) ||
      (opts.failOnce && !onceFired && cmd.includes(opts.failOnce) && (onceFired = true));
    if (failNow) {
      throw Object.assign(new Error(`stub failure: ${cmd}`), { stderr: `stub stderr for ${cmd}` }, opts.errorProps ?? {});
    }
    for (const [needle, out] of Object.entries(opts.stdout ?? {})) {
      if (cmd.includes(needle)) return { stdout: out, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return calls;
}

/** applyUpdate is fire-and-forget internally; await it then flush microtasks. */
async function runUpdate(password?: string | null, allowWithoutBackup?: boolean, actor?: string) {
  await applyUpdate(password ?? null, allowWithoutBackup ?? false, actor);
  await Promise.resolve();
}

/** Actions of every Event the run wrote, in order. */
function eventActions(): string[] {
  return logEvent.mock.calls.map((c: any[]) => c[0]?.action);
}
function eventNamed(action: string): any {
  return logEvent.mock.calls.map((c: any[]) => c[0]).find((e: any) => e?.action === action);
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
  _setRunningCommitForTests(undefined);
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
    const generate = calls.findIndex((c) => c.includes("index.js generate"));
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

// Until 2026-09-09 the updater wrote no Event rows at all; its only durable
// record was .update-status.json, which Dismiss deletes. These pin the trail
// and the per-step clock that the timeout message now quotes.
d("applyUpdate — audit trail and per-step timing", () => {
  it("a clean run writes started then applied, naming the actor and the train", async () => {
    settingRows.set("update.train", "nightly");
    stubExec();

    await runUpdate(null, false, "dmoore");

    expect(eventActions()).toEqual(["server.update.started", "server.update.applied"]);
    const started = eventNamed("server.update.started");
    expect(started.actor).toBe("dmoore");
    expect(started.details.train).toBe("nightly");
    const applied = eventNamed("server.update.applied");
    expect(applied.actor).toBe("dmoore");
    expect(typeof applied.details.pipelineDurationMs).toBe("number");
    // Every finished step reports how long it took.
    expect(applied.details.steps.slice(0, 6).every((s: any) => typeof s.durationMs === "number")).toBe(true);
  });

  it("a failure writes started then failed, naming the step and its measured duration", async () => {
    stubExec({ failOn: "npm ci" });

    await runUpdate();

    expect(eventActions()).toEqual(["server.update.started", "server.update.failed"]);
    const failed = eventNamed("server.update.failed");
    expect(failed.level).toBe("error");
    expect(failed.details.step).toBe("Install dependencies");
    expect(failed.details.stepIndex).toBe(STEP.DEPS);
    expect(typeof failed.details.stepDurationMs).toBe("number");
    expect(failed.message).toContain('failed at "Install dependencies"');
    // Nothing claimed the update was applied.
    expect(eventNamed("server.update.applied")).toBeUndefined();
  });

  it("the actor defaults to system:update when the caller has none", async () => {
    stubExec();
    await runUpdate();
    expect(eventNamed("server.update.started").actor).toBe("system:update");
  });

  it("every step that ran carries startedAt and durationMs; pending ones carry neither", async () => {
    stubExec({ failOn: "npm run build" });

    await runUpdate();

    const s = steps();
    for (let i = 0; i <= STEP.BUILD; i++) {
      expect(s[i].startedAt, `step ${i} startedAt`).toBeTruthy();
      expect(typeof s[i].durationMs, `step ${i} durationMs`).toBe("number");
    }
    expect(s[STEP.MIGRATE].startedAt).toBeUndefined();
    expect(s[STEP.MIGRATE].durationMs).toBeUndefined();
  });
});

// The registry preflight. It shipped on 2026-09-09 and failed a prod update the
// same day on a host whose registry was fine: one connection stalled, npm's
// default 5-minute fetch-timeout meant it could not emit its own error inside
// the 45 s ceiling, and the message then gave `npm ci`'s warm-cache advice and
// blamed TLS for what was a hang. Every run here fails at the build step so the
// restart timer is never scheduled while fake timers are being advanced.
d("applyUpdate — registry preflight", () => {
  const RETRY_MS = 3_000;

  it("tells npm to fail fast so its own error fits inside the ceiling", async () => {
    const calls = stubExec({ failOn: "npm run build" });
    await runUpdate();
    const ping = calls.find((c) => c.startsWith("npm ping"));
    expect(ping).toContain("--fetch-retries=0");
    expect(ping).toMatch(/--fetch-timeout=\d+/);
  });

  it("retries once after a transient failure and proceeds to the install", async () => {
    const calls = stubExec({ failOnce: "npm ping", failOn: "npm run build", errorProps: { killed: true } });

    const run = runUpdate();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await run;

    expect(calls.filter((c) => c.startsWith("npm ping")).length).toBe(2);
    expect(calls.some((c) => c.includes("npm ci"))).toBe(true);
    expect(steps()[STEP.DEPS]?.status).toBe("done");
  });

  it("a hang (two timeouts) fails the step with hang advice, not TLS advice or warm-cache advice", async () => {
    const calls = stubExec({ failOn: "npm ping", errorProps: { killed: true } });

    const run = runUpdate();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await run;

    expect(calls.filter((c) => c.startsWith("npm ping")).length).toBe(2);
    expect(calls.some((c) => c.includes("npm ci"))).toBe(false);
    const msg = steps()[STEP.DEPS]?.message ?? "";
    expect(getUpdateStatus().state).toBe("failed");
    expect(msg).toContain("a hang, not a refusal");
    expect(msg).toContain("dependencies are untouched");
    expect(msg).not.toContain("warm npm cache");
    // The cause list for a hang must not lead with the certificate story.
    expect(msg.indexOf("DROPPING")).toBeGreaterThan(-1);
  });

  it("a refusal (fast error) fails the step with the TLS/firewall cause list", async () => {
    stubExec({ failOn: "npm ping", errorProps: { stderr: "npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } });

    const run = runUpdate();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await run;

    const msg = steps()[STEP.DEPS]?.message ?? "";
    expect(msg).toContain("NODE_EXTRA_CA_CERTS");
    expect(msg).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(msg).not.toContain("a hang, not a refusal");
  });

  /**
   * Prod, 2026-09-10: .env carried NODE_EXTRA_CA_CERTS and the preflight still
   * failed UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Whether the variable reached
   * THIS process (systemd reads .env only at unit start; the npm child
   * inherits this process's environment) is the one fact that separates "restart
   * the service" from "the bundle lacks the CA", so the refusal message states
   * it rather than leaving the operator to guess.
   */
  describe("the refusal message says what this process knows about NODE_EXTRA_CA_CERTS", () => {
    const saved = process.env.NODE_EXTRA_CA_CERTS;
    afterEach(() => {
      if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = saved;
    });

    async function refusal(): Promise<string> {
      stubExec({ failOn: "npm ping", errorProps: { stderr: "npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } });
      const run = runUpdate();
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await run;
      return steps()[STEP.DEPS]?.message ?? "";
    }

    it("unset: names the restart, because a line in .env is invisible until the unit restarts", async () => {
      delete process.env.NODE_EXTRA_CA_CERTS;
      const msg = await refusal();
      expect(msg).toContain("NODE_EXTRA_CA_CERTS is NOT set in this process's environment");
      expect(msg).toContain("systemctl restart polaris.target");
    });

    it("set to a missing file: says the file does not exist", async () => {
      process.env.NODE_EXTRA_CA_CERTS = "/nonexistent/polaris-test-bundle.pem";
      const msg = await refusal();
      expect(msg).toContain("NODE_EXTRA_CA_CERTS=/nonexistent/polaris-test-bundle.pem is set but that file does not exist");
    });

    it("set to a real file: rules the variable out and points at the bundle's contents", async () => {
      process.env.NODE_EXTRA_CA_CERTS = fileURLToPath(import.meta.url);
      const msg = await refusal();
      expect(msg).toContain("is set and the file exists, so the variable is not the problem");
      expect(msg).toContain("update-ca-trust");
    });
  });

  it("a 404 from a private mirror counts as reachable and does not block the install", async () => {
    // The ping fails with a 404 (failOnce, so the stub's errorProps describe
    // THAT failure); the build failure keeps the restart timer unscheduled.
    const calls = stubExec({
      failOnce: "npm ping",
      failOn: "npm run build",
      errorProps: { stderr: "npm error code E404\nnpm error 404 Not Found - GET https://nexus.example/repository/npm/-/ping" },
    });

    await runUpdate();

    expect(calls.filter((c) => c.startsWith("npm ping")).length).toBe(1);
    expect(calls.some((c) => c.includes("npm ci"))).toBe(true);
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

  /**
   * Prod, 2026-09-10: a failed run of deploy/update-linux.sh rolled back with
   * `git checkout <old> -- .`, which leaves HEAD at the new commit and the
   * tree at the old content — 77 "locally modified" files — and the in-app
   * pull refused with "Your local changes to the following files would be
   * overwritten by merge". The checkout is an installation, not an editing
   * surface: tracked-file changes are discarded before the pull, named on the
   * step, and carried into the Event trail.
   */
  it("discards local changes to tracked files before pulling, and says so on the step and in the Event", async () => {
    settingRows.set("update.train", "nightly");
    const calls = stubExec({
      stdout: { "git status --porcelain --untracked-files=no": "M  CLAUDE.md\nM  deploy/update-linux.sh\n" },
    });

    await runUpdate();

    const status = calls.findIndex((c) => c.includes("git status --porcelain --untracked-files=no"));
    const reset = calls.findIndex((c) => c.includes("git reset --hard HEAD"));
    const pull = calls.findIndex((c) => c.includes("git pull --ff-only"));
    expect(status).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(status);
    expect(pull).toBeGreaterThan(reset);
    expect(steps()[STEP.PULL]?.message ?? "").toContain("discarded local changes to 2 tracked files");
    expect(eventNamed("server.update.applied")?.details?.discardedLocalChanges).toEqual([
      "CLAUDE.md",
      "deploy/update-linux.sh",
    ]);
  });

  it("leaves a clean checkout alone — no reset when nothing is dirty", async () => {
    settingRows.set("update.train", "nightly");
    const calls = stubExec();

    await runUpdate();

    expect(calls.some((c) => c.includes("git reset --hard"))).toBe(false);
    expect(steps()[STEP.PULL]?.message ?? "").not.toContain("discarded");
    expect(eventNamed("server.update.applied")?.details?.discardedLocalChanges).toEqual([]);
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

      // The preflight retries once, 3 s apart, before giving up — advance the
      // fake clock through that sleep or the run never resolves.
      const run = runUpdate();
      await vi.advanceTimersByTimeAsync(3_000);
      await run;

      expect(calls.some((c) => c.includes("npm ci"))).toBe(false);
      const msg = steps()[STEP.DEPS]?.message ?? "";
      expect(msg).toContain("Cannot reach the npm registry");
      expect(msg).toContain("safe to restart");
      // A fast error (no timeout kill) keeps the TLS cause list.
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

// ── checkForUpdates: the running commit, not the checkout ────────────────────
//
// The pipeline pulls BEFORE it installs, builds and restarts. An update that
// fails after the pull (prod, 2026-09-10: TLS inspection at Install
// dependencies) leaves the checkout's HEAD ahead of the process serving
// requests. Measured against HEAD that host read "up to date" with no Apply
// button — the old build kept running and nothing could finish the update
// from the UI. The check measures against the boot commit instead.
d("checkForUpdates — measures against the RUNNING commit, not the checkout's HEAD", () => {
  const RUNNING = "a".repeat(40);
  const PULLED = "b".repeat(40);
  const REMOTE_NEWER = "c".repeat(40);

  /** git as seen by checkForUpdates on the nightly train (origin/HEAD resolves). */
  function stubGit(opts: { head: string; remote: string; running: string | null | undefined }) {
    _setRunningCommitForTests(opts.running);
    return stubExec({
      stdout: {
        "git rev-list -n 1 HEAD": opts.head + "\n",
        "git rev-list -n 1 origin/HEAD": opts.remote + "\n",
        "git rev-list --count origin/HEAD": "2792\n",
        "git rev-list --count ": "5\n",
        "git log --oneline ": "cccccc1 fix: one\ncccccc2 fix: two\n",
        "git show origin/HEAD:package.json": JSON.stringify({ version: "0.9.0" }),
      },
    });
  }

  it("reports up to date when the running build, the checkout and the remote agree", async () => {
    stubGit({ head: RUNNING, remote: RUNNING, running: RUNNING });
    const s = await checkForUpdates();
    expect(s.state).toBe("up-to-date");
    expect(s.note).toBeUndefined();
  });

  it("offers the update when the checkout was pulled but never installed, and says so", async () => {
    const calls = stubGit({ head: PULLED, remote: PULLED, running: RUNNING });
    const s = await checkForUpdates();
    expect(s.state).toBe("available");
    expect(s.currentCommit).toBe("aaaaaaa");
    expect(s.checkoutCommit).toBe("bbbbbbb");
    expect(s.latestCommit).toBe("bbbbbbb");
    expect(s.latestVersion).toBe("0.9.2792");
    expect(s.commitsBehind).toBe(5);
    expect(s.changes).toHaveLength(2);
    expect(s.note).toMatch(/already at bbbbbbb/);
    expect(s.note).toMatch(/Apply Update finishes/);
    // The changelog is measured from what is RUNNING, not from HEAD — or it
    // would be empty for exactly the case this exists for.
    expect(calls).toContain(`git rev-list --count ${RUNNING}..origin/HEAD`);
    expect(calls).toContain(`git log --oneline ${RUNNING}..origin/HEAD`);
  });

  it("a plain new release (checkout still at the running commit) carries no note", async () => {
    const calls = stubGit({ head: RUNNING, remote: REMOTE_NEWER, running: RUNNING });
    const s = await checkForUpdates();
    expect(s.state).toBe("available");
    expect(s.note).toBeUndefined();
    expect(s.currentCommit).toBe("aaaaaaa");
    expect(s.checkoutCommit).toBe("aaaaaaa");
    expect(calls).toContain(`git rev-list --count ${RUNNING}..origin/HEAD`);
  });

  it("falls back to HEAD when the running commit is unknown", async () => {
    const calls = stubGit({ head: PULLED, remote: REMOTE_NEWER, running: null });
    const s = await checkForUpdates();
    expect(s.state).toBe("available");
    expect(s.currentCommit).toBe("bbbbbbb");
    expect(s.note).toBeUndefined();
    expect(calls).toContain("git rev-list --count HEAD..origin/HEAD");
  });

  it("never interpolates a running commit that is not a plain SHA", async () => {
    const calls = stubGit({ head: PULLED, remote: REMOTE_NEWER, running: "aaaaaaa; rm -rf /" });
    await checkForUpdates();
    expect(calls.some((c) => c.includes("rm -rf"))).toBe(false);
    expect(calls).toContain("git rev-list --count HEAD..origin/HEAD");
  });
});
