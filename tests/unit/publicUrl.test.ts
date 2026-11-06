/**
 * tests/unit/publicUrl.test.ts
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getPublicUrlPort, getPublicApiBaseUrl, deriveNginxServerName, derivePolarisPort, publicBaseUrl } from "../../src/utils/publicUrl.js";
import { ackUrlForEmail, ackUrlForPush, notificationsPageUrl, assetPageUrl, pushDeepLinkUrl } from "../../src/utils/notificationTemplate.js";

const savedPublicUrl = process.env.POLARIS_PUBLIC_URL;
const savedPort = process.env.PORT;

beforeEach(() => {
  delete process.env.POLARIS_PUBLIC_URL;
  delete process.env.PORT;
});

afterAll(() => {
  if (savedPublicUrl === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = savedPublicUrl;
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;
});

describe("getPublicUrlPort", () => {
  it("returns null when unset", () => {
    expect(getPublicUrlPort()).toBeNull();
  });
  it("returns the explicit port", () => {
    process.env.POLARIS_PUBLIC_URL = "https://x.example.com:8443";
    expect(getPublicUrlPort()).toBe(8443);
  });
  it("defaults https to 443 and http to 80", () => {
    process.env.POLARIS_PUBLIC_URL = "https://x.example.com";
    expect(getPublicUrlPort()).toBe(443);
    process.env.POLARIS_PUBLIC_URL = "http://x.example.com";
    expect(getPublicUrlPort()).toBe(80);
  });
  it("returns null on a malformed URL", () => {
    process.env.POLARIS_PUBLIC_URL = "not a url";
    expect(getPublicUrlPort()).toBeNull();
  });
});

describe("getPublicApiBaseUrl", () => {
  it("returns null when unset or malformed", () => {
    expect(getPublicApiBaseUrl()).toBeNull();
    process.env.POLARIS_PUBLIC_URL = "not a url";
    expect(getPublicApiBaseUrl()).toBeNull();
  });
  it("appends /api/v1 to the origin", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(getPublicApiBaseUrl()).toBe("https://polaris.example.com/api/v1");
  });
  it("keeps an explicit port and drops any path", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.corp.example:8443/some/base/";
    expect(getPublicApiBaseUrl()).toBe("https://polaris.corp.example:8443/api/v1");
  });
});

describe("deriveNginxServerName", () => {
  it("uses POLARIS_PUBLIC_URL's hostname", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.corp.example:8443/base";
    expect(deriveNginxServerName()).toBe("polaris.corp.example");
  });
  it("falls back to the placeholder when unset or malformed", () => {
    expect(deriveNginxServerName()).toBe("polaris.example.com");
    process.env.POLARIS_PUBLIC_URL = "not a url";
    expect(deriveNginxServerName()).toBe("polaris.example.com");
  });
});

describe("derivePolarisPort", () => {
  it("defaults to 3000 when PORT is unset", () => {
    expect(derivePolarisPort()).toBe(3000);
  });
  it("uses a valid PORT", () => {
    process.env.PORT = "8080";
    expect(derivePolarisPort()).toBe(8080);
  });
  it("falls back to 3000 on junk or out-of-range values", () => {
    for (const bad of ["abc", "0", "-1", "70000", "3.5"]) {
      process.env.PORT = bad;
      expect(derivePolarisPort()).toBe(3000);
    }
  });
});

describe("publicBaseUrl", () => {
  it("is null when unset, empty, blank or only slashes", () => {
    expect(publicBaseUrl()).toBeNull();
    process.env.POLARIS_PUBLIC_URL = "";
    expect(publicBaseUrl()).toBeNull();
    process.env.POLARIS_PUBLIC_URL = "   ";
    expect(publicBaseUrl()).toBeNull();
    process.env.POLARIS_PUBLIC_URL = "///";
    expect(publicBaseUrl()).toBeNull();
  });

  it("trims whitespace and EVERY trailing slash, keeping a path", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(publicBaseUrl()).toBe("https://polaris.example.com");
    process.env.POLARIS_PUBLIC_URL = " https://polaris.example.com// \n";
    expect(publicBaseUrl()).toBe("https://polaris.example.com");
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com:8443/ipam/";
    expect(publicBaseUrl()).toBe("https://polaris.example.com:8443/ipam");
  });

  it("re-reads the variable on every call", () => {
    process.env.POLARIS_PUBLIC_URL = "https://a.example.com";
    expect(publicBaseUrl()).toBe("https://a.example.com");
    process.env.POLARIS_PUBLIC_URL = "https://b.example.com";
    expect(publicBaseUrl()).toBe("https://b.example.com");
  });
});

// The bug the shared normaliser closed (CQ-B042, 2026-11-06): the link
// builders stripped ONE trailing slash and no whitespace while OIDC stripped
// both, so a value that signed people in fine mailed broken links.
describe("alert links use the normalised base", () => {
  it("a stray space or doubled slash no longer breaks emailed and pushed links", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com// ";
    expect(ackUrlForEmail("n1")).toBe("https://polaris.example.com/alert-ack.html?id=n1");
    expect(ackUrlForPush("n1")).toBe("https://polaris.example.com/alert-ack.html?id=n1");
    expect(notificationsPageUrl()).toBe("https://polaris.example.com/automations.html");
    expect(assetPageUrl("a1")).toMatch(/^https:\/\/polaris\.example\.com\/[^/]/);
    expect(pushDeepLinkUrl("mobile")).toBe("https://polaris.example.com/mobile.html#alerts");
  });

  it("a blank value behaves as unset: email links null, push links relative", () => {
    process.env.POLARIS_PUBLIC_URL = "  ";
    expect(ackUrlForEmail("n1")).toBeNull();
    expect(notificationsPageUrl()).toBeNull();
    expect(ackUrlForPush("n1")).toBe("/alert-ack.html?id=n1");
  });
});
