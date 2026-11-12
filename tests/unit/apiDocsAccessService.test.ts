/**
 * tests/unit/apiDocsAccessService.test.ts
 *
 * apiDocsConfig Setting-row persistence and the /api docs-page gate decision:
 * enabled-by-default rfc1918 posture, the RFC1918-only rule on custom entries
 * (rejected at save AND re-filtered on read), loopback-always-allowed,
 * off-means-off (disabled denies loopback too), the fail-CLOSED gate wrapper
 * (opposite of login-access, which fails open — this fronts an
 * unauthenticated disclosure surface), and the nginx allow-line derivation.
 * Prisma is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  getApiDocsSettings,
  saveApiDocsSettings,
  invalidateApiDocsSettingsCache,
  defaultApiDocsSettings,
  docsSourceAllowed,
  isApiDocsSourceAllowed,
  deriveApiDocsNginxAllow,
  API_DOCS_SETTING_KEY,
  type ApiDocsSettings,
} from "../../src/services/apiDocsAccessService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  invalidateApiDocsSettingsCache();
  // saveApiDocsSettings reads current settings first; default to "no row".
  findUnique.mockResolvedValue(null);
  upsert.mockImplementation(async (args: { create: { value: unknown } }) => args.create);
});

function settings(overrides: Partial<ApiDocsSettings> = {}): ApiDocsSettings {
  return { ...defaultApiDocsSettings(), ...overrides };
}

describe("defaults + parsing", () => {
  it("defaults to enabled + rfc1918 scope + empty list", () => {
    expect(defaultApiDocsSettings()).toEqual({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
  });

  it("returns defaults when no row exists or the row is garbage", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getApiDocsSettings()).toEqual(defaultApiDocsSettings());

    invalidateApiDocsSettingsCache();
    findUnique.mockResolvedValue({ key: API_DOCS_SETTING_KEY, value: "oops" });
    expect(await getApiDocsSettings()).toEqual(defaultApiDocsSettings());
  });

  it('refuses "all" from a hand-edited row — the docs scope has no such value', async () => {
    findUnique.mockResolvedValue({ key: API_DOCS_SETTING_KEY, value: { enabled: true, ipScope: "all" } });
    expect((await getApiDocsSettings()).ipScope).toBe("rfc1918");
  });

  it("re-filters a hand-edited PUBLIC CIDR out on read — save-time validation is not the only wall", async () => {
    findUnique.mockResolvedValue({
      key: API_DOCS_SETTING_KEY,
      value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.0.0.0/8", "8.8.8.0/24", "garbage"] },
    });
    expect((await getApiDocsSettings()).allowedCidrs).toEqual(["10.0.0.0/8"]);
  });
});

describe("saveApiDocsSettings", () => {
  it("normalizes, dedupes, and stores valid RFC1918 entries", async () => {
    const saved = await saveApiDocsSettings({
      ipScope: "custom",
      allowedCidrs: ["10.1.1.5/24", "10.1.1.0/24", "192.168.44.7"],
    });
    expect(saved.allowedCidrs).toEqual(["10.1.1.0/24", "192.168.44.7/32"]);
  });

  it("rejects an unparseable entry with a message naming it", async () => {
    await expect(saveApiDocsSettings({ allowedCidrs: ["not-a-cidr"] })).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringContaining('"not-a-cidr"'),
    });
  });

  it("rejects a non-RFC1918 entry with a message naming it — the requirement this service exists for", async () => {
    for (const pub of ["8.8.8.0/24", "203.0.113.5", "0.0.0.0/0", "172.32.0.0/24"]) {
      await expect(saveApiDocsSettings({ ipScope: "custom", allowedCidrs: [pub] })).rejects.toMatchObject({
        httpStatus: 400,
        message: expect.stringContaining(`"${pub}"`),
      });
    }
  });

  it("rejects a loopback entry (always allowed, never scope) via the RFC1918 rule", async () => {
    await expect(saveApiDocsSettings({ allowedCidrs: ["127.0.0.1"] })).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an enabled custom scope with an empty list", async () => {
    await expect(saveApiDocsSettings({ enabled: true, ipScope: "custom", allowedCidrs: [] })).rejects.toMatchObject(
      { httpStatus: 400 },
    );
  });

  it("merges partial input over the current row", async () => {
    findUnique.mockResolvedValue({
      key: API_DOCS_SETTING_KEY,
      value: { enabled: true, ipScope: "custom", allowedCidrs: ["10.5.0.0/16"] },
    });
    const saved = await saveApiDocsSettings({ enabled: false });
    expect(saved).toEqual({ enabled: false, ipScope: "custom", allowedCidrs: ["10.5.0.0/16"] });
  });
});

describe("docsSourceAllowed", () => {
  it("disabled denies EVERYONE, loopback included — off means off", () => {
    const s = settings({ enabled: false });
    expect(docsSourceAllowed("127.0.0.1", s)).toBe(false);
    expect(docsSourceAllowed("10.0.0.1", s)).toBe(false);
  });

  it("loopback is always allowed under every enabled scope, in every form Node reports it", () => {
    for (const scope of ["loopback", "rfc1918", "custom"] as const) {
      const s = settings({ ipScope: scope, allowedCidrs: scope === "custom" ? ["10.5.0.0/16"] : [] });
      expect(docsSourceAllowed("127.0.0.1", s)).toBe(true);
      expect(docsSourceAllowed("::1", s)).toBe(true);
      expect(docsSourceAllowed("::ffff:127.0.0.1", s)).toBe(true);
    }
  });

  it("loopback scope refuses private and public sources", () => {
    const s = settings({ ipScope: "loopback" });
    expect(docsSourceAllowed("10.0.0.1", s)).toBe(false);
    expect(docsSourceAllowed("8.8.8.8", s)).toBe(false);
  });

  it("rfc1918 scope admits private, refuses public (v4-mapped forms included)", () => {
    const s = settings();
    expect(docsSourceAllowed("192.168.1.20", s)).toBe(true);
    expect(docsSourceAllowed("::ffff:10.1.2.3", s)).toBe(true);
    expect(docsSourceAllowed("8.8.8.8", s)).toBe(false);
    expect(docsSourceAllowed("::ffff:8.8.8.8", s)).toBe(false);
  });

  it("custom scope admits only listed networks (plus loopback); empty source refused", () => {
    const s = settings({ ipScope: "custom", allowedCidrs: ["10.5.0.0/16"] });
    expect(docsSourceAllowed("10.5.3.9", s)).toBe(true);
    expect(docsSourceAllowed("10.6.0.1", s)).toBe(false);
    expect(docsSourceAllowed("", s)).toBe(false);
  });
});

describe("isApiDocsSourceAllowed — fails CLOSED", () => {
  it("denies when the settings read throws (unauthenticated disclosure surface)", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await isApiDocsSourceAllowed("127.0.0.1")).toBe(false);
  });

  it("allows a loopback caller on a healthy read", async () => {
    findUnique.mockResolvedValue(null);
    expect(await isApiDocsSourceAllowed("127.0.0.1")).toBe(true);
  });
});

describe("deriveApiDocsNginxAllow", () => {
  it("disabled → no allows (the rendered block is deny-all alone)", () => {
    expect(deriveApiDocsNginxAllow(settings({ enabled: false }))).toEqual({ enabled: false, allow: [] });
  });

  it("loopback → the loopback pair only", () => {
    expect(deriveApiDocsNginxAllow(settings({ ipScope: "loopback" }))).toEqual({
      enabled: true,
      allow: ["127.0.0.0/8", "::1"],
    });
  });

  it("rfc1918 → loopback pair + the three RFC1918 ranges, in stable order", () => {
    expect(deriveApiDocsNginxAllow(settings())).toEqual({
      enabled: true,
      allow: ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    });
  });

  it("custom → loopback pair + the stored CIDRs in stored order", () => {
    expect(
      deriveApiDocsNginxAllow(settings({ ipScope: "custom", allowedCidrs: ["10.5.0.0/16", "192.168.7.0/24"] })),
    ).toEqual({ enabled: true, allow: ["127.0.0.0/8", "::1", "10.5.0.0/16", "192.168.7.0/24"] });
  });
});
