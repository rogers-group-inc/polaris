/**
 * tests/integration/agentCommandExpiry.test.ts — business rule 154 against a
 * real database: the queries the unit test fakes (tests/unit/
 * agentCommandExpiry.test.ts) select and settle the rows they should.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  AGENT_COMMAND_TTL_MS,
  AGENT_COMMAND_RETENTION_DAYS,
  fetchPendingCommands,
  expireStaleAgentCommands,
  pruneOldAgentCommands,
} from "../../src/services/agentCommandService.js";

const d = dbDescribe;
const AGENT = "cmd-expiry-test-agent";
const ASSET = "cmd-expiry-test-asset";
const SCRIPT = "cmd-expiry-test.sh";
const MIN = 60_000;
const DAY = 24 * 3600 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function cleanup() {
  await prisma.automationScriptRun.deleteMany({ where: { scriptName: SCRIPT } });
  await prisma.agentCommand.deleteMany({ where: { managedAgentId: AGENT } });
  await prisma.event.deleteMany({ where: { resourceName: SCRIPT } });
}

async function queue(requestedAt: Date, status = "pending") {
  const run = await prisma.automationScriptRun.create({
    data: { scriptName: SCRIPT, sha256: "0".repeat(64), runOn: "agent", assetId: ASSET, ruleId: "deleted-rule", timeoutSec: 60, requestedBy: "system:automation", requestedAt },
  });
  const cmd = await prisma.agentCommand.create({
    data: { assetId: ASSET, managedAgentId: AGENT, action: "run_script", target: SCRIPT, payload: { runId: run.id, body: "echo hi" }, status, requestedAt },
  });
  await prisma.automationScriptRun.update({ where: { id: run.id }, data: { agentCommandId: cmd.id } });
  return { run, cmd };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("a queued agent command expires (rule 154)", () => {
  it("is not handed to an agent that reconnects after the window, and is settled by the sweep", async () => {
    const stale = await queue(ago(AGENT_COMMAND_TTL_MS + 5 * MIN));
    const fresh = await queue(ago(MIN));

    // The host comes back: it gets only the command queued inside the window.
    const got = await fetchPendingCommands(AGENT);
    expect(got.map((c) => c.id)).toEqual([fresh.cmd.id]);
    expect((await prisma.agentCommand.findUnique({ where: { id: stale.cmd.id } }))!.status).toBe("pending");

    const res = await expireStaleAgentCommands();
    expect(res.commands).toBeGreaterThanOrEqual(1);

    const cmd = await prisma.agentCommand.findUnique({ where: { id: stale.cmd.id } });
    expect(cmd!.status).toBe("failed");
    expect(cmd!.error).toMatch(/expired/);
    const run = await prisma.automationScriptRun.findUnique({ where: { id: stale.run.id } });
    expect(run!.status).toBe("failed");
    expect(run!.completedAt).not.toBeNull();
    const ev = await prisma.event.findFirst({ where: { action: "automation.script.run", resourceName: SCRIPT } });
    expect(ev!.level).toBe("warning");
    expect((ev!.details as { reason?: string }).reason).toBe("expired");

    // The delivered one is untouched.
    expect((await prisma.automationScriptRun.findUnique({ where: { id: fresh.run.id } }))!.status).toBe("running");
    // And nothing is left for the next poll.
    expect(await fetchPendingCommands(AGENT)).toEqual([]);
  });

  it("ages finished commands out with the run retention window", async () => {
    const old = await queue(ago((AGENT_COMMAND_RETENTION_DAYS + 1) * DAY), "failed");
    const recent = await queue(ago(DAY), "succeeded");
    await pruneOldAgentCommands();
    expect(await prisma.agentCommand.findUnique({ where: { id: old.cmd.id } })).toBeNull();
    expect(await prisma.agentCommand.findUnique({ where: { id: recent.cmd.id } })).not.toBeNull();
  });
});
