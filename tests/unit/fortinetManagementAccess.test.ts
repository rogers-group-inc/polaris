/**
 * tests/unit/fortinetManagementAccess.test.ts
 *
 * Pure-parser coverage for the management-access (allowaccess) summary. These
 * functions must never throw on malformed/missing payloads, and must never turn
 * a value they cannot read into `[]` ("nothing permitted" — which hides the
 * slide-over's Open HTTPS / Open SSH buttons). Unreadable is `null`, unknown.
 * Both encodings are covered: FortiOS REST (space-separated strings, string
 * references) and FortiManager's device DB (string arrays, one-element
 * reference arrays, [addr, mask] ip arrays).
 */

import { describe, it, expect } from "vitest";
import {
  parseAllowaccess,
  protocolFlags,
  findInterfaceRow,
  buildFirewallSummary,
  parseWtpProfiles,
  parseWtpToProfile,
  buildApSummary,
  buildSwitchSummary,
  parseLocalAccessPolicies,
  localAccessHalfFor,
  pickLocalAccessPolicy,
  summarizeGateManagementAccess,
  shapeManagementAccessForClient,
} from "../../src/services/fortinetManagementAccessService.js";

const TS = "2026-06-19T00:00:00.000Z";

describe("parseAllowaccess", () => {
  it("splits a space-separated string and lowercases", () => {
    expect(parseAllowaccess("PING HTTPS SSH snmp")).toEqual(["ping", "https", "ssh", "snmp"]);
  });
  it("handles an array of strings (FortiManager's device-DB encoding)", () => {
    expect(parseAllowaccess(["https", "ssh"])).toEqual(["https", "ssh"]);
  });
  it("handles FortiOS array-of-objects (q_origin_key / name)", () => {
    expect(parseAllowaccess([{ q_origin_key: "https" }, { name: "ssh" }])).toEqual(["https", "ssh"]);
  });
  it("dedupes while preserving order", () => {
    expect(parseAllowaccess("https https ssh")).toEqual(["https", "ssh"]);
  });
  it("an empty string or empty array is a real answer: nothing permitted", () => {
    expect(parseAllowaccess("")).toEqual([]);
    expect(parseAllowaccess([])).toEqual([]);
  });
  it("anything it cannot read is unknown (null), never 'nothing permitted'", () => {
    expect(parseAllowaccess(null)).toBeNull();
    expect(parseAllowaccess(undefined)).toBeNull();
    // A bitmask — what an older FortiManager could return for a flag set.
    expect(parseAllowaccess(42 as unknown)).toBeNull();
    expect(parseAllowaccess({} as unknown)).toBeNull();
    // One unreadable entry poisons the list rather than silently shortening it.
    expect(parseAllowaccess(["https", 7] as unknown)).toBeNull();
  });
});

describe("protocolFlags", () => {
  it("maps presence to booleans", () => {
    expect(protocolFlags(["https", "snmp"])).toEqual({ https: true, ssh: false, snmp: true });
  });
  it("null protocols → all false (unknown)", () => {
    expect(protocolFlags(null)).toEqual({ https: false, ssh: false, snmp: false });
  });
});

describe("findInterfaceRow", () => {
  const cmdb = { results: [{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: "https ssh" }, { name: "port1" }] };
  it("matches case-insensitively inside a results wrapper", () => {
    expect(findInterfaceRow(cmdb, "MGMT")?.name).toBe("mgmt");
  });
  it("returns null for a missing or blank name", () => {
    expect(findInterfaceRow(cmdb, "wan1")).toBeNull();
    expect(findInterfaceRow(cmdb, "")).toBeNull();
    expect(findInterfaceRow(cmdb, null)).toBeNull();
  });
});

