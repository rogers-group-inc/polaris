/**
 * Unit tests for public/js/automations-portability.js — automation export /
 * import.
 *
 * The headline property is **every export is a valid import**: whatever
 * stripForExport emits must survive the real `ruleInputSchema`. That is why this
 * file imports the actual server schema (with prisma mocked, the
 * notificationRuleShapeV2 pattern) rather than asserting on a hand-written
 * shape — a strip that quietly produces an un-importable body is the failure
 * mode worth a test.
 *
 * The other three groups pin the defects a validation pass found in the design:
 *   (A) `actions` must be EXPLICIT — omitting it saves a rule with zero actions.
 *   (B) an empty scope must never be emitted — it means MATCH NOTHING while
 *       rendering as "All assets".
 *   (C) blanking a state-probe / widget dimension WIDENS the trigger, so it must
 *       be reported back to the caller.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { vi } from "vitest";
import { ruleInputSchema } from "../../src/services/notificationTypes.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Dependency {
  kind: string;
  name: string;
  usedFor?: string;
  unresolved?: boolean;
}
interface Stripped {
  rule: Record<string, unknown>;
  dependencies: Dependency[];
  needsDevices: boolean;
  blankedDimensions: string[];
}
interface Portability {
  FORMAT_VERSION: number;
  FILE_SUFFIX: string;
  nameFromFilename(f: unknown): string;
  filenameForExport(n: unknown): string;
  stripForExport(body: unknown, catalogs?: unknown): Stripped;
  buildExportFile(body: unknown, catalogs?: unknown, meta?: unknown): Record<string, unknown>;
  parseImportFile(text: unknown, filename: unknown, triggerTypes?: string[]): {
    rule: Record<string, unknown>;
    dependencies: Dependency[];
    name: string;
    needsDevices: boolean;
    blankedDimensions: string[];
    problems: string[];
  };
  checkDependencies(deps: Dependency[], catalogs?: unknown): { kind: string; name: string; present: boolean | null }[];
  forCodeView(body: unknown): Record<string, unknown>;
  diffForConfirm(before: unknown, after: unknown): { key: string; from: string; to: string; alarming: boolean }[];
}

let P: Portability;

beforeAll(() => {
  // Browser script, no module system — eval it with a window to hang the
  // namespace on (the automationSentences.test.ts pattern).
  const code = readFileSync(resolve(here, "../../public/js/automations-portability.js"), "utf8");
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  // eslint-disable-next-line no-eval
  (0, eval)(code);
  P = (g.window as { PolarisAutomationPortability: Portability }).PolarisAutomationPortability;
});

const CATALOGS = {
  channels: [{ id: "ch1", name: "SMTP - NOC", type: "smtp" }],
  scripts: [{ id: "sc1", name: "restart-nginx" }],
  users: [{ id: "u1", username: "dmoore" }],
  roles: [{ id: "r1", name: "NOC" }],
  stateProbes: [{ id: "sp1", name: "PSU alarm" }],
  regions: [{ name: "Nashville" }],
  tags: [{ name: "critical" }],
  assets: [{ id: "a1", hostname: "CORE-SW-01" }],
};

/** A notify action with every install-specific reference populated. */
const notifyAction = {
  type: "notify",
  channelId: "ch1",
  recipientUserIds: ["u1"],
  recipientRoles: ["r1"],
  recipientRegions: ["Nashville"],
  recipientAssetContacts: true,
  emailComposition: {
    subjectTemplate: "S",
    cc: { recipientUserIds: ["u1"], addresses: ["a@example.com"] },
    bcc: { recipientRoles: ["r1"] },
  },
};

const apiCallAction = {
  type: "api_call",
  method: "POST",
  url: "https://hooks.example.com/notify",
  headers: { Authorization: "Bearer SUPER-SECRET-TOKEN" },
  bodyTemplate: '{"asset":"{asset}"}',
  timeoutSec: 15,
};

const scriptAction = { type: "script", scriptId: "sc1", runOn: "server", timeoutSec: 60 };

