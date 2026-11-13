/**
 * tests/unit/monitorSettings.test.ts — own suite for
 * services/monitoring/monitorSettings.ts (CQ-T010).
 *
 * Complements, does not repeat:
 *   - resolveMonitorSettings.test.ts — the four-tier resolver, class overrides,
 *     per-asset overrides, caching, provenance labels, fleetCadences
 *   - sdwanCadence.test.ts — sdwanIntervalFromConfig
 *   - defaultPollingProxyAware / workloadPollingDefaults — defaultPollingForSource
 *   - snmpPollingCredential / pollingCompatibility / probes — resolveSnmpConfigForStream
 *
 * Unreached until now: getAdMonitorProtocol (the AD-lock policy), the
 * credential chain helpers (loadClassOverrideStreamCredential,
 * resolveAgentlessCredConfig with its AD bind fallback,
 * loadSnmpCredentialConfigForFortinetAsset's refusals, the class-tier step of
 * resolveSnmpConfigForStream), winrmConnFrom, the integration tier's
 * side-effects — the SD-WAN sidecar resolveSdwanIntervalSec reads (and the
 * FMG proxy-without-token case that has no REST path), the system-info cadence
 * derived from the discovery pollInterval and its clamp — the scoped cache
 * invalidation of that sidecar, and resolveCurrentStateIntervalSec.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getAdMonitorProtocol,
  loadClassOverrideStreamCredential,
  resolveSnmpConfigForStream,
  resolveAgentlessCredConfig,
  winrmConnFrom,
  loadSnmpCredentialConfigForFortinetAsset,
  resolveMonitorSettings,
  resolveSdwanIntervalSec,
  invalidateMonitorSettingsCache,
  resolveCurrentStateIntervalSec,
  HARDCODED_FLOOR,
  COLLECTOR_REQUEST_TIMEOUT_MS,
  sysUpTimeOid,
} from "../../src/services/monitoring/monitorSettings.js";

beforeEach(() => {
  resetDbStub();
  invalidateMonitorSettingsCache();
  stubbed(prisma.monitorClassOverride.findFirst).mockResolvedValue(null);
  stubbed(prisma.setting.findUnique).mockResolvedValue(null);
});

describe("constants", () => {
  it("collectors fail fast per request; the probe OID is sysUpTime.0", () => {
    expect(COLLECTOR_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(sysUpTimeOid).toBe("1.3.6.1.2.1.1.3.0");
    expect(HARDCODED_FLOOR).toMatchObject({ intervalSeconds: 60, failureThreshold: 3, probeTimeoutMs: 5000 });
  });
});

describe("getAdMonitorProtocol", () => {
  it("locks Windows to WinRM and Linux to SSH, anything else unlocked", () => {
    expect(getAdMonitorProtocol("Windows Server 2022 Datacenter")).toBe("winrm");
    expect(getAdMonitorProtocol("WINDOWS 11 Enterprise")).toBe("winrm");
    expect(getAdMonitorProtocol("Red Hat Enterprise Linux 9")).toBe("ssh");
    expect(getAdMonitorProtocol("macOS 15")).toBeNull();
    expect(getAdMonitorProtocol("")).toBeNull();
    expect(getAdMonitorProtocol(null)).toBeNull();
    expect(getAdMonitorProtocol(undefined)).toBeNull();
  });
});

// ─── credential chain ───────────────────────────────────────────────────────

describe("loadClassOverrideStreamCredential", () => {
  it("returns the credential only when it exists and is of the type the method needs", async () => {
    expect(await loadClassOverrideStreamCredential(null, "snmp")).toBeNull();
    expect(prisma.credential.findUnique).not.toHaveBeenCalled();

    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    expect(await loadClassOverrideStreamCredential("gone", "snmp")).toBeNull();

    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "c", type: "ssh", config: {} });
    expect(await loadClassOverrideStreamCredential("c", "snmp")).toBeNull();
    expect(await loadClassOverrideStreamCredential("c", "ssh")).toMatchObject({ type: "ssh" });
  });
});

describe("resolveSnmpConfigForStream", () => {
  it("falls from the asset's stream credential to the class-tier credential", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "cls", type: "snmp", config: { community: "class" } });
    const r = await resolveSnmpConfigForStream({ type: "winrm", config: {} }, "cls", false, null);
    expect(r).toEqual({ cfg: { community: "class" } });
  });

  it("names the error label when no tier supplies SNMP and the source is not Fortinet", async () => {
    const r = await resolveSnmpConfigForStream(null, null, false, { config: { monitorCredentialId: "x" } }, "No SNMP credential for LLDP");
    expect(r).toEqual({ error: "No SNMP credential for LLDP" });
  });
});

describe("loadSnmpCredentialConfigForFortinetAsset", () => {
  it("uses the asset's own SNMP credential first", async () => {
    expect(await loadSnmpCredentialConfigForFortinetAsset({ type: "snmp", config: { community: "a" } }, null)).toEqual({ community: "a" });
    expect(await loadSnmpCredentialConfigForFortinetAsset({ type: "snmp", config: null }, null)).toEqual({});
  });

  it("falls back to the integration's monitor credential", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "m", type: "snmp", config: { version: "v3" } });
    expect(await loadSnmpCredentialConfigForFortinetAsset(null, { config: { monitorCredentialId: "m" } })).toEqual({ version: "v3" });
  });

  it("refuses with a reason an operator can act on", async () => {
    await expect(loadSnmpCredentialConfigForFortinetAsset(null, { config: {} })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(loadSnmpCredentialConfigForFortinetAsset(null, null)).rejects.toMatchObject({ httpStatus: 409 });
    stubbed(prisma.credential.findUnique).mockResolvedValue(null);
    await expect(loadSnmpCredentialConfigForFortinetAsset(null, { config: { monitorCredentialId: "m" } })).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "m", type: "winrm", config: {} });
    await expect(loadSnmpCredentialConfigForFortinetAsset(null, { config: { monitorCredentialId: "m" } }))
      .rejects.toThrow('must be SNMP (got "winrm")');
  });
});

describe("resolveAgentlessCredConfig", () => {
  const ad = { type: "activedirectory", config: { bindDn: "svc@corp", bindPassword: "pw" } };

  it("the stream's own credential of the right method wins", async () => {
    expect(await resolveAgentlessCredConfig({ type: "ssh", config: { username: "u" } }, "cls", "ssh", ad)).toEqual({ username: "u" });
    expect(prisma.credential.findUnique).not.toHaveBeenCalled();
  });

  it("then the class-tier credential", async () => {
    stubbed(prisma.credential.findUnique).mockResolvedValue({ id: "cls", type: "winrm", config: { username: "cls" } });
    expect(await resolveAgentlessCredConfig({ type: "ssh", config: {} }, "cls", "winrm", ad)).toEqual({ username: "cls" });
  });

  it("then the AD bind account — WinRM over HTTPS 5986, SSH on 22", async () => {
    expect(await resolveAgentlessCredConfig(null, null, "winrm", ad)).toEqual({ username: "svc@corp", password: "pw", useHttps: true, port: 5986 });
    expect(await resolveAgentlessCredConfig(null, null, "ssh", ad)).toEqual({ username: "svc@corp", password: "pw", port: 22 });
  });

  it("is null with no usable tier: not AD, or an AD integration missing half its bind", async () => {
    expect(await resolveAgentlessCredConfig(null, null, "ssh", { type: "fortigate", config: { bindDn: "a", bindPassword: "b" } })).toBeNull();
    expect(await resolveAgentlessCredConfig(null, null, "ssh", { type: "activedirectory", config: { bindDn: "a" } })).toBeNull();
    expect(await resolveAgentlessCredConfig(null, null, "ssh", null)).toBeNull();
  });
});

describe("winrmConnFrom", () => {
  it("projects the credential, HTTPS unless refused, TLS verify only when asked, a 30 s floor", () => {
    expect(winrmConnFrom("h", { username: "u", password: "p" }, 5000)).toEqual({
      host: "h", username: "u", password: "p", useHttps: true, port: undefined, verifyTls: false, timeoutMs: 30_000,
    });
    expect(winrmConnFrom("h", { useHttps: false, port: 5985, verifyTls: true }, 60_000)).toMatchObject({
      username: "", password: "", useHttps: false, port: 5985, verifyTls: true, timeoutMs: 60_000,
    });
    expect(winrmConnFrom("h", { port: "5986" }, 1).port).toBeUndefined();
  });
});

// ─── integration-tier side effects ──────────────────────────────────────────

const fw = (integrationId: string | null, type: string | null, assetType = "firewall") => ({
  assetType, discoveredByIntegrationId: integrationId, discoveredByIntegrationType: type,
} as Parameters<typeof resolveMonitorSettings>[0]);

describe("resolveSdwanIntervalSec — the sidecar the tier load fills", () => {
  it("reads the armed interval after a resolve, per (integration, class)", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: null, config: { pullSdwan: true, sdwanIntervalSeconds: 300 } });
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g1", assetType: "firewall" })).toBeNull(); // cold
    await resolveMonitorSettings(fw("g1", "fortigate"));
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g1", assetType: "firewall" })).toBe(300);
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g1", assetType: "switch" })).toBeNull();
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: null, assetType: "firewall" })).toBeNull();
  });

  it("an FMG on proxy with no FortiGate token has no REST path, so no SD-WAN cadence", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortimanager", pollInterval: null, config: { pullSdwan: true } });
    await resolveMonitorSettings(fw("m1", "fortimanager"));
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "m1", assetType: "firewall" })).toBeNull();
  });

  it("the same FMG with a token (or off proxy) gets the default 60 s", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortimanager", pollInterval: null, config: { pullSdwan: true, fortigateApiToken: "t" } });
    await resolveMonitorSettings(fw("m2", "fortimanager"));
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "m2", assetType: "firewall" })).toBe(60);
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortimanager", pollInterval: null, config: { pullSdwan: true, useProxy: false } });
    await resolveMonitorSettings(fw("m3", "fortimanager"));
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "m3", assetType: "firewall" })).toBe(60);
  });

  it("is dropped by a scoped invalidation of that integration, kept for another", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: null, config: { pullSdwan: true } });
    await resolveMonitorSettings(fw("g1", "fortigate"));
    await resolveMonitorSettings(fw("g2", "fortigate"));
    invalidateMonitorSettingsCache({ integrationId: "g1" });
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g1", assetType: "firewall" })).toBeNull();
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g2", assetType: "firewall" })).toBe(60);
    invalidateMonitorSettingsCache({ integrationId: "g2", assetType: "firewall" });
    expect(resolveSdwanIntervalSec({ discoveredByIntegrationId: "g2", assetType: "firewall" })).toBeNull();
  });
});

describe("integration tier — system-info cadence from the discovery pollInterval", () => {
  it("derives it from pollInterval hours when the tier does not set one, clamped to a day", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: 4, config: {} });
    expect((await resolveMonitorSettings(fw("p4", "fortigate"))).systemInfoIntervalSeconds).toBe(14_400);
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: 48, config: {} });
    expect((await resolveMonitorSettings(fw("p48", "fortigate"))).systemInfoIntervalSeconds).toBe(86_400);
  });

  it("an explicit tier value wins over the derivation", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({
      type: "fortigate", pollInterval: 4, config: { monitorSettings: { systemInfoIntervalSeconds: 900 } },
    });
    expect((await resolveMonitorSettings(fw("px", "fortigate"))).systemInfoIntervalSeconds).toBe(900);
  });

  it("loads each (integration, class) once until invalidated", async () => {
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: null, config: {} });
    await resolveMonitorSettings(fw("c1", "fortigate"));
    await resolveMonitorSettings(fw("c1", "fortigate"));
    expect(prisma.integration.findUnique).toHaveBeenCalledTimes(1);
    invalidateMonitorSettingsCache({ integrationId: "c1" });
    await resolveMonitorSettings(fw("c1", "fortigate"));
    expect(prisma.integration.findUnique).toHaveBeenCalledTimes(2);
  });
});

// ─── resolveCurrentStateIntervalSec ─────────────────────────────────────────

describe("resolveCurrentStateIntervalSec", () => {
  const asset = (over: Record<string, unknown> = {}) => ({
    id: "a1", assetType: "firewall", monitored: true, status: "active", discoveredByIntegrationId: "g1",
    monitorOverride: null, discoveredByIntegration: { type: "fortigate", pollInterval: 12 }, ...over,
  });

  it("is null for a missing asset", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    expect(await resolveCurrentStateIntervalSec("x", { discoveryFallback: true })).toBeNull();
  });

  it("a monitored device is refreshed at its resolved system-info cadence", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    stubbed(prisma.integration.findUnique).mockResolvedValue({ type: "fortigate", pollInterval: null, config: { monitorSettings: { systemInfoIntervalSeconds: 600 } } });
    expect(await resolveCurrentStateIntervalSec("a1", { discoveryFallback: true })).toBe(600);
  });

  it("an unmonitored or retired device is refreshed only by discovery — when that table has a discovery writer", async () => {
    for (const over of [{ monitored: false }, { status: "decommissioned" }, { status: "disabled" }]) {
      stubbed(prisma.asset.findUnique).mockResolvedValue(asset(over));
      expect(await resolveCurrentStateIntervalSec("a1", { discoveryFallback: true })).toBe(12 * 3600);
      expect(await resolveCurrentStateIntervalSec("a1", { discoveryFallback: false })).toBeNull();
    }
    expect(prisma.integration.findUnique).not.toHaveBeenCalled();
  });

  it("a resolver failure falls back to the discovery figure rather than throwing", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    stubbed(prisma.integration.findUnique).mockRejectedValue(new Error("db down"));
    expect(await resolveCurrentStateIntervalSec("a1", { discoveryFallback: true })).toBe(43_200);
  });
});
