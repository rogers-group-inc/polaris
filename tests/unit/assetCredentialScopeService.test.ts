/**
 * tests/unit/assetCredentialScopeService.test.ts — CQ-T010 own suite for
 * src/services/assetCredentialScopeService.ts (business rule 112(e)).
 *
 * Rule 112(e): a read-level walk (`POST /assets/:id/snmp-walk`, the MIB walks)
 * may aim only a credential the asset ALREADY uses — "its credential slots,
 * the class-override credentials its monitor settings resolve, its
 * integration's monitor credential"; anything else needs `assets:write` (403).
 * tests/unit/snmpPollingCredential.test.ts pins the pure chain step by step;
 * this suite covers the scope check itself, the async lookup, and the two
 * together (the walk tab's default must pass the walk's own gate).
 *
 * The asset read honours Prisma's `select`, so a column the service does not
 * ask for is absent — exactly as the real client returns it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const mon = vi.hoisted(() => ({ resolveMonitorSettings: vi.fn() }));
vi.mock("../../src/services/monitoringService.js", () => ({ resolveMonitorSettings: mon.resolveMonitorSettings }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  assertCredentialInAssetScope,
  pickSnmpPollingCredentialId,
  snmpPollingCredentialCandidates,
  snmpPollingCredentialId,
} from "../../src/services/assetCredentialScopeService.js";

const p = prisma as any;

/** Serve one asset row through findUnique, keeping only the selected keys. */
function serveAsset(full: Record<string, unknown> | null) {
  stubbed(p.asset.findUnique).mockImplementation(async ({ select }: { select: Record<string, unknown> }) => {
    if (!full) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) if (k in full) out[k] = full[k];
    return out;
  });
}

async function expect403(promise: Promise<unknown>) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(403);
  expect((err as AppError).message).toMatch(/Assets Read-Write/);
}

const BASE = { id: "a1", assetType: "switch", ipAddress: "10.0.0.5", discoveredByIntegrationId: null, discoveredByIntegration: null };

beforeEach(() => {
  resetDbStub();
  mon.resolveMonitorSettings.mockReset();
  mon.resolveMonitorSettings.mockResolvedValue({});
});