/** Fixtures spanning the shapes a rule can take. Each must round-trip. */
function fixtures(): Record<string, Record<string, unknown>> {
  return {
    "numeric metric with severity bands": {
      name: "CPU high",
      description: "watch cpu",
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric",
        metric: "cpuPct",
        aggregation: "avg",
        windowSec: 300,
        operator: ">=",
        threshold: 80,
        forDurationSec: 300,
      },
      scope: { allAssets: true },
      reset: { mode: "auto", clearThreshold: 70 },
      actions: [{ type: "event" }, notifyAction, apiCallAction, scriptAction],
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 10, actions: [notifyAction] }] },
      severityBands: [
        { threshold: 90, severity: "serious", actions: [notifyAction], escalation: { stopOn: "clear", tiers: [{ afterMin: 5, actions: [notifyAction] }] } },
        { threshold: 95, severity: "critical", forDurationSec: 60, actions: [scriptAction] },
      ],
      bandNotify: { onIncrease: true, onDecrease: true, onResolved: false, resolvedMode: "dedicated", resolvedActions: [notifyAction] },
      resetActions: [{ type: "event" }, notifyAction],
      cooldownSec: 600,
      messageTemplate: "{asset} cpu {value}",
      requireAckNote: true,
      channels: ["in_app"],
    },
    "composite trigger with per-leaf dimension filters": {
      name: "Composite",
      severity: "serious",
      trigger: {
        type: "composite",
        kind: "asset",
        op: "or",
        forDurationSec: 120,
        children: [
          {
            type: "asset_metric",
            metric: "hwSensorValue",
            aggregation: "max",
            windowSec: 600,
            operator: ">=",
            threshold: 65,
            forDurationSec: 0,
            dimensionFilter: { sensorClass: "temperature", stateProbeId: "sp1" },
          },
          {
            type: "asset_state",
            field: "monitorStatus",
            operator: "==",
            value: "down",
            forDurationSec: 0,
            dimensionFilter: { widgetId: "w-123" },
          },
        ],
      },
      scope: { assetTypes: ["switch"], tags: ["critical"] },
      reset: { mode: "manual" },
      actions: [notifyAction],
    },
    "condition-tree scope with an assetId leaf": {
      name: "Tree",
      severity: "warning",
      trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0 },
      scope: {
        condition: {
          op: "and",
          children: [
            { field: "tag", operator: "has", value: "critical" },
            { op: "or", children: [{ field: "assetId", operator: "equals", value: "a1" }] },
          ],
        },
      },
      reset: { mode: "timed", afterSec: 3600 },
      actions: [{ type: "event" }],
    },
    "custom reset condition tree": {
      name: "Reset tree",
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: {
        mode: "condition",
        sustainSec: 300,
        condition: {
          op: "and",
          children: [
            { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: "<", threshold: 70, forDurationSec: 0 },
          ],
        },
      },
      actions: [notifyAction],
    },
    "event trigger": {
      name: "Discovery failed",
      severity: "serious",
      trigger: { type: "event", actionPattern: "integration.discover.error", minLevel: "warning" },
      scope: {},
      reset: { mode: "manual" },
      actions: [notifyAction],
      messageTemplate: "{value}",
    },
    "host metric": {
      name: "Polaris host cpu",
      severity: "warning",
      trigger: { type: "host_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
      scope: {},
      reset: { mode: "auto" },
      actions: [{ type: "event" }, notifyAction],
    },
    "legacy escalation email tiers": {
      name: "Legacy esc",
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: { mode: "manual" },
      actions: [notifyAction],
      escalation: {
        stopOn: "acknowledge",
        tiers: [{ afterMin: 15, channelId: "ch1", to: { recipientUserIds: ["u1"] }, subjectTemplate: "late" }],
      },
    },
  };
}

// ─── The headline property ───────────────────────────────────────────────────

