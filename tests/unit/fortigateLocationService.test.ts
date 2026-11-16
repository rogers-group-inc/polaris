/**
 * tests/unit/fortigateLocationService.test.ts — sysLocation over FortiOS REST
 * during discovery. Returns the trimmed, whitespace-collapsed location or null;
 * never throws (a transport failure is a warn and a null).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ build: vi.fn(), call: vi.fn(), warn: vi.fn() }));

vi.mock("../../src/services/reservationPushService.js", () => ({
  buildTransportForIntegration: h.build,
  callFortiOs: h.call,
}));
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { fetchFortigateSysLocation } from "../../src/services/fortigateLocationService.js";

const INTEGRATION = { id: "int-1", type: "fortimanager", config: {} };
const fetchIt = () => fetchFortigateSysLocation({ integration: INTEGRATION, deviceName: "FGT-BR01" });

beforeEach(() => {
  h.build.mockReset();
  h.call.mockReset();
  h.warn.mockReset();
  h.build.mockResolvedValue({ kind: "transport" });
});

describe("fetchFortigateSysLocation", () => {
  it("builds the integration's transport for the device and GETs the SNMP sysinfo block", async () => {
    h.call.mockResolvedValue({ location: "Nashville DC" });
    expect(await fetchIt()).toBe("Nashville DC");
    expect(h.build).toHaveBeenCalledWith(INTEGRATION, "FGT-BR01");
    expect(h.call).toHaveBeenCalledWith({ kind: "transport" }, "GET", "/api/v2/cmdb/system.snmp/sysinfo");
  });

  it("collapses inner whitespace and trims", async () => {
    h.call.mockResolvedValue({ location: "  Bldg 4,\n  Floor 2\t Rack 7 " });
    expect(await fetchIt()).toBe("Bldg 4, Floor 2 Rack 7");
  });

  it("accepts the block wrapped in an array", async () => {
    h.call.mockResolvedValue([{ location: "Wrapped" }]);
    expect(await fetchIt()).toBe("Wrapped");
  });

  it("is null for an empty, blank, missing or non-string location, and for an empty array", async () => {
    for (const result of [{ location: "" }, { location: "   " }, {}, { location: 42 }, [], null, undefined]) {
      h.call.mockResolvedValue(result);
      expect(await fetchIt()).toBeNull();
    }
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("is null and a warning when the transport cannot be built or the call fails — never a throw", async () => {
    h.build.mockRejectedValue(new Error("no token"));
    expect(await fetchIt()).toBeNull();
    h.build.mockResolvedValue({});
    h.call.mockRejectedValue(new Error("HTTP 404"));
    expect(await fetchIt()).toBeNull();
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.warn.mock.calls[1][0]).toMatchObject({ integrationId: "int-1", deviceName: "FGT-BR01", err: "HTTP 404" });
  });
});
