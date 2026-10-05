/**
 * tests/unit/pathMonitorTrigger.test.ts — the Path Monitor trigger type
 * (business rule 85, 2026-10-05 addendum): which stored triggers count as
 * Path Monitor, the agent-host pool their scope is narrowed to, the
 * `includeServer` flag and its save-time refusals, and how a server-side
 * route change matches a "Path changed" automation.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  isPathTrigger,
  isPathMetric,
  pathTriggerIncludesServer,
  pathMonitorScope,
  scopeForTrigger,
  eventMatchesPathServer,
  buildSchemaCatalog,
  AGENT_INSTALLED_RULE,
  PATH_METRICS,
} from "../../src/services/notificationTypes.js";

const pathLeaf = (metric: string, extra: Record<string, unknown> = {}) => ({
  type: "asset_metric", metric, aggregation: "latest", windowSec: 0, operator: ">", threshold: 1, ...extra,
});

function parseRule(trigger: unknown, reset: unknown = { mode: "auto" }) {
  return ruleInputSchema.safeParse({
    name: "Path rule", enabled: true, severity: "warning",
    trigger, scope: { allAssets: true }, reset, actions: [{ type: "event" }],
  });
}

describe("isPathTrigger", () => {
  it("is a path metric, the path change, or a composite of path metrics only", () => {
    for (const m of PATH_METRICS) expect(isPathTrigger(pathLeaf(m))).toBe(true);
    expect(isPathTrigger({ type: "change", changeType: "path_check_path_changed" })).toBe(true);
    expect(isPathTrigger({ type: "composite", kind: "asset", op: "and", children: [pathLeaf("pathOk"), pathLeaf("pathLatencyMs")] })).toBe(true);
  });
  it("is not a device metric, another change, or a mixed tree", () => {
    expect(isPathTrigger(pathLeaf("cpuPct"))).toBe(false);
    expect(isPathTrigger({ type: "change", changeType: "firmware_changed" })).toBe(false);
    expect(isPathTrigger({ type: "composite", kind: "asset", op: "and", children: [pathLeaf("pathOk"), pathLeaf("cpuPct")] })).toBe(false);
    expect(isPathTrigger(null)).toBe(false);
    expect(isPathMetric("cpuPct")).toBe(false);
  });
});

describe("pathMonitorScope — the agent-host pool", () => {
  it("ANDs 'Polaris Agent installed' into the operator's own conditions", () => {
    const own = { op: "and" as const, children: [{ field: "tags", operator: "contains", value: "branch" }] };
    expect(pathMonitorScope({ condition: own }).condition).toEqual({ op: "and", children: [AGENT_INSTALLED_RULE, own] });
  });
  it("narrows All assets to agent hosts", () => {
    const s = pathMonitorScope({ allAssets: true });
    expect(s.allAssets).toBe(true);
    expect(s.condition).toEqual({ op: "and", children: [AGENT_INSTALLED_RULE] });
  });
  it("keeps a scope that selects nothing selecting nothing", () => {
    expect(pathMonitorScope({})).toEqual({});
    expect(pathMonitorScope({ condition: { op: "and", children: [] } })).toEqual({ condition: { op: "and", children: [] } });
  });
  it("scopeForTrigger leaves a device rule's scope alone", () => {
    const scope = { allAssets: true };
    expect(scopeForTrigger(scope, pathLeaf("cpuPct"))).toBe(scope);
    expect(scopeForTrigger(scope, pathLeaf("pathOk")).condition).toBeTruthy();
  });
});

describe("includeServer", () => {
  it("saves on a path metric and on the path change", () => {
    expect(parseRule(pathLeaf("pathOk", { includeServer: true })).success).toBe(true);
    expect(parseRule({ type: "change", changeType: "path_check_path_changed", includeServer: true }, { mode: "manual" }).success).toBe(true);
  });
  it("is refused anywhere else", () => {
    expect(parseRule(pathLeaf("cpuPct", { includeServer: true })).success).toBe(false);
    expect(parseRule({ type: "change", changeType: "firmware_changed", includeServer: false }, { mode: "manual" }).success).toBe(false);
  });
  it("is refused beside a custom reset condition, which could never recover the server", () => {
    const reset = { mode: "condition", condition: { op: "and", children: [pathLeaf("pathOk", { operator: "==", threshold: 1 })] } };
    expect(parseRule(pathLeaf("pathOk", { operator: "==", threshold: 0, includeServer: true }), reset).success).toBe(false);
    expect(parseRule(pathLeaf("pathOk", { operator: "==", threshold: 0, includeServer: false }), reset).success).toBe(true);
  });
  it("only a single-condition trigger watches the server", () => {
    expect(pathTriggerIncludesServer(pathLeaf("pathOk", { includeServer: true }))).toBe(true);
    expect(pathTriggerIncludesServer(pathLeaf("pathOk"))).toBe(false);
    expect(pathTriggerIncludesServer(pathLeaf("cpuPct", { includeServer: true }))).toBe(false);
  });
});

describe("composite trees", () => {
  it("refuse path conditions mixed with device conditions", () => {
    const mixed = { type: "composite", kind: "asset", op: "and", children: [pathLeaf("pathOk"), pathLeaf("cpuPct")] };
    const r = parseRule(mixed);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("Path Monitor conditions cannot be combined");
  });
  it("accept a tree of path conditions only", () => {
    const tree = { type: "composite", kind: "asset", op: "or", children: [pathLeaf("pathOk", { operator: "==", threshold: 0 }), pathLeaf("pathLatencyMs", { threshold: 800 })] };
    expect(parseRule(tree).success).toBe(true);
  });
});

describe("eventMatchesPathServer — a server-side route change", () => {
  const change = (includeServer?: boolean) => ({ type: "change", changeType: "path_check_path_changed", ...(includeServer == null ? {} : { includeServer }) });
  it("follows includeServer when it is set", () => {
    expect(eventMatchesPathServer(change(true), true, "path-check")).toBe(true);
    expect(eventMatchesPathServer(change(false), false, "path-check")).toBe(false);
  });
  it("keeps the pre-flag behaviour when absent: unfiltered matches, filtered does not", () => {
    expect(eventMatchesPathServer(change(), false, "path-check")).toBe(true);
    expect(eventMatchesPathServer(change(), true, "path-check")).toBe(false);
  });
  it("is not the deciding test for a host's own route change or another trigger", () => {
    expect(eventMatchesPathServer(change(true), true, "asset")).toBeNull();
    expect(eventMatchesPathServer({ type: "change", changeType: "firmware_changed" }, false, "path-check")).toBeNull();
  });
});

describe("schema catalog", () => {
  it("serves the Path Monitor vocabulary the wizard files its category from", () => {
    const cat = buildSchemaCatalog() as unknown as { pathMonitor: { metrics: string[]; changeTypes: string[]; agentRule: unknown } };
    expect(cat.pathMonitor.metrics).toEqual([...PATH_METRICS]);
    expect(cat.pathMonitor.changeTypes).toEqual(["path_check_path_changed"]);
    expect(cat.pathMonitor.agentRule).toEqual(AGENT_INSTALLED_RULE);
  });
});
