/**
 * tests/unit/brandingSettings.test.ts — the pure helpers behind the branding
 * Setting row.
 *
 * The flag normalizer is the one with teeth: the placement checkboxes default
 * ON, so reading a stored `false` through a `||` would silently turn an
 * operator's "don't show my logo here" back on at every read.
 */

import { describe, it, expect } from "vitest";
import {
  BRANDING_DEFAULTS,
  displayAppName,
  hasCustomLogo,
  isDefaultLogoUrl,
  logoCacheControl,
  logoVersionStamp,
  normalizeBrandingFlag,
  normalizeTemperatureUnit,
} from "../../src/services/brandingService.js";

describe("logoVersionStamp", () => {
  it("is stable for the same file and changes with any upload", () => {
    const v = logoVersionStamp(1_700_000_000_000, 4096, "0.9.123");
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(logoVersionStamp(1_700_000_000_000, 4096, "0.9.123")).toBe(v);
    // A new upload rewrites the fixed filename: new mtime, usually a new size.
    expect(logoVersionStamp(1_700_000_000_001, 4096, "0.9.123")).not.toBe(v);
    expect(logoVersionStamp(1_700_000_000_000, 4097, "0.9.123")).not.toBe(v);
    // A Polaris update can change the symbol the accent composite draws in.
    expect(logoVersionStamp(1_700_000_000_000, 4096, "0.9.124")).not.toBe(v);
  });
});

describe("logoCacheControl", () => {
  it("is immutable only for a request naming the CURRENT version", () => {
    expect(logoCacheControl("abc", "abc")).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates for no version, a stale one, or no custom logo", () => {
    // A payload cached before logoVersion existed asks without one.
    expect(logoCacheControl(undefined, "abc")).toBe("no-cache");
    // A stale version must never pin old bytes for a year.
    expect(logoCacheControl("old", "abc")).toBe("no-cache");
    expect(logoCacheControl("abc", null)).toBe("no-cache");
    // A repeated query param arrives as an array; never immutable.
    expect(logoCacheControl(["abc", "abc"], "abc")).toBe("no-cache");
  });
});

describe("normalizeBrandingFlag", () => {
  it("keeps a stored false, defaults only when nothing is stored", () => {
    expect(normalizeBrandingFlag(false, true)).toBe(false);
    expect(normalizeBrandingFlag(undefined, true)).toBe(true);
    expect(normalizeBrandingFlag(null, true)).toBe(true);
    expect(normalizeBrandingFlag(undefined, false)).toBe(false);
  });

  it('reads the string forms a form post can produce ("false"/"" are off)', () => {
    expect(normalizeBrandingFlag("true", false)).toBe(true);
    expect(normalizeBrandingFlag("on", false)).toBe(true);
    expect(normalizeBrandingFlag("false", true)).toBe(false);
    expect(normalizeBrandingFlag("0", true)).toBe(false);
    expect(normalizeBrandingFlag("", true)).toBe(false);
  });
});

describe("hasCustomLogo", () => {
  it("is true only for a logo that isn't the shipped default", () => {
    expect(hasCustomLogo("/uploads/custom-logo.png")).toBe(true);
    expect(hasCustomLogo(BRANDING_DEFAULTS.logoUrl)).toBe(false);
    expect(hasCustomLogo("")).toBe(false);
  });

  it("still treats the RETIRED /logo.png default as non-custom", () => {
    // The upgrade trap this guards: an install seeded before the themed brand
    // marks has `logoUrl: "/logo.png"` in its branding Setting row, and that
    // file no longer ships. Judging it by the CURRENT default alone answers
    // true, every surface then treats it as an operator upload, and the sidebar
    // and login page of every pre-existing install paint a 404.
    expect(hasCustomLogo("/logo.png")).toBe(false);
  });
});

describe("isDefaultLogoUrl", () => {
  it("accepts the current default and every retired one", () => {
    expect(isDefaultLogoUrl("/img/brand/polaris-symbol-dark.png")).toBe(true);
    expect(isDefaultLogoUrl("/logo.png")).toBe(true);
  });

  it("rejects an upload, a lookalike path, and empty values", () => {
    expect(isDefaultLogoUrl("/uploads/custom-logo.png")).toBe(false);
    // Substring-ish neighbours must not pass — this is an exact-match list.
    expect(isDefaultLogoUrl("/img/brand/polaris-symbol-light.png")).toBe(false);
    expect(isDefaultLogoUrl("/logo.png.bak")).toBe(false);
    expect(isDefaultLogoUrl("")).toBe(false);
    expect(isDefaultLogoUrl(null)).toBe(false);
    expect(isDefaultLogoUrl(undefined)).toBe(false);
  });
});

describe("displayAppName", () => {
  it("falls back for the surfaces that must print a name", () => {
    expect(displayAppName({ appName: "Acme" })).toBe("Acme");
    // Blank is a legitimate stored value — a logo can carry the wordmark — but
    // a page title or a PWA manifest still needs something to say.
    expect(displayAppName({ appName: "" })).toBe("Polaris");
    expect(displayAppName({ appName: "   " })).toBe("Polaris");
    expect(displayAppName({})).toBe("Polaris");
  });
});

describe("normalizeTemperatureUnit", () => {
  it("is unchanged by the new fields", () => {
    expect(normalizeTemperatureUnit("f")).toBe("f");
    expect(normalizeTemperatureUnit("nonsense")).toBe("c");
  });
});
