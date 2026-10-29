import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// A real PNG so resvg has something decodable to embed. Read with the sync fs
// API, which the node:fs/promises mock below does not touch.
// The shipped default mark. "-dark" = for a dark background: every opaque icon
// variant paints ICON_BG behind it and iOS composites onto black.
const DEFAULT_LOGO_URL = "/img/brand/polaris-symbol-dark.png";
const DEFAULT_LOGO_FILE = "polaris-symbol-dark.png";
const LEGACY_LOGO_URL = "/logo.png"; // retired 2026-08, still stored by old installs
const REAL_LOGO = readFileSync(join(process.cwd(), "public", "img", "brand", DEFAULT_LOGO_FILE));

function webpBuffer(): Buffer {
  const b = Buffer.alloc(64);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  return b;
}

/** Virtual filesystem: path -> bytes. Anything else 404s, except the default logo. */
const files = new Map<string, Buffer>();
const state = { mtimeMs: 1000 };

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: unknown) => {
    const key = String(p);
    const hit = files.get(key);
    if (hit) return hit;
    if (key.endsWith(DEFAULT_LOGO_FILE)) return REAL_LOGO;
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
  }),
  stat: vi.fn(async (p: unknown) => {
    const key = String(p);
    if (!files.has(key) && !key.endsWith(DEFAULT_LOGO_FILE)) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return { mtimeMs: state.mtimeMs };
  }),
}));