describe("every export is a valid import", () => {
  for (const [label, body] of Object.entries(fixtures())) {
    it(`round-trips: ${label}`, () => {
      const { rule } = P.stripForExport(body, CATALOGS);
      const parsed = ruleInputSchema.safeParse(rule);
      if (!parsed.success) {
        throw new Error(
          `stripped ${label} does not parse:\n` +
            parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n") +
            `\n\nbody:\n${JSON.stringify(rule, null, 2)}`,
        );
      }
    });
  }

  it("a re-strip of an already-stripped body is a no-op (idempotent)", () => {
    for (const body of Object.values(fixtures())) {
      const once = P.stripForExport(body, CATALOGS).rule;
      const twice = P.stripForExport(once, CATALOGS).rule;
      expect(twice).toEqual(once);
    }
  });

  it("the whole export FILE parses once its rule is handed to the schema", () => {
    const file = P.buildExportFile(fixtures()["numeric metric with severity bands"], CATALOGS, {
      exportedAt: "2026-08-24T00:00:00.000Z",
      polarisVersion: "0.28.0",
    });
    expect(file.polarisAutomation).toBe(P.FORMAT_VERSION);
    expect(file.exportedAt).toBe("2026-08-24T00:00:00.000Z");
    expect(Array.isArray(file.dependencies)).toBe(true);
    expect(ruleInputSchema.safeParse(file.rule).success).toBe(true);
  });
});

// ─── (A) actions must be explicit ────────────────────────────────────────────

describe("(A) the action list is explicit and empty", () => {
  it("exports actions: [] — every action is wiring, and the audit Event needs none (rule 146)", () => {
    const { rule } = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { allAssets: true },
        actions: [notifyAction, apiCallAction, scriptAction],
      },
      CATALOGS,
    );
    expect(rule.actions).toEqual([]);
  });

  it("always emits an explicit (never absent) actions array", () => {
    for (const body of Object.values(fixtures())) {
      const { rule } = P.stripForExport(body, CATALOGS);
      expect(Array.isArray(rule.actions)).toBe(true);
    }
  });

  it("drops the retired event action, chain and all", () => {
    const { rule } = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { allAssets: true },
        actions: [{ type: "event", escalation: { stopOn: "clear", tiers: [{ afterMin: 5, actions: [notifyAction] }] } }],
      },
      CATALOGS,
    );
    expect(rule.actions).toEqual([]);
    expect(ruleInputSchema.safeParse(rule).success).toBe(true);
  });
});

// ─── (B) never emit an empty scope ───────────────────────────────────────────

describe("(B) an empty scope is never emitted", () => {
  it("a scope of only pinned assetIds becomes an empty CONDITION TREE, not {}", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { assetIds: ["a1", "a2"] },
      },
      CATALOGS,
    );
    // {} would mean MATCH NOTHING while rendering as "All assets" checked.
    expect(s.rule.scope).toEqual({ condition: { op: "and", children: [] } });
    expect(s.needsDevices).toBe(true);
  });

  it("flags needsDevices so the caller can force a re-pick", () => {
    const s = P.stripForExport(
      { name: "n", severity: "warning", trigger: { type: "event", actionPattern: "x" }, scope: { integrationIds: ["i1"] } },
      CATALOGS,
    );
    expect(s.needsDevices).toBe(true);
  });

  it("keeps a real scope untouched and does not flag it", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { assetTypes: ["switch"], assetIds: ["a1"] },
      },
      CATALOGS,
    );
    expect(s.rule.scope).toEqual({ assetTypes: ["switch"] });
    expect(s.needsDevices).toBe(false);
  });

  it("removes an emptied nested group instead of leaving it true-for-every-asset", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: {
          condition: {
            op: "and",
            children: [
              { field: "tag", operator: "has", value: "critical" },
              { op: "or", children: [{ field: "assetId", operator: "equals", value: "a1" }] },
            ],
          },
        },
      },
      CATALOGS,
    );
    // An empty AND group evaluates true for every asset, so it must be REMOVED
    // from its parent, not preserved as an empty group.
    expect(s.rule.scope).toEqual({
      condition: { op: "and", children: [{ field: "tag", operator: "has", value: "critical" }] },
    });
  });

  it("a condition tree of nothing but assetId leaves collapses to the refused-empty tree", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { condition: { op: "and", children: [{ field: "assetId", operator: "equals", value: "a1" }] } },
      },
      CATALOGS,
    );
    expect(s.rule.scope).toEqual({ condition: { op: "and", children: [] } });
    expect(s.needsDevices).toBe(true);
  });
});

