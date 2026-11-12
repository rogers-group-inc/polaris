/**
 * tests/unit/logger.test.ts
 *
 * The logger is pure configuration (a pino instance), so only that wiring is
 * testable without a transport harness: LOG_LEVEL sets the level (default
 * "info") and production skips the pino-pretty transport. pino itself is
 * replaced by a spy so no transport worker thread is started.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pinoMock = vi.hoisted(() => vi.fn((opts: unknown) => ({ __opts: opts })));
vi.mock("pino", () => ({ default: pinoMock }));

const saved = { LOG_LEVEL: process.env.LOG_LEVEL, NODE_ENV: process.env.NODE_ENV };

async function load(env: { LOG_LEVEL?: string; NODE_ENV?: string }) {
  if (env.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = env.LOG_LEVEL;
  if (env.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env.NODE_ENV;
  vi.resetModules();
  const mod = await import("../../src/utils/logger.js");
  return mod.logger as unknown as { __opts: { level: string; transport?: { target: string } } };
}

beforeEach(() => pinoMock.mockClear());
afterEach(() => {
  if (saved.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved.LOG_LEVEL;
  if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
});

describe("logger", () => {
  it("defaults to level info", async () => {
    const l = await load({ NODE_ENV: "production" });
    expect(l.__opts.level).toBe("info");
  });

  it("honours LOG_LEVEL", async () => {
    const l = await load({ LOG_LEVEL: "debug", NODE_ENV: "production" });
    expect(l.__opts.level).toBe("debug");
  });

  it("uses no transport in production", async () => {
    const l = await load({ NODE_ENV: "production" });
    expect(l.__opts.transport).toBeUndefined();
  });

  it("pretty-prints outside production", async () => {
    const l = await load({ NODE_ENV: "development" });
    expect(l.__opts.transport).toEqual({ target: "pino-pretty" });
  });
});
