/**
 * tests/unit/alertBrandService.test.ts — own suite for
 * src/services/alertBrandService.ts (CQ-T010).
 *
 * The pure layout half (renderBrandBlock / fitLogo / the token in the default
 * bodies) is pinned by alertBrandLetterhead.test.ts. This file drives the
 * delivery-time step, `buildAlertBrandBlock`, against stubbed branding and a
 * stubbed filesystem:
 *
 *  - rule 27: the shipped wordmark prints no name beside it; an operator's own
 *    logo is captioned with the app name, unless the name was blanked;
 *  - the accent composite wins when enabled, then the uploaded file, then the
 *    shipped wordmark — every failure rung falls one step, nothing throws;
 *  - PNG / JPEG only; unreadable dimensions drop the image;
 *  - the 60 s memo;
 *  - the token helpers, including `$` patterns in operator text.
 *
 * The module memoizes for 60 s with Date.now(), so every test moves a faked
 * clock two minutes on before it runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  getBranding: vi.fn(),
  renderAccentedLogo: vi.fn(),
  resolveBrandingLogoFile: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: m.readFile }));
vi.mock("../../src/services/brandingService.js", () => ({
  getBranding: m.getBranding,
  displayAppName: (b: { appName?: string | null }) => (b.appName || "").trim() || "Polaris",
}));
vi.mock("../../src/services/brandLogoService.js", () => ({ renderAccentedLogo: m.renderAccentedLogo }));
vi.mock("../../src/services/appIconService.js", () => ({ resolveBrandingLogoFile: m.resolveBrandingLogoFile }));

import {
  BRAND_LOGO_CID,
  brandTokensIn,
  buildAlertBrandBlock,
  substituteBrandTokens,
} from "../../src/services/alertBrandService.js";

/** A buffer imageSize can read: PNG signature + an IHDR chunk header. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A buffer jpegSize can read: SOI + an SOF0 segment. */
function jpeg(width: number, height: number): Buffer {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
const SHIPPED = png(600, 120);

function branding(over: Record<string, unknown> = {}) {
  return { appName: "Polaris", subtitle: "", customLogo: false, logoAccent: false, logoUrl: "/img/brand/polaris.png", ...over };
}

let clock = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Ten minutes on: past the 60 s memo whatever a test before it moved the clock to.
  clock += 600_000;
  vi.setSystemTime(clock);
  m.getBranding.mockReset();
  m.renderAccentedLogo.mockReset();
  m.resolveBrandingLogoFile.mockReset();
  m.readFile.mockReset();
  m.readFile.mockImplementation(async (p: string) => {
    if (String(p).endsWith("polaris-horiz-light.png")) return SHIPPED;
    throw new Error(`ENOENT ${p}`);
  });
  m.resolveBrandingLogoFile.mockReturnValue({ ok: true, path: "/uploads/logo-custom.png" });
});

afterEach(() => vi.useRealTimers());

describe("buildAlertBrandBlock — shipped branding (rule 27)", () => {
  it("uses the light horizontal wordmark and prints no name beside it", async () => {
    m.getBranding.mockResolvedValue(branding());
    const b = await buildAlertBrandBlock();
    expect(String(m.readFile.mock.calls[0]![0])).toMatch(/img[\\/]brand[\\/]polaris-horiz-light\.png$/);
    expect(b.html).toContain(`src="cid:${BRAND_LOGO_CID}"`);
    expect(b.html).not.toContain("<div"); // no caption, no subtitle
    // 600x120 fits the 150x46 box by width: 150x30.
    expect(b.html).toContain('width="150" height="30"');
    expect(b.attachment).toMatchObject({ cid: BRAND_LOGO_CID, filename: "logo.png", contentType: "image/png" });
    expect(b.attachment!.content).toBe(SHIPPED);
    // The text body still names the sender, through the alt text.
    expect(b.text).toBe("Polaris");
  });

  it("keeps the subtitle either way, and names the sender in alt from displayAppName", async () => {
    m.getBranding.mockResolvedValue(branding({ appName: "  ", subtitle: "  Network Management Tool " }));
    const b = await buildAlertBrandBlock();
    expect(b.html).toContain('alt="Polaris"');
    expect(b.html).toContain(">Network Management Tool</div>");
    expect(b.text).toBe("Polaris — Network Management Tool");
  });

  it("never consults the uploaded-file or accent rungs without a custom logo", async () => {
    m.getBranding.mockResolvedValue(branding({ logoAccent: true }));
    await buildAlertBrandBlock();
    expect(m.renderAccentedLogo).not.toHaveBeenCalled();
    expect(m.resolveBrandingLogoFile).not.toHaveBeenCalled();
  });
});

