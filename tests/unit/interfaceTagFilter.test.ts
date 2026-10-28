/**
 * tests/unit/interfaceTagFilter.test.ts — business rule 133(g): an interface
 * condition narrowed to the ports carrying a tag (`dimensionFilter.ifTag`).
 *
 * The case that asked for it: one switch, several monitored ports, some tagged
 * "Critical" and some "Warning" — one automation per priority, each firing
 * only about its own ports.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  interfaceTagMatch,
  INTERFACE_TAG_TARGETS,
  triggerDimensionApplicable,
  ruleInputSchema,
  buildSchemaCatalog,
  triggerSignature,
  dimensionSpaceOf,
  type Trigger,
} from "../../src/services/notificationTypes.js";

describe("interfaceTagMatch", () => {
  it("matches a whole tag name, case-insensitively", () => {
    expect(interfaceTagMatch(["Critical"], "critical")).toBe(true);
    expect(interfaceTagMatch(["uplink", "Critical"], "Critical")).toBe(true);
    expect(interfaceTagMatch(["Warning"], "Critical")).toBe(false);
  });

  it("never matches a substring of a tag", () => {
    expect(interfaceTagMatch(["priority-critical"], "critical")).toBe(false);
    expect(interfaceTagMatch(["Crit"], "Critical")).toBe(false);
  });

  it("reads a \"|\" list as any-of", () => {
    expect(interfaceTagMatch(["Serious"], "Critical | Serious")).toBe(true);
    expect(interfaceTagMatch(["Warning"], "Critical|Serious")).toBe(false);
  });

  it("passes every port when unset, and no untagged port when set", () => {
    expect(interfaceTagMatch([], undefined)).toBe(true);
    expect(interfaceTagMatch(undefined, "")).toBe(true);
    expect(interfaceTagMatch(null, " | ")).toBe(true);
    expect(interfaceTagMatch([], "Critical")).toBe(false);
    expect(interfaceTagMatch(undefined, "Critical")).toBe(false);
  });
});

describe("INTERFACE_TAG_TARGETS", () => {
  it("is exactly the conditions that read one interface per reading", () => {
    expect([...INTERFACE_TAG_TARGETS].sort()).toEqual([
      "ifAdminStatus", "ifInBps", "ifInErrorRate", "ifIpAddress",
      "ifOperStatus", "ifOutBps", "ifOutErrorRate", "poeStatus",
    ]);
  });

  it("is what the dimension-values endpoint accepts for ifTag", () => {
    expect(triggerDimensionApplicable("ifOperStatus", "ifTag")).toBe(true);
    expect(triggerDimensionApplicable("ifInBps", "ifTag")).toBe(true);
    expect(triggerDimensionApplicable("cpuPct", "ifTag")).toBe(false);
    expect(triggerDimensionApplicable("monitorStatus", "ifTag")).toBe(false);
  });

  it("is published to the wizard", () => {
    expect(buildSchemaCatalog().interfaceTagTargets).toEqual([...INTERFACE_TAG_TARGETS]);
  });
});

describe("ifTag on a rule", () => {
  const down = (dimensionFilter: Record<string, string>) => ({
    name: "r",
    trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter },
  });

  it("saves on an interface condition", () => {
    expect(ruleInputSchema.safeParse(down({ ifTag: "Critical" })).success).toBe(true);
  });

  it("is refused on a condition that reads no interface", () => {
    const bad = ruleInputSchema.safeParse({
      name: "r",
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90, dimensionFilter: { ifTag: "Critical" } },
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/interface tag filter/);
  });

  it("is refused on a composite leaf that reads no interface", () => {
    const bad = ruleInputSchema.safeParse({
      name: "r",
      trigger: {
        type: "composite", op: "or",
        children: [
          { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifTag: "Critical" } },
          { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", dimensionFilter: { ifTag: "Critical" } },
        ],
      },
    });
    expect(bad.success).toBe(false);
  });

  it("gives a Critical and a Warning automation different signatures, and the same key space", () => {
    const crit = down({ ifTag: "Critical" }).trigger as Trigger;
    const warn = down({ ifTag: "Warning" }).trigger as Trigger;
    expect(triggerSignature(crit)).not.toBe(triggerSignature(warn));
    // Narrows readings, never re-keys them (reset trees stay in one space).
    expect(dimensionSpaceOf(crit)).toBe(dimensionSpaceOf({ type: "asset_state", field: "ifOperStatus" }));
  });
});
