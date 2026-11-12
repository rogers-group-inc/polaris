/**
 * tests/unit/loginAccessService.test.ts
 *
 * loginAccessConfig Setting-row persistence + the gate decision. The
 * load-bearing cases are the lockout ones: disabled must admit everyone,
 * an enabled custom scope with no networks must be REFUSED at save, and a
 * settings read that throws must fail OPEN — a DB blip turning into "nobody
 * can log in locally" is the exact failure this feature exists to prevent.
 * Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  getLoginAccessSettings,
  saveLoginAccessSettings,
  invalidateLoginAccessCache,
  defaultLoginAccessSettings,
  loginSourceAllowed,
  isLoginSourceAllowed,
  LOGIN_ACCESS_SETTING_KEY,
} from "../../src/services/loginAccessService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  invalidateLoginAccessCache();
});

describe("defaults + parsing", () => {
  it("defaults to NO restriction — an upgrade must not start refusing logins", () => {
    expect(defaultLoginAccessSettings()).toEqual({
      enabled: false,
      ipScope: "rfc1918",
      allowedCidrs: [],
    });
  });

  it("a missing row parses to the defaults", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getLoginAccessSettings()).toEqual(defaultLoginAccessSettings());
    expect(findUnique).toHaveBeenCalledWith({ where: { key: LOGIN_ACCESS_SETTING_KEY } });
  });

  it("tolerates a garbage row instead of throwing on every request", async () => {
    findUnique.mockResolvedValue({ value: "not an object" });
    expect(await getLoginAccessSettings()).toEqual(defaultLoginAccessSettings());
  });

  it("drops unparseable CIDRs from a stored row rather than failing the read", async () => {
    findUnique.mockResolvedValue({
      value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8", "nonsense", 42] },
    });
    expect((await getLoginAccessSettings()).allowedCidrs).toEqual(["10.0.0.0/8"]);
  });

  it("falls back to the default scope when the stored one is unknown", async () => {
    findUnique.mockResolvedValue({ value: { enabled: true, ipScope: "everyone" } });
    expect((await getLoginAccessSettings()).ipScope).toBe("rfc1918");
  });
});

describe("loginSourceAllowed", () => {
  it("admits every source while disabled, whatever the scope says", () => {
    const s = { enabled: false, ipScope: "custom" as const, allowedCidrs: ["10.0.0.0/8"] };
    expect(loginSourceAllowed("8.8.8.8", s)).toBe(true);
    expect(loginSourceAllowed("", s)).toBe(true);
  });

  it("applies the scope once enabled", () => {
    const s = { enabled: true, ipScope: "rfc1918" as const, allowedCidrs: [] };
    expect(loginSourceAllowed("10.1.1.1", s)).toBe(true);
    expect(loginSourceAllowed("8.8.8.8", s)).toBe(false);
  });
});

describe("isLoginSourceAllowed — fail-open", () => {
  it("admits the request when the settings read throws", async () => {
    findUnique.mockRejectedValue(new Error("db is down"));
    await expect(isLoginSourceAllowed("8.8.8.8")).resolves.toBe(true);
  });

  it("enforces normally when the read succeeds", async () => {
    findUnique.mockResolvedValue({ value: { enabled: true, ipScope: "rfc1918", allowedCidrs: [] } });
    await expect(isLoginSourceAllowed("8.8.8.8")).resolves.toBe(false);
    await expect(isLoginSourceAllowed("192.168.4.4")).resolves.toBe(true);
  });
});

describe("saveLoginAccessSettings", () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(null);
    upsert.mockImplementation(async ({ create }: any) => create);
  });

  it("normalizes and de-duplicates the allow-list", async () => {
    const saved = await saveLoginAccessSettings({
      enabled: true,
      ipScope: "custom",
      allowedCidrs: ["10.0.0.5/8", "10.0.0.9/8", " 192.168.1.7 "],
    });
    expect(saved.allowedCidrs).toEqual(["10.0.0.0/8", "192.168.1.7/32"]);
  });

  it("rejects an unparseable network with a usable message", async () => {
    await expect(
      saveLoginAccessSettings({ enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/33"] }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses an enabled custom scope with no networks — that blocks login everywhere", async () => {
    await expect(
      saveLoginAccessSettings({ enabled: true, ipScope: "custom", allowedCidrs: [] }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("allows an empty custom list while disabled (mid-edit state)", async () => {
    const saved = await saveLoginAccessSettings({ enabled: false, ipScope: "custom", allowedCidrs: [] });
    expect(saved).toEqual({ enabled: false, ipScope: "custom", allowedCidrs: [] });
  });

  it("merges partially — an omitted field keeps its stored value", async () => {
    findUnique.mockResolvedValue({
      value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8"] },
    });
    const saved = await saveLoginAccessSettings({ enabled: false });
    expect(saved).toEqual({ enabled: false, ipScope: "custom", allowedCidrs: ["10.0.0.0/8"] });
  });

  it("primes the cache so the next read doesn't hit the DB", async () => {
    await saveLoginAccessSettings({ enabled: true, ipScope: "rfc1918" });
    findUnique.mockClear();
    expect(await getLoginAccessSettings()).toEqual({
      enabled: true,
      ipScope: "rfc1918",
      allowedCidrs: [],
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
