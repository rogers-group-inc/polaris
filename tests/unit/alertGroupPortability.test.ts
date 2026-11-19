/**
 * tests/unit/alertGroupPortability.test.ts — the Alert Groups tab's Export
 * (`buildGroupExportFile` in public/js/automations-portability.js) and the
 * code view's diff over group keys.
 *
 * The export follows the automation export's rule: nothing install-specific
 * travels as an id. Members and path checks go out BY NAME, the delivery half
 * only as named dependencies with `actions` emptied, and a device filter is
 * made portable as an automation's is.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

interface Portability {
  GROUP_FILE_SUFFIX: string;
  buildGroupExportFile(group: unknown, catalogs?: unknown, meta?: unknown): Record<string, any>;
  groupFilenameForExport(name: unknown): string;
  diffForConfirm(before: unknown, after: unknown, keys?: string[]): { key: string; alarming: boolean }[];
}

let P: Portability;

beforeAll(() => {
  const code = readFileSync(resolve(here, "../../public/js/automations-portability.js"), "utf8");
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  (0, eval)(code);
  P = (g.window as { PolarisAutomationPortability: Portability }).PolarisAutomationPortability;
});

const CATALOGS = {
  channels: [{ id: "ch1", name: "SMTP - NOC", type: "smtp" }],
  pathChecks: [{ id: "pc1", name: "ERP" }, { id: "pc2", name: "VPN" }],
};

const GROUP = {
  id: "g1", createdAt: "x", createdBy: "someone",
  name: "Branch paths", description: "d", enabled: true,
  scope: { allAssets: true },
  foldBy: "automation", minFailingPercent: 80,
  pathCheckIds: ["pc1", "gone"],
  messageTemplate: null, requireAckNote: true,
  repeat: { everyMin: 30, stopOn: "acknowledge" },
  actions: [{ type: "notify", channelId: "ch1", addresses: ["noc@example.test"] }],
  escalation: null, resetActions: null, emailComposition: null,
  rules: [{ id: "r1", name: "Path down" }],
};

describe("buildGroupExportFile", () => {
  it("carries the group's policy and names, never its ids", () => {
    const file = P.buildGroupExportFile(GROUP, CATALOGS, { exportedAt: "2026-11-19T00:00:00.000Z", polarisVersion: "0.9.1" });
    expect(file.polarisAlertGroup).toBe(1);
    expect(file.polarisVersion).toBe("0.9.1");
    expect(file.group).toEqual({
      name: "Branch paths", description: "d", enabled: true,
      scope: { allAssets: true },
      foldBy: "automation", minFailingPercent: 80,
      pathChecks: ["ERP", "gone"],
      automations: ["Path down"],
      messageTemplate: null, requireAckNote: true,
      repeat: { everyMin: 30, stopOn: "acknowledge" },
      actions: [],
    });
    const text = JSON.stringify(file);
    for (const id of ["g1", "ch1", "pc1", "r1"]) expect(text).not.toContain(`"${id}"`);
  });

  it("lists delivery, members and path checks as dependencies, an unknown check as unresolved", () => {
    const deps = P.buildGroupExportFile(GROUP, CATALOGS).dependencies as { kind: string; name: string; unresolved?: boolean }[];
    expect(deps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "automation", name: "Path down" }),
      expect.objectContaining({ kind: "pathCheck", name: "ERP" }),
      expect.objectContaining({ kind: "pathCheck", name: "gone", unresolved: true }),
    ]));
    expect(deps.some((d) => d.name === "SMTP - NOC")).toBe(true);
  });

  it("treats a missing scope as every device", () => {
    const file = P.buildGroupExportFile({ ...GROUP, scope: null }, CATALOGS);
    expect(file.group.scope).toEqual({ allAssets: true });
    expect(file.needsDeviceSelection).toBeUndefined();
  });

  it("names the file .alert-group.json", () => {
    expect(P.groupFilenameForExport("Branch: paths")).toBe("Branch- paths" + P.GROUP_FILE_SUFFIX);
    expect(P.GROUP_FILE_SUFFIX).toBe(".alert-group.json");
  });
});

describe("diffForConfirm with group keys", () => {
  it("flags emptying the members as alarming", () => {
    const d = P.diffForConfirm({ ruleIds: ["r1"] }, { ruleIds: [] }, ["ruleIds", "pathCheckIds"]);
    expect(d).toEqual([expect.objectContaining({ key: "ruleIds", alarming: true })]);
  });
});
