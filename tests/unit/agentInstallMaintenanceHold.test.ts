/**
 * tests/unit/agentInstallMaintenanceHold.test.ts
 *
 * Which agent operations hold the asset in maintenance, and which deliberately
 * do not (business rule 80).
 *
 * The operations that stop a RUNNING agent — upgrade, reinstall, uninstall —
 * cause the `agent.disconnected` they would otherwise page about, so they hold
 * the asset for the duration. A first install and a retry of a failed one take
 * no hold: there is no agent to disconnect, and suppressing alerts there would
 * silence a host that is still telling the truth about itself.
 *
 * The hold is taken in the SYNCHRONOUS half, before the background runner is
 * scheduled: the installer stops the service within seconds, and a hold that
 * lands after it has done so has missed the event it exists to catch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  // runUninstall/runInstall find no row and bail — this file is about the
  // synchronous half. Only the hold helper's select-shaped read gets a row.
  findUnique: vi.fn(async (args: { include?: unknown }) =>
    args.include ? null : { assetId: "asset-1" },
  ),
  openMaintenanceHold:    vi.fn(async () => true),
  releaseMaintenanceHold: vi.fn(async () => true),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    managedAgent: { findUnique: h.findUnique, update: vi.fn(async () => ({})) },
    asset:        { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({
  openMaintenanceHold:    h.openMaintenanceHold,
  releaseMaintenanceHold: h.releaseMaintenanceHold,
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { startInstall, startUninstall } from "../../src/services/agentInstallService.js";

const heldKinds = () =>
  h.openMaintenanceHold.mock.calls.map((c) => (c[0] as unknown as { kind: string }).kind);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agent operations and the maintenance hold", () => {
  it("holds for an uninstall", async () => {
    await startUninstall({ managedAgentId: "ma-1", credentialId: "cred-1" });

    expect(heldKinds()).toEqual(["agent-uninstall"]);
    expect(h.openMaintenanceHold).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: "asset-1", kind: "agent-uninstall" }),
    );
  });

  it("holds for a reinstall, which the route asks for by kind", async () => {
    await startInstall({ managedAgentId: "ma-1", credentialId: "cred-1", holdKind: "agent-reinstall" });

    expect(heldKinds()).toEqual(["agent-reinstall"]);
  });

  it("does NOT hold for a first install or a retry", async () => {
    await startInstall({ managedAgentId: "ma-1", credentialId: "cred-1" });

    expect(h.openMaintenanceHold).not.toHaveBeenCalled();
  });

  it("takes the hold before the background runner is scheduled", async () => {
    // Ordering is the whole point: the runner stops the agent service, and a
    // hold taken after that has already missed the disconnect.
    let heldBeforeReturn = false;
    h.openMaintenanceHold.mockImplementation(async () => { heldBeforeReturn = true; return true; });

    await startUninstall({ managedAgentId: "ma-1", credentialId: "cred-1" });

    expect(heldBeforeReturn).toBe(true);
  });

  it("carries on when the hold cannot be taken", async () => {
    // A hold is an improvement to an upgrade, never a precondition for one.
    h.openMaintenanceHold.mockRejectedValue(new Error("db down"));

    await expect(
      startUninstall({ managedAgentId: "ma-1", credentialId: "cred-1" }),
    ).resolves.toBeUndefined();
  });

  it("carries on when the agent row is gone", async () => {
    h.findUnique.mockResolvedValue(null);

    await expect(
      startUninstall({ managedAgentId: "ghost", credentialId: "cred-1" }),
    ).resolves.toBeUndefined();
    expect(h.openMaintenanceHold).not.toHaveBeenCalled();
  });
});
