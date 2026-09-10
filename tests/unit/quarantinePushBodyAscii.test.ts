/**
 * tests/unit/quarantinePushBodyAscii.test.ts — what Polaris writes into a
 * FortiOS config field stays printable ASCII, and a refused write says why.
 *
 * Two findings from a production quarantine push that failed with nothing but
 * "Quarantine failed: 0/1 FortiGate(s) accepted the push. First error:
 * FortiGate returned HTTP 500":
 *
 *   1. The target description was built with an em dash (U+2014) from the day
 *      the service shipped, and the per-MAC description carries the asset
 *      hostname as typed — so a push could put non-ASCII bytes into a device
 *      config string. A rejected write costs an operator a security action:
 *      pushQuarantineToFortigate rolls the new target back and the asset never
 *      reaches `quarantined`. Descriptions are Polaris's own phrasing, so
 *      keeping them ASCII gives up nothing.
 *
 *   2. `fgRequest` discarded the response body on a non-2xx, so FortiOS's own
 *      `error` code and `cli_error` text — the part that distinguishes a
 *      rejected field from an unsupported table — never reached the operator,
 *      the Event details or the log. The FMG-proxy path had always relayed the
 *      device's message, so the DIRECT transport was the blind one.
 *
 * These do not assert that either was the cause of that 500 — the point is that
 * the next one is diagnosable and the payload holds no bytes worth suspecting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asciiForDevice } from "../../src/services/assetQuarantineService.js";
import { fgRequest } from "../../src/services/fortigateService.js";

// The FortiManager/FortiGate transports call `tlsFetch` — undici's own fetch
// paired with its own dispatcher, because a dispatcher is only valid to the
// undici copy that created it (see src/utils/tlsDispatcher.ts). Route it back
// to the global fetch so this file keeps stubbing that one seam. The real
// pairing is exercised unmocked, against a live local server, in
// tests/unit/tlsDispatcher.test.ts — mocking it here is what let the
// undici 6 -> 8 skew reach production unnoticed.
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

describe("asciiForDevice", () => {
  it("turns the dashes Polaris authors into a hyphen", () => {
    expect(asciiForDevice("Polaris asset quarantine — user:dmoore")).toBe(
      "Polaris asset quarantine - user:dmoore",
    );
    expect(asciiForDevice("a – b")).toBe("a - b");
  });

  it("leaves ordinary ASCII exactly as it was", () => {
    const s = "Polaris/user:dmoore: WKS-1234 (front desk) #2 [floor 3] 50%";
    expect(asciiForDevice(s)).toBe(s);
  });

  it("collapses a non-ASCII run to one space instead of dropping it", () => {
    // Dropping silently would join two words into one and read as a typo.
    expect(asciiForDevice("BureauéèêName")).toBe("Bureau Name");
  });

  it("never returns leading or trailing filler", () => {
    expect(asciiForDevice("  HOST  ")).toBe("HOST");
  });

  it("can return empty, which every caller has to handle", () => {
    // A hostname made entirely of non-ASCII has no ASCII rendering; the caller
    // substitutes its own fallback rather than sending "".
    expect(asciiForDevice("你好")).toBe("");
  });

  it("strips control characters, not just non-ASCII", () => {
    // A NUL or a bell inside a CMDB string is its own kind of trouble.
    expect(asciiForDevice("a\u0000\u0007b")).toBe("a b");
    expect(asciiForDevice("a\tb")).toBe("a b");
    expect(asciiForDevice("line\nbreak")).toBe("line break");
  });
});

describe("the quarantine push body carries no non-ASCII", () => {
  // Guards the two description fields at their source rather than through a
  // transport mock: both are pure string builders.
  it("the source no longer authors an em dash into a CMDB write", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../../src/services/assetQuarantineService.ts"), "utf8");
    // Only the lines that build a value SENT to the device — comments in this
    // file are prose and keep their typography.
    const sent = src
      .split(/\r?\n/)
      .filter((l) => /description:\s|const candidate =/.test(l) && !l.trim().startsWith("*") && !l.trim().startsWith("//"));
    expect(sent.length).toBeGreaterThan(0);
    for (const line of sent) {
      expect([...line].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
    }
  });
});

describe("fgRequest surfaces the FortiOS error body", () => {
  const config = { host: "10.0.0.1", port: 443, apiToken: "t", verifySsl: false } as any;
  let fetchMock: ReturnType<typeof vi.fn>;

  const mock = (status: number, body: unknown, asText?: string) => {
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (asText !== undefined ? asText : JSON.stringify(body)),
    } as any);
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the HTTP status prefix classifyPushError reads", async () => {
    mock(500, { http_status: 500, status: "error", error: -651 });
    await expect(fgRequest(config, "POST", "/api/v2/cmdb/user/quarantine/targets", { body: {} } as any))
      .rejects.toThrow(/FortiGate returned HTTP 500/);
  });

  it("names the path the write was refused on", async () => {
    mock(500, { error: -651 });
    await expect(fgRequest(config, "POST", "/api/v2/cmdb/user/quarantine/targets"))
      .rejects.toThrow(/\/api\/v2\/cmdb\/user\/quarantine\/targets/);
  });

  it("relays cli_error, which is the actual answer", async () => {
    mock(500, { http_status: 500, error: -651, cli_error: "entry not found in datasource" });
    await expect(fgRequest(config, "POST", "/api/v2/cmdb/user/quarantine/targets"))
      .rejects.toThrow(/entry not found in datasource/);
  });

  it("always keeps the numeric CLI code, the part Fortinet docs are indexed by", async () => {
    mock(500, { error: -651 });
    await expect(fgRequest(config, "POST", "/api/v2/cmdb/x")).rejects.toThrow(/FortiOS error -651/);
  });

  it("survives a body that is not JSON at all", async () => {
    // Something in front of the gate answering with an HTML error page must not
    // turn a device error into a parse error.
    mock(502, null, "<html><head><title>502 Bad Gateway</title></head>\n<body>nginx</body></html>");
    const err = await fgRequest(config, "GET", "/api/v2/cmdb/x").catch((e) => e);
    expect(err.message).toMatch(/FortiGate returned HTTP 502/);
    expect(err.message).toMatch(/502 Bad Gateway/);
    expect(err.message.length).toBeLessThan(400);
  });

  it("adds nothing when the body is empty", async () => {
    mock(500, null, "");
    const err = await fgRequest(config, "GET", "/api/v2/cmdb/x").catch((e) => e);
    expect(err.message).toBe("FortiGate returned HTTP 500 for /api/v2/cmdb/x");
  });

  it("does not disturb the 401 / 403 / 404 messages", async () => {
    // These are deliberately prescriptive and are asserted in
    // fgRequestStatusMapping.test.ts; the detail suffix is for the generic path.
    mock(401, { error: -1 });
    await expect(fgRequest(config, "GET", "/api/v2/cmdb/x")).rejects.toThrow(/check your API token/);
    mock(403, { error: -1 });
    await expect(fgRequest(config, "GET", "/api/v2/cmdb/x")).rejects.toThrow(/access profile/);
    mock(404, { error: -1 });
    await expect(fgRequest(config, "GET", "/api/v2/cmdb/x")).rejects.toThrow(/^Endpoint not found: \/api\/v2\/cmdb\/x$/);
  });
});
