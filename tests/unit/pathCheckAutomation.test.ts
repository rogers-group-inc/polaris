/**
 * tests/unit/pathCheckAutomation.test.ts — the automation vocabulary for
 * agent-run path checks: the six path* metrics and their `checkId`
 * dimension, the `agentInstalled` device-filter field (joined row AND
 * prefetched verdict), the path-change change type, the alert-email chart
 * suppression and the specimen dimension.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  evaluateScopeCondition,
  relationLeafKey,
  pathCheckFilterMatches,
  isBooleanMetric,
  METRIC_DIMENSIONS,
  METRIC_META,
  CHANGE_TYPE_ACTIONS,
  CHANGE_TYPE_META,
  WINDOWED_RATIO_METRICS,
  SCOPE_FIELD_OPS,
  scopeConditionMeta,
  scopeMatchesAsset,
  type ScopeConditionGroup,
} from "../../src/services/notificationTypes.js";
import { isPathCheckScopedAlert, chartTokenForMetric } from "../../src/services/alertChartService.js";
import { sampleDimensionFor, SAMPLE_PATH_CHECK } from "../../src/utils/sampleAlertDevice.js";

const CONN = ["pathLatencyMs", "pathHttpStatus", "pathOk", "pathFailurePct", "pathHopCount", "pathTlsDaysLeft"];

describe("path* metrics", () => {
  it("each carries label metadata and the checkId dimension", () => {
    for (const m of CONN) {
      expect(METRIC_META[m]?.label).toBeTruthy();
      expect(METRIC_DIMENSIONS[m]).toEqual(["checkId"]);
    }
  });
  it("pathOk is boolean and pathFailurePct is a windowed ratio", () => {
    expect(isBooleanMetric("pathOk")).toBe(true);
    expect((WINDOWED_RATIO_METRICS as readonly string[]).includes("pathFailurePct")).toBe(true);
  });
  it("a latency SLA with a check filter saves (dimensionFilter is .strict())", () => {
    const parsed = ruleInputSchema.safeParse({
      name: "Intranet latency SLA",
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "pathLatencyMs", aggregation: "latest", windowSec: 0,
        operator: ">", threshold: 800, forPolls: 3, forDurationSec: 180,
        dimensionFilter: { checkId: "c-intranet" },
      },
      scope: { condition: { op: "and", children: [{ field: "agentInstalled", operator: "equals", value: "yes" }] } },
      reset: { mode: "auto" },
      actions: [{ type: "event" }],
    });
    expect(parsed.success).toBe(true);
  });
  it("pathCheckFilterMatches: blank = every check, else exact id", () => {
    expect(pathCheckFilterMatches(undefined, { checkId: "a" })).toBe(true);
    expect(pathCheckFilterMatches({ checkId: "a" }, { checkId: "a" })).toBe(true);
    expect(pathCheckFilterMatches({ checkId: "a" }, { checkId: "b" })).toBe(false);
  });
});

describe("agentInstalled device-filter field", () => {
  const tree = (value: string, operator = "equals"): ScopeConditionGroup => ({
    op: "and",
    children: [{ field: "agentInstalled", operator, value }],
  });
  it("is offered with yes/no values (no client valueOptions case needed)", () => {
    expect(SCOPE_FIELD_OPS.agentInstalled).toEqual(["equals", "notEquals"]);
    const meta = scopeConditionMeta(SCOPE_FIELD_OPS).fields.find((f) => f.field === "agentInstalled");
    expect(meta).toMatchObject({ label: "Polaris Agent installed", values: ["yes", "no"] });
  });
  it("reads the joined managedAgent row on single-asset paths", () => {
    const active = { id: "a", managedAgent: { installStatus: "active" } };
    const pending = { id: "b", managedAgent: { installStatus: "pending" } };
    const none = { id: "c", managedAgent: null };
    expect(evaluateScopeCondition(tree("yes"), active)).toBe(true);
    expect(evaluateScopeCondition(tree("yes"), pending)).toBe(false);
    expect(evaluateScopeCondition(tree("yes"), none)).toBe(false);
    expect(evaluateScopeCondition(tree("no"), none)).toBe(true);
    expect(evaluateScopeCondition(tree("yes", "notEquals"), active)).toBe(false);
  });
  it("prefers the fleet prefetch verdict, and treats a missing key as unknown", () => {
    const leaf = tree("yes").children[0] as any;
    const hits = new Map([[relationLeafKey(leaf), true]]);
    // No managedAgent joined — the prefetch alone answers.
    expect(evaluateScopeCondition(tree("yes"), { id: "a", relationLeafHits: hits })).toBe(true);
    // "no" is a different key; absent -> falls back to the (missing) join -> not installed.
    expect(evaluateScopeCondition(tree("no"), { id: "a", relationLeafHits: hits })).toBe(true);
  });
  it("scopeMatchesAsset honours it", () => {
    expect(scopeMatchesAsset({ condition: tree("yes") }, { id: "a", assetType: "server", tags: [], managedAgent: { installStatus: "active" } } as any)).toBe(true);
  });
});

describe("path-change change type", () => {
  it("maps to the Event the ingest writes, with a label", () => {
    expect(CHANGE_TYPE_ACTIONS.path_check_path_changed).toBe("path_check.path_changed");
    expect(CHANGE_TYPE_META.path_check_path_changed).toMatch(/path/i);
  });
});

describe("alert email + specimen", () => {
  it("draws no device charts for a path-check alert", () => {
    for (const m of CONN) {
      expect(isPathCheckScopedAlert(m)).toBe(true);
      expect(chartTokenForMetric(m)).toBeNull();
    }
    expect(isPathCheckScopedAlert("cpuPct")).toBe(false);
  });
  it("a delivery test names a made-up check", () => {
    expect(sampleDimensionFor("pathLatencyMs")).toBe(SAMPLE_PATH_CHECK);
  });
});