describe("buildFirewallSummary", () => {
  const cmdb = [{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: "ping https ssh" }];
  it("reads the named interface's allowaccess + ip", () => {
    const s = buildFirewallSummary(cmdb, "mgmt", "1.2.3.4", TS)!;
    expect(s.source).toBe("firewall-interface");
    expect(s.interfaceName).toBe("mgmt");
    expect(s.mgmtIp).toBe("10.0.0.1");
    expect(s.https).toBe(true);
    expect(s.ssh).toBe(true);
    expect(s.snmp).toBe(false);
    expect(s.protocols).toEqual(["ping", "https", "ssh"]);
  });
  it("reads FortiManager's device-DB row ([addr, mask] ip, string-array allowaccess)", () => {
    const s = buildFirewallSummary([{ name: "mgmt", ip: ["10.0.0.9", "255.255.255.0"], allowaccess: ["ping", "https"] }], "mgmt", null, TS)!;
    expect(s.mgmtIp).toBe("10.0.0.9");
    expect(s.protocols).toEqual(["ping", "https"]);
  });
  it("falls back to the supplied mgmtIp when the interface has no usable ip", () => {
    const s = buildFirewallSummary([{ name: "mgmt", ip: "0.0.0.0 0.0.0.0", allowaccess: "https" }], "mgmt", "9.9.9.9", TS)!;
    expect(s.mgmtIp).toBe("9.9.9.9");
  });
  it("an unreadable allowaccess leaves the buttons optimistic (protocols null)", () => {
    const s = buildFirewallSummary([{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: 12 }], "mgmt", null, TS)!;
    expect(s.protocols).toBeNull();
  });
  it("returns null when the named interface is absent", () => {
    expect(buildFirewallSummary(cmdb, "doesnotexist", "1.2.3.4", TS)).toBeNull();
  });
});

describe("AP profile join", () => {
  const profiles = parseWtpProfiles([
    { name: "branch-aps", allowaccess: "https ssh" },
    { name: "lobby-aps", allowaccess: "" },
  ]);
  const wtpToProfile = parseWtpToProfile([
    { serial: "FP231KABC", "wtp-profile": "branch-aps" },
    { "wtp-id": "FP231KDEF", "wtp-profile": "lobby-aps" },
    // FortiManager's device DB returns a reference as a one-element array.
    { "wtp-id": "FP231KGHI", "wtp-profile": ["branch-aps"] },
    // …and an unset one as an empty array — no profile.
    { "wtp-id": "FP231KJKL", "wtp-profile": [] },
  ]);

  it("resolves an AP serial → profile → allowaccess", () => {
    const s = buildApSummary("FP231KABC", "10.1.1.5", wtpToProfile, profiles, TS)!;
    expect(s.source).toBe("fortiap-profile");
    expect(s.profileName).toBe("branch-aps");
    expect(s.https).toBe(true);
    expect(s.ssh).toBe(true);
    expect(s.snmp).toBe(false);
    expect(s.mgmtIp).toBe("10.1.1.5");
  });
  it("resolves via wtp-id when serial field is absent, empty allowaccess → all false", () => {
    const s = buildApSummary("fp231kdef", null, wtpToProfile, profiles, TS)!;
    expect(s.profileName).toBe("lobby-aps");
    expect(s.https).toBe(false);
    expect(s.snmp).toBe(false);
    expect(s.protocols).toEqual([]);
  });
  it("accepts FortiManager's one-element reference array", () => {
    expect(buildApSummary("FP231KGHI", null, wtpToProfile, profiles, TS)!.profileName).toBe("branch-aps");
    expect(buildApSummary("FP231KJKL", null, wtpToProfile, profiles, TS)).toBeNull();
  });
  it("a profile the profile table does not list is unknown, not 'nothing permitted'", () => {
    const s = buildApSummary("FP231KABC", null, wtpToProfile, new Map(), TS)!;
    expect(s.profileName).toBe("branch-aps");
    expect(s.protocols).toBeNull();
  });
  it("returns null when the AP isn't mapped to a profile", () => {
    expect(buildApSummary("UNKNOWN", null, wtpToProfile, profiles, TS)).toBeNull();
  });
});

