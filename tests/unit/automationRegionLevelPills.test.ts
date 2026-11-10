/**
 * tests/unit/automationRegionLevelPills.test.ts
 *
 * The level-scoped device-region pill: `deviceRegionLevel`, whose VALUE is the
 * asset-relative level. Unlike the other two dynamic kinds it is keyed by value
 * rather than by kind, because several levels can coexist on one action.
 *
 * Two behaviors are pinned deliberately:
 *   - a STORED level deeper than the catalogue still nests renders as an
 *     `unknown` pill rather than vanishing (same contract as an unknown user or
 *     role — losing a recipient silently is worse than showing a stub);
 *   - the levels round-trip SORTED and deduped, so re-saving an automation
 *     doesn't churn the stored shape.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { wizardSource } from "./_automationsWizardSource.js";

type Pill = { kind: string; value: string; label: string; unknown?: boolean };
type Recipients = {
  recipientUserIds?: string[];
  addresses?: string[];
  recipientRoles?: string[];
  recipientRegions?: string[];
  recipientDeviceRegion?: boolean;
  recipientDeviceRegionLevels?: number[];
  recipientAssetContacts?: boolean;
};

let pillsToRecipients: (p: Pill[]) => Recipients;
let recipientsToPills: (
  r: Recipients | null | undefined,
  users: unknown[],
  roles?: unknown[],
  maxLevel?: number,
) => Pill[];

beforeAll(() => {
  const src = wizardSource();
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.document = { addEventListener() {}, querySelector: () => null, getElementById: () => null };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  // The pill vocabulary lives in recipient-picker.js, which every page loads
  // before the wizard (2026-11-09).
  new vm.Script(readFileSync(resolve(__dirname, "../../public/js/recipient-picker.js"), "utf8"), { filename: "recipient-picker.js" }).runInContext(sandbox);
  new vm.Script(src, { filename: "automations-wizard.js" }).runInContext(sandbox);
  const api = (sandbox.window as Record<string, unknown>).PolarisAutomationRecipients as {
    pillsToRecipients: typeof pillsToRecipients;
    recipientsToPills: typeof recipientsToPills;
  };
  pillsToRecipients = api.pillsToRecipients;
  recipientsToPills = api.recipientsToPills;
});

describe("pillsToRecipients — level pills", () => {
  it("collects a level pill into recipientDeviceRegionLevels", () => {
    expect(pillsToRecipients([{ kind: "deviceRegionLevel", value: "2", label: "Asset’s L2 Region Users" }]))
      .toEqual({ recipientDeviceRegionLevels: [2] });
  });

  it("sorts and dedupes several levels", () => {
    expect(pillsToRecipients([
      { kind: "deviceRegionLevel", value: "3", label: "L3" },
      { kind: "deviceRegionLevel", value: "1", label: "L1" },
      { kind: "deviceRegionLevel", value: "3", label: "L3 again" },
    ])).toEqual({ recipientDeviceRegionLevels: [1, 3] });
  });

  it("is independent of the all-levels flag — both can be set", () => {
    expect(pillsToRecipients([
      { kind: "deviceRegion", value: "1", label: "Asset’s Region Users" },
      { kind: "deviceRegionLevel", value: "2", label: "Asset’s L2 Region Users" },
    ])).toEqual({ recipientDeviceRegion: true, recipientDeviceRegionLevels: [2] });
  });

  it("ignores a non-integer or zero level rather than storing it", () => {
    expect(pillsToRecipients([
      { kind: "deviceRegionLevel", value: "0", label: "L0" },
      { kind: "deviceRegionLevel", value: "abc", label: "bad" },
      { kind: "deviceRegionLevel", value: "1.5", label: "half" },
    ])).toEqual({});
  });

  it("mixes with every other pill kind", () => {
    const out = pillsToRecipients([
      { kind: "deviceRegionLevel", value: "2", label: "L2" },
      { kind: "user", value: "u1", label: "Jane" },
      { kind: "role", value: "r1", label: "NOC" },
      { kind: "region", value: "Atlanta", label: "Atlanta" },
      { kind: "address", value: "NOC@Example.com", label: "noc" },
    ]);
    expect(out).toEqual({
      recipientDeviceRegionLevels: [2],
      recipientUserIds: ["u1"],
      recipientRoles: ["r1"],
      recipientRegions: ["Atlanta"],
      addresses: ["noc@example.com"],
    });
  });
});

describe("recipientsToPills — level pills", () => {
  it("renders one pill per stored level, labelled by level", () => {
    const pills = recipientsToPills({ recipientDeviceRegionLevels: [1, 2] }, [], [], 3);
    expect(pills).toEqual([
      { kind: "deviceRegionLevel", value: "1", label: "Asset’s L1 Region Users", unknown: false },
      { kind: "deviceRegionLevel", value: "2", label: "Asset’s L2 Region Users", unknown: false },
    ]);
  });

  it("flags a stored level deeper than the catalogue still nests as UNKNOWN, never drops it", () => {
    const pills = recipientsToPills({ recipientDeviceRegionLevels: [4] }, [], [], 2);
    expect(pills).toHaveLength(1);
    expect(pills[0]).toMatchObject({ kind: "deviceRegionLevel", value: "4", unknown: true });
  });

  it("does not flag anything unknown when the depth is not known", () => {
    // maxLevel omitted (an older payload, or the scope-options fetch failed):
    // guessing "unknown" would put a scary stub on a perfectly good automation.
    const pills = recipientsToPills({ recipientDeviceRegionLevels: [4] }, []);
    expect(pills[0]).toMatchObject({ unknown: false });
  });

  it("renders the all-levels flag and the level pills together, broadest first", () => {
    const pills = recipientsToPills(
      { recipientDeviceRegion: true, recipientDeviceRegionLevels: [2] },
      [], [], 2,
    );
    expect(pills.map((p) => p.kind)).toEqual(["deviceRegion", "deviceRegionLevel"]);
  });

  it("round-trips pills → payload → pills", () => {
    const start: Pill[] = [
      { kind: "deviceRegionLevel", value: "1", label: "Asset’s L1 Region Users" },
      { kind: "deviceRegionLevel", value: "2", label: "Asset’s L2 Region Users" },
    ];
    const back = recipientsToPills(pillsToRecipients(start), [], [], 3);
    expect(back.map((p) => p.value)).toEqual(["1", "2"]);
  });

  it("omits the key entirely when no level pill is present", () => {
    expect(pillsToRecipients([{ kind: "user", value: "u1", label: "Jane" }]))
      .not.toHaveProperty("recipientDeviceRegionLevels");
  });
});