describe("buildAlertBrandBlock — an operator's own logo", () => {
  it("captions the upload with the app name and the subtitle", async () => {
    const upload = png(400, 400);
    m.readFile.mockImplementation(async (p: string) => (p === "/uploads/logo-custom.png" ? upload : SHIPPED));
    m.getBranding.mockResolvedValue(branding({ customLogo: true, appName: " Acme <NOC> ", subtitle: "Plant ops", logoUrl: "/uploads/logo-custom.png" }));
    const b = await buildAlertBrandBlock();
    expect(m.resolveBrandingLogoFile).toHaveBeenCalledWith("/uploads/logo-custom.png");
    expect(b.attachment!.content).toBe(upload);
    expect(b.html).toContain('width="46" height="46"'); // square: capped by height
    expect(b.html).toContain(">Acme &lt;NOC&gt;</div>");
    expect(b.html).toContain('alt="Acme &lt;NOC&gt;"');
    expect(b.html).toContain(">Plant ops</div>");
    expect(b.text).toBe("Acme <NOC> — Plant ops");
  });

  it("prints no caption when the operator blanked the name", async () => {
    m.readFile.mockResolvedValue(png(100, 20));
    m.getBranding.mockResolvedValue(branding({ customLogo: true, appName: "" }));
    const b = await buildAlertBrandBlock();
    expect(b.html).toContain("<img");
    expect(b.html).not.toContain("font-weight:600");
  });

  it("uses the accent composite (light variant) when the operator enabled one", async () => {
    const accented = png(300, 100);
    m.renderAccentedLogo.mockResolvedValue({ buf: accented });
    m.getBranding.mockResolvedValue(branding({ customLogo: true, logoAccent: true }));
    const b = await buildAlertBrandBlock();
    expect(m.renderAccentedLogo).toHaveBeenCalledWith("light");
    expect(b.attachment!.content).toBe(accented);
    expect(m.resolveBrandingLogoFile).not.toHaveBeenCalled();
  });

  it("falls back to the uploaded file when the composite fails or is unusable", async () => {
    const upload = jpeg(200, 50);
    m.readFile.mockImplementation(async (p: string) => (p === "/uploads/logo-custom.png" ? upload : SHIPPED));
    m.getBranding.mockResolvedValue(branding({ customLogo: true, logoAccent: true }));

    m.renderAccentedLogo.mockRejectedValueOnce(new Error("resvg missing"));
    const a = await buildAlertBrandBlock();
    expect(a.attachment).toMatchObject({ contentType: "image/jpeg", filename: "logo.jpg" });
    expect(a.attachment!.content).toBe(upload);

    vi.setSystemTime((clock += 120_000));
    m.renderAccentedLogo.mockResolvedValueOnce({ buf: WEBP });
    const b = await buildAlertBrandBlock();
    expect(b.attachment!.content).toBe(upload);
  });

  it("falls back to the shipped wordmark when the logo URL does not resolve", async () => {
    m.resolveBrandingLogoFile.mockReturnValue({ ok: false, path: "/x" });
    m.getBranding.mockResolvedValue(branding({ customLogo: true, appName: "Acme" }));
    const b = await buildAlertBrandBlock();
    expect(b.attachment!.content).toBe(SHIPPED);
    // The name decision is about the operator's branding, not which art loaded.
    expect(b.html).toContain(">Acme</div>");
  });

  it("falls back to the shipped wordmark when the upload is WebP, unreadable, or has no dimensions", async () => {
    m.getBranding.mockResolvedValue(branding({ customLogo: true }));
    for (const bad of [WEBP, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), null]) {
      vi.setSystemTime((clock += 120_000));
      m.readFile.mockImplementation(async (p: string) => {
        if (p !== "/uploads/logo-custom.png") return SHIPPED;
        if (bad === null) throw new Error("EACCES");
        return bad;
      });
      const b = await buildAlertBrandBlock();
      expect(b.attachment!.content).toBe(SHIPPED);
    }
  });
});

