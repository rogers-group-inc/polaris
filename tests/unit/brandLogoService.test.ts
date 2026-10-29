/**
 * tests/unit/brandLogoService.test.ts — the accented-logo composite.
 *
 * Two things matter here. The geometry (where the Polaris symbol lands and how
 * big it is) is what the operator was promised — "bottom-right corner, roughly
 * 35% the size of their logo" — and the degradation rules, because this render
 * feeds an <img> on an unauthenticated login page: every failure has to end in
 * "no accent", never in an exception.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Stand-in bytes for an operator upload — any decodable PNG will do; the
// shipped mark is reused so the fixture can't rot with a retired filename.
const REAL_LOGO = readFileSync(join(process.cwd(), "public", "img", "brand", "polaris-symbol-dark.png"));
const REAL_SYMBOL_DARK = readFileSync(join(process.cwd(), "public", "img", "brand", "polaris-symbol-dark.png"));
const REAL_SYMBOL_LIGHT = readFileSync(join(process.cwd(), "public", "img", "brand", "polaris-symbol-light.png"));

/** Virtual filesystem: anything not registered here ENOENTs. */
const files = new Map<string, Buffer>();

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: unknown) => {
    const hit = files.get(String(p));
    if (hit) return hit;
    throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: "ENOENT" });
  }),
  stat: vi.fn(async (p: unknown) => {
    if (!files.has(String(p))) throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: "ENOENT" });
    return { mtimeMs: 4242 };
  }),
}));

const branding = {
  appName: "Acme",
  subtitle: "",
  logoUrl: "/uploads/custom-logo.png",
  logoAccent: true,
  logoOnLogin: true,
  logoOnSidebar: true,
  temperatureUnit: "c" as const,
  customLogo: true,
  version: "0.0.0",
};

vi.mock("../../src/services/brandingService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/brandingService.js")>();
  return { ...actual, getBranding: vi.fn(async () => branding) };
});

const {
  accentGeometry, renderAccentedLogo, normalizeBrandTheme,
  ACCENT_SYMBOL_PATHS, MAX_RENDER_PX, __resetBrandLogoCacheForTests,
} = await import("../../src/services/brandLogoService.js");
const { UPLOADS_DIR } = await import("../../src/utils/paths.js");

const CUSTOM_LOGO_PATH = join(UPLOADS_DIR, "custom-logo.png");

beforeEach(() => {
  files.clear();
  files.set(CUSTOM_LOGO_PATH, REAL_LOGO);
  files.set(ACCENT_SYMBOL_PATHS.dark, REAL_SYMBOL_DARK);
  files.set(ACCENT_SYMBOL_PATHS.light, REAL_SYMBOL_LIGHT);
  branding.logoAccent = true;
  branding.logoUrl = "/uploads/custom-logo.png";
  __resetBrandLogoCacheForTests();
});

describe("accentGeometry", () => {
  it("puts a half-size symbol flush in the bottom-right of a square logo", () => {
    const g = accentGeometry({ width: 400, height: 400 });
    expect(g).toEqual({ width: 400, height: 400, accent: 200, accentX: 200, accentY: 200 });
  });

  it("clamps on a wide banner, where half the width would overflow the height", () => {
    const g = accentGeometry({ width: 1000, height: 200 });
    // 0.5 * 1000 = 500 would be far taller than the logo; half the short side wins.
    expect(g.accent).toBe(100);
    expect(g.accentX).toBe(900);
    expect(g.accentY).toBe(100);
  });

  it("clamps on a tall logo the same way", () => {
    const g = accentGeometry({ width: 200, height: 1000 });
    expect(g.accent).toBe(100);
    expect(g.accentX).toBe(100);
    expect(g.accentY).toBe(900);
  });

  it("scales an oversized upload down to the render cap, keeping its aspect", () => {
    const g = accentGeometry({ width: 4000, height: 2000 });
    expect(g.width).toBe(MAX_RENDER_PX);
    expect(g.height).toBe(MAX_RENDER_PX / 2);
    // Accent is computed on the RENDERED size, not the upload's — and at
    // ACCENT_FRACTION 0.5 the clamp binds for anything but a square logo, so
    // this 2:1 banner gets half its (rendered) height.
    expect(g.accent).toBe(Math.round(MAX_RENDER_PX / 4));
  });

  it("never returns a zero-size accent for a 1px logo", () => {
    const g = accentGeometry({ width: 1, height: 1 });
    expect(g.accent).toBeGreaterThanOrEqual(1);
  });
});

