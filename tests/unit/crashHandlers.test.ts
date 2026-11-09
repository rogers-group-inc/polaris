/**
 * tests/unit/crashHandlers.test.ts
 *
 * The process-level last-resort handlers. What matters is not that they run some
 * code, but that they preserve three properties:
 *
 *   1. They EXIT. Continuing after an unhandled rejection means running with
 *      unknown invariants (a half-applied transaction, a monitor worker that
 *      lost its lease), which is worse than a supervised restart.
 *   2. They exit with a code distinct from the boot-time config guards' `1`, so
 *      exit-code history separates "misconfigured, never started" from "was
 *      running, then died".
 *   3. They make the crash legible: a structured fatal log naming the role, and
 *      a metric increment. Before they existed the only artifact was Node's raw
 *      stack trace on stderr, and Restart=on-failure brought the process back so
 *      a repeating crash was invisible outside journald.
 *
 * installCrashHandlers registers real process listeners, so the suite removes
 * them again via _resetForTests to avoid leaking across files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fatal = vi.fn();
vi.mock("../../src/utils/logger.js", () => ({
  logger: { fatal, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const recordProcessCrash = vi.fn();
vi.mock("../../src/metrics.js", () => ({ recordProcessCrash }));

const { installCrashHandlers, _resetForTests, CRASH_EXIT_CODE } = await import(
  "../../src/utils/crashHandlers.js"
);

const savedRole = process.env.POLARIS_ROLE;

/** Fire the registered handler for `event` and return process.exit's argument. */
function fireAndCaptureExit(event: "unhandledRejection" | "uncaughtException", payload: unknown): number | undefined {
  // One literal per call: process.listeners() has no overload taking the union.
  const listeners = (event === "unhandledRejection"
    ? process.listeners("unhandledRejection")
    : process.listeners("uncaughtException")) as Array<(arg: unknown) => void>;
  expect(listeners.length).toBeGreaterThan(0);
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    return undefined as never;
  }) as never);
  try {
    // The handler defers the exit by a tick so pino can flush.
    vi.useFakeTimers();
    listeners[listeners.length - 1]!(payload);
    vi.runAllTimers();
  } finally {
    vi.useRealTimers();
    exitSpy.mockRestore();
  }
  return exitCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  process.env.POLARIS_ROLE = "monitor";
});

afterEach(() => {
  _resetForTests();
  if (savedRole === undefined) delete process.env.POLARIS_ROLE;
  else process.env.POLARIS_ROLE = savedRole;
});

describe("installCrashHandlers", () => {
  it("registers a listener for both fatal event kinds", () => {
    expect(process.listenerCount("unhandledRejection")).toBe(0);
    expect(process.listenerCount("uncaughtException")).toBe(0);
    installCrashHandlers();
    expect(process.listenerCount("unhandledRejection")).toBe(1);
    expect(process.listenerCount("uncaughtException")).toBe(1);
  });

  it("is idempotent, so booting through index.ts twice cannot double-register", () => {
    installCrashHandlers();
    installCrashHandlers();
    installCrashHandlers();
    expect(process.listenerCount("unhandledRejection")).toBe(1);
    expect(process.listenerCount("uncaughtException")).toBe(1);
  });
});

describe("on an unhandled rejection", () => {
  it("logs fatal with the role and origin, counts it, and exits non-zero", () => {
    installCrashHandlers();
    const reason = new Error("boom");

    const code = fireAndCaptureExit("unhandledRejection", reason);

    expect(code).toBe(CRASH_EXIT_CODE);
    expect(code).not.toBe(1); // distinct from the boot-time config guards
    expect(recordProcessCrash).toHaveBeenCalledWith("monitor", "unhandled_rejection");
    expect(fatal).toHaveBeenCalledTimes(1);
    const [ctx, msg] = fatal.mock.calls[0]!;
    expect(ctx).toMatchObject({ err: reason, role: "monitor", kind: "unhandled_rejection" });
    expect(String(msg)).toContain("unhandled promise rejection");
  });

  it("labels the role 'all' when POLARIS_ROLE is unset (single-process install)", () => {
    delete process.env.POLARIS_ROLE;
    installCrashHandlers();
    fireAndCaptureExit("unhandledRejection", new Error("x"));
    expect(recordProcessCrash).toHaveBeenCalledWith("all", "unhandled_rejection");
  });
});

describe("on an uncaught exception", () => {
  it("uses its own kind label and still exits", () => {
    installCrashHandlers();
    const code = fireAndCaptureExit("uncaughtException", new Error("nope"));
    expect(code).toBe(CRASH_EXIT_CODE);
    expect(recordProcessCrash).toHaveBeenCalledWith("monitor", "uncaught_exception");
    expect(String(fatal.mock.calls[0]![1])).toContain("uncaught exception");
  });
});

describe("robustness", () => {
  it("still exits when the metrics call throws", () => {
    // A metrics failure must never mask the crash it is reporting.
    recordProcessCrash.mockImplementation(() => { throw new Error("registry gone"); });
    installCrashHandlers();
    const code = fireAndCaptureExit("unhandledRejection", new Error("boom"));
    expect(code).toBe(CRASH_EXIT_CODE);
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("falls back to console.error and still exits when the logger throws", () => {
    // Broken pino transport / EPIPE on stdout. The crash must never be silent.
    fatal.mockImplementation(() => { throw new Error("transport closed"); });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    installCrashHandlers();

    const code = fireAndCaptureExit("unhandledRejection", new Error("boom"));

    expect(code).toBe(CRASH_EXIT_CODE);
    expect(consoleErr).toHaveBeenCalled();
    expect(String(consoleErr.mock.calls[0]![0])).toContain("FATAL");
    consoleErr.mockRestore();
  });
});
