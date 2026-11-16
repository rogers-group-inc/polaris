/**
 * tests/unit/agentCommandWake.test.ts — the cross-process "wake this agent" and
 * "refetch your config" NOTIFYs. Best effort: never throws; the command poll
 * and the heartbeat configEtag are the guaranteed floors. Payloads go through
 * pg_notify parameters; the config refresh is chunked to stay under 8000 bytes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { publishCommandWake, publishConfigRefresh, CMD_WAKE_CHANNEL, CFG_REFRESH_CHANNEL } from "../../src/services/agentCommandWake.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const executeRaw = () => stubbed(prisma.$executeRaw);
const values = (i: number) => executeRaw().mock.calls[i].slice(1);

beforeEach(() => {
  resetDbStub();
  executeRaw().mockResolvedValue(1);
});

describe("channel names", () => {
  it("are lowercase literals (unquoted identifiers fold, and LISTEN must match)", () => {
    expect(CMD_WAKE_CHANNEL).toBe("polaris_agent_cmd_wake");
    expect(CFG_REFRESH_CHANNEL).toBe("polaris_agent_cfg_refresh");
  });
});

describe("publishCommandWake", () => {
  it("notifies the wake channel with the agent id as a bound parameter", async () => {
    await publishCommandWake("agent-1");
    expect(executeRaw()).toHaveBeenCalledOnce();
    expect(values(0)).toEqual([CMD_WAKE_CHANNEL, "agent-1"]);
    expect((executeRaw().mock.calls[0][0] as string[]).join("?")).toMatch(/pg_notify\(\?, \?\)/);
  });

  it("does nothing for an empty id", async () => {
    await publishCommandWake("");
    expect(executeRaw()).not.toHaveBeenCalled();
  });

  it("swallows a NOTIFY failure", async () => {
    executeRaw().mockRejectedValue(new Error("db down"));
    await expect(publishCommandWake("agent-1")).resolves.toBeUndefined();
  });
});

describe("publishConfigRefresh", () => {
  it("sends one comma-joined, deduped payload without blanks", async () => {
    await publishConfigRefresh(["a", "b", "", "a", "c"]);
    expect(executeRaw()).toHaveBeenCalledOnce();
    expect(values(0)).toEqual([CFG_REFRESH_CHANNEL, "a,b,c"]);
  });

  it("sends nothing for an empty list", async () => {
    await publishConfigRefresh([]);
    await publishConfigRefresh([""]);
    expect(executeRaw()).not.toHaveBeenCalled();
  });

  it("chunks at 150 ids so a payload of uuids stays under pg_notify's 8000-byte cap", async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await publishConfigRefresh(ids);
    expect(executeRaw()).toHaveBeenCalledTimes(3);
    const payloads = [0, 1, 2].map((i) => values(i)[1] as string);
    expect(payloads.map((p) => p.split(",").length)).toEqual([150, 150, 1]);
    for (const p of payloads) expect(Buffer.byteLength(p)).toBeLessThan(8000);
  });

  // Was a bug until 2026-11-16: the first failed chunk returned, so the remaining chunks were never sent.
  it("carries on with the remaining chunks after a failed one and does not throw", async () => {
    executeRaw().mockRejectedValueOnce(new Error("db down"));
    const ids = Array.from({ length: 200 }, (_, i) => `id${i}`);
    await expect(publishConfigRefresh(ids)).resolves.toBeUndefined();
    expect(executeRaw()).toHaveBeenCalledTimes(2);
    expect((values(1)[1] as string).split(",")).toHaveLength(50);
  });
});
