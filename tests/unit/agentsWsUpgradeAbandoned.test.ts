/**
 * tests/unit/agentsWsUpgradeAbandoned.test.ts
 *
 * `upgradeAbandoned` decides whether an agent hung up on its WS upgrade while
 * the bearer verify was queued. After a server restart that verify can outlast
 * the agent's 10s handshake timeout; the agent redials, and finishing the
 * abandoned upgrade would attach a dead socket over the live retry.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/services/agentTokenService.js", () => ({ verifyBearer: vi.fn() }));
vi.mock("../../src/services/agentChannelService.js", () => ({ attach: vi.fn() }));

import { upgradeAbandoned } from "../../src/api/routes/agentsWs.js";

const live = { destroyed: false, readable: true, writable: true };

describe("upgradeAbandoned", () => {
  it("a socket still open both ways is not abandoned", () => {
    expect(upgradeAbandoned(live, false)).toBe(false);
  });

  it("a close or end seen during the verify means abandoned, even if the flags lag", () => {
    expect(upgradeAbandoned(live, true)).toBe(true);
  });

  it("a destroyed socket is abandoned", () => {
    expect(upgradeAbandoned({ ...live, destroyed: true }, false)).toBe(true);
  });

  it("a half-closed socket (agent sent FIN) is abandoned", () => {
    expect(upgradeAbandoned({ ...live, readable: false }, false)).toBe(true);
  });

  it("a socket we can no longer write the 101 to is abandoned", () => {
    expect(upgradeAbandoned({ ...live, writable: false }, false)).toBe(true);
  });
});
