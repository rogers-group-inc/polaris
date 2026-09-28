/**
 * tests/unit/rulesMatchingAssetCarveOut.test.ts — `findRulesMatchingAsset`, the
 * asset-details Alerts tab's "automations that can trigger for this asset",
 * applies the engine's specificity carve-out. A general automation that a
 * more-specific same-signature peer has taken the asset from never evaluates
 * for it, so listing it beside the peer ("High CPU utilization" for all assets
 * next to "Server High CPU utilization" for servers) claimed two automations
 * could fire where only one can. Prisma is mocked — the filter is under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findUnique: (...a: unknown[]) => findUnique(...a) },
    notificationRule: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const { findRulesMatchingAsset } = await import("../../src/services/notificationRuleService.js");

const SERVER = {
  id: "a1", assetType: "server", tags: [], discoveredByIntegrationId: null, manufacturer: "VMware",
  model: null, ipAddress: "10.0.0.5", hostname: "twvcorsmt1", os: "Windows Server 2022", status: "active",
  managedAgent: null,
};
const SWITCH = { ...SERVER, id: "a2", assetType: "switch", hostname: "sw-1", os: null };

const cpu = (aggregation: string) => ({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80, aggregation, windowSec: 900, forDurationSec: 0 });
const down = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 };
const servers = { condition: { op: "and", children: [{ field: "assetType", operator: "equals", value: "server" }] } };

function rule(id: string, trigger: unknown, scope: unknown) {
  return { id, name: id, enabled: true, severity: "warning", trigger, scope, severityBands: null, actions: [], reset: { mode: "auto" }, escalation: null, bandNotify: null, clearBehavior: "auto", targets: [] };
}

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("findRulesMatchingAsset — specificity carve-out", () => {
  it("drops the all-assets automation a server-scoped peer on the same metric supersedes", async () => {
    findUnique.mockResolvedValue(SERVER);
    findMany.mockResolvedValue([rule("general", cpu("avg"), { allAssets: true }), rule("server", cpu("latest"), servers)]);
    expect(ids(await findRulesMatchingAsset("a1", { carveOut: true }))).toEqual(["server"]);
  });

  it("keeps the general automation on an asset the specific one does not cover", async () => {
    findUnique.mockResolvedValue(SWITCH);
    findMany.mockResolvedValue([rule("general", cpu("avg"), { allAssets: true }), rule("server", cpu("latest"), servers)]);
    expect(ids(await findRulesMatchingAsset("a2", { carveOut: true }))).toEqual(["general"]);
  });

  it("keeps both when they watch different signatures", async () => {
    findUnique.mockResolvedValue(SERVER);
    findMany.mockResolvedValue([rule("down", down, { allAssets: true }), rule("server", cpu("latest"), servers)]);
    expect(ids(await findRulesMatchingAsset("a1", { carveOut: true }))).toEqual(["down", "server"]);
  });

  it("keeps both on a same-rank tie (both fire)", async () => {
    findUnique.mockResolvedValue(SERVER);
    findMany.mockResolvedValue([rule("a", cpu("avg"), { allAssets: true }), rule("b", cpu("latest"), { allAssets: true })]);
    expect(ids(await findRulesMatchingAsset("a1", { carveOut: true }))).toEqual(["a", "b"]);
  });

  it("supersedes down detection the same way (Asset down → Data Center Asset down)", async () => {
    findUnique.mockResolvedValue(SERVER);
    findMany.mockResolvedValue([rule("asset-down", down, { allAssets: true }), rule("dc-down", down, servers)]);
    expect(ids(await findRulesMatchingAsset("a1", { carveOut: true }))).toEqual(["dc-down"]);
  });

  it("returns superseded rules too without the option (getMetricSeverityTiers wants them)", async () => {
    findUnique.mockResolvedValue(SERVER);
    findMany.mockResolvedValue([rule("general", cpu("avg"), { allAssets: true }), rule("server", cpu("latest"), servers)]);
    expect(ids(await findRulesMatchingAsset("a1"))).toEqual(["general", "server"]);
  });
});
