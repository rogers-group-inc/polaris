/**
 * tests/unit/agentInstallScripts.test.ts — the agent install-method catalog
 * and its OS-LOCK (CQ-T010): every platform has exactly one default, ids are
 * unique, an omitted id resolves to the platform default, and a variant can
 * never run against another OS (a hand-crafted request must not put a
 * PowerShell installer on a Linux host).
 */

import { describe, it, expect } from "vitest";
import { AGENT_INSTALL_SCRIPTS, resolveInstallScriptId, type AgentOsPlatform } from "../../src/services/agentInstallScripts.js";

const PLATFORMS: AgentOsPlatform[] = ["linux", "darwin", "windows"];

describe("AGENT_INSTALL_SCRIPTS", () => {
  it("has exactly one default per platform and unique ids", () => {
    for (const os of PLATFORMS) {
      expect(AGENT_INSTALL_SCRIPTS.filter((s) => s.osPlatform === os && s.isDefault), os).toHaveLength(1);
    }
    const ids = AGENT_INSTALL_SCRIPTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveInstallScriptId", () => {
  it("an omitted, null or empty id is the platform default", () => {
    for (const os of PLATFORMS) {
      const def = AGENT_INSTALL_SCRIPTS.find((s) => s.osPlatform === os && s.isDefault)!.id;
      expect(resolveInstallScriptId(os)).toBe(def);
      expect(resolveInstallScriptId(os, null)).toBe(def);
      expect(resolveInstallScriptId(os, "")).toBe(def);
    }
  });

  it("a known id for the right OS is returned as is", () => {
    for (const s of AGENT_INSTALL_SCRIPTS) expect(resolveInstallScriptId(s.osPlatform, s.id)).toBe(s.id);
  });

  it("an unknown id is a 400", () => {
    expect(() => resolveInstallScriptId("linux", "curl | bash")).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });

  it("OS-LOCK: every variant is refused on every other platform", () => {
    for (const s of AGENT_INSTALL_SCRIPTS) {
      for (const os of PLATFORMS.filter((p) => p !== s.osPlatform)) {
        expect(() => resolveInstallScriptId(os, s.id), `${s.id} on ${os}`).toThrow(/cannot be used on a/);
      }
    }
  });
});
