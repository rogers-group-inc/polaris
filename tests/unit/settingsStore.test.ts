/**
 * tests/unit/settingsStore.test.ts — the generic TTL-cached Setting accessor.
 *
 * Contract (polaris-change-impact → settings-platform.md): get() caches for
 * ttlMs and re-parses on every miss (a missing row parses `undefined`); save()
 * upserts and PRIMES the cache with the written value; invalidate() drops it;
 * peek() is the live value or null once expired. The cache is per store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { createSettingStore } from "../../src/services/settingsStore.js";

const T0 = new Date("2026-11-16T12:00:00Z").getTime();

beforeEach(() => {
  resetDbStub();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

function makeStore(ttlMs = 1000) {
  const parse = vi.fn((raw: unknown) => ({ n: typeof (raw as { n?: unknown })?.n === "number" ? (raw as { n: number }).n : 0 }));
  const store = createSettingStore<{ n: number }>({ key: "k1", ttlMs, parse });
  return { store, parse };
}

describe("createSettingStore.get", () => {
  it("parses undefined for a missing row (defaults)", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue(null);
    const { store, parse } = makeStore();
    expect(await store.get()).toEqual({ n: 0 });
    expect(parse).toHaveBeenCalledWith(undefined);
    expect(prisma.setting.findUnique).toHaveBeenCalledWith({ where: { key: "k1" } });
  });

  it("parses the stored value", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ key: "k1", value: { n: 5 } });
    const { store } = makeStore();
    expect(await store.get()).toEqual({ n: 5 });
  });

  it("serves from cache within the TTL and re-reads after it", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValueOnce({ value: { n: 1 } }).mockResolvedValueOnce({ value: { n: 2 } });
    const { store, parse } = makeStore(1000);
    expect((await store.get()).n).toBe(1);
    vi.setSystemTime(T0 + 999);
    expect((await store.get()).n).toBe(1);
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 1000);
    expect((await store.get()).n).toBe(2);
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(2);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("propagates a DB error and caches nothing", async () => {
    stubbed(prisma.setting.findUnique).mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ value: { n: 3 } });
    const { store } = makeStore();
    await expect(store.get()).rejects.toThrow("db down");
    expect(store.peek()).toBeNull();
    expect((await store.get()).n).toBe(3);
  });

  it("keeps two stores' caches apart", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValueOnce({ value: { n: 1 } }).mockResolvedValueOnce({ value: { n: 2 } });
    const a = makeStore().store;
    const b = makeStore().store;
    expect((await a.get()).n).toBe(1);
    expect((await b.get()).n).toBe(2);
  });
});

describe("createSettingStore.peek", () => {
  it("is null before any read", () => {
    expect(makeStore().store.peek()).toBeNull();
  });

  it("returns the live value and null once expired", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ value: { n: 7 } });
    const { store } = makeStore(500);
    await store.get();
    expect(store.peek()).toEqual({ n: 7 });
    vi.setSystemTime(T0 + 500);
    expect(store.peek()).toBeNull();
    // peek never touches the DB.
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("createSettingStore.save", () => {
  it("upserts the value under its key and primes the cache (no re-read)", async () => {
    const { store, parse } = makeStore();
    const out = await store.save({ n: 9 });
    expect(out).toEqual({ n: 9 });
    expect(prisma.setting.upsert).toHaveBeenCalledWith({
      where: { key: "k1" },
      update: { value: { n: 9 } },
      create: { key: "k1", value: { n: 9 } },
    });
    expect(store.peek()).toEqual({ n: 9 });
    expect(await store.get()).toEqual({ n: 9 });
    expect(prisma.setting.findUnique).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it("leaves the cache untouched when the upsert fails", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValue({ value: { n: 1 } });
    const { store } = makeStore();
    await store.get();
    stubbed(prisma.setting.upsert).mockRejectedValueOnce(new Error("write failed"));
    await expect(store.save({ n: 2 })).rejects.toThrow("write failed");
    expect(store.peek()).toEqual({ n: 1 });
  });
});

describe("createSettingStore.invalidate", () => {
  it("forces the next get to hit the DB", async () => {
    stubbed(prisma.setting.findUnique).mockResolvedValueOnce({ value: { n: 1 } }).mockResolvedValueOnce({ value: { n: 2 } });
    const { store } = makeStore(60_000);
    await store.get();
    store.invalidate();
    expect(store.peek()).toBeNull();
    expect((await store.get()).n).toBe(2);
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(2);
  });
});