describe("normalizeBrandTheme", () => {
  it("accepts only the two known themes, defaulting to dark", () => {
    expect(normalizeBrandTheme("light")).toBe("light");
    expect(normalizeBrandTheme("LIGHT")).toBe("light");
    expect(normalizeBrandTheme("dark")).toBe("dark");
    // Query strings are untrusted and reach a filesystem path lookup.
    expect(normalizeBrandTheme("../../etc/passwd")).toBe("dark");
    expect(normalizeBrandTheme(undefined)).toBe("dark");
    expect(normalizeBrandTheme(["light", "dark"])).toBe("dark");
  });
});

// Real image composites; the 5 s default is crossed under full-suite load.
describe("renderAccentedLogo", { timeout: 30_000 }, () => {
  it("composites a PNG and memoizes it", async () => {
    const first = await renderAccentedLogo();
    expect(first).not.toBeNull();
    expect(first!.buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(first!.etag).toMatch(/^[0-9a-f]{16}$/);

    const second = await renderAccentedLogo();
    expect(second!.buf).toBe(first!.buf); // same object = cache hit, not a re-render
  });

  it("renders a distinct composite per theme, and caches both", async () => {
    const dark = await renderAccentedLogo("dark");
    const light = await renderAccentedLogo("light");
    // Different symbol art in, different bytes and different ETag out — a
    // shared ETag would let one theme's render revalidate into the other's.
    expect(dark!.buf.equals(light!.buf)).toBe(false);
    expect(dark!.etag).not.toBe(light!.etag);
    // Neither evicted the other.
    expect((await renderAccentedLogo("dark"))!.buf).toBe(dark!.buf);
    expect((await renderAccentedLogo("light"))!.buf).toBe(light!.buf);
  });

  it("defaults to the dark variant", async () => {
    const explicit = await renderAccentedLogo("dark");
    expect((await renderAccentedLogo())!.buf).toBe(explicit!.buf);
  });

  it("returns null when the accent is switched off", async () => {
    branding.logoAccent = false;
    expect(await renderAccentedLogo()).toBeNull();
  });

  it("returns null on the shipped default logo — there is nothing to accent", async () => {
    branding.logoUrl = "/img/brand/polaris-symbol-dark.png";
    expect(await renderAccentedLogo()).toBeNull();
  });

  it("returns null on the RETIRED default logo too", async () => {
    // "/logo.png" is still the stored value on installs seeded before the
    // themed marks; reading it as an upload would try to accent a 404.
    branding.logoUrl = "/logo.png";
    expect(await renderAccentedLogo()).toBeNull();
  });

  it("returns null (rather than throwing) when the logo file is missing", async () => {
    files.delete(CUSTOM_LOGO_PATH);
    expect(await renderAccentedLogo()).toBeNull();
  });

  it("returns null when the symbol art is missing", async () => {
    files.delete(ACCENT_SYMBOL_PATHS.dark);
    expect(await renderAccentedLogo("dark")).toBeNull();
    // The other theme's art is still there, so that variant still renders.
    expect(await renderAccentedLogo("light")).not.toBeNull();
  });

  it("returns null for a WebP logo — resvg cannot embed it", async () => {
    const webp = Buffer.alloc(64);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    files.set(CUSTOM_LOGO_PATH, webp);
    expect(await renderAccentedLogo()).toBeNull();
  });

  it("never composites something outside the uploads dir", async () => {
    // resolveBrandingLogoFile basenames the path, so this can only ever land on
    // uploads/.env — which isn't there. Either way: no render, no read escape.
    branding.logoUrl = "/uploads/../../.env";
    expect(await renderAccentedLogo()).toBeNull();
  });
});
