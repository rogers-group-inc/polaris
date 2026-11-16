/**
 * tests/unit/brandingService.test.ts — getBranding, the read side of the
 * `branding` Setting row (business rule 27), plus the helper edges the pure
 * suite (brandingSettings.test.ts) does not reach.
 *
 * Contract (polaris-change-impact → settings-platform.md): never throws on a
 * missing row; `appName` may be stored EMPTY and is read with `!== undefined`;
 * the three logo flags read through normalizeBrandingFlag so a stored `false`
 * survives; `customLogo` is derived from DEFAULT_LOGO_URLS (current + retired
 * `/logo.png`); `logoVersion` comes from the resolved upload's mtime + size +
 * the app version, and is null with no custom logo or no readable file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  resolveBrandingLogoFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/version.js", () => ({ getAppVersion: () => "0.9.42" }));
vi.mock("../../src/services/appIconService.js", () => ({ resolveBrandingLogoFile: h.resolveBrandingLogoFile }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return { ...real, stat: h.stat, default: { ...real, stat: h.stat } };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getBranding,
  BRANDING_DEFAULTS,
  logoVersionStamp,
  normalizeBrandingFlag,
  normalizeTemperatureUnit,
  hasCustomLogo,
  isDefaultLogoUrl,
  displayAppName,
  logoCacheControl,
} from "../../src/services/brandingService.js";

function stored(value: Record<string, unknown> | null): void {
  stubbed(prisma.setting.findUnique).mockResolvedValue(value === null ? null : { key: "branding", value });
}

beforeEach(() => {
  resetDbStub();
  h.resolveBrandingLogoFile.mockReset();
  h.stat.mockReset();
  stored(null);
});

describe("getBranding", () => {
  it("answers the defaults with no row, and reads the branding key", async () => {
    const b = await getBranding();
    expect(b).toEqual({
      ...BRANDING_DEFAULTS,
      customLogo: false,
      logoVersion: null,
      version: "0.9.42",
    });
    expect(prisma.setting.findUnique).toHaveBeenCalledWith({ where: { key: "branding" } });
    expect(h.resolveBrandingLogoFile).not.toHaveBeenCalled();
  });

  it("keeps a deliberately EMPTY appName and subtitle", async () => {
    stored({ appName: "", subtitle: "" });
    const b = await getBranding();
    expect(b.appName).toBe("");
    expect(b.subtitle).toBe("");
    expect(displayAppName(b)).toBe("Polaris");
  });

  it("keeps a stored false on the default-ON placement flags", async () => {
    stored({ logoOnLogin: false, logoOnSidebar: false, logoAccent: true });
    const b = await getBranding();
    expect(b.logoOnLogin).toBe(false);
    expect(b.logoOnSidebar).toBe(false);
    expect(b.logoAccent).toBe(true);
  });

  it("normalizes the temperature unit", async () => {
    stored({ temperatureUnit: " F " });
    expect((await getBranding()).temperatureUnit).toBe("f");
    stored({ temperatureUnit: "kelvin" });
    expect((await getBranding()).temperatureUnit).toBe("c");
  });

  it("falls back to the default logo URL on an empty stored one", async () => {
    stored({ logoUrl: "" });
    const b = await getBranding();
    expect(b.logoUrl).toBe(BRANDING_DEFAULTS.logoUrl);
    expect(b.customLogo).toBe(false);
  });

  it("treats the retired /logo.png as the shipped default, not an upload", async () => {
    stored({ logoUrl: "/logo.png" });
    const b = await getBranding();
    expect(b.logoUrl).toBe("/logo.png");
    expect(b.customLogo).toBe(false);
    expect(b.logoVersion).toBeNull();
    expect(h.resolveBrandingLogoFile).not.toHaveBeenCalled();
  });

  it("versions a custom logo from the resolved file's mtime + size + app version", async () => {
    stored({ logoUrl: "/uploads/logo.png" });
    h.resolveBrandingLogoFile.mockReturnValue({ ok: true, path: "/data/uploads/logo.png" });
    h.stat.mockResolvedValue({ mtimeMs: 1_700_000_000_000, size: 4096 });
    const b = await getBranding();
    expect(b.customLogo).toBe(true);
    expect(h.resolveBrandingLogoFile).toHaveBeenCalledWith("/uploads/logo.png");
    expect(h.stat).toHaveBeenCalledWith("/data/uploads/logo.png");
    expect(b.logoVersion).toBe(logoVersionStamp(1_700_000_000_000, 4096, "0.9.42"));
  });

  it("answers a null version when the upload path does not resolve", async () => {
    stored({ logoUrl: "/elsewhere/logo.png" });
    h.resolveBrandingLogoFile.mockReturnValue({ ok: false, path: "/default.png" });
    const b = await getBranding();
    expect(b.customLogo).toBe(true);
    expect(b.logoVersion).toBeNull();
    expect(h.stat).not.toHaveBeenCalled();
  });

  it("answers a null version, never throws, when the file is missing", async () => {
    stored({ logoUrl: "/uploads/logo.png" });
    h.resolveBrandingLogoFile.mockReturnValue({ ok: true, path: "/data/uploads/logo.png" });
    h.stat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect((await getBranding()).logoVersion).toBeNull();
  });

  it("propagates a DB error (only a MISSING row answers defaults)", async () => {
    stubbed(prisma.setting.findUnique).mockRejectedValue(new Error("db down"));
    await expect(getBranding()).rejects.toThrow("db down");
  });
});

describe("helper edges", () => {
  it("normalizeBrandingFlag reads string forms", () => {
    expect(normalizeBrandingFlag("false", true)).toBe(false);
    expect(normalizeBrandingFlag("0", true)).toBe(false);
    expect(normalizeBrandingFlag("", true)).toBe(false);
    expect(normalizeBrandingFlag("true", false)).toBe(true);
    expect(normalizeBrandingFlag(0, true)).toBe(false);
    expect(normalizeBrandingFlag(null, true)).toBe(true);
  });

  it("normalizeTemperatureUnit treats null/undefined as Celsius", () => {
    expect(normalizeTemperatureUnit(undefined)).toBe("c");
    expect(normalizeTemperatureUnit(null)).toBe("c");
  });

  it("hasCustomLogo / isDefaultLogoUrl on empty values", () => {
    expect(hasCustomLogo("")).toBe(false);
    expect(isDefaultLogoUrl(null)).toBe(false);
    expect(isDefaultLogoUrl(undefined)).toBe(false);
    expect(isDefaultLogoUrl(BRANDING_DEFAULTS.logoUrl)).toBe(true);
  });

  it("displayAppName trims and falls back on whitespace-only or null", () => {
    expect(displayAppName({ appName: "  Acme  " })).toBe("Acme");
    expect(displayAppName({ appName: "   " })).toBe("Polaris");
    expect(displayAppName({ appName: null })).toBe("Polaris");
    expect(displayAppName({})).toBe("Polaris");
  });

  it("logoCacheControl never pins a repeated (array) v param", () => {
    expect(logoCacheControl(["abc", "abc"], "abc")).toBe("no-cache");
  });
});