const branding = { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: DEFAULT_LOGO_URL, version: "0.0.0" };
vi.mock("../../src/services/brandingService.js", () => ({
  BRANDING_DEFAULTS: { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png" },
  // Mirrors the real predicate: the current default AND the retired one, so a
  // pre-upgrade branding row is not mistaken for an operator upload.
  isDefaultLogoUrl: (u: string) => u === "/img/brand/polaris-symbol-dark.png" || u === "/logo.png",
  getBranding: vi.fn(async () => branding),
}));

const { renderAppIcon, getIconSetVersion, resolveBrandingLogoFile, findIconSpec, ICON_SPECS, __resetIconCacheForTests } =
  await import("../../src/services/appIconService.js");
const { UPLOADS_DIR } = await import("../../src/utils/paths.js");

/** PNG signature + IHDR width/height, so we assert the ACTUAL raster size. */
function pngDims(buf: Buffer): { sig: boolean; w: number; h: number } {
  const sig = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { sig, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

beforeEach(() => {
  files.clear();
  state.mtimeMs = 1000;
  branding.logoUrl = DEFAULT_LOGO_URL;
  __resetIconCacheForTests();
});

describe("resolveBrandingLogoFile", () => {
  it("maps the default logoUrl to the shipped logo", () => {
    expect(resolveBrandingLogoFile(DEFAULT_LOGO_URL).ok).toBe(true);
  });

  it("still maps the RETIRED default to the shipped logo", () => {
    // An install seeded before the themed marks stores "/logo.png". Treating it
    // as an upload would send it down the /uploads/ branch and answer ok:false
    // forever, so every PWA icon would fall back to raw bytes.
    const r = resolveBrandingLogoFile(LEGACY_LOGO_URL);
    expect(r.ok).toBe(true);
    expect(r.path).toContain(DEFAULT_LOGO_FILE);
  });

  it("maps an uploaded logo into UPLOADS_DIR", () => {
    const r = resolveBrandingLogoFile("/uploads/custom-logo.png");
    expect(r.ok).toBe(true);
    expect(r.path).toBe(resolve(join(UPLOADS_DIR, "custom-logo.png")));
  });

  it("never escapes UPLOADS_DIR, whatever the branding row says", () => {
    // The `branding` Setting row is operator-writable, so this is the one
    // untrusted input in the service. basename() neutralizes the traversal
    // (so these stay *inside* the uploads dir and are readable-but-not-an-image),
    // and the prefix assertion is the backstop.
    const root = resolve(UPLOADS_DIR);
    for (const evil of ["/uploads/../../../.env", "/uploads/../../secrets.png", "/uploads/....//....//etc/passwd"]) {
      const r = resolveBrandingLogoFile(evil);
      expect(r.path.startsWith(root + sep), evil).toBe(true);
    }
  });

  it("refuses degenerate upload paths outright", () => {
    for (const bad of ["/uploads/", "/uploads/..", "/uploads/."]) {
      expect(resolveBrandingLogoFile(bad).ok, bad).toBe(false);
    }
  });

  it("refuses a URL that isn't an upload at all", () => {
    expect(resolveBrandingLogoFile("http://evil.example/x.png").ok).toBe(false);
    expect(resolveBrandingLogoFile("/etc/passwd").ok).toBe(false);
  });
});

describe("ICON_SPECS", () => {
  it("is the allowlist the route matches against", () => {
    expect(ICON_SPECS.map((s) => s.name)).toEqual([
      "app-192", "app-512", "app-maskable-192", "app-maskable-512", "app-apple-180",
    ]);
    expect(findIconSpec("app-512")).toMatchObject({ variant: "any", size: 512 });
    expect(findIconSpec("app-999")).toBeNull();
    expect(findIconSpec("../../etc/passwd")).toBeNull();
  });
});

// Real image renders; the 5 s default is crossed under full-suite load.
describe("renderAppIcon", { timeout: 30_000 }, () => {
  it("renders each spec at its declared pixel size", async () => {
    for (const spec of ICON_SPECS) {
      const png = await renderAppIcon(spec.variant, spec.size);
      const { sig, w, h } = pngDims(png);
      expect(sig, spec.name).toBe(true);
      expect([w, h], spec.name).toEqual([spec.size, spec.size]);
    }
  });

  it("memoizes identical requests", async () => {
    const a = await renderAppIcon("any", 192);
    const b = await renderAppIcon("any", 192);
    expect(b).toBe(a); // same Buffer instance = cache hit
  });

  it("busts the cache when the logo file's mtime changes", async () => {
    // logoUrl never changes on re-upload (fixed filename), so mtime is the
    // only invalidation signal.
    const a = await renderAppIcon("any", 192);
    state.mtimeMs = 2000;
    const b = await renderAppIcon("any", 192);
    expect(b).not.toBe(a);
  });

  it("falls back to the default logo when the uploaded file is missing", async () => {
    branding.logoUrl = "/uploads/gone.png";
    const png = await renderAppIcon("any", 192);
    const { sig, w } = pngDims(png);
    expect(sig).toBe(true);
    expect(w).toBe(192);
  });

  it("falls back for a WebP logo, which resvg cannot decode when embedded", async () => {
    branding.logoUrl = "/uploads/custom-logo.webp";
    files.set(resolve(join(UPLOADS_DIR, "custom-logo.webp")), webpBuffer());
    const png = await renderAppIcon("any", 512);
    const { sig, w } = pngDims(png);
    expect(sig).toBe(true);
    expect(w).toBe(512);
  });

  it("falls back when the uploaded file isn't an image at all", async () => {
    branding.logoUrl = "/uploads/custom-logo.png";
    files.set(resolve(join(UPLOADS_DIR, "custom-logo.png")), Buffer.from("<?php echo 1; ?>"));
    const png = await renderAppIcon("any", 192);
    expect(pngDims(png).w).toBe(192);
  });

  it("never throws on a traversal logoUrl", async () => {
    branding.logoUrl = "/uploads/../../../.env";
    await expect(renderAppIcon("maskable", 512)).resolves.toBeInstanceOf(Buffer);
  });
});

describe("getIconSetVersion", () => {
  it("is stable across calls and changes when the source changes", async () => {
    const v1 = await getIconSetVersion();
    expect(await getIconSetVersion()).toBe(v1);

    state.mtimeMs = 9999;
    const v2 = await getIconSetVersion();
    expect(v2).not.toBe(v1);

    branding.logoUrl = "/uploads/custom-logo.png";
    files.set(resolve(join(UPLOADS_DIR, "custom-logo.png")), REAL_LOGO);
    expect(await getIconSetVersion()).not.toBe(v2);
  });

  it("is a short hex stamp", async () => {
    expect(await getIconSetVersion()).toMatch(/^[0-9a-f]{8}$/);
  });
});