// ─── (C) blanked dimensions must be reported ─────────────────────────────────

describe("(C) blanking an id-valued dimension is reported, not silent", () => {
  it("reports a blanked stateProbeId and names the probe as a dependency", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: {
          type: "asset_metric",
          metric: "customStateValue",
          aggregation: "latest",
          windowSec: 0,
          operator: "==",
          threshold: 1,
          forDurationSec: 0,
          dimensionFilter: { stateProbeId: "sp1", stateRowPattern: "PSU" },
        },
        scope: { allAssets: true },
        actions: [{ type: "event" }],
      },
      CATALOGS,
    );
    expect(s.blankedDimensions).toContain("stateProbeId");
    // The filter is GONE (leaving it would carry a foreign id) ...
    expect((s.rule.trigger as { dimensionFilter: Record<string, unknown> }).dimensionFilter.stateProbeId).toBeUndefined();
    // ... and the sibling pattern survives.
    expect((s.rule.trigger as { dimensionFilter: Record<string, unknown> }).dimensionFilter.stateRowPattern).toBe("PSU");
    // ... and the operator can see WHAT to re-pick.
    expect(s.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "stateProbe", name: "PSU alarm" })]),
    );
  });

  it("reaches dimension filters nested inside composite children", () => {
    const s = P.stripForExport(fixtures()["composite trigger with per-leaf dimension filters"], CATALOGS);
    expect(s.blankedDimensions).toEqual(expect.arrayContaining(["stateProbeId", "widgetId"]));
    const kids = (s.rule.trigger as { children: { dimensionFilter?: Record<string, unknown> }[] }).children;
    expect(kids[0]!.dimensionFilter!.stateProbeId).toBeUndefined();
    expect(kids[0]!.dimensionFilter!.sensorClass).toBe("temperature");
    expect(kids[1]!.dimensionFilter!.widgetId).toBeUndefined();
  });

  it("reaches dimension filters inside a custom reset condition tree", () => {
    const s = P.stripForExport(
      {
        name: "n",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
        scope: { allAssets: true },
        reset: {
          mode: "condition",
          condition: {
            op: "and",
            children: [
              {
                type: "asset_metric",
                metric: "customStateValue",
                aggregation: "latest",
                windowSec: 300,
                operator: "==",
                threshold: 0,
                forDurationSec: 0,
                dimensionFilter: { stateProbeId: "sp1" },
              },
            ],
          },
        },
        actions: [{ type: "event" }],
      },
      CATALOGS,
    );
    expect(s.blankedDimensions).toContain("stateProbeId");
    const leaf = (s.rule.reset as { condition: { children: { dimensionFilter?: Record<string, unknown> }[] } }).condition.children[0]!;
    expect(leaf.dimensionFilter!.stateProbeId).toBeUndefined();
  });

  it("leaves a trigger with no id-valued dimension unflagged", () => {
    const s = P.stripForExport(fixtures()["numeric metric with severity bands"], CATALOGS);
    expect(s.blankedDimensions).toEqual([]);
  });
});

// ─── No secrets, no ids ──────────────────────────────────────────────────────

