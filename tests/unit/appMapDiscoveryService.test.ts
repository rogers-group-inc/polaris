/**
 * tests/unit/appMapDiscoveryService.test.ts
 *
 * Pure-logic coverage for the service & process DISCOVERY RULES (Integrations →
 * Polaris Agent): normalizeRule / normalizeConfig (validation, dedup, pattern
 * compilation, mode/source/assetIds, and the fold-forward of the pre-rules
 * single-selection shape), resolveBlockPins (which reported names a block
 * selects), and applyPinChangesToConfig (the auto-rule mint / consolidate /
 * trim / prune machinery behind the Services-tab Monitor/Map checkboxes).
 *
 * The DB-bound half (aggregates / previews / apply / unmapEverywhere /
 * recordOperatorPinChanges persistence) isn't exercised here — prisma is stubbed
 * only so importing the module doesn't open a connection.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    asset: { findMany: vi.fn(), update: vi.fn() },
    assetProcess: { findMany: vi.fn() },
    assetService: { findMany: vi.fn() },
    assetProcessConnection: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

import {
  normalizeRule,
  normalizeConfig,
  resolveBlockPins,
  emptyConfig,
  isRuleEmpty,
  applyPinChangesToConfig,
  PROCESS_CAPABLE_ASSET_TYPES,
  type AppMapAutoMapConfig,
  type OperatorPinChange,
} from "../../src/services/appMapDiscoveryService.js";

const block = (over: Record<string, unknown> = {}) =>
  ({ names: [], patterns: [], regex: false, ...over } as any);

const RULE = (over: Record<string, unknown> = {}) => ({ name: "R", ...over });
const SCOPE = { version: 1, match: "all", rules: [{ field: "assetType", op: "exact", values: ["server"] }] };

describe("normalizeRule", () => {
  it("requires a name", () => {
    expect(() => normalizeRule({ processes: { names: ["nginx"] } })).toThrow(/name is required/i);
    expect(() => normalizeRule(RULE({ name: "   " }))).toThrow(/name is required/i);
  });

  it("caps the name length", () => {
    expect(() => normalizeRule(RULE({ name: "x".repeat(65) }))).toThrow(/64 characters/);
  });

  it("mints an id when none is supplied and preserves one that is", () => {
    expect(normalizeRule(RULE()).id).toMatch(/[0-9a-f-]{36}/);
    expect(normalizeRule(RULE({ id: "keep-me" })).id).toBe("keep-me");
  });

  it("defaults enabled to true but honours an explicit false", () => {
    expect(normalizeRule(RULE()).enabled).toBe(true);
    expect(normalizeRule(RULE({ enabled: false })).enabled).toBe(false);
  });

  it("keeps names, trims them, and drops blanks", () => {
    const r = normalizeRule(RULE({ processes: { names: ["  nginx ", "", "   ", "java"] } }));
    expect(r.processes.names).toEqual(["nginx", "java"]);
  });

  it("dedups case-insensitively but preserves the first spelling", () => {
    // Pins are matched against inventory case-sensitively, so folding case would
    // silently stop matching the real program name.
    const r = normalizeRule(RULE({ services: { names: ["MyApp.service", "myapp.service"] } }));
    expect(r.services.names).toEqual(["MyApp.service"]);
  });

  it("rejects a non-array names field and non-string entries", () => {
    expect(() => normalizeRule(RULE({ processes: { names: "nginx" } }))).toThrow(/array of strings/);
    expect(() => normalizeRule(RULE({ processes: { names: ["nginx", 7] } }))).toThrow(/array of strings/);
  });

  it("caps each list at 64 entries (matching the assets PUT)", () => {
    const many = Array.from({ length: 65 }, (_, i) => "p" + i);
    expect(() => normalizeRule(RULE({ processes: { names: many } }))).toThrow(/64 entries/);
  });

  it("rejects an invalid regex at save time rather than on every reconcile", () => {
    expect(() => normalizeRule(RULE({
      processes: { patterns: ["([unclosed"], regex: true },
    }))).toThrow(/Invalid regex/);
  });

  it("accepts wildcard patterns when regex is false", () => {
    const r = normalizeRule(RULE({ processes: { patterns: ["nginx*"], regex: false } }));
    expect(r.processes.patterns).toEqual(["nginx*"]);
    expect(r.processes.regex).toBe(false);
  });

  it("treats an unusable scope tree as no scope, not as match-nothing", () => {
    expect(normalizeRule(RULE({ scope: { version: 1, match: "all", rules: [] } })).scope).toBeNull();
  });

  // The flat builder's criteria fold forward into the shared condition tree, so
  // a rule written before the cutover opens in the new builder intact.
  it("folds legacy flat criteria forward into a condition tree", () => {
    const r = normalizeRule(RULE({ scope: SCOPE }));
    expect(r.scope).toEqual({ op: "and", children: [{ field: "assetType", operator: "equals", value: "server" }] });
  });

  it("keeps flat criteria the tree can't express (an integration rule) as they are", () => {
    const flat = { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] };
    const r = normalizeRule(RULE({ scope: flat }));
    expect(r.scope).toEqual(flat);
  });

  it("accepts a condition tree over the device-filter vocabulary, tag included", () => {
    const tree = {
      op: "and",
      children: [
        { field: "tag", operator: "has", value: "prod" },
        { op: "or", children: [
          { field: "location", operator: "contains", value: "Ashfield" },
          { field: "subnet", operator: "inSubnetNamed", value: "Plant-*" },
        ] },
      ],
    };
    expect(normalizeRule(RULE({ scope: tree })).scope).toEqual(tree);
  });

  it("collapses an empty condition tree to no scope, never and([])", () => {
    // and([]) is true for every asset — storing it would be an all-assets rule
    // the operator never asked for.
    expect(normalizeRule(RULE({ scope: { op: "and", children: [] } })).scope).toBeNull();
  });

  it("rejects a tree field outside the device-filter vocabulary", () => {
    expect(() => normalizeRule(RULE({
      scope: { op: "and", children: [{ field: "bogus", operator: "equals", value: "x" }] },
    }))).toThrow(/Device filter is invalid/);
  });

  it("defaults mode to map (pre-mode rules were map rules) and honours monitor", () => {
    expect(normalizeRule(RULE()).mode).toBe("map");
    expect(normalizeRule(RULE({ mode: "monitor" })).mode).toBe("monitor");
    expect(normalizeRule(RULE({ mode: "bogus" })).mode).toBe("map");
  });

  it("defaults source to manual and honours auto", () => {
    expect(normalizeRule(RULE()).source).toBe("manual");
    expect(normalizeRule(RULE({ source: "auto" })).source).toBe("auto");
    expect(normalizeRule(RULE({ source: "robot" })).source).toBe("manual");
  });

  it("normalizes assetIds: trims, dedups case-SENSITIVELY, drops blanks", () => {
    const r = normalizeRule(RULE({ assetIds: [" a1 ", "", "a1", "A1"] }));
    expect(r.assetIds).toEqual(["a1", "A1"]);
    expect(normalizeRule(RULE()).assetIds).toEqual([]);
  });

  it("rejects a non-array assetIds", () => {
    expect(() => normalizeRule(RULE({ assetIds: "a1" }))).toThrow(/array of strings/);
  });
});

describe("normalizeConfig", () => {
  it("returns an empty config for null input", () => {
    expect(normalizeConfig(null)).toEqual(emptyConfig());
  });

  it("always stamps version 2", () => {
    expect(normalizeConfig({ version: 99, rules: [RULE({ processes: { names: ["x"] } })] }).version).toBe(2);
  });

  it("rejects duplicate rule names case-insensitively", () => {
    expect(() => normalizeConfig({
      rules: [RULE({ name: "Truckscale" }), RULE({ name: "truckscale" })],
    })).toThrow(/Duplicate rule name/);
  });

  it("rejects duplicate rule ids (an edit would otherwise fan out)", () => {
    expect(() => normalizeConfig({
      rules: [RULE({ name: "A", id: "same" }), RULE({ name: "B", id: "same" })],
    })).toThrow(/Duplicate rule id/);
  });

  it("caps the rule count (raised to 200 for single-item auto rules)", () => {
    const rules = Array.from({ length: 201 }, (_, i) => RULE({ name: "r" + i }));
    expect(() => normalizeConfig({ rules })).toThrow(/At most 200 rules/);
  });

  // The pre-rules shape was a single {processes, services, scope} selection. It
  // must fold forward rather than being read as "no rules", or an install that
  // configured the old modal silently loses its pins on upgrade.
  it("folds the pre-rules single selection forward into one rule", () => {
    const cfg = normalizeConfig({
      version: 1,
      processes: { names: ["nginx"] },
      services: { names: ["myapp.service"] },
      scope: SCOPE,
    });
    expect(cfg.version).toBe(2);
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.name).toBe("Imported selection");
    expect(cfg.rules[0]!.enabled).toBe(true);
    expect(cfg.rules[0]!.processes.names).toEqual(["nginx"]);
    expect(cfg.rules[0]!.services.names).toEqual(["myapp.service"]);
    expect(cfg.rules[0]!.scope).not.toBeNull();
  });

  it("folds an EMPTY legacy selection to no rules rather than an inert one", () => {
    expect(normalizeConfig({ version: 1, processes: { names: [] }, services: { names: [] } }).rules).toEqual([]);
  });

  it("leaves an already-v2 config alone", () => {
    const cfg = normalizeConfig({ version: 2, rules: [RULE({ name: "Keep", processes: { names: ["nginx"] } })] });
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.name).toBe("Keep");
  });
});

describe("isRuleEmpty", () => {
  it("is true when only a scope is set (a scope alone pins nothing)", () => {
    expect(isRuleEmpty(normalizeRule(RULE({ scope: SCOPE })))).toBe(true);
  });

  it("is false as soon as either side has a name or pattern", () => {
    expect(isRuleEmpty(normalizeRule(RULE({ processes: { names: ["nginx"] } })))).toBe(false);
    expect(isRuleEmpty(normalizeRule(RULE({ services: { patterns: ["*.service"] } })))).toBe(false);
  });
});

describe("PROCESS_CAPABLE_ASSET_TYPES", () => {
  // Inventory only ever comes from the agent / agentless SSH+WinRM, which land on
  // general-purpose hosts. Counting appliances made the wizard's device count
  // promise pins that could never happen. Widening this list is the single switch
  // for "processes on network hardware" later.
  it("is workstations and servers only", () => {
    expect([...PROCESS_CAPABLE_ASSET_TYPES]).toEqual(["workstation", "server"]);
  });

  it("excludes appliance types that never report an inventory", () => {
    for (const t of ["firewall", "switch", "access_point", "printer", "router", "hypervisor", "other"]) {
      expect(PROCESS_CAPABLE_ASSET_TYPES as readonly string[]).not.toContain(t);
    }
  });

  it("covers vCenter VMs, which are typed server", () => {
    expect(PROCESS_CAPABLE_ASSET_TYPES as readonly string[]).toContain("server");
  });
});

describe("resolveBlockPins", () => {
  const reported = ["nginx", "nginx-worker", "postgres", "java", "sshd"];

  it("selects nothing for an empty block", () => {
    expect(resolveBlockPins(block(), reported)).toEqual([]);
  });

  it("selects nothing when the host reports nothing", () => {
    expect(resolveBlockPins(block({ names: ["nginx"] }), [])).toEqual([]);
  });

  it("matches explicit names EXACTLY (no substring creep)", () => {
    expect(resolveBlockPins(block({ names: ["nginx"] }), reported)).toEqual(["nginx"]);
  });

  it("ignores selected names the host doesn't report", () => {
    expect(resolveBlockPins(block({ names: ["nginx", "redis"] }), reported)).toEqual(["nginx"]);
  });

  it("expands wildcard patterns", () => {
    expect(resolveBlockPins(block({ patterns: ["nginx*"] }), reported).sort())
      .toEqual(["nginx", "nginx-worker"]);
  });

  it("honours regex mode", () => {
    expect(resolveBlockPins(block({ patterns: ["^(java|sshd)$"], regex: true }), reported).sort())
      .toEqual(["java", "sshd"]);
  });

  it("unions names and patterns without duplicating an overlap", () => {
    const got = resolveBlockPins(block({ names: ["nginx", "postgres"], patterns: ["nginx*"] }), reported);
    expect(got.sort()).toEqual(["nginx", "nginx-worker", "postgres"]);
    expect(new Set(got).size).toBe(got.length);
  });
});

describe("applyPinChangesToConfig (auto rules from Services-tab pin toggles)", () => {
  const cfgOf = (...rules: unknown[]): AppMapAutoMapConfig =>
    normalizeConfig({ version: 2, rules });
  const change = (over: Partial<OperatorPinChange> = {}): OperatorPinChange => ({
    assetId: "asset-1", kind: "service", name: "nginx.service",
    surface: "map", action: "added", ...over,
  });

  it("mints a single-item auto rule for a first-time MAP pin", () => {
    const cfg = cfgOf();
    const out = applyPinChangesToConfig(cfg, [change()]);
    expect(out.changed).toBe(true);
    expect(out.createdRules).toEqual(["Auto: nginx.service"]);
    expect(cfg.rules.length).toBe(1);
    const r = cfg.rules[0]!;
    expect(r.source).toBe("auto");
    expect(r.mode).toBe("map");
    expect(r.scope).toBeNull();
    expect(r.assetIds).toEqual(["asset-1"]);
    expect(r.services.names).toEqual(["nginx.service"]);
    expect(r.processes.names).toEqual([]);
    expect(out.touchedRuleIds).toEqual([r.id]);
  });

  it("suffixes monitor-only auto rules and keeps the modes as separate rules", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change({ surface: "monitor" })]);
    applyPinChangesToConfig(cfg, [change({ surface: "map" })]);
    expect(cfg.rules.map((r) => r.name).sort()).toEqual([
      "Auto: nginx.service", "Auto: nginx.service (monitor)",
    ]);
    expect(cfg.rules.find((r) => r.mode === "monitor")).toBeTruthy();
    expect(cfg.rules.find((r) => r.mode === "map")).toBeTruthy();
  });

  it("consolidates: the same item pinned on a second asset joins the existing auto rule", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change({ assetId: "a1" })]);
    const out = applyPinChangesToConfig(cfg, [change({ assetId: "a2" })]);
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.assetIds).toEqual(["a1", "a2"]);
    expect(out.createdRules).toEqual([]);
    expect(out.updatedRules).toEqual(["Auto: nginx.service"]);
  });

  it("re-pinning an already-recorded asset is a no-op", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change()]);
    const out = applyPinChangesToConfig(cfg, [change()]);
    expect(out.changed).toBe(false);
    expect(cfg.rules[0]!.assetIds).toEqual(["asset-1"]);
  });

  it("NEVER consolidates into a manual rule, even a single-item one", () => {
    const cfg = cfgOf({
      name: "Hand-made", source: "manual", mode: "map",
      services: { names: ["nginx.service"] }, assetIds: ["a1"],
    });
    const out = applyPinChangesToConfig(cfg, [change({ assetId: "a2" })]);
    // A NEW auto rule appears instead of the manual rule growing.
    expect(cfg.rules.length).toBe(2);
    expect(cfg.rules[0]!.assetIds).toEqual(["a1"]);
    expect(out.createdRules.length).toBe(1);
    // ...and the auto rule's name dodges the collision-prone base by counter
    // only when needed (here the base name is free).
    expect(out.createdRules[0]).toBe("Auto: nginx.service");
  });

  it("disambiguates the auto name when an operator already took it", () => {
    const cfg = cfgOf({
      name: "Auto: nginx.service", source: "manual", mode: "map",
      services: { names: ["nginx.service", "other.service"] },
    });
    const out = applyPinChangesToConfig(cfg, [change()]);
    expect(out.createdRules).toEqual(["Auto: nginx.service 2"]);
  });

  it("unpinning takes the asset off the matching auto rule", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change({ assetId: "a1" }), change({ assetId: "a2" })]);
    const out = applyPinChangesToConfig(cfg, [change({ assetId: "a1", action: "removed" })]);
    expect(out.trimmedRules).toEqual(["Auto: nginx.service"]);
    expect(cfg.rules[0]!.assetIds).toEqual(["a2"]);
  });

  it("deletes an auto rule that loses its LAST asset (must not decay to match-everything)", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change()]);
    const out = applyPinChangesToConfig(cfg, [change({ action: "removed" })]);
    expect(out.prunedRules).toEqual(["Auto: nginx.service"]);
    expect(cfg.rules).toEqual([]);
  });

  it("unpinning never touches MANUAL rules (the reconcile re-pins by design)", () => {
    const cfg = cfgOf({
      name: "Hand-made", source: "manual", mode: "map",
      services: { names: ["nginx.service"] }, assetIds: ["asset-1"],
    });
    const out = applyPinChangesToConfig(cfg, [change({ action: "removed" })]);
    expect(out.changed).toBe(false);
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.assetIds).toEqual(["asset-1"]);
  });

  it("unpin only affects the matching surface's mode", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [change({ surface: "monitor" }), change({ surface: "map" })]);
    applyPinChangesToConfig(cfg, [change({ surface: "map", action: "removed" })]);
    expect(cfg.rules.length).toBe(1);
    expect(cfg.rules[0]!.mode).toBe("monitor");
  });

  it("keeps process and service pins in separate auto rules", () => {
    const cfg = cfgOf();
    applyPinChangesToConfig(cfg, [
      change({ kind: "process", name: "nginx" }),
      change({ kind: "service", name: "nginx" }),
    ]);
    expect(cfg.rules.length).toBe(2);
    const proc = cfg.rules.find((r) => r.processes.names.length)!;
    const svc = cfg.rules.find((r) => r.services.names.length)!;
    expect(proc.processes.names).toEqual(["nginx"]);
    expect(svc.services.names).toEqual(["nginx"]);
  });

  it("truncates very long item names into the 64-char rule-name cap", () => {
    const long = "x".repeat(120);
    const cfg = cfgOf();
    const out = applyPinChangesToConfig(cfg, [change({ name: long })]);
    expect(out.createdRules.length).toBe(1);
    expect(out.createdRules[0]!.length).toBeLessThanOrEqual(64);
    // The rule still pins the FULL name — only the display name is truncated.
    expect(cfg.rules[0]!.services.names).toEqual([long]);
    // And the whole config still round-trips validation.
    expect(() => normalizeConfig(cfg)).not.toThrow();
  });
});