describe("assertCredentialInAssetScope", () => {
  it("lets a caller with assets:write aim any credential, without reading the asset", async () => {
    await expect(assertCredentialInAssetScope("a1", "anything", true)).resolves.toBeUndefined();
    expect(p.asset.findUnique).not.toHaveBeenCalled();
    expect(mon.resolveMonitorSettings).not.toHaveBeenCalled();
  });

  it.each([
    "monitorCredentialId",
    "responseTimeCredentialId",
    "cpuMemoryCredentialId",
    "temperatureCredentialId",
    "interfacesCredentialId",
    "lldpCredentialId",
  ])("admits the asset's own %s", async (slot) => {
    serveAsset({ ...BASE, [slot]: "c-own" });
    await expect(assertCredentialInAssetScope("a1", "c-own", false)).resolves.toBeUndefined();
  });

  it("admits a class-override credential the monitor settings resolve", async () => {
    serveAsset(BASE);
    mon.resolveMonitorSettings.mockResolvedValue({ cpuMemoryCredentialId: "c-class", eventLogCredentialId: "c-ev" });
    await expect(assertCredentialInAssetScope("a1", "c-class", false)).resolves.toBeUndefined();
    await expect(assertCredentialInAssetScope("a1", "c-ev", false)).resolves.toBeUndefined();
  });

  it("admits the discovering integration's monitor credential", async () => {
    serveAsset({ ...BASE, discoveredByIntegrationId: "i1", discoveredByIntegration: { type: "fortimanager", config: { monitorCredentialId: "c-int" } } });
    await expect(assertCredentialInAssetScope("a1", "c-int", false)).resolves.toBeUndefined();
  });

  it("hands the resolver the asset's type, address and integration", async () => {
    serveAsset({ ...BASE, discoveredByIntegrationId: "i1", discoveredByIntegration: { type: "vcenter", config: null } });
    await assertCredentialInAssetScope("a1", "x", false).catch(() => undefined);
    expect(mon.resolveMonitorSettings).toHaveBeenCalledWith(expect.objectContaining({
      assetType: "switch",
      ipAddress: "10.0.0.5",
      discoveredByIntegrationId: "i1",
      discoveredByIntegrationType: "vcenter",
    }));
  });

  it("an asset with no type resolves as 'other' and no address as null", async () => {
    serveAsset({ ...BASE, assetType: null, ipAddress: null });
    await assertCredentialInAssetScope("a1", "x", false).catch(() => undefined);
    expect(mon.resolveMonitorSettings).toHaveBeenCalledWith(expect.objectContaining({
      assetType: "other", ipAddress: null, discoveredByIntegrationId: null, discoveredByIntegrationType: null,
    }));
  });

  it("refuses (403) a credential the asset does not use", async () => {
    serveAsset({ ...BASE, monitorCredentialId: "c-own" });
    mon.resolveMonitorSettings.mockResolvedValue({ cpuMemoryCredentialId: "c-class" });
    await expect403(assertCredentialInAssetScope("a1", "c-stranger", false));
  });

  it("refuses (403) for an unknown asset, which uses nothing, without resolving settings", async () => {
    serveAsset(null);
    await expect403(assertCredentialInAssetScope("ghost", "c-any", false));
    expect(mon.resolveMonitorSettings).not.toHaveBeenCalled();
  });

  it("an integration config that is not an object, or names a non-string, contributes nothing", async () => {
    serveAsset({ ...BASE, discoveredByIntegration: { type: "fortigate", config: "garbage" } });
    await expect403(assertCredentialInAssetScope("a1", "garbage", false));
    serveAsset({ ...BASE, discoveredByIntegration: { type: "fortigate", config: { monitorCredentialId: 42 } } });
    await expect403(assertCredentialInAssetScope("a1", "42", false));
  });

  it("an empty-string slot is not a credential", async () => {
    serveAsset({ ...BASE, monitorCredentialId: "" });
    await expect403(assertCredentialInAssetScope("a1", "", false));
  });

  // Was a bug until 2026-11-14: credentialIdsAttachedToAsset reads only ASSET_CREDENTIAL_SLOTS
  // (monitor / responseTime / cpuMemory / temperature / interfaces / lldp),
  // but Asset also carries processesCredentialId, eventLogCredentialId and
  // customWidgetCredentialId — credential slots the asset's own monitoring
  // authenticates with. An asset whose processes stream polls with its own
  // "c-proc" refuses a read-level walk with c-proc: 403. Rule 112(e) says
  // "its credential slots" — expected: allowed.
  it("admits the asset's own processes / event-log / custom-widget credential slots", async () => {
    serveAsset({ ...BASE, processesCredentialId: "c-proc", eventLogCredentialId: "c-ev", customWidgetCredentialId: "c-cw" });
    await expect(assertCredentialInAssetScope("a1", "c-proc", false)).resolves.toBeUndefined();
    await expect(assertCredentialInAssetScope("a1", "c-ev", false)).resolves.toBeUndefined();
    await expect(assertCredentialInAssetScope("a1", "c-cw", false)).resolves.toBeUndefined();
  });

  // BUG (the operator-visible face of the one above): the SNMP Walk tab starts
  // on `snmpPollingCredentialId` (assetDetailReadService), which can pick the
  // asset's customWidgetCredentialId (custom widgets polled over SNMP). A
  // read-only user who then clicks Walk with that default is refused 403 by
  // assertCredentialInAssetScope — the tab's own default fails the tab's own
  // gate. Expected: the default credential passes.
  it("the walk tab's default credential always passes the walk's read-level gate", async () => {
    const assetRow = { ...BASE, customWidgetCredentialId: "c-cw", customWidgetPolling: "snmp" };
    stubbed(p.credential.findMany).mockResolvedValue([{ id: "c-cw", type: "snmp" }]);
    const picked = await snmpPollingCredentialId({
      asset: { customWidgetCredentialId: "c-cw", customWidgetPolling: "snmp" },
      resolved: {},
      integration: null,
    });
    expect(picked).toBe("c-cw");
    serveAsset(assetRow);
    await expect(assertCredentialInAssetScope("a1", picked!, false)).resolves.toBeUndefined();
  });
});

