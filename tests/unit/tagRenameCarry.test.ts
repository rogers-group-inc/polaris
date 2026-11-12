/**
 * tests/unit/tagRenameCarry.test.ts
 *
 * Business rule 169, the pure half: `rewriteTagRefs` renames a tag in the
 * three shapes that store its NAME, wherever they sit in a JSON tree, and
 * touches nothing else.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/appMapDiscoveryService.js", () => ({ getConfig: vi.fn(), saveConfig: vi.fn() }));

import { rewriteTagRefs, summarizeTagCarry } from "../../src/services/tagRenameCarryService.js";

const cond = (value: string, operator = "has") => ({ field: "tag", operator, value });

describe("rule 169: rewriteTagRefs", () => {
  it("renames a tag condition at any depth, matching the name case-insensitively", () => {
    const tree = { op: "and", children: [cond("Core"), { op: "or", children: [cond("core", "notHas"), cond("edge")] }] };
    expect(rewriteTagRefs(tree, "core", "backbone")).toEqual({
      op: "and", children: [cond("backbone"), { op: "or", children: [cond("backbone", "notHas"), cond("edge")] }],
    });
  });

  it("matches the whole name only", () => {
    const tree = { children: [cond("core-switch"), cond("my core")] };
    expect(rewriteTagRefs(tree, "core", "backbone")).toBe(tree);
  });

  it("leaves a condition on another field alone even when its value is the tag's name", () => {
    const tree = { children: [{ field: "hostname", operator: "contains", value: "core" }, { field: "assetType", operator: "equals", value: "core" }] };
    expect(rewriteTagRefs(tree, "core", "backbone")).toBe(tree);
  });

  it("renames inside recipientTags, and does not list a name twice", () => {
    const actions = [{ type: "notify", channelId: "c", recipientTags: ["Core", "edge"] }, { type: "notify", channelId: "c", recipientTags: ["core", "backbone"] }];
    expect(rewriteTagRefs(actions, "core", "backbone")).toEqual([
      { type: "notify", channelId: "c", recipientTags: ["backbone", "edge"] },
      { type: "notify", channelId: "c", recipientTags: ["backbone"] },
    ]);
  });

  it("renames one term of an ifTag list and keeps the others", () => {
    const trigger = { type: "asset_state", field: "ifOperStatus", dimensionFilter: { ifTag: "uplink|Core|wan", ifNamePattern: "core" } };
    expect(rewriteTagRefs(trigger, "core", "backbone")).toEqual(
      { type: "asset_state", field: "ifOperStatus", dimensionFilter: { ifTag: "uplink|backbone|wan", ifNamePattern: "core" } },
    );
  });

  it("returns the very same object when nothing names the tag, and never mutates its input", () => {
    const tree = { scope: { op: "and", children: [cond("edge")] }, actions: [{ type: "notify", recipientTags: ["ops"] }], n: 3, s: null };
    expect(rewriteTagRefs(tree, "core", "backbone")).toBe(tree);

    const hit = { scope: { op: "and", children: [cond("core")] } };
    const frozen = JSON.stringify(hit);
    const out = rewriteTagRefs(hit, "core", "backbone");
    expect(out).not.toBe(hit);
    expect(JSON.stringify(hit)).toBe(frozen);
  });

  it("passes non-objects through", () => {
    expect(rewriteTagRefs(null, "a", "b")).toBeNull();
    expect(rewriteTagRefs("core", "core", "b")).toBe("core");
    expect(rewriteTagRefs(7, "a", "b")).toBe(7);
  });
});

describe("rule 169: summarizeTagCarry", () => {
  const none = { users: 0, groupMappings: 0, automations: 0, alertGroups: 0, quietTimes: 0, pathChecks: 0, tagFilters: 0, contacts: 0, appMapRules: 0 };
  it("lists only what followed, singular and plural", () => {
    expect(summarizeTagCarry(none)).toBe("");
    expect(summarizeTagCarry({ ...none, users: 1, automations: 3, appMapRules: 1 })).toBe("1 user, 3 automations, 1 Application Map rule");
  });
});
