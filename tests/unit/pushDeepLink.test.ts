import { describe, it, expect, afterEach } from "vitest";
import { pushDeepLinkUrl, normalizePushSurface, PUSH_DEEP_LINK_PATHS, assetPageUrl, assetUrlForPush } from "../../src/utils/notificationTemplate.js";

const ORIGINAL = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = ORIGINAL;
});

describe("normalizePushSurface", () => {
  it("only ever yields a known surface", () => {
    expect(normalizePushSurface("mobile")).toBe("mobile");
    expect(normalizePushSurface("desktop")).toBe("desktop");
    // Anything unrecognized (pre-upgrade rows, absent meta, junk) is desktop —
    // that's where the only enrollment UI used to live.
    for (const junk of [undefined, null, "", "MOBILE", "phone", 7, {}]) {
      expect(normalizePushSurface(junk)).toBe("desktop");
    }
  });
});

describe("pushDeepLinkUrl", () => {
  it("sends a mobile subscription to the mobile alerts screen", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(pushDeepLinkUrl("mobile")).toBe("https://polaris.example.com/mobile.html#more/alerts");
  });

  it("sends a desktop subscription to the Automations page", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(pushDeepLinkUrl("desktop")).toBe("https://polaris.example.com/automations.html");
  });

  it("strips a trailing slash on the public URL", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(pushDeepLinkUrl("mobile")).toBe("https://polaris.example.com/mobile.html#more/alerts");
  });

  it("falls back to a RELATIVE path when POLARIS_PUBLIC_URL is unset", () => {
    // Never null, unlike notificationsPageUrl. This is what stops an unset
    // public URL from routing every push to the service worker's hardcoded
    // desktop fallback regardless of surface.
    delete process.env.POLARIS_PUBLIC_URL;
    expect(pushDeepLinkUrl("mobile")).toBe("/mobile.html#more/alerts");
    expect(pushDeepLinkUrl("desktop")).toBe("/automations.html");
  });

  it("never returns null or empty for any input", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    for (const junk of [undefined, null, "", "nonsense"]) {
      expect(pushDeepLinkUrl(junk)).toBe(PUSH_DEEP_LINK_PATHS.desktop);
    }
  });
});

// The "Open device" link — the email's button / {asset.link}, and the push
// tray's action. Both name the SURFACE-NEUTRAL landing route, never a front
// end: the message is composed once for every reader, and which UI fits is
// only known when the link is opened (app.ts resolves it from the user-agent).
describe("assetPageUrl (email)", () => {
  it("is the /assets/<id> landing route under the public URL", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(assetPageUrl("a1")).toBe("https://polaris.example.com/assets/a1");
    expect(assetPageUrl("a1")).not.toContain("assets.html");
    expect(assetPageUrl("a1")).not.toContain("mobile.html");
  });

  it("is null without a public URL or an asset — an email cannot resolve a relative path", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(assetPageUrl("a1")).toBeNull();
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(assetPageUrl(null)).toBeNull();
    expect(assetPageUrl(undefined)).toBeNull();
  });
});

describe("assetUrlForPush", () => {
  it("is the same landing route, absolute when it can be", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(assetUrlForPush("a1")).toBe("https://polaris.example.com/assets/a1");
  });

  it("falls back to the RELATIVE landing path without a public URL — the worker resolves it", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(assetUrlForPush("a1")).toBe("/assets/a1");
  });

  it("is null for an alert with no asset, so the tray button disappears", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(assetUrlForPush(null)).toBeNull();
    expect(assetUrlForPush(undefined)).toBeNull();
    expect(assetUrlForPush("")).toBeNull();
  });
});
