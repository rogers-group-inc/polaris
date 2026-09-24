/**
 * tests/unit/assetOpenLink.test.ts — the surface-neutral device link and the
 * per-request decision behind it.
 *
 * The bug this pins: the "Open device" link in an alert email named the
 * DESKTOP page outright, and the phone redirect only ever watched "/", so a
 * phone opening the email got the full desktop UI. The link now goes through
 * `/assets/<id>`, which app.ts resolves from the user-agent; these tests cover
 * the pure half of that decision so the route test only has to prove wiring.
 */
import { describe, it, expect } from "vitest";
import {
  PHONE_UA_REGEX,
  isPhoneUserAgent,
  isAssetOpenId,
  assetOpenPath,
  desktopAssetPath,
  mobileAssetPath,
  resolveAssetOpenTarget,
} from "../../src/utils/assetOpenLink.js";

const ID = "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b";

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:129.0) Gecko/20100101 Firefox/129.0",
};

describe("isPhoneUserAgent", () => {
  it("is the same test the root redirect applies — Mobile, iPhone, iPod", () => {
    expect(isPhoneUserAgent(UA.androidChrome)).toBe(true);
    expect(isPhoneUserAgent(UA.iphoneSafari)).toBe(true);
    expect(isPhoneUserAgent("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X)")).toBe(true);
    expect(PHONE_UA_REGEX.source).toBe("(Mobile|iPhone|iPod)");
  });

  it("leaves desktops, iPads and an absent header on the desktop", () => {
    // iPad Safari asks for desktop layouts and the desktop UI fits a tablet.
    expect(isPhoneUserAgent(UA.ipadSafari)).toBe(false);
    expect(isPhoneUserAgent(UA.windowsChrome)).toBe(false);
    expect(isPhoneUserAgent(UA.macFirefox)).toBe(false);
    expect(isPhoneUserAgent(undefined)).toBe(false);
    expect(isPhoneUserAgent(null)).toBe(false);
    expect(isPhoneUserAgent("")).toBe(false);
  });
});

describe("isAssetOpenId", () => {
  it("accepts a UUID in either case and nothing else", () => {
    expect(isAssetOpenId(ID)).toBe(true);
    expect(isAssetOpenId(ID.toUpperCase())).toBe(true);
    for (const junk of ["", "x", "3f2a9c1e", "../login.html", "%2e%2e", ID + "x", undefined, null]) {
      expect(isAssetOpenId(junk)).toBe(false);
    }
  });
});

describe("the three paths", () => {
  it("embed the id, encoded, in the shape each front end routes on", () => {
    expect(assetOpenPath(ID)).toBe(`/assets/${ID}`);
    expect(desktopAssetPath(ID)).toBe(`/assets.html#view=asset:${ID}`);
    expect(mobileAssetPath(ID)).toBe(`/mobile.html#asset/${ID}`);
  });

  it("encode an id they are handed rather than trusting it", () => {
    expect(assetOpenPath("a b/c")).toBe("/assets/a%20b%2Fc");
    expect(mobileAssetPath("a#b")).toBe("/mobile.html#asset/a%23b");
  });
});

describe("resolveAssetOpenTarget", () => {
  it("sends a phone to the mobile SPA's asset detail", () => {
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.androidChrome })).toBe(mobileAssetPath(ID));
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.iphoneSafari })).toBe(mobileAssetPath(ID));
  });

  it("sends everything else to the desktop assets page", () => {
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.windowsChrome })).toBe(desktopAssetPath(ID));
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.ipadSafari })).toBe(desktopAssetPath(ID));
    // No header at all (curl, a mail client's link preview) is a desktop.
    expect(resolveAssetOpenTarget({ id: ID, userAgent: undefined })).toBe(desktopAssetPath(ID));
  });

  it("honours ?desktop=1 on a phone — the SPA's own Desktop view escape hatch", () => {
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.iphoneSafari, desktop: "1" })).toBe(desktopAssetPath(ID));
    // Only the exact value the root redirect accepts; anything else is not an opt-out.
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.iphoneSafari, desktop: "true" })).toBe(mobileAssetPath(ID));
    expect(resolveAssetOpenTarget({ id: ID, userAgent: UA.iphoneSafari, desktop: ["1"] })).toBe(mobileAssetPath(ID));
  });

  it("refuses to redirect on anything that is not an asset id", () => {
    expect(resolveAssetOpenTarget({ id: "../login.html", userAgent: UA.iphoneSafari })).toBeNull();
    expect(resolveAssetOpenTarget({ id: "", userAgent: UA.windowsChrome })).toBeNull();
    expect(resolveAssetOpenTarget({ id: undefined, userAgent: UA.windowsChrome })).toBeNull();
  });
});
