/**
 * tests/unit/assistantProfileTools.test.ts — rule 95 for the assistant's
 * manufacturer-profile, MIB and automation lookups.
 *
 * What is pinned:
 *   - each tool checks the CALLER's own key (manufacturerProfiles / mibDatabase /
 *     automationManagement read) before it reads anything;
 *   - get_manufacturer_profile reports readiness the way the profile page does,
 *     lists only configured rows, and never returns an HTTP check's credential;
 *   - search_mib_symbols reads the operator's own uploaded module (the real
 *     parser runs) — objects, enum values, table columns, missing imports;
 *   - get_automation masks api_call headers exactly as the API does;
 *   - the profile playbook wins over the outage playbook for MIB questions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  getProfileFor: vi.fn(),
  listMibs: vi.fn(),
  getMib: vi.fn(),
  resolveSymbolsForMib: vi.fn(),
  missingRootsForMib: vi.fn(),
  listRules: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({
  listProfiles: h.listProfiles,
  getProfile: h.getProfile,
  getProfileFor: h.getProfileFor,
  refreshProfileCacheIfStale: async () => false,
}));
vi.mock("../../src/services/mibService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMibs: h.listMibs,
  getMib: h.getMib,
}));
vi.mock("../../src/services/oidRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSymbolsForMib: h.resolveSymbolsForMib,
  missingRootsForMib: h.missingRootsForMib,
}));
vi.mock("../../src/services/notificationRuleService.js", () => ({ listRules: h.listRules }));

import { runAssistantTool, assistantToolDefs } from "../../src/services/assistantToolService.js";
import { pickPlaybook } from "../../src/services/assistantPlaybookService.js";

function reqWith(perms: Record<string, string>) {
  return { session: { userId: "u1", roleSnapshot: { permissions: perms } } } as any;
}
const ctx = (perms: Record<string, string>) => ({ req: reqWith(perms), maxRows: 50 });

beforeEach(() => vi.clearAllMocks());

const UPS_MIB = `
TEST-UPS-MIB DEFINITIONS ::= BEGIN
IMPORTS
    enterprises, OBJECT-TYPE, Integer32 FROM SNMPv2-SMI
    testCore FROM TEST-CORE-MIB;

upsBatteryStatus OBJECT-TYPE
    SYNTAX      INTEGER { unknown(1), batteryNormal(2), batteryLow(3) }
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "The battery status."
    ::= { testCore 1 }

upsProbeTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF UpsProbeEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "The temperature probes."
    ::= { testCore 2 }

upsProbeEntry OBJECT-TYPE
    SYNTAX      UpsProbeEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "One probe."
    INDEX       { upsProbeIndex }
    ::= { upsProbeTable 1 }

UpsProbeEntry ::= SEQUENCE { upsProbeIndex Integer32, upsProbeTemp Integer32 }

upsProbeIndex OBJECT-TYPE
    SYNTAX      Integer32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Probe number."
    ::= { upsProbeEntry 1 }

upsProbeTemp OBJECT-TYPE
    SYNTAX      Integer32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Probe temperature in tenths of a degree Celsius."
    ::= { upsProbeEntry 2 }
END
`;

describe("permission gate", () => {
  it.each([
    ["list_manufacturer_profiles", "{}", () => h.listProfiles],
    ["get_manufacturer_profile", '{"manufacturer":"APC"}', () => h.getProfile],
    ["list_mibs", "{}", () => h.listMibs],
    ["search_mib_symbols", '{"module":"TEST-UPS-MIB"}', () => h.listMibs],
    ["list_automations", "{}", () => h.listRules],
    ["get_automation", '{"name":"x"}', () => h.listRules],
  ])("%s refuses a role without its key and reads nothing", async (name, args, fn) => {
    const r = await runAssistantTool(name, args, ctx({ assets: "read" }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Not permitted/);
    expect(fn()).not.toHaveBeenCalled();
  });

  it("all six are offered to the model", () => {
    const names = assistantToolDefs().map((t) => t.function.name);
    for (const n of ["list_manufacturer_profiles", "get_manufacturer_profile", "list_mibs", "search_mib_symbols", "list_automations", "get_automation"]) {
      expect(names).toContain(n);
    }
  });
});

describe("get_manufacturer_profile", () => {
  const unresolved = { symbol: "upsLoad", resolved: false, oid: null, fromScope: null, fromModuleName: null, hint: { kind: "no-module" } };
  const resolved = { symbol: "upsProbeTemp", resolved: true, oid: "1.2", fromScope: "vendor", fromModuleName: "TEST-UPS-MIB", hint: null };
  const row = (metricKey: string, extra: Record<string, unknown> = {}) => ({
    id: `m-${metricKey}`, metricKey, defaultSymbol: null, defaultSymbolB: null, defaultMibId: null, defaultMibStdKey: null,
    defaultType: "scalar", defaultTransform: null, defaultAggregate: "none", defaultLabel: null,
    defaultParsePattern: null, defaultParseTemplate: null, defaultSensorColumns: null, overrides: [], readiness: null, ...extra,
  });

  it("finds the profile by manufacturer and reports configured rows with their readiness", async () => {
    h.getProfileFor.mockReturnValue({ id: "p-apc" });
    h.getProfile.mockResolvedValue({
      id: "p-apc", manufacturer: "APC", matchPattern: "schneider",
      metrics: [
        row("cpu"),
        row("temperature", { defaultSymbol: "upsProbeTemp", defaultType: "table", readiness: { a: resolved, b: null } }),
        row("memory", { defaultSymbol: "upsLoad", readiness: { a: unresolved, b: null } }),
      ],
      widgets: [{ id: "w1", name: "Web UI", widgetType: "http", symbol: null, type: "scalar", transform: null, modelPattern: null, stateMap: null, labelSymbol: null, httpCheck: { path: "/" }, credentialId: "cred-secret-id", displayOptions: {}, order: 0, mibId: null }],
    });
    const r = await runAssistantTool("get_manufacturer_profile", '{"manufacturer":"apc"}', ctx({ manufacturerProfiles: "read" }));
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.alsoAppliesWhen).toBe("schneider");
    expect(d.unconfiguredMetrics).toEqual(["cpu"]);
    expect(d.metrics.map((m: any) => m.metric)).toEqual(["temperature", "memory"]);
    expect(d.metrics[0].readiness[0]).toEqual({ symbol: "upsProbeTemp", resolved: true, module: "TEST-UPS-MIB", layer: "vendor" });
    expect(d.metrics[1].readiness[0]).toEqual({ symbol: "upsLoad", resolved: false, why: "no uploaded MIB defines it" });
    // The check's request is shown; the credential behind it never is.
    expect(d.widgets[0]).toMatchObject({ name: "Web UI", authenticated: true });
    expect(JSON.stringify(d)).not.toContain("cred-secret-id");
  });

  it("says plainly when there is no such profile", async () => {
    h.getProfileFor.mockReturnValue(null);
    const r = await runAssistantTool("get_manufacturer_profile", '{"manufacturer":"Nobody"}', ctx({ manufacturerProfiles: "read" }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/list_manufacturer_profiles/);
  });
});

describe("search_mib_symbols reads the operator's module", () => {
  beforeEach(() => {
    h.listMibs.mockResolvedValue([{ id: "mib1", moduleName: "TEST-UPS-MIB", manufacturer: "APC", model: null, imports: [], size: 1, uploadedAt: new Date(0) }]);
    h.getMib.mockResolvedValue({ id: "mib1", moduleName: "TEST-UPS-MIB", manufacturer: "APC", model: null, contents: UPS_MIB });
    h.resolveSymbolsForMib.mockResolvedValue(new Map([["upsProbeTemp", "1.3.6.1.4.1.99999.2.1.2"], ["upsBatteryStatus", null]]));
    h.missingRootsForMib.mockReturnValue([{ symbol: "testCore", module: "TEST-CORE-MIB" }]);
  });

  it("finds objects by a word, with enum values, the column they sit in, and what to upload next", async () => {
    const r = await runAssistantTool("search_mib_symbols", '{"module":"test-ups-mib","query":"temperature"}', ctx({ mibDatabase: "read" }));
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.missingImports).toEqual(["TEST-CORE-MIB"]);
    const temp = d.symbols.find((s: any) => s.name === "upsProbeTemp");
    expect(temp).toMatchObject({ oid: "1.3.6.1.4.1.99999.2.1.2", column: "column of upsProbeEntry" });

    const status = (await runAssistantTool("search_mib_symbols", '{"module":"TEST-UPS-MIB","query":"battery"}', ctx({ mibDatabase: "read" }))).data as any;
    expect(status.symbols[0]).toMatchObject({ name: "upsBatteryStatus", oid: null, enum: ["unknown(1)", "batteryNormal(2)", "batteryLow(3)"] });
  });

  it("lists tables and their columns", async () => {
    const d = (await runAssistantTool("search_mib_symbols", '{"module":"TEST-UPS-MIB","tablesOnly":true}', ctx({ mibDatabase: "read" }))).data as any;
    expect(d.tables).toEqual([expect.objectContaining({ table: "upsProbeTable", row: "upsProbeEntry", columns: ["upsProbeIndex", "upsProbeTemp"] })]);
  });

  it("asks for a manufacturer when the module is uploaded twice, and says when it is not uploaded", async () => {
    h.listMibs.mockResolvedValue([
      { id: "a", moduleName: "TEST-UPS-MIB", manufacturer: "APC", model: null, imports: [], size: 1, uploadedAt: new Date(0) },
      { id: "b", moduleName: "TEST-UPS-MIB", manufacturer: "Eaton", model: null, imports: [], size: 1, uploadedAt: new Date(0) },
    ]);
    const twice = await runAssistantTool("search_mib_symbols", '{"module":"TEST-UPS-MIB"}', ctx({ mibDatabase: "read" }));
    expect(JSON.stringify(twice.data)).toMatch(/Pass manufacturer/);
    const none = await runAssistantTool("search_mib_symbols", '{"module":"IF-MIB"}', ctx({ mibDatabase: "read" }));
    expect(JSON.stringify(none.data)).toMatch(/No uploaded MIB/);
  });
});

describe("automations", () => {
  const RULE = {
    id: "r1", name: "Firewall CPU high", enabled: true, severity: "serious",
    trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, forPolls: 3 },
    scope: { assetTypes: ["firewall"] },
    actions: [{ type: "api_call", url: "https://tickets.example/api", headers: { Authorization: "Bearer real-secret" } }],
    createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-02T00:00:00Z"),
    alertGroup: null,
  };

  it("list_automations summarizes what each rule watches", async () => {
    h.listRules.mockResolvedValue([RULE]);
    const d = (await runAssistantTool("list_automations", "{}", ctx({ automationManagement: "read" }))).data as any;
    expect(d.rows[0]).toEqual({
      id: "r1", name: "Firewall CPU high", enabled: true, severity: "serious",
      trigger: "cpuPct > 90 for 3 readings", scopeFilters: ["assetTypes"], actions: ["api_call"],
    });
  });

  it("get_automation masks an api_call header exactly as the API does", async () => {
    h.listRules.mockResolvedValue([RULE]);
    const r = await runAssistantTool("get_automation", '{"name":"firewall cpu high"}', ctx({ automationManagement: "read" }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain("real-secret");
    expect((r.data as any).actions[0].headers.Authorization).toBe("••••••••");
    expect((r.data as any).createdAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("the profile playbook", () => {
  it("takes MIB and profile questions, ahead of the outage playbook", () => {
    expect(pickPlaybook("which OID carries the battery temperature on our UPS?")?.id).toBe("profile");
    expect(pickPlaybook("why is the custom widget empty on ups-dc?")?.id).toBe("profile");
    expect(pickPlaybook("why are the hardware sensors unresolved for Fortinet")?.id).toBe("profile");
    expect(pickPlaybook("why did sw-nsh-02 go down?")?.id).toBe("correlate");
  });
});
