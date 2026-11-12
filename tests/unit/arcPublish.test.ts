/**
 * tests/unit/arcPublish.test.ts
 *
 * Running the SSH onboarding script on Azure Arc machines.
 *
 * Arc has no inert state — a run command EXECUTES on creation — so the safety
 * properties pinned here are about what gets targeted and what gets sent:
 * an explicit id list resolved against the live roster, per-OS script routing
 * that skips rather than guesses, and per-item tolerance so one bad machine
 * cannot abort a batch (or, worse, silently shorten it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface FakeIntegration { id: string; name: string; type: string; config: Record<string, unknown> }
const db = { integrations: [] as FakeIntegration[] };

vi.mock("../../src/db.js", () => ({
  prisma: {
    integration: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        db.integrations.filter((i) => (where?.type ? i.type === where.type : true))),
      findUnique: vi.fn(async ({ where }: any) => db.integrations.find((i) => i.id === where.id) ?? null),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());

let roster: any[] = [];
const dispatchCalls: Array<{ targets: any[]; scripts: any; opts: any }> = [];
let dispatchImpl: (targets: any[], scripts: any) => any[] = (targets) =>
  targets.map((t: any) => ({ armId: t.armId, name: t.name, dispatched: true }));

vi.mock("../../src/services/azureArcService.js", () => ({
  listRunCommandTargets: vi.fn(async () => roster),
  dispatchRunCommand: vi.fn(async (_cfg: any, targets: any[], scripts: any, opts: any) => {
    dispatchCalls.push({ targets, scripts, opts });
    return dispatchImpl(targets, scripts);
  }),
  readRunCommandResult: vi.fn(async () => ({ provisioningState: "Succeeded", exitCode: 0, stdout: "ok", stderr: null })),
}));

vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingScript: vi.fn(async (platform: string) => ({
    platform, kind: "remediation",
    filename: platform === "linux" ? "onboard.sh" : "onboard.ps1",
    script: platform === "linux" ? "LINUX-SCRIPT" : "WINDOWS-SCRIPT",
  })),
}));

import {
  runOnboardingOnMachines,
  listPublishTargets,
  listMachines,
  ARC_RUN_COMMAND_NAME,
} from "../../src/services/arcPublishService.js";

const INT_ID = "11111111-1111-1111-1111-111111111111";

function machine(over: Partial<any> = {}) {
  return {
    armId: `/subscriptions/s/resourcegroups/rg/providers/microsoft.hybridcompute/machines/${over.name ?? "m1"}`,
    name: "m1", subscriptionId: "s", resourceGroup: "rg", azureRegion: "eastus",
    osType: "linux", status: "Connected", ...over,
  };
}

function seedEnabled(config: Record<string, unknown> = {}) {
  db.integrations.push({
    id: INT_ID, name: "Corp Arc", type: "azurearc",
    config: { tenantId: "t", clientId: "c", clientSecret: "s", allowRunCommand: true, ...config },
  });
}

beforeEach(() => {
  db.integrations = [];
  roster = [];
  dispatchCalls.length = 0;
  dispatchImpl = (targets) => targets.map((t: any) => ({ armId: t.armId, name: t.name, dispatched: true }));
  vi.clearAllMocks();
});

describe("target resolution", () => {
  it("resolves ids against the LIVE roster, not the request body", async () => {
    // The subscription/resourceGroup/region that end up in the ARM URL and body
    // must come from Azure, not from whatever a caller posted.
    seedEnabled();
    roster = [machine({ name: "real", resourceGroup: "rg-real", azureRegion: "westus" })];
    await runOnboardingOnMachines(INT_ID, [roster[0].armId], "tester");

    const sent = dispatchCalls[0].targets[0];
    expect(sent.resourceGroup).toBe("rg-real");
    expect(sent.azureRegion).toBe("westus");
  });

  it("matches ARM ids case-insensitively", async () => {
    seedEnabled();
    roster = [machine({ name: "m1" })];
    await runOnboardingOnMachines(INT_ID, [roster[0].armId.toUpperCase()], "tester");
    expect(dispatchCalls[0].targets).toHaveLength(1);
  });

  it("drops ids that are not in the roster and records them", async () => {
    seedEnabled();
    roster = [machine({ name: "known" })];
    await runOnboardingOnMachines(INT_ID, [roster[0].armId, "/subscriptions/x/…/bogus"], "tester");

    expect(dispatchCalls[0].targets).toHaveLength(1);
    const ev = eventLog.logEvent.mock.calls.map((c: any[]) => c[0])[0];
    expect(ev.details.unknownArmIds).toEqual(["/subscriptions/x/…/bogus"]);
  });

  it("refuses when NONE of the ids are in the roster", async () => {
    seedEnabled();
    roster = [machine({ name: "known" })];
    await expect(runOnboardingOnMachines(INT_ID, ["/nope"], "tester"))
      .rejects.toThrow(/none of the selected machines/i);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("refuses an empty selection and an oversized one", async () => {
    seedEnabled();
    roster = [machine()];
    await expect(runOnboardingOnMachines(INT_ID, [], "t")).rejects.toThrow(/at least one machine/i);
    const many = Array.from({ length: 201 }, (_, i) => `/id/${i}`);
    await expect(runOnboardingOnMachines(INT_ID, many, "t")).rejects.toThrow(/at most 200/i);
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe("scripts", () => {
  it("sends BOTH platform scripts so each machine gets the matching one", async () => {
    seedEnabled();
    roster = [machine({ name: "lin", osType: "linux" }), machine({ name: "win", osType: "windows" })];
    await runOnboardingOnMachines(INT_ID, roster.map((m) => m.armId), "tester");

    // Routing itself lives in dispatchRunCommand; what matters here is that
    // both bodies reach it, or the Windows machines would get a bash script.
    expect(dispatchCalls[0].scripts).toEqual({ windows: "WINDOWS-SCRIPT", linux: "LINUX-SCRIPT" });
  });

  it("uses a stable run-command name so re-running replaces rather than accumulates", async () => {
    seedEnabled();
    roster = [machine()];
    await runOnboardingOnMachines(INT_ID, [roster[0].armId], "tester");
    expect(dispatchCalls[0].opts.runCommandName).toBe(ARC_RUN_COMMAND_NAME);
  });
});

describe("opt-in gate", () => {
  it("refuses when the integration has not enabled run commands", async () => {
    seedEnabled({ allowRunCommand: false });
    roster = [machine()];
    await expect(runOnboardingOnMachines(INT_ID, [roster[0].armId], "t"))
      .rejects.toThrow(/Script Publishing tab/i);
    expect(dispatchCalls).toHaveLength(0); // nothing executed anywhere
  });

  it("refuses a non-Arc integration", async () => {
    db.integrations.push({ id: INT_ID, name: "Entra", type: "entraid", config: { allowRunCommand: true } });
    await expect(runOnboardingOnMachines(INT_ID, ["/x"], "t")).rejects.toThrow(/Azure Arc integration/i);
  });

  it("gates the read-only machine list on the same flag", async () => {
    seedEnabled({ allowRunCommand: false });
    await expect(listMachines(INT_ID)).rejects.toThrow(/not enabled/i);
  });
});

describe("partial failure", () => {
  it("reports dispatched / skipped / failed separately", async () => {
    // A caller that only saw successes could not tell "42 onboarded" from
    // "42 attempted, 30 skipped".
    seedEnabled();
    roster = [machine({ name: "a" }), machine({ name: "b" }), machine({ name: "c" })];
    dispatchImpl = (targets) => [
      { armId: targets[0].armId, name: "a", dispatched: true },
      { armId: targets[1].armId, name: "b", dispatched: false, skipped: "unknown OS type (none)" },
      { armId: targets[2].armId, name: "c", dispatched: false, error: "HTTP 403" },
    ];
    const res = await runOnboardingOnMachines(INT_ID, roster.map((m) => m.armId), "tester");
    expect(res).toMatchObject({ dispatched: 1, skipped: 1, failed: 1 });
    expect(res.results).toHaveLength(3);
  });
});

describe("audit", () => {
  it("stamps ONE warning event for the batch with the per-machine roll-up", async () => {
    // Per-machine events at 200 targets would bury the Events page.
    seedEnabled();
    roster = [machine({ name: "a" }), machine({ name: "b" })];
    await runOnboardingOnMachines(INT_ID, roster.map((m) => m.armId), "alice");

    const evs = eventLog.logEvent.mock.calls.map((c: any[]) => c[0])
      .filter((e: any) => e.action === "arc.run_command_executed");
    expect(evs).toHaveLength(1);
    expect(evs[0].level).toBe("warning");
    expect(evs[0].actor).toBe("alice");
    expect(evs[0].details.machines).toHaveLength(2);
    expect(evs[0].message).toMatch(/administrative SSH/);
  });
});

describe("listPublishTargets", () => {
  it("returns Arc integrations flagged by opt-in state", async () => {
    seedEnabled();
    db.integrations.push({
      id: "22222222-2222-2222-2222-222222222222", name: "Other Arc", type: "azurearc",
      config: { tenantId: "t", clientId: "c", clientSecret: "s" },
    });
    const targets = await listPublishTargets();
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.integrationName === "Corp Arc")!.enabled).toBe(true);
    // Disabled targets are returned so the UI can point at the checkbox.
    expect(targets.find((t) => t.integrationName === "Other Arc")!.enabled).toBe(false);
  });
});