describe("buildAlertBrandBlock — every failure degrades, nothing throws", () => {
  it("sends without letterhead when branding cannot be read", async () => {
    m.getBranding.mockRejectedValue(new Error("db down"));
    await expect(buildAlertBrandBlock()).resolves.toEqual({ html: "", text: "", attachment: null });
  });

  it("drops only the image when even the shipped wordmark is unreadable", async () => {
    m.readFile.mockRejectedValue(new Error("ENOENT"));
    m.getBranding.mockResolvedValue(branding({ subtitle: "NOC" }));
    const b = await buildAlertBrandBlock();
    expect(b.attachment).toBeNull();
    expect(b.html).not.toContain("<img");
    expect(b.html).toContain(">NOC</div>");
    expect(b.text).toBe("NOC");
  });

  it("is the empty block when there is no image, no name and no subtitle", async () => {
    m.readFile.mockRejectedValue(new Error("ENOENT"));
    m.getBranding.mockResolvedValue(branding());
    expect(await buildAlertBrandBlock()).toEqual({ html: "", text: "", attachment: null });
  });
});

describe("buildAlertBrandBlock — the 60 s memo", () => {
  it("reads branding once inside the window and again after it", async () => {
    m.getBranding.mockResolvedValue(branding({ subtitle: "one" }));
    const a = await buildAlertBrandBlock();
    vi.setSystemTime(clock + 59_000);
    m.getBranding.mockResolvedValue(branding({ subtitle: "two" }));
    const b = await buildAlertBrandBlock();
    expect(b).toBe(a);
    expect(m.getBranding).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 61_000);
    const c = await buildAlertBrandBlock();
    expect(m.getBranding).toHaveBeenCalledTimes(2);
    expect(c.text).toContain("two");
  });
});

describe("brandTokensIn / substituteBrandTokens", () => {
  it("finds {brand.header} in any of the templates and skips empties", () => {
    expect([...brandTokensIn(null, undefined, "", "x {brand.header} y")]).toEqual(["brand.header"]);
    expect(brandTokensIn("{brand.footer} {brand}").size).toBe(0);
  });

  it("fills every occurrence, and an empty block removes the token", () => {
    expect(substituteBrandTokens("a{brand.header}b{brand.header}", "X")).toBe("aXbX");
    expect(substituteBrandTokens("a{brand.header}b", "")).toBe("ab");
    expect(substituteBrandTokens("", "X")).toBe("");
  });

  // Was a bug until 2026-11-14: substituteBrandTokens passes the block to String.replace as a
  // replacement STRING, so `$&` / `$'` / `` $` `` in the operator's own
  // subtitle or app name (escapeHtml leaves `$` alone) are expanded. Input:
  // body "<td>{brand.header}</td>", block "Cash $& Carry" → wrong output
  // "<td>Cash {brand.header} Carry</td>"; right output "<td>Cash $& Carry</td>".
  // The same bug was fixed in substitutePushRecipientTokens /
  // substituteEmailRecipientTokens (CQ-T010 batch 6) and is already avoided in
  // substituteProcessTokens / substitutePathGraphTokens (`() => block`).
  it("inserts the block literally, even when it contains $ replacement patterns", () => {
    expect(substituteBrandTokens("<td>{brand.header}</td>", "Cash $& Carry")).toBe("<td>Cash $& Carry</td>");
  });
});
