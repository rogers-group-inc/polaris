/**
 * tests/unit/agentRebootPermissionService.test.ts — turning an agent host's
 * reboot opt-in on and off (business rule 115, CQ-T010): enable installs the
 * host permission BEFORE setting the flag and throws 502 (flag untouched) when
 * it cannot; disable clears the flag FIRST and keeps it cleared even when the
 * host cannot be reached; only an agent in a toggleable state is changed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getCredential: vi.fn(), applyOnHost: vi.fn(), refresh: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: h.getCredential }));
vi.mock("../../src/services/agentInstallService.js", () => ({ applyRebootPermissionOnHost: h.applyOnHost }));
vi.mock("../../src/services/agentCommandWake.js", () => ({ publishConfigRefresh: h.refresh }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { setAgentRebootEnabled } from "../../src/services/agentRebootPermissionService.js";

const findUnique = stubbed(prisma.managedAgent.findUnique);
const update = stubbed(prisma.managedAgent.update);
const agent = (over: Record<string, unknown> = {}) => ({
  id: "ag", osPlatform: "linux", installStatus: "active", installTransport: "ssh", installCredentialId: "c", rebootEnabled: false,
  asset: { hostname: "web1", ipAddress: "10.0.0.5", dnsName: null }, ...over,
});

beforeEach(() => {
  resetDbStub(); resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.getCredential.mockResolvedValue({ id: "c", config: { username: "u" } });
  h.refresh.mockResolvedValue(undefined);
});

describe("setAgentRebootEnabled", () => {
  it("404 without an agent, 409 while it is mid-install", async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(setAgentRebootEnabled({ assetId: "a", enabled: true, actor: "op" })).rejects.toMatchObject({ httpStatus: 404 });
    findUnique.mockResolvedValueOnce(agent({ installStatus: "installing" }));
    await expect(setAgentRebootEnabled({ assetId: "a", enabled: true, actor: "op" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it("enable: installs on the host first, then sets the flag and clears rebootCapable", async () => {
    findUnique.mockResolvedValue(agent());
    h.applyOnHost.mockResolvedValue(undefined);
    expect(await setAgentRebootEnabled({ assetId: "a", enabled: true, actor: "op" })).toEqual({ rebootEnabled: true, hostError: null });
    expect(h.applyOnHost.mock.calls[0][0]).toMatchObject({ host: "10.0.0.5", osPlatform: "linux", transport: "ssh", enable: true });
    expect(h.applyOnHost.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
    expect(update).toHaveBeenCalledWith({ where: { id: "ag" }, data: { rebootEnabled: true, rebootCapable: null } });
    expect(h.refresh).toHaveBeenCalledWith(["ag"]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.reboot_enabled", actor: "op" });
  });

  it("enable: a host failure is a 502, the flag stays off and a warning Event says why", async () => {
    findUnique.mockResolvedValue(agent());
    h.applyOnHost.mockRejectedValue(new Error("Permission denied"));
    await expect(setAgentRebootEnabled({ assetId: "a", enabled: true, actor: "op" })).rejects.toMatchObject({ httpStatus: 502 });
    expect(update).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.reboot_permission_failed", level: "warning" });
  });

  it("enable: a missing install credential refuses without touching the host", async () => {
    findUnique.mockResolvedValue(agent({ installCredentialId: null }));
    await expect(setAgentRebootEnabled({ assetId: "a", enabled: true, actor: "op" })).rejects.toThrow(/install credential/);
    expect(h.applyOnHost).not.toHaveBeenCalled();
  });

  it("disable: clears the flag first and keeps it cleared when the host cannot be reached", async () => {
    findUnique.mockResolvedValue(agent({ rebootEnabled: true }));
    h.applyOnHost.mockRejectedValue(new Error("unreachable"));
    const r = await setAgentRebootEnabled({ assetId: "a", enabled: false, actor: "op" });
    expect(r).toEqual({ rebootEnabled: false, hostError: "unreachable" });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(h.applyOnHost.mock.invocationCallOrder[0]);
    expect(update).toHaveBeenCalledWith({ where: { id: "ag" }, data: { rebootEnabled: false, rebootCapable: null } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.reboot_disabled", level: "warning" });
  });

  it("disable: a clean removal logs at info", async () => {
    findUnique.mockResolvedValue(agent({ rebootEnabled: true }));
    h.applyOnHost.mockResolvedValue(undefined);
    expect(await setAgentRebootEnabled({ assetId: "a", enabled: false, actor: "op" })).toEqual({ rebootEnabled: false, hostError: null });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "agent.reboot_disabled", level: "info" });
  });
});