describe("an exported file carries no secrets and no install-specific ids", () => {
  it("omits api_call headers, channel/script/user/role/probe ids", () => {
    const text = JSON.stringify(P.buildExportFile(fixtures()["numeric metric with severity bands"], CATALOGS));
    for (const needle of ["SUPER-SECRET-TOKEN", "Bearer", '"ch1"', '"sc1"', '"u1"', '"r1"', '"sp1"', "a@example.com"]) {
      expect(text, `exported file must not contain ${needle}`).not.toContain(needle);
    }
  });

  it("omits `enabled` so an import cannot arrive pre-enabled", () => {
    for (const body of Object.values(fixtures())) {
      const { rule } = P.stripForExport(body, CATALOGS);
      expect(rule.enabled).toBeUndefined();
    }
  });

  it("drops rule-level escalation and emailComposition but names their channels", () => {
    const s = P.stripForExport(fixtures()["numeric metric with severity bands"], CATALOGS);
    expect(s.rule.escalation).toBeUndefined();
    expect(s.rule.emailComposition).toBeUndefined();
    expect(s.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "deliveryChannel", name: "SMTP - NOC" })]),
    );
  });

  it("empties each severity band's actions but keeps its threshold ladder", () => {
    const s = P.stripForExport(fixtures()["numeric metric with severity bands"], CATALOGS);
    const bands = s.rule.severityBands as { threshold: number; severity: string; actions: unknown[]; escalation?: unknown }[];
    expect(bands.map((b) => [b.severity, b.threshold])).toEqual([
      ["serious", 90],
      ["critical", 95],
    ]);
    bands.forEach((b) => {
      expect(b.actions).toEqual([]);
      expect(b.escalation).toBeUndefined();
    });
    expect(bands[1]!.forDurationSec).toBe(60);
  });

  it("keeps bandNotify policy but not its resolvedActions", () => {
    const s = P.stripForExport(fixtures()["numeric metric with severity bands"], CATALOGS);
    expect(s.rule.bandNotify).toEqual({
      onIncrease: true,
      onDecrease: true,
      onResolved: false,
      resolvedMode: "dedicated",
    });
  });

  it("names a legacy email escalation tier's channel as a dependency", () => {
    const s = P.stripForExport(fixtures()["legacy escalation email tiers"], CATALOGS);
    expect(s.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "deliveryChannel", name: "SMTP - NOC" })]),
    );
  });

  it("labels an unresolvable pinned device as an id rather than passing it off as a hostname", () => {
    const s = P.stripForExport(
      { name: "n", severity: "warning", trigger: { type: "event", actionPattern: "x" }, scope: { assetIds: ["a1", "unknown-id"] } },
      CATALOGS,
    );
    const assets = s.dependencies.filter((d) => d.kind === "asset");
    const resolved = assets.find((d) => d.name === "CORE-SW-01");
    const unresolved = assets.find((d) => d.name === "device id unknown-id");
    // A resolvable id becomes the hostname and is not flagged ...
    expect(resolved).toBeDefined();
    expect(resolved!.unresolved).toBeUndefined();
    // ... an unresolvable one is labelled as an id, never passed off as a name.
    expect(unresolved).toBeDefined();
    expect(unresolved!.unresolved).toBe(true);
  });

  it("collapses one channel referenced from many places into a single dependency", () => {
    const s = P.stripForExport(fixtures()["numeric metric with severity bands"], CATALOGS);
    const channels = s.dependencies.filter((d) => d.kind === "deliveryChannel");
    expect(channels).toHaveLength(1);
    // ... while still listing every place it was used.
    expect(channels[0]!.usedFor).toContain("Action");
  });
});

// ─── Filenames ──────────────────────────────────────────────────────────────

