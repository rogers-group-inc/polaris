/**
 * tests/unit/assetSourcePriorityService.test.ts
 *
 * The operator's order for which discovery source's "where was this learned?"
 * wins (Asset.learnedLocation). The write path is STRICT — a typo, a duplicate
 * or a non-string is a 400, never silently dropped — while kinds the client
 * omits are appended in default order. A save primes this process's
 * projection at once; refreshProjectionPriority (boot + every discovery run)
 * never throws and falls back to the default order.
 *
 * The catalogue and normalizer (utils/assetSourceLocation) run for real; the
 * Setting store and the projection hook are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  stored: null as unknown,
  getFails: false,
  save: vi.fn(),
  setPriority: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("../../src/services/settingsStore.js", () => ({
  createSettingStore: (opts: { parse: (raw: unknown) => unknown }) => ({
    get: async () => {
      if (m.getFails) throw new Error("db down");
      return opts.parse(m.stored);
    },
    save: m.save,
  }),
}));
vi.mock("../../src/utils/assetProjection.js", () => ({ setLearnedLocationPriority: m.setPriority }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));

const svc = await import("../../src/services/assetSourcePriorityService.js");
const { defaultSourceLocationPriority, LOCATION_CONTRIBUTORS } = await import("../../src/utils/assetSourceLocation.js");

const DEFAULT = defaultSourceLocationPriority();

beforeEach(() => {
  m.stored = null;
  m.getFails = false;
  m.save.mockReset().mockImplementation(async (v: unknown) => v);
  m.setPriority.mockReset();
  m.logEvent.mockReset();
});

describe("getSourcePrioritySettings", () => {
  it("returns the default order and one catalogue entry per kind when nothing is stored", async () => {
    const s = await svc.getSourcePrioritySettings();
    expect(s.order).toEqual(DEFAULT.order);
    expect(s.integrationPrefix).toBe(false);
    expect(s.contributors.map((c) => c.kind)).toEqual(DEFAULT.order);
    expect(s.contributors.length).toBe(LOCATION_CONTRIBUTORS.length);
  });

  it("emits contributors in the operator's order, with a stored stale kind self-healed away", async () => {
    const [a, b] = DEFAULT.order;
    m.stored = { order: [b, "retired-source", a], integrationPrefix: true };
    const s = await svc.getSourcePrioritySettings();
    expect(s.order.slice(0, 2)).toEqual([b, a]);
    expect(s.order).not.toContain("retired-source");
    expect(s.contributors[0].kind).toBe(b);
    expect(s.integrationPrefix).toBe(true);
  });
});

describe("saveSourceLocationPriority — strict on write", () => {
  it.each([
    ["a non-array order", { order: "fortiswitch" }, "must be an array"],
    ["an empty entry", { order: ["  "] }, "non-empty"],
    ["a non-string entry", { order: [7] }, "non-empty"],
    ["an unknown kind", { order: ["fortiswich"] }, "Unknown asset source kind"],
  ])("400s %s and saves nothing", async (_label, body, msg) => {
    await expect(svc.saveSourceLocationPriority(body)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining(msg) });
    expect(m.save).not.toHaveBeenCalled();
    expect(m.setPriority).not.toHaveBeenCalled();
  });

  it("400s a duplicate kind", async () => {
    const k = DEFAULT.order[0];
    await expect(svc.saveSourceLocationPriority({ order: [k, ` ${k} `] })).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("Duplicate") });
  });

  it("appends the kinds the client omitted, in default order", async () => {
    const last = DEFAULT.order[DEFAULT.order.length - 1];
    const saved = await svc.saveSourceLocationPriority({ order: [last] });
    expect(saved.order[0]).toBe(last);
    expect(saved.order.slice(1)).toEqual(DEFAULT.order.filter((k) => k !== last));
  });

  it("keeps the stored order and prefix when the field is absent; prefix is true only for a literal true", async () => {
    const [a, b] = DEFAULT.order;
    m.stored = { order: [b, a], integrationPrefix: true };
    const kept = await svc.saveSourceLocationPriority({});
    expect(kept.order.slice(0, 2)).toEqual([b, a]);
    expect(kept.integrationPrefix).toBe(true);
    const truthy = await svc.saveSourceLocationPriority({ integrationPrefix: "yes" });
    expect(truthy.integrationPrefix).toBe(false);
  });

  it("primes this process's projection with what was saved and audits old vs new", async () => {
    const [a, b] = DEFAULT.order;
    const saved = await svc.saveSourceLocationPriority({ order: [b, a], integrationPrefix: true }, "alice");
    expect(m.setPriority).toHaveBeenCalledWith(saved);
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "asset.source_priority.updated",
      actor: "alice",
      details: expect.objectContaining({
        order: saved.order, integrationPrefix: true, previousOrder: DEFAULT.order, previousIntegrationPrefix: false,
      }),
    }));
  });

  it("audits a system caller as 'system'", async () => {
    await svc.saveSourceLocationPriority({});
    expect(m.logEvent.mock.calls[0][0].actor).toBe("system");
  });
});

describe("refreshProjectionPriority", () => {
  it("installs the stored order", async () => {
    const [a, b] = DEFAULT.order;
    m.stored = { order: [b, a] };
    await svc.refreshProjectionPriority();
    expect(m.setPriority.mock.calls[0][0].order.slice(0, 2)).toEqual([b, a]);
  });

  it("never throws: a read failure installs the default order (pre-feature behaviour)", async () => {
    m.getFails = true;
    await expect(svc.refreshProjectionPriority()).resolves.toBeUndefined();
    expect(m.setPriority).toHaveBeenCalledWith(DEFAULT);
  });
});
