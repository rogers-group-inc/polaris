/**
 * tests/unit/agentDeployService.test.ts — the per-asset agent verbs moved out
 * of routes/assets/agent.ts (CQ-B062 slice 2): the card strips secrets and is
 * null for no agent, install refuses what cannot take an agent, retry only
 * resets a failed install, and removal revokes first (force drops the row).
 * The permission gates stay covered by tests/integration/agentDeployGrant.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  agentFindUnique: vi.fn(), agentUpdate: vi.fn(), agentDelete: vi.fn(), agentCreate: vi.fn(),
  assetFindUnique: vi.fn(), assetUpdate: vi.fn(), connDeleteMany: vi.fn(), transaction: vi.fn(),
  logEvent: vi.fn(), getCredential: vi.fn(), revokeBearer: vi.fn(), startInstall: vi.fn(), startUninstall: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: {
    managedAgent: { findUnique: m.agentFindUnique, update: m.agentUpdate, delete: m.agentDelete, create: m.agentCreate },
    asset: { findUnique: m.assetFindUnique, update: m.assetUpdate },
    assetProcessConnection: { deleteMany: m.connDeleteMany },
    $transaction: m.transaction,
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: m.getCredential }));
vi.mock("../../src/services/agentTokenService.js", () => ({ revokeBearer: m.revokeBearer }));
vi.mock("../../src/services/agentInstallService.js", () => ({ startInstall: m.startInstall, startUninstall: m.startUninstall }));

import { getAgentCard, kickoffAgentInstall, retryAgentInstall, removeAgent } from "../../src/services/agentDeployService.js";

beforeEach(() => { for (const f of Object.values(m)) f.mockReset(); });

describe("getAgentCard", () => {
  it("is null when the asset has no agent", async () => {
    m.agentFindUnique.mockResolvedValue(null);
    expect(await getAgentCard("a")).toBeNull();
  });
  it("strips the enrollment and bearer secrets", async () => {
    m.agentFindUnique.mockResolvedValue({ id: "ag", enrollmentTokenHash: "h", enrollmentTokenPrefix: "p", bearerHash: "b", installStatus: "active", reportedCapEff: null });
    const card = await getAgentCard("a");
    expect(card).toMatchObject({ id: "ag", installStatus: "active" });
    expect(card).not.toHaveProperty("bearerHash");
    expect(card).not.toHaveProperty("enrollmentTokenHash");
    expect(card).not.toHaveProperty("enrollmentTokenPrefix");
  });
});

describe("kickoffAgentInstall", () => {
  const input = { credentialId: "c", osPlatform: "linux" as const, arch: "amd64" as const };
  it("404s an unknown asset and refuses hypervisors and containers", async () => {
    m.assetFindUnique.mockResolvedValueOnce(null);
    await expect(kickoffAgentInstall("a", input, "op")).rejects.toMatchObject({ httpStatus: 404 });
    for (const assetType of ["hypervisor", "container"]) {
      m.assetFindUnique.mockResolvedValueOnce({ id: "a", assetType, discoveredByIntegration: null });
      await expect(kickoffAgentInstall("a", input, "op")).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(m.agentCreate).not.toHaveBeenCalled();
  });
  it("refuses WinRM for a Linux host", async () => {
    m.assetFindUnique.mockResolvedValue({ id: "a", assetType: "server", discoveredByIntegration: null });
    await expect(kickoffAgentInstall("a", { ...input, transport: "winrm" }, "op")).rejects.toThrow(/WinRM transport is only valid for Windows/);
  });
});

describe("retryAgentInstall", () => {
  it("404 without a row, 409 unless failed, 400 when the credential is gone", async () => {
    m.agentFindUnique.mockResolvedValueOnce(null);
    await expect(retryAgentInstall("a", "op")).rejects.toMatchObject({ httpStatus: 404 });
    m.agentFindUnique.mockResolvedValueOnce({ id: "ag", installStatus: "active", installCredentialId: "c" });
    await expect(retryAgentInstall("a", "op")).rejects.toMatchObject({ httpStatus: 409 });
    m.agentFindUnique.mockResolvedValueOnce({ id: "ag", installStatus: "failed", installCredentialId: "c" });
    m.getCredential.mockRejectedValueOnce(new Error("gone"));
    await expect(retryAgentInstall("a", "op")).rejects.toMatchObject({ httpStatus: 400 });
    expect(m.startInstall).not.toHaveBeenCalled();
  });
  it("resets a failed install to pending and starts it", async () => {
    m.agentFindUnique.mockResolvedValue({ id: "ag", installStatus: "failed", installCredentialId: "c", osPlatform: "linux", arch: "amd64" });
    m.getCredential.mockResolvedValue({ id: "c" });
    expect(await retryAgentInstall("a", "op")).toEqual({ managedAgentId: "ag", installStatus: "pending" });
    expect(m.agentUpdate).toHaveBeenCalledWith({ where: { id: "ag" }, data: { installStatus: "pending", installError: null } });
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.install_retry", actor: "op" });
    expect(m.startInstall).toHaveBeenCalledWith({ managedAgentId: "ag", credentialId: "c" });
  });
});

describe("removeAgent", () => {
  it("revokes the bearer before anything else, then force-drops the row in one transaction", async () => {
    m.agentFindUnique.mockResolvedValue({ id: "ag", installCredentialId: "c" });
    m.transaction.mockResolvedValue([]);
    expect(await removeAgent("a", "op", true)).toEqual({ ok: true, forced: true });
    expect(m.revokeBearer).toHaveBeenCalledWith("ag");
    expect(m.revokeBearer.mock.invocationCallOrder[0]).toBeLessThan(m.transaction.mock.invocationCallOrder[0]);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.force_removed" });
    expect(m.startUninstall).not.toHaveBeenCalled();
  });
  it("leaves the row revoked with a warning when the install credential is gone", async () => {
    m.agentFindUnique.mockResolvedValue({ id: "ag", installCredentialId: null });
    const r = await removeAgent("a", "op", false);
    expect(r).toMatchObject({ ok: true, forced: false, installStatus: "revoked" });
    expect(m.agentUpdate).toHaveBeenCalledWith({ where: { id: "ag" }, data: { installStatus: "revoked" } });
  });
  it("otherwise starts the remote uninstall", async () => {
    m.agentFindUnique.mockResolvedValue({ id: "ag", installCredentialId: "c" });
    expect(await removeAgent("a", "op", false)).toEqual({ ok: true, forced: false, installStatus: "uninstalling" });
    expect(m.startUninstall).toHaveBeenCalledWith({ managedAgentId: "ag", credentialId: "c" });
  });
});
