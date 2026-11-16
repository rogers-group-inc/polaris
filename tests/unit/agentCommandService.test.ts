/**
 * tests/unit/agentCommandService.test.ts — the agent command queue's delivery
 * shape and its result report (rules 115, 155).
 *
 * Expiry, the sweep and retention (rule 155) are pinned by
 * tests/unit/agentCommandExpiry.test.ts; this file covers what it does not:
 * fetchPendingCommands' view shape and bounds, and recordCommandResult —
 * ownership (404), the run_script completion + audit Event, the reboot ack
 * that writes nothing, and the generic audit for a foreign action.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/automationScriptService.js", () => ({ SCRIPT_OUTPUT_CAP_BYTES: 16 }));

import { fetchPendingCommands, recordCommandResult, commandExpiryCutoff } from "../../src/services/agentCommandService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const cmdFindMany = () => stubbed(prisma.agentCommand.findMany);
const cmdUpdateMany = () => stubbed(prisma.agentCommand.updateMany);
const cmdFindUnique = () => stubbed(prisma.agentCommand.findUnique);
const cmdUpdate = () => stubbed(prisma.agentCommand.update);
const runUpdateMany = () => stubbed(prisma.automationScriptRun.updateMany);
const runFindFirst = () => stubbed(prisma.automationScriptRun.findFirst);
const runUpdate = () => stubbed(prisma.automationScriptRun.update);

const event = (i = 0) => eventLog.logEvent.mock.calls[i][0] as unknown as Record<string, any>;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
});

describe("fetchPendingCommands", () => {
  const NOW = new Date("2026-11-16T12:00:00Z");

  it("asks for this agent's pending, unexpired commands, oldest first, at most 20", async () => {
    cmdFindMany().mockResolvedValue([]);
    await fetchPendingCommands("agent-1", NOW);
    expect(cmdFindMany().mock.calls[0][0]).toMatchObject({
      where: { managedAgentId: "agent-1", status: "pending", requestedAt: { gte: commandExpiryCutoff(NOW) } },
      orderBy: { requestedAt: "asc" },
      take: 20,
    });
  });

  it("writes nothing when there is nothing to hand out", async () => {
    cmdFindMany().mockResolvedValue([]);
    expect(await fetchPendingCommands("agent-1", NOW)).toEqual([]);
    expect(cmdUpdateMany()).not.toHaveBeenCalled();
    expect(runUpdateMany()).not.toHaveBeenCalled();
  });

  it("marks every handed-out command sent, and moves only run_script runs to running", async () => {
    cmdFindMany().mockResolvedValue([
      { id: "c1", action: "run_script", target: "fix.sh", payload: { runId: "r1" } },
      { id: "c2", action: "reboot", target: "host", payload: null },
    ]);
    await fetchPendingCommands("agent-1", NOW);
    expect(cmdUpdateMany().mock.calls[0][0]).toMatchObject({ where: { id: { in: ["c1", "c2"] } }, data: { status: "sent" } });
    expect(runUpdateMany().mock.calls[0][0]).toMatchObject({ where: { agentCommandId: { in: ["c1"] }, status: "pending" }, data: { status: "running" } });
  });

  it("skips the run update when no run_script went out", async () => {
    cmdFindMany().mockResolvedValue([{ id: "c2", action: "reboot", target: "host", payload: null }]);
    await fetchPendingCommands("agent-1", NOW);
    expect(runUpdateMany()).not.toHaveBeenCalled();
  });

  it("includes payload only when the command has one", async () => {
    cmdFindMany().mockResolvedValue([
      { id: "c1", action: "run_script", target: "fix.sh", payload: { runId: "r1" } },
      { id: "c2", action: "reboot", target: "host", payload: null },
    ]);
    expect(await fetchPendingCommands("agent-1", NOW)).toEqual([
      { id: "c1", action: "run_script", target: "fix.sh", payload: { runId: "r1" } },
      { id: "c2", action: "reboot", target: "host" },
    ]);
  });
});

describe("recordCommandResult — ownership", () => {
  it("is a 404 for a command that does not exist", async () => {
    cmdFindUnique().mockResolvedValue(null);
    await expect(recordCommandResult("agent-1", "c1", true, null, null)).rejects.toMatchObject({ httpStatus: 404 });
    expect(cmdUpdate()).not.toHaveBeenCalled();
  });

  it("is a 404 for another agent's command, and changes nothing", async () => {
    cmdFindUnique().mockResolvedValue({ id: "c1", managedAgentId: "agent-2", action: "run_script" });
    await expect(recordCommandResult("agent-1", "c1", true, null, null)).rejects.toMatchObject({ httpStatus: 404 });
    expect(cmdUpdate()).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("recordCommandResult — run_script", () => {
  const RUN = { id: "r1", scriptId: "s1", scriptName: "fix.sh", ruleId: "rule-1", notificationId: "n1", requestedBy: null };

  beforeEach(() => {
    cmdFindUnique().mockResolvedValue({ id: "c1", managedAgentId: "agent-1", assetId: "asset-1", action: "run_script", target: "fix.sh", requestedBy: null });
    runFindFirst().mockResolvedValue(RUN);
  });

  it("settles the command and the run, and audits the run once", async () => {
    await recordCommandResult("agent-1", "c1", true, null, "succeeded", { exitCode: 0, stdout: "ok", stderr: "" });
    expect(cmdUpdate().mock.calls[0][0].data).toMatchObject({ status: "succeeded", error: null, resultState: "succeeded" });
    expect(runUpdate().mock.calls[0][0]).toMatchObject({ where: { id: "r1" }, data: { status: "succeeded", exitCode: 0, stdout: "ok", stderr: null } });
    expect(eventLog.logEvent).toHaveBeenCalledOnce();
    expect(event()).toMatchObject({
      action: "automation.script.run", resourceType: "automation-script", resourceId: "s1", resourceName: "fix.sh",
      actor: "system:automation", level: "info",
      details: { runId: "r1", ruleId: "rule-1", notificationId: "n1", exitCode: 0, runOn: "agent", status: "succeeded", assetId: "asset-1" },
    });
    expect(event().message).toContain("(exit 0)");
  });

  it("takes the agent's observed resultState when it is a run status", async () => {
    await recordCommandResult("agent-1", "c1", false, "timed out", "timeout", { exitCode: null });
    expect(runUpdate().mock.calls[0][0].data.status).toBe("timeout");
    expect(event().level).toBe("warning");
    expect(event().message).toContain("(exit n/a)");
  });

  it("maps an unknown resultState from the success flag", async () => {
    await recordCommandResult("agent-1", "c1", false, null, "weird");
    expect(runUpdate().mock.calls[0][0].data.status).toBe("failed");
    runUpdate().mockClear();
    await recordCommandResult("agent-1", "c1", true, null, null);
    expect(runUpdate().mock.calls[0][0].data.status).toBe("succeeded");
  });

  it("falls back to the error text for stderr, and caps output at the script output cap", async () => {
    await recordCommandResult("agent-1", "c1", false, "interpreter not found", null, { stdout: "x".repeat(40) });
    const d = runUpdate().mock.calls[0][0].data;
    expect(d.stdout).toBe("x".repeat(16));
    expect(d.stderr).toBe("interpreter not ");
    expect(d.exitCode).toBeNull();
  });

  // Was a bug until 2026-11-16: output was cut at 16 UTF-16 chars, not 16 UTF-8 bytes.
  it("caps output by UTF-8 bytes without splitting a multi-byte character", async () => {
    // "é" is 2 bytes, "€" is 3: 7 × "é" = 14 bytes, then "€" would reach 17.
    await recordCommandResult("agent-1", "c1", true, null, "succeeded", { stdout: "ééééééé€x", stderr: "€".repeat(10) });
    const d = runUpdate().mock.calls[0][0].data;
    expect(d.stdout).toBe("ééééééé");
    expect(d.stderr).toBe("€".repeat(5));
  });

  it("stores null rather than empty strings when nothing was printed", async () => {
    await recordCommandResult("agent-1", "c1", true, null, "succeeded", { stdout: "", stderr: "" });
    expect(runUpdate().mock.calls[0][0].data).toMatchObject({ stdout: null, stderr: null });
  });

  it("names the operator who asked as the actor when there is one", async () => {
    runFindFirst().mockResolvedValue({ ...RUN, requestedBy: "alice" });
    await recordCommandResult("agent-1", "c1", true, null, "succeeded");
    expect(event().actor).toBe("alice");
  });

  it("settles the command and writes nothing else when its run row is gone", async () => {
    runFindFirst().mockResolvedValue(null);
    await recordCommandResult("agent-1", "c1", true, null, "succeeded");
    expect(cmdUpdate()).toHaveBeenCalledOnce();
    expect(runUpdate()).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("recordCommandResult — reboot and foreign actions", () => {
  it("records a reboot ack on the command and writes no Event (the reboot run owns them)", async () => {
    cmdFindUnique().mockResolvedValue({ id: "c1", managedAgentId: "agent-1", assetId: "asset-1", action: "reboot", target: "host" });
    await recordCommandResult("agent-1", "c1", true, null, "acknowledged");
    expect(cmdUpdate().mock.calls[0][0].data).toMatchObject({ status: "succeeded", resultState: "acknowledged" });
    expect(runFindFirst()).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("audits any other action generically against the asset", async () => {
    cmdFindUnique().mockResolvedValue({ id: "c1", managedAgentId: "agent-1", assetId: "asset-1", action: "service_restart", target: "nginx", requestedBy: "bob" });
    await recordCommandResult("agent-1", "c1", false, "refused", "refused");
    expect(cmdUpdate().mock.calls[0][0].data.status).toBe("failed");
    expect(event()).toMatchObject({
      action: "agent.command.service_restart.result", resourceType: "asset", resourceId: "asset-1", actor: "bob",
      level: "warning", message: 'Agent command "service_restart" on "nginx" failed: refused',
      details: { commandId: "c1", resultState: "refused" },
    });
  });
});