describe("nameFromFilename", () => {
  it("uses the basename minus the extension", () => {
    expect(P.nameFromFilename("CPU high.automation.json")).toBe("CPU high");
    expect(P.nameFromFilename("CPU high.json")).toBe("CPU high");
    expect(P.nameFromFilename("no-extension")).toBe("no-extension");
  });

  it("keeps hyphens and inner punctuation — only path and control chars go", () => {
    expect(P.nameFromFilename("Switch temp-high (west).automation.json")).toBe("Switch temp-high (west)");
  });

  it("strips path components, including traversal", () => {
    expect(P.nameFromFilename("../../etc/passwd.json")).toBe("passwd");
    expect(P.nameFromFilename("C:\\Users\\x\\rule.automation.json")).toBe("rule");
    expect(P.nameFromFilename("/tmp/a/b/rule.json")).toBe("rule");
  });

  it("refuses names that scrub away to nothing", () => {
    expect(P.nameFromFilename("..")).toBe("");
    expect(P.nameFromFilename(".json")).toBe("");
    expect(P.nameFromFilename("   .json")).toBe("");
    expect(P.nameFromFilename("")).toBe("");
    expect(P.nameFromFilename(null)).toBe("");
  });

  it("removes control characters and collapses whitespace", () => {
    expect(P.nameFromFilename("a\u0000b\u001fc.json")).toBe("a b c");
    expect(P.nameFromFilename("  lots   of   space .json")).toBe("lots of space");
  });

  it("caps at the schema's 200-character name limit", () => {
    const out = P.nameFromFilename("x".repeat(400) + ".json");
    expect(out.length).toBe(200);
  });

  it("does not treat an HTML-ish filename as special (escaping is the renderer's job)", () => {
    expect(P.nameFromFilename("<img onerror=x>.json")).toBe("<img onerror=x>");
  });
});

describe("filenameForExport", () => {
  it("appends the double extension", () => {
    expect(P.filenameForExport("Switch temp high")).toBe("Switch temp high.automation.json");
  });

  it("replaces characters that are illegal in a filename", () => {
    expect(P.filenameForExport('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j.automation.json");
  });

  it("falls back to a usable name when the automation name is empty", () => {
    expect(P.filenameForExport("")).toBe("automation.automation.json");
    expect(P.filenameForExport(null)).toBe("automation.automation.json");
  });

  it("round-trips a normal name through both directions", () => {
    const name = "Switch temp-high (west)";
    expect(P.nameFromFilename(P.filenameForExport(name))).toBe(name);
  });
});

// ─── Import parsing ─────────────────────────────────────────────────────────

describe("parseImportFile", () => {
  const TRIGGER_TYPES = ["asset_metric", "asset_state", "host_metric", "event", "change", "composite"];

  function fileText(overrides?: Record<string, unknown>): string {
    return JSON.stringify({
      polarisAutomation: 1,
      dependencies: [],
      rule: {
        name: "ignored — the filename wins",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80, forDurationSec: 0 },
        scope: { allAssets: true },
        actions: [{ type: "event" }],
        ...overrides,
      },
    });
  }

  it("takes the name from the FILENAME, not the file body", () => {
    const r = P.parseImportFile(fileText(), "My rule.automation.json", TRIGGER_TYPES);
    expect(r.name).toBe("My rule");
    expect(r.rule.name).toBe("My rule");
  });

  it("produces a body the real schema accepts", () => {
    const r = P.parseImportFile(fileText(), "My rule.automation.json", TRIGGER_TYPES);
    expect(ruleInputSchema.safeParse(r.rule).success).toBe(true);
  });

  it("accepts a bare rule body (pasted out of View code)", () => {
    const bare = JSON.stringify({
      name: "x",
      severity: "warning",
      trigger: { type: "event", actionPattern: "a.b" },
      scope: {},
      actions: [{ type: "event" }],
    });
    const r = P.parseImportFile(bare, "Pasted.json", TRIGGER_TYPES);
    expect(r.name).toBe("Pasted");
  });

  it("re-strips on the way in, so a hand-written file cannot smuggle a foreign id", () => {
    const hostile = JSON.stringify({
      rule: {
        name: "x",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 1, forDurationSec: 0 },
        scope: { allAssets: true },
        actions: [{ type: "notify", channelId: "someone-elses-channel" }, { type: "script", scriptId: "their-script", runOn: "server" }],
      },
    });
    const r = P.parseImportFile(hostile, "Hostile.json", TRIGGER_TYPES);
    expect(JSON.stringify(r.rule)).not.toContain("someone-elses-channel");
    expect(JSON.stringify(r.rule)).not.toContain("their-script");
    expect(r.rule.actions).toEqual([]);
  });

  it("rejects invalid JSON with a message naming the problem", () => {
    expect(() => P.parseImportFile("{not json", "a.json", TRIGGER_TYPES)).toThrow(/Invalid JSON/);
  });

  it("rejects an empty file", () => {
    expect(() => P.parseImportFile("", "a.json", TRIGGER_TYPES)).toThrow(/empty/i);
    expect(() => P.parseImportFile("   ", "a.json", TRIGGER_TYPES)).toThrow(/empty/i);
  });

  it("rejects a prototype-pollution key anywhere in the tree", () => {
    const nasty = '{"rule":{"trigger":{"type":"event"},"scope":{"__proto__":{"polluted":true}}}}';
    expect(() => P.parseImportFile(nasty, "a.json", TRIGGER_TYPES)).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a constructor / prototype key", () => {
    expect(() => P.parseImportFile('{"constructor":{}}', "a.json", TRIGGER_TYPES)).toThrow(/constructor/);
    expect(() => P.parseImportFile('{"a":{"prototype":{}}}', "a.json", TRIGGER_TYPES)).toThrow(/prototype/);
  });

  it("rejects a file that nests absurdly deeply", () => {
    let deep = "1";
    for (let i = 0; i < 40; i++) deep = `{"a":${deep}}`;
    expect(() => P.parseImportFile(deep, "a.json", TRIGGER_TYPES)).toThrow(/nests too deeply/);
  });

  it("rejects an oversized file", () => {
    const huge = '{"rule":{"trigger":{"type":"event"},"pad":"' + "x".repeat(300 * 1024) + '"}}';
    expect(() => P.parseImportFile(huge, "a.json", TRIGGER_TYPES)).toThrow(/too large/);
  });

  it("rejects a file with no trigger", () => {
    expect(() => P.parseImportFile('{"rule":{"name":"x"}}', "a.json", TRIGGER_TYPES)).toThrow(/no trigger/);
  });

  it("rejects an unknown trigger type rather than throwing mid-render", () => {
    expect(() => P.parseImportFile('{"rule":{"trigger":{"type":"nonsense"}}}', "a.json", TRIGGER_TYPES)).toThrow(
      /unknown trigger type/,
    );
  });

  it("rejects a non-list actions field", () => {
    expect(() =>
      P.parseImportFile('{"rule":{"trigger":{"type":"event"},"actions":"nope"}}', "a.json", TRIGGER_TYPES),
    ).toThrow(/not a list/);
  });

  it("refuses a filename that scrubs away to nothing", () => {
    expect(() => P.parseImportFile(fileText(), "..", TRIGGER_TYPES)).toThrow(/Rename the file/);
  });

  it("warns — but proceeds — on a future format version", () => {
    const future = JSON.stringify({
      polarisAutomation: 99,
      rule: {
        name: "x",
        severity: "warning",
        trigger: { type: "event", actionPattern: "a" },
        scope: {},
        actions: [{ type: "event" }],
      },
    });
    const r = P.parseImportFile(future, "Future.json", TRIGGER_TYPES);
    expect(r.problems.join(" ")).toMatch(/format version 99/);
    expect(r.rule.name).toBe("Future");
  });
});

