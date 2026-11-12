/**
 * tests/unit/releaseDhcpLease.test.ts — the DHCP lease release sends the verb
 * FortiOS actually exposes, on both transports.
 *
 * Established on a FortiOS 7.6.8 lab gate (2026-11-03) after an operator
 * reported that revoking a lease "doesn't appear to work":
 *
 *   POST /api/v2/monitor/system/dhcp/release-lease  {ip: "x"}  → 404 "Endpoint not found"
 *   POST /api/v2/monitor/system/dhcp/revoke         {ip: ["x"]} → 200 {status: "success"}
 *
 * The first is the path Polaris had shipped since the feature landed; the
 * second is the only lease-revoke verb FortiOS has. Because the release is
 * best-effort by design, the 404 never surfaced further than a
 * `reservation.lease_release.failed` warning Event, so the Polaris row was
 * freed while the gate kept the lease — exactly the symptom reported.
 *
 * The device is faked one layer down, at `fgRequest` / `fmgProxyRest`, so the
 * transport dispatch in `callFortiOs` runs for real and both transports are
 * pinned to the same path and body shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fgRequest = vi.hoisted(() => vi.fn());
const fmgProxyRest = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest }));
vi.mock("../../src/services/fortimanagerService.js", () => ({
  fmgProxyRest,
  resolveDeviceMgmtIpViaFmg: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());

const { releaseDhcpLease, DHCP_LEASE_REVOKE_PATH } = await import(
  "../../src/services/reservationPushService.js"
);

const fortigateIntegration = {
  id: "int-fg",
  type: "fortigate",
  config: { host: "192.0.2.1", apiUser: "polaris_api", apiToken: "t", vdom: "root" },
};

const fmgProxyIntegration = {
  id: "int-fmg",
  type: "fortimanager",
  config: { host: "192.0.2.2", apiUser: "u", apiToken: "t", adom: "root", useProxy: true },
};

beforeEach(() => {
  fgRequest.mockReset();
  fmgProxyRest.mockReset();
  fgRequest.mockResolvedValue({ status: "success" });
  fmgProxyRest.mockResolvedValue({ status: "success" });
});

describe("releaseDhcpLease — the FortiOS verb", () => {
  it("is dhcp/revoke, never a path FortiOS does not have", () => {
    expect(DHCP_LEASE_REVOKE_PATH).toBe("/api/v2/monitor/system/dhcp/revoke");
    expect(DHCP_LEASE_REVOKE_PATH).not.toContain("release-lease");
  });

  it("standalone FortiGate: POSTs dhcp/revoke with the IP as a one-element array", async () => {
    const r = await releaseDhcpLease({
      integration: fortigateIntegration,
      deviceName: "HUB1-a",
      ip: "10.1.2.3",
    });
    expect(r).toEqual({ released: true });
    expect(fmgProxyRest).not.toHaveBeenCalled();
    expect(fgRequest).toHaveBeenCalledTimes(1);
    const [, method, path, opts] = fgRequest.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/api/v2/monitor/system/dhcp/revoke");
    expect(opts.body).toEqual({ ip: ["10.1.2.3"] });
    expect(opts.query).toEqual({ vdom: "root" });
  });

  it("FortiManager proxy: the same path and body go through the proxy with the vdom on the resource", async () => {
    const r = await releaseDhcpLease({
      integration: fmgProxyIntegration,
      deviceName: "branch-fw",
      ip: "10.1.2.3",
    });
    expect(r).toEqual({ released: true });
    expect(fgRequest).not.toHaveBeenCalled();
    expect(fmgProxyRest).toHaveBeenCalledTimes(1);
    const [, deviceName, method, resource, opts] = fmgProxyRest.mock.calls[0];
    expect(deviceName).toBe("branch-fw");
    expect(method).toBe("POST");
    expect(resource).toBe("/api/v2/monitor/system/dhcp/revoke?vdom=root");
    expect(opts.body).toEqual({ ip: ["10.1.2.3"] });
  });

  it("never sends a revoke without a valid IP — an empty list would revoke every lease", async () => {
    await expect(
      releaseDhcpLease({ integration: fortigateIntegration, deviceName: "HUB1-a", ip: "" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      releaseDhcpLease({ integration: fortigateIntegration, deviceName: "HUB1-a", ip: "not-an-ip" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(fgRequest).not.toHaveBeenCalled();
    expect(fmgProxyRest).not.toHaveBeenCalled();
  });

  it("refuses without a device name before any transport call", async () => {
    await expect(
      releaseDhcpLease({ integration: fortigateIntegration, deviceName: "", ip: "10.1.2.3" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(fgRequest).not.toHaveBeenCalled();
  });

  it("propagates a device-side failure so the caller can record lease_release.failed", async () => {
    fgRequest.mockRejectedValueOnce(new Error("Endpoint not found: /api/v2/monitor/system/dhcp/revoke"));
    await expect(
      releaseDhcpLease({ integration: fortigateIntegration, deviceName: "HUB1-a", ip: "10.1.2.3" }),
    ).rejects.toThrow(/Endpoint not found/);
  });
});