describe("snmpPollingCredentialCandidates", () => {
  it("collects every named id once: asset slots, resolved stream credentials, the integration's", () => {
    const ids = snmpPollingCredentialCandidates({
      asset: { monitorCredentialId: "m", cpuMemoryCredentialId: "m", customWidgetCredentialId: "w", customWidgetPolling: "snmp" },
      resolved: { interfacesCredentialId: "cls", responseTimePolling: "snmp", lldpCredentialId: "" },
      integration: { type: "fortigate", config: { monitorCredentialId: "int" } },
    });
    expect(ids.sort()).toEqual(["cls", "int", "m", "w"]);
  });

  it("never treats the customWidgetPolling METHOD as an id", () => {
    expect(snmpPollingCredentialCandidates({ asset: { customWidgetPolling: "snmp" }, resolved: {}, integration: null })).toEqual([]);
  });
});

describe("pickSnmpPollingCredentialId — complementary cases", () => {
  const types = (o: Record<string, string>) => new Map(Object.entries(o));

  it("storage authenticates as the interfaces stream", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { interfacesCredentialId: "if" },
      resolved: { storagePolling: "snmp" },
      integration: null,
      credentialTypes: types({ if: "snmp" }),
    })).toBe("if");
  });

  it("a stream credential that no longer exists falls back to the default", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { lldpCredentialId: "deleted", monitorCredentialId: "def" },
      resolved: { lldpPolling: "snmp" },
      integration: null,
      credentialTypes: types({ def: "snmp" }),
    })).toBe("def");
  });

  it("the Fortinet integration fallback applies only to FortiManager / FortiGate and only when SNMP", () => {
    const base = { asset: {}, resolved: { cpuMemoryPolling: "snmp" } };
    expect(pickSnmpPollingCredentialId({ ...base, integration: { type: "fortigate", config: { monitorCredentialId: "i" } }, credentialTypes: types({ i: "snmp" }) })).toBe("i");
    expect(pickSnmpPollingCredentialId({ ...base, integration: { type: "vcenter", config: { monitorCredentialId: "i" } }, credentialTypes: types({ i: "snmp" }) })).toBeNull();
    expect(pickSnmpPollingCredentialId({ ...base, integration: { type: "fortimanager", config: { monitorCredentialId: "i" } }, credentialTypes: types({ i: "ssh" }) })).toBeNull();
  });

  it("custom widgets: widget → temperature → CPU/memory → default", () => {
    const pick = (asset: Record<string, string>) => pickSnmpPollingCredentialId({
      asset: { ...asset, customWidgetPolling: "snmp" },
      resolved: {},
      integration: null,
      credentialTypes: types({ w: "snmp", t: "snmp", c: "snmp", d: "snmp", x: "ssh" }),
    });
    expect(pick({ customWidgetCredentialId: "w", temperatureCredentialId: "t" })).toBe("w");
    expect(pick({ customWidgetCredentialId: "x", temperatureCredentialId: "t" })).toBe("t");
    expect(pick({ cpuMemoryCredentialId: "c", monitorCredentialId: "d" })).toBe("c");
    expect(pick({ monitorCredentialId: "d" })).toBe("d");
    expect(pick({})).toBeNull();
  });
});

describe("snmpPollingCredentialId", () => {
  it("names nothing: no query, null", async () => {
    await expect(snmpPollingCredentialId({ asset: {}, resolved: { responseTimePolling: "snmp" }, integration: null })).resolves.toBeNull();
    expect(p.credential.findMany).not.toHaveBeenCalled();
  });

  it("reads the candidates' types in ONE query and picks with them", async () => {
    stubbed(p.credential.findMany).mockResolvedValue([{ id: "def", type: "snmp" }, { id: "cpu", type: "ssh" }]);
    const id = await snmpPollingCredentialId({
      asset: { monitorCredentialId: "def", cpuMemoryCredentialId: "cpu" },
      resolved: { cpuMemoryPolling: "snmp", responseTimePolling: "snmp" },
      integration: null,
    });
    // responseTime has no own credential → default (SNMP) wins first.
    expect(id).toBe("def");
    expect(p.credential.findMany).toHaveBeenCalledTimes(1);
    const q = stubbed(p.credential.findMany).mock.calls[0]![0];
    expect(q.select).toEqual({ id: true, type: true });
    expect([...q.where.id.in].sort()).toEqual(["cpu", "def"]);
  });

  it("a candidate deleted since is treated as missing", async () => {
    stubbed(p.credential.findMany).mockResolvedValue([]);
    await expect(snmpPollingCredentialId({ asset: { monitorCredentialId: "gone" }, resolved: { responseTimePolling: "snmp" }, integration: null })).resolves.toBeNull();
  });
});
