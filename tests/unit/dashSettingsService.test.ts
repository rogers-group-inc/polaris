/**
 * tests/unit/dashSettingsService.test.ts
 *
 * dashConfig Setting-row persistence: safe-off defaults, tolerant parsing of
 * garbage rows, legacy rfc1918Only → ipScope migration, custom-CIDR
 * normalization + validation, the empty-custom-list guard, partial-merge save
 * semantics, and the TTL cache (+ explicit invalidate). Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  getDashSettings,
  saveDashSettings,
  invalidateDashSettingsCache,
  defaultDashSettings,
  DASH_SETTING_KEY,
} from "../../src/services/dashSettingsService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  invalidateDashSettingsCache();
});

describe("defaults + parsing", () => {
  it("defaults to disabled + rfc1918 scope + empty list", () => {
    expect(defaultDashSettings()).toEqual({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  });

  it("returns defaults when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getDashSettings()).toEqual({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  });

  it("tolerates a garbage row", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: "oops" });
    expect(await getDashSettings()).toEqual({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  });

  it("migrates a legacy rfc1918Only boolean to ipScope", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: false } });
    expect(await getDashSettings()).toEqual({ enabled: true, ipScope: "all", allowedCidrs: [] });

    invalidateDashSettingsCache();
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, rfc1918Only: true } });
    expect((await getDashSettings()).ipScope).toBe("rfc1918");
  });

  it("reads a custom-scope row and drops invalid CIDRs on parse", async () => {
    findUnique.mockResolvedValue({
      key: DASH_SETTING_KEY,
      value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8", "garbage", "2001:db8::/32", "192.168.1.5"] },
    });
    expect(await getDashSettings()).toEqual({
      enabled: true,
      ipScope: "custom",
      allowedCidrs: ["10.0.0.0/8", "192.168.1.5/32"],
    });
  });
});

describe("TTL cache", () => {
  it("serves from cache within the TTL and refetches after invalidate", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, ipScope: "all" } });
    await getDashSettings();
    await getDashSettings();
    expect(findUnique).toHaveBeenCalledTimes(1);
    invalidateDashSettingsCache();
    await getDashSettings();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("saveDashSettings", () => {
  it("merges a partial input over current and normalizes custom CIDRs", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: false, ipScope: "rfc1918", allowedCidrs: [] } });
    upsert.mockResolvedValue({});
    const saved = await saveDashSettings({ enabled: true, ipScope: "custom", allowedCidrs: ["192.168.10.50/24", "203.0.113.5"] });
    expect(saved).toEqual({ enabled: true, ipScope: "custom", allowedCidrs: ["192.168.10.0/24", "203.0.113.5/32"] });
    expect(upsert).toHaveBeenCalled();
  });

  it("throws 400 on an invalid custom CIDR", async () => {
    findUnique.mockResolvedValue(null);
    await expect(saveDashSettings({ enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8", "nope"] }))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("rejects an enabled custom scope with an empty list", async () => {
    findUnique.mockResolvedValue(null);
    await expect(saveDashSettings({ enabled: true, ipScope: "custom", allowedCidrs: [] }))
      .rejects.toBeInstanceOf(AppError);
  });

  it("allows a disabled custom scope with an empty list", async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    const saved = await saveDashSettings({ enabled: false, ipScope: "custom", allowedCidrs: [] });
    expect(saved).toEqual({ enabled: false, ipScope: "custom", allowedCidrs: [] });
  });

  it("keeps existing allowedCidrs when input omits them", async () => {
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8"] } });
    upsert.mockResolvedValue({});
    const saved = await saveDashSettings({ enabled: false });
    expect(saved.allowedCidrs).toEqual(["10.0.0.0/8"]);
  });

  it("invalidates the cache so the next read sees the new value", async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    await getDashSettings();
    await saveDashSettings({ enabled: true, ipScope: "all" });
    findUnique.mockResolvedValue({ key: DASH_SETTING_KEY, value: { enabled: true, ipScope: "all" } });
    expect((await getDashSettings()).enabled).toBe(true);
  });
});
