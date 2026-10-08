/**
 * tests/unit/sdwanMemberIpFilter.test.ts — business rule 98.
 *
 * The SD-WAN member IP address filter: `dimensionFilter.sdwanMemberIp` holds a
 * comparison ("!= 0.0.0.0" / "== <address>") on the SD-WAN member conditions,
 * and the engine keeps a member reading only when the member interface's
 * CURRENT address passes it. It replaced "Skip unused ports" (rule 88, retired
 * 2026-10-08), so the retired flag is pinned here too: it no longer exists,
 * and an old payload carrying it is stripped rather than refused.
 *
 * Pure surfaces only; the engine's resolver is
 * tests/integration/sdwanMemberIpFilter.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import {
  parseMemberIpFilter,
  memberIpPasses,
  ruleInputSchema,
  triggerSignature,
  buildSchemaCatalog,
  SDWAN_MEMBER_IP_TARGETS,
  type Trigger,
} from "../../src/services/notificationTypes.js";

describe("parseMemberIpFilter", () => {
  it("reads both operators, whitespace-tolerant", () => {
    expect(parseMemberIpFilter("!= 0.0.0.0")).toEqual({ operator: "!=", ip: "0.0.0.0" });
    expect(parseMemberIpFilter("==10.4.1.1")).toEqual({ operator: "==", ip: "10.4.1.1" });
    expect(parseMemberIpFilter("  !=   2001:db8::1 ")).toEqual({ operator: "!=", ip: "2001:db8::1" });
  });

  it("refuses anything that is not an operator and a real address", () => {
    for (const bad of ["0.0.0.0", "> 10.0.0.1", "!= 10.0.0", "!= 10.0.0.0/8", "!= wan1", "", null, undefined]) {
      expect(parseMemberIpFilter(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("memberIpPasses", () => {
  const notZero = parseMemberIpFilter("!= 0.0.0.0")!;
  const isAddr = parseMemberIpFilter("== 10.4.1.1")!;

  it("treats every unaddressed shape as 0.0.0.0", () => {
    for (const unaddressed of ["0.0.0.0", "0.0.0.0 0.0.0.0", "0.0.0.0/0", "", "  "]) {
      expect(memberIpPasses(notZero, unaddressed), JSON.stringify(unaddressed)).toBe(false);
    }
  });

  it("compares the BARE address, whatever shape the transport reported", () => {
    expect(memberIpPasses(notZero, "203.0.113.9 255.255.255.0")).toBe(true);
    expect(memberIpPasses(isAddr, "10.4.1.1/24")).toBe(true);
    expect(memberIpPasses(isAddr, "10.4.1.1 255.255.255.0")).toBe(true);
    expect(memberIpPasses(isAddr, "10.4.1.11")).toBe(false);
  });

  it("answers UNKNOWN (null) for an address it could not read, so the reading is kept", () => {
    expect(memberIpPasses(notZero, null)).toBeNull();
    expect(memberIpPasses(isAddr, undefined)).toBeNull();
  });
});

describe("the rule schema", () => {
  const rule = (trigger: unknown) => ({ name: "r", scope: { allAssets: true }, trigger });
  const loss = (df: Record<string, string>) => ({
    type: "asset_metric", metric: "sdwanPacketLoss", operator: ">=", threshold: 20, dimensionFilter: df,
  });

  it("accepts the filter on every SD-WAN member condition", () => {
    expect([...SDWAN_MEMBER_IP_TARGETS].sort()).toEqual(["sdwanJitterMs", "sdwanLatencyMs", "sdwanMemberState", "sdwanPacketLoss"]);
    expect(ruleInputSchema.safeParse(rule(loss({ sdwanMemberIp: "!= 0.0.0.0" }))).success).toBe(true);
    expect(ruleInputSchema.safeParse(rule({
      type: "asset_state", field: "sdwanMemberState", operator: "==", value: "down",
      dimensionFilter: { healthCheck: "Metrocenter", sdwanMemberIp: "!= 0.0.0.0" },
    })).success).toBe(true);
  });

  it("refuses it on a condition that does not read one member per reading", () => {
    const res = ruleInputSchema.safeParse(rule({
      type: "asset_state", field: "ifOperStatus", operator: "==", value: "down",
      dimensionFilter: { sdwanMemberIp: "!= 0.0.0.0" },
    }));
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain("only applies to the SD-WAN member conditions");
  });

  it("refuses a value that is not a comparison", () => {
    expect(ruleInputSchema.safeParse(rule(loss({ sdwanMemberIp: "0.0.0.0" }))).success).toBe(false);
  });

  it("strips the retired skipUnusedPorts flag rather than refusing an old payload", () => {
    const res = ruleInputSchema.safeParse(rule({ ...loss({}), skipUnusedPorts: true }));
    expect(res.success).toBe(true);
    expect(JSON.stringify(res.success ? res.data.trigger : {})).not.toContain("skipUnusedPorts");
  });

  it("makes the filter part of the signature, so filtered and unfiltered never carve each other out", () => {
    const a = triggerSignature(loss({}) as unknown as Trigger);
    const b = triggerSignature(loss({ sdwanMemberIp: "!= 0.0.0.0" }) as unknown as Trigger);
    expect(a).not.toBe(b);
  });

  it("publishes the targets to the wizard and no longer publishes the retired option", () => {
    const cat = buildSchemaCatalog() as Record<string, unknown>;
    expect(cat.sdwanMemberIpTargets).toEqual([...SDWAN_MEMBER_IP_TARGETS]);
    expect(cat).not.toHaveProperty("skipUnusedPortTargets");
  });
});

describe("the wizard side", () => {
  type Leaf = Record<string, any>;
  type Group = { op: string; children: (Leaf | Group)[] };
  let F: {
    compile: (t: Group, s: (l: Leaf, d: string) => boolean) => { tree: Group; errors: string[] };
    lift: (t: Group, s: (l: Leaf, d: string) => boolean, dims: string[]) => Group;
    parseMemberIp: (raw: string) => { operator: string; ip: string } | null;
    memberIpWords: (raw: string) => string;
  };

  beforeAll(() => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, "../../public/js/automations-wizard.js"), "utf8");
    const sandbox: Record<string, any> = {
      window: {},
      document: { addEventListener() {}, getElementById: () => null },
      escapeHtml: (x: unknown) => String(x ?? ""),
      api: {},
      permAtLeast: () => true,
      showToast: () => {},
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    F = sandbox.window.PolarisTriggerFilters;
  });

  it("parses and words the stored comparison", () => {
    expect(F.parseMemberIp("!= 0.0.0.0")).toEqual({ operator: "!=", ip: "0.0.0.0" });
    expect(F.memberIpWords("!= 0.0.0.0")).toBe("is not 0.0.0.0");
    expect(F.memberIpWords("== 10.4.1.1")).toBe("is 10.4.1.1");
  });

  it("folds a filter row into the SD-WAN conditions only, and lifts it back out", () => {
    const supports = (l: Leaf, d: string) =>
      d === "sdwanMemberIp" && ["sdwanMemberState", "sdwanPacketLoss"].includes(l.field ?? l.metric);
    const tree: Group = {
      op: "and",
      children: [
        { type: "asset_state", field: "sdwanMemberState", operator: "==", value: "down" },
        { type: "asset_metric", metric: "sdwanPacketLoss", operator: ">=", threshold: 20 },
        { type: "asset_filter", dim: "sdwanMemberIp", value: "!= 0.0.0.0" },
      ],
    };
    const { tree: out, errors } = F.compile(tree, supports);
    expect(errors).toEqual([]);
    expect(out.children.map((c: Leaf) => c.dimensionFilter)).toEqual([
      { sdwanMemberIp: "!= 0.0.0.0" }, { sdwanMemberIp: "!= 0.0.0.0" },
    ]);
    const back = F.lift(out, supports, ["sdwanMemberIp"]);
    expect(back.children[2]).toEqual({ type: "asset_filter", dim: "sdwanMemberIp", value: "!= 0.0.0.0" });
    expect(back.children[0]).not.toHaveProperty("dimensionFilter");
  });

  it("no longer draws or collects a Skip unused ports box", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(resolve(here, "../../public/js/automations-wizard.js"), "utf8");
    expect(code).not.toMatch(/skipUnused|tgl-skip-unused/);
  });
});