describe("parseLocalAccessPolicies", () => {
  // The operator's own config, as FortiOS returns it over REST.
  const RES = {
    results: [
      { name: "default", "mgmt-allowaccess": "https ping ssh snmp", "internal-allowaccess": "https ping ssh snmp" },
      { name: "Locked", "mgmt-allowaccess": "ping", "internal-allowaccess": "ping snmp" },
    ],
  };
  it("keys by lowercased name and normalizes both halves", () => {
    const m = parseLocalAccessPolicies(RES);
    expect([...m.keys()]).toEqual(["default", "locked"]);
    expect(m.get("default")!.internal).toEqual(["https", "ping", "ssh", "snmp"]);
    expect(m.get("locked")!.mgmt).toEqual(["ping"]);
    // The display name keeps its original casing.
    expect(m.get("locked")!.name).toBe("Locked");
  });
  it("accepts a bare array and the underscore field spelling", () => {
    const m = parseLocalAccessPolicies([{ name: "d", mgmt_allowaccess: "ssh", internal_allowaccess: ["https"] }]);
    expect(m.get("d")!.mgmt).toEqual(["ssh"]);
    expect(m.get("d")!.internal).toEqual(["https"]);
  });
  it("leaves an unstated or unreadable half NULL rather than an empty allowaccess", () => {
    // [] would read as "no protocol permitted" — a positive claim the payload
    // never made, and one that would hide both verbs on the asset page.
    const m = parseLocalAccessPolicies([{ name: "d", "internal-allowaccess": "https", "mgmt-allowaccess": 3 }]);
    expect(m.get("d")!.mgmt).toBeNull();
    expect(m.get("d")!.internal).toEqual(["https"]);
  });
  it("skips unnamed / malformed rows and never throws", () => {
    expect(parseLocalAccessPolicies(null).size).toBe(0);
    expect(parseLocalAccessPolicies({ results: [null, 7, { name: "  " }] }).size).toBe(0);
  });
});

describe("localAccessHalfFor", () => {
  it("reads the mgmt half only for the dedicated MGMT port", () => {
    expect(localAccessHalfFor("mgmt")).toBe("mgmt");
    expect(localAccessHalfFor("MGMT1")).toBe("mgmt");
  });
  it("treats internal and any operator-named SVI as in-band", () => {
    expect(localAccessHalfFor("internal")).toBe("internal");
    expect(localAccessHalfFor("fortilink-mgmt-svi")).toBe("internal");
    expect(localAccessHalfFor("")).toBe("internal");
  });
});

describe("pickLocalAccessPolicy", () => {
  it("picks the default policy — the one every managed switch answers to", () => {
    const policies = parseLocalAccessPolicies([
      { name: "default", "internal-allowaccess": "https ssh" },
      { name: "Locked", "internal-allowaccess": "ping" },
    ]);
    expect(pickLocalAccessPolicy(policies)!.name).toBe("default");
  });
  it("uses the only policy when it isn't called default", () => {
    const one = parseLocalAccessPolicies([{ name: "RGI-Switches", "internal-allowaccess": "ssh" }]);
    expect(pickLocalAccessPolicy(one)!.name).toBe("RGI-Switches");
  });
  it("returns null when several policies exist and none is default", () => {
    const two = parseLocalAccessPolicies([{ name: "A" }, { name: "B" }]);
    expect(pickLocalAccessPolicy(two)).toBeNull();
  });
  it("returns null with no policies at all", () => {
    expect(pickLocalAccessPolicy(new Map())).toBeNull();
    expect(pickLocalAccessPolicy(null)).toBeNull();
  });
});

describe("buildSwitchSummary", () => {
  const policies = parseLocalAccessPolicies([
    { name: "default", "mgmt-allowaccess": "https ping ssh snmp", "internal-allowaccess": "https ping snmp" },
  ]);
  it("reads the internal half for a FortiLink-managed switch", () => {
    const s = buildSwitchSummary("internal", "10.2.2.2", TS, policies);
    expect(s.source).toBe("fortiswitch");
    expect(s.protocols).toEqual(["https", "ping", "snmp"]);
    expect(s.https).toBe(true);
    // SSH is permitted on the out-of-band port only — the verb must not show.
    expect(s.ssh).toBe(false);
    expect(s.profileName).toBe("default");
    expect(s.mgmtIp).toBe("10.2.2.2");
    expect(s.interfaceName).toBe("internal");
  });
  it("reads the mgmt half when the operator polls the MGMT port", () => {
    const s = buildSwitchSummary("mgmt", null, TS, policies);
    expect(s.ssh).toBe(true);
    expect(s.interfaceName).toBe("mgmt");
  });
  it("stays unknown when the policy read failed", () => {
    for (const p of [new Map(), null, undefined]) {
      const s = buildSwitchSummary("internal", null, TS, p as any);
      expect(s.protocols).toBeNull();
      expect(s.profileName).toBeNull();
    }
  });
  it("stays unknown when the policy states no list for the half in use", () => {
    const half = parseLocalAccessPolicies([{ name: "default", "mgmt-allowaccess": "https" }]);
    expect(buildSwitchSummary("internal", null, TS, half).protocols).toBeNull();
  });
});