// ─── Dependency checking ────────────────────────────────────────────────────

describe("checkDependencies", () => {
  it("reports present vs missing against the install's catalogs", () => {
    const checked = P.checkDependencies(
      [
        { kind: "deliveryChannel", name: "SMTP - NOC" },
        { kind: "deliveryChannel", name: "Teams - NetOps" },
        { kind: "script", name: "restart-nginx" },
        { kind: "role", name: "NOC" },
        { kind: "role", name: "Nobody" },
        { kind: "region", name: "Nashville" },
        { kind: "user", name: "dmoore" },
        { kind: "stateProbe", name: "PSU alarm" },
      ],
      CATALOGS,
    );
    expect(checked.map((c) => c.present)).toEqual([true, false, true, true, false, true, true, true]);
  });

  it("matches case-insensitively", () => {
    expect(P.checkDependencies([{ kind: "deliveryChannel", name: "smtp - noc" }], CATALOGS)[0]!.present).toBe(true);
  });

  it("reports null — not false — for a kind with no catalogue to check", () => {
    const checked = P.checkDependencies(
      [
        { kind: "asset", name: "device id abc" },
        { kind: "subnet", name: "10.0.0.0/8" },
        { kind: "emailAddress", name: "a@b.c" },
      ],
      CATALOGS,
    );
    // "can't tell" must never render as "missing".
    expect(checked.map((c) => c.present)).toEqual([null, null, null]);
  });

  it("handles a bare-string catalogue as well as {name} rows", () => {
    expect(P.checkDependencies([{ kind: "region", name: "Nashville" }], { regions: ["Nashville"] })[0]!.present).toBe(true);
  });

  it("survives missing catalogs entirely", () => {
    expect(P.checkDependencies([{ kind: "deliveryChannel", name: "x" }], {})[0]!.present).toBe(null);
    expect(P.checkDependencies([], undefined)).toEqual([]);
  });
});

