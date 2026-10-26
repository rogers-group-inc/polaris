/**
 * tests/unit/assistantPlaybookService.test.ts — which playbook a question
 * triggers (business rule 95), and that each playbook's first-round tools
 * and procedure name real tools.
 */

import { describe, it, expect } from "vitest";
import { PLAYBOOKS, pickPlaybook } from "../../src/services/assistantPlaybookService.js";
import { assistantToolDefs } from "../../src/services/assistantToolService.js";

const TOOL_NAMES = new Set(assistantToolDefs().map((t) => t.function.name));

describe("pickPlaybook", () => {
  it.each([
    ["why did NSH-FW01 go down last night?", "correlate"],
    ["what caused the outage at Murfreesboro?", "correlate"],
    ["root cause for sw-nsh-02 dropping", "correlate"],
    ["what else went down with the core switch", "correlate"],
    ["what changed since yesterday?", "changed"],
    ["anything new overnight", "changed"],
    ["what happened in the last 12 hours", "correlate"],
    ["is sw-nsh-02 ok?", "health"],
    ["status of fw-nsh-01", "health"],
    ["how is core-1 doing", "health"],
    ["which networks are nearly full?", "capacity"],
    ["networks over 80%", "capacity"],
    ["are we running out of addresses in Nashville", "capacity"],
    ["utilization of the guest vlan", "capacity"],
    ["look up ip 153.66.102.165", "address"],
    ["whose address is 10.10.3.178?", "address"],
    ["what is 172.22.63.254", "address"],
    ["why is 10.10.3.178 down?", "correlate"],
    ["is 10.10.3.178 ok?", "health"],
    ["create a reported of the highest average memory utilizations of the 61f fortigate firewalls", "telemetry"],
    ["which firewalls have the highest CPU this week", "telemetry"],
    ["why is fw-nsh-01 cpu so high", "telemetry"],
    ["what is in your memory about me", null],
    ["what does sw-nsh-02 depend on?", "dependencies"],
    ["what goes down if core-1 goes down", "dependencies"],
    ["what's behind fw-nsh-01", "dependencies"],
    ["why did ap-12 go down? check upstream", "correlate"],
    ["where is 0a:11:22:33:44:55", "endpoint"],
    ["which port is aabb.ccdd.eeff on", "endpoint"],
    ["what access point is the CEO's laptop on", "endpoint"],
    ["what is plugged into port 12 on sw-nsh-02", "endpoint"],
    ["what is 10.10.3.178 plugged into", "address"],
    ["list the switches that rebooted at 10:30:45", null],
    ["is the ERP reachable from the branches?", "paths"],
    ["which path checks are failing", "paths"],
    ["what was m365 availability last week", "paths"],
    ["what is the WAN utilization at the Nashville sites", "interfaces"],
    ["busiest links today", "interfaces"],
    ["which switch ports are down at HQ", "interfaces"],
    ["any PoE faults?", "interfaces"],
    ["which port is 0a:11:22:33:44:55 on", "endpoint"],
  ])("%s → %s", (q, id) => {
    expect(pickPlaybook(q)?.id ?? null).toBe(id);
  });

  it("matches nothing for a plain lookup, small talk, or an empty question", () => {
    expect(pickPlaybook("how many networks do we have?")).toBeNull();
    expect(pickPlaybook("thanks!")).toBeNull();
    expect(pickPlaybook("list the switches")).toBeNull();
    expect(pickPlaybook("")).toBeNull();
  });

  it("every playbook names only real tools, in its first-round set and its procedure", () => {
    for (const p of PLAYBOOKS) {
      expect(p.firstRoundTools.length).toBeGreaterThan(0);
      for (const t of p.firstRoundTools) expect(TOOL_NAMES.has(t), `${p.id}: ${t}`).toBe(true);
      for (const m of p.guidance.match(/\b((?:list|get|find|search|create|fleet|telemetry|interface|path_check)_\w+|search)\b/g) ?? []) {
        expect(TOOL_NAMES.has(m), `${p.id} guidance names ${m}`).toBe(true);
      }
      expect(p.guidance).toMatch(/what you infer/);
    }
  });
});