describe("summarizeGateManagementAccess", () => {
  const base = {
    checkedAt: TS,
    firewall: { serial: "FGT1", mgmtIp: "10.0.0.1" },
    interfaceRows: [{ name: "mgmt", ip: "10.0.0.1 255.255.255.0", allowaccess: "https ssh" }],
    aps: [{ serial: "FAP1", ipAddress: "10.1.0.5" }],
    wtpRows: [{ "wtp-id": "FAP1", "wtp-profile": "p1" }],
    wtpProfileRows: [{ name: "p1", allowaccess: "https snmp" }],
    switches: [{ serial: "FSW1", ipAddress: "10.2.0.5" }],
    localAccessRows: [{ name: "default", "internal-allowaccess": "https ssh" }],
  };
  const bySerial = (r: ReturnType<typeof summarizeGateManagementAccess>) =>
    Object.fromEntries(r.map((m) => [m.serial, m.summary]));

  it("summarizes the firewall, its APs and its switches from the tables the pass read", () => {
    const r = bySerial(summarizeGateManagementAccess(base));
    expect(Object.keys(r).sort()).toEqual(["FAP1", "FGT1", "FSW1"]);
    expect(r.FGT1.protocols).toEqual(["https", "ssh"]);
    expect(r.FAP1.snmp).toBe(true);
    expect(r.FAP1.mgmtIp).toBe("10.1.0.5");
    expect(r.FSW1.ssh).toBe(true);
    expect(r.FSW1.interfaceName).toBe("internal");
    expect(r.FGT1.checkedAt).toBe(TS);
  });
  it("honours the operator's management interface names", () => {
    const r = bySerial(summarizeGateManagementAccess({
      ...base,
      mgmtInterfaceName: "port9",
      interfaceRows: [{ name: "port9", allowaccess: "ping" }],
      switchManagementInterface: "mgmt",
      localAccessRows: [{ name: "default", "mgmt-allowaccess": "snmp", "internal-allowaccess": "https" }],
    }));
    expect(r.FGT1.interfaceName).toBe("port9");
    expect(r.FSW1.protocols).toEqual(["snmp"]);
  });
  it("a table that was not read leaves its devices out (they keep what they had)", () => {
    const r = bySerial(summarizeGateManagementAccess({ ...base, interfaceRows: null, wtpRows: null }));
    expect(r.FGT1).toBeUndefined();
    expect(r.FAP1).toBeUndefined();
    expect(r.FSW1).toBeDefined();
  });
  it("a managed switch always gets a summary — unknown when the policy was unreadable", () => {
    const r = bySerial(summarizeGateManagementAccess({ ...base, localAccessRows: null }));
    expect(r.FSW1.protocols).toBeNull();
  });
  it("a gate with no firewall serial, APs or switches yields nothing", () => {
    expect(summarizeGateManagementAccess({ firewall: null, interfaceRows: base.interfaceRows })).toEqual([]);
  });
});

describe("shapeManagementAccessForClient", () => {
  it("keeps protocols null so the client stays optimistic", () => {
    const out = shapeManagementAccessForClient({ mgmtIp: "10.0.0.1", protocols: null, https: false, ssh: false });
    expect(out).toEqual({ mgmtIp: "10.0.0.1", protocols: null, https: false, ssh: false });
  });
  it("drops the fields only the slide-over reads", () => {
    const out = shapeManagementAccessForClient({
      source: "fortiswitch", interfaceName: "internal", profileName: "default", snmp: true,
      checkedAt: TS, mgmtIp: "10.0.0.2", protocols: ["https"], https: true, ssh: false,
    });
    expect(out).toEqual({ mgmtIp: "10.0.0.2", protocols: ["https"], https: true, ssh: false });
  });
  it("null for a missing / non-object blob", () => {
    expect(shapeManagementAccessForClient(null)).toBeNull();
    expect(shapeManagementAccessForClient("nope")).toBeNull();
  });
});