describe("retired re-notify cooldown", () => {
  it("drops cooldownSec from the portable shape, in BOTH directions", () => {
    // stripForExport is what parseImportFile re-strips an INCOMING file
    // through, so this one assertion covers the half that matters: a
    // pre-cutover .automation.json must not import a suppression the builder
    // has no control for and clearNotificationCooldowns already cleared
    // everywhere else.
    const out = P.stripForExport({
      name: "Old export",
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
      scope: { allAssets: true },
      actions: [{ type: "event" }],
      cooldownSec: 600,
    }, {});
    expect(out.rule.cooldownSec).toBeNull();
  });
});

// ─── The code editor ────────────────────────────────────────────────────────

describe("forCodeView", () => {
  it("drops the legacy mirror columns", () => {
    // Leaving `targets` in the editor lets normalizeRuleInputCore rebuild
    // `actions` from it when the operator deletes `actions` — a lossy
    // resurrection that looks like it worked.
    const out = P.forCodeView({
      name: "n",
      actions: [{ type: "event" }],
      targets: [{ channelId: "ch1" }],
      clearBehavior: "auto",
      clearAfterSec: 60,
    });
    expect(out.targets).toBeUndefined();
    expect(out.clearBehavior).toBeUndefined();
    expect(out.clearAfterSec).toBeUndefined();
    expect(out.actions).toEqual([{ type: "event" }]);
  });

  it("drops server-owned and list-render-only columns", () => {
    const out = P.forCodeView({
      name: "n",
      id: "abc",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-02",
      createdBy: "dmoore",
      devicesSummary: "All devices",
      triggerSummary: "cpu high",
      triggerType: "asset_metric",
    });
    expect(Object.keys(out)).toEqual(["name"]);
  });

  it("does not mutate its input", () => {
    const src = { name: "n", targets: [{ channelId: "ch1" }] };
    P.forCodeView(src);
    expect(src.targets).toBeDefined();
  });
});

describe("diffForConfirm", () => {
  it("flags taking a disabled automation live as alarming", () => {
    const d = P.diffForConfirm({ enabled: false }, { enabled: true });
    expect(d).toEqual([expect.objectContaining({ key: "enabled", from: "false", to: "true", alarming: true })]);
  });

  it("flags removing the device filter and gutting the action list", () => {
    const d = P.diffForConfirm({ scope: { allAssets: true }, actions: [{ type: "notify" }] }, {});
    expect(d.filter((x) => x.alarming).map((x) => x.key).sort()).toEqual(["actions", "scope"]);
  });

  it("reports a cleared JSON column without calling it alarming", () => {
    const d = P.diffForConfirm({ severityBands: [{ threshold: 1 }] }, {});
    expect(d).toEqual([expect.objectContaining({ key: "severityBands", to: "(removed)", alarming: false })]);
  });

  it("is empty when nothing changed", () => {
    const body = { enabled: true, severity: "warning", scope: { allAssets: true }, actions: [{ type: "event" }] };
    expect(P.diffForConfirm(body, JSON.parse(JSON.stringify(body)))).toEqual([]);
  });

  it("treats an absent field and an explicit null as the same", () => {
    expect(P.diffForConfirm({ escalation: null }, {})).toEqual([]);
  });
});
