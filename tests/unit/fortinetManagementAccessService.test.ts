/**
 * tests/unit/fortinetManagementAccessService.test.ts — CQ-T010.
 *
 * Complements tests/unit/fortinetManagementAccess.test.ts (the happy-path and
 * headline-contract cases for every parser) and
 * tests/unit/fortiosInterfaceCmdbFormat.test.ts (the CMDB row formats). This
 * file pins the edges those leave open: the encoding variants the header
 * promises every parser accepts (and refuses), the null-never-[] contract on
 * partial reads, the defaults summarizeGateManagementAccess applies to blank
 * operator settings, and the default `checkedAt` stamp. Everything here is
 * pure — no database, no device.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApSummary,
  buildFirewallSummary,
  buildSwitchSummary,
  findInterfaceRow,
  parseAllowaccess,
  parseLocalAccessPolicies,
  parseWtpProfiles,
  parseWtpToProfile,
  pickLocalAccessPolicy,
  protocolFlags,
  shapeManagementAccessForClient,
  summarizeGateManagementAccess,
} from "../../src/services/fortinetManagementAccessService.js";

const AT = "2026-03-01T12:00:00.000Z";

describe("parseAllowaccess — encoding edges", () => {
  it("splits multi-token array entries and collapses tabs / repeated whitespace", () => {
    expect(parseAllowaccess(["ping  https", "\tSSH\n"])).toEqual(["ping", "https", "ssh"]);
  });

  it("dedupes across mixed array entry shapes (string + named object)", () => {
    expect(parseAllowaccess(["https", { name: "HTTPS" }, { q_origin_key: "ssh" }])).toEqual(["https", "ssh"]);
  });

  it("prefers q_origin_key over name on the same object", () => {
    expect(parseAllowaccess([{ q_origin_key: "snmp", name: "ignored" }])).toEqual(["snmp"]);
  });

  it("an array containing a null / number / nameless object is unknown as a whole", () => {
    expect(parseAllowaccess(["https", null])).toBeNull();
    expect(parseAllowaccess(["https", 7])).toBeNull();
    expect(parseAllowaccess([{ other: "x" }])).toBeNull();
  });

  it("a whitespace-only string is a real 'nothing permitted' answer", () => {
    expect(parseAllowaccess("   ")).toEqual([]);
  });

  it("booleans and undefined are unknown", () => {
    expect(parseAllowaccess(true)).toBeNull();
    expect(parseAllowaccess(undefined)).toBeNull();
  });
});

describe("protocolFlags", () => {
  it("is exact-match: 'https-admin' or 'snmpv3' do not count", () => {
    expect(protocolFlags(["https-admin", "snmpv3", "ssh"])).toEqual({ https: false, ssh: true, snmp: false });
  });

  it("an empty list is all false (nothing permitted)", () => {
    expect(protocolFlags([])).toEqual({ https: false, ssh: false, snmp: false });
  });
});

describe("findInterfaceRow", () => {
  it("trims both the wanted name and the row name", () => {
    const row = { name: " port1 ", allowaccess: "ping" };
    expect(findInterfaceRow([row], "  PORT1")).toBe(row);
  });

  it("ignores rows without a string name and non-array tables", () => {
    expect(findInterfaceRow([null, { name: 3 }, "x"], "3")).toBeNull();
    expect(findInterfaceRow({ results: "nope" }, "port1")).toBeNull();
    expect(findInterfaceRow(null, "port1")).toBeNull();
  });
});

describe("buildFirewallSummary — mgmt IP resolution", () => {
  it("an interface ip of 0.0.0.0 is not an address: the fallback is used", () => {
    const s = buildFirewallSummary([{ name: "mgmt", ip: "0.0.0.0 0.0.0.0", allowaccess: "https" }], "mgmt", "10.9.9.9", AT);
    expect(s?.mgmtIp).toBe("10.9.9.9");
  });

  it("no usable ip and an empty fallback yields mgmtIp null, not ''", () => {
    const s = buildFirewallSummary([{ name: "mgmt", allowaccess: "https" }], "mgmt", "", AT);
    expect(s?.mgmtIp).toBeNull();
  });

  it("reports the row's own spelling of the interface name and the read stamp", () => {
    const s = buildFirewallSummary([{ name: "MGMT1", ip: "10.0.0.1 255.255.255.0", allowaccess: "ssh" }], "mgmt1", null, AT);
    expect(s).toMatchObject({ source: "firewall-interface", interfaceName: "MGMT1", profileName: null, ssh: true, checkedAt: AT });
  });
});

describe("AP profile tables — field fallbacks", () => {
  it("parseWtpToProfile keys by uppercased serial, falling back through wtp-id, wtp_id, name", () => {
    const map = parseWtpToProfile([
      { serial: " fp231f0001 ", "wtp-profile": "P1" },
      { wtp_id: "FP2", wtp_profile: "P2" },
      { name: "fp3", "wtp-profile": ["P3"] },
    ]);
    expect(map.get("FP231F0001")).toBe("P1");
    expect(map.get("FP2")).toBe("P2");
    expect(map.get("FP3")).toBe("P3");
  });

  it("parseWtpToProfile refuses a multi-element or blank profile reference", () => {
    const map = parseWtpToProfile([
      { serial: "A", "wtp-profile": ["P1", "P2"] },
      { serial: "B", "wtp-profile": "  " },
      { serial: "", "wtp-profile": "P3" },
    ]);
    expect(map.size).toBe(0);
  });

  it("parseWtpProfiles keeps an unreadable allowaccess as null under the lowercased name", () => {
    const map = parseWtpProfiles({ results: [{ name: " Indoor ", allowaccess: 42 }, { name: "Outdoor", allowaccess: "" }] });
    expect(map.get("indoor")).toBeNull();
    expect(map.get("outdoor")).toEqual([]);
  });

  it("buildApSummary looks the profile up case-insensitively and drops an empty AP ip", () => {
    const s = buildApSummary(" fp1 ", "", new Map([["FP1", "Indoor"]]), new Map([["indoor", ["snmp"]]]), AT);
    expect(s).toMatchObject({ source: "fortiap-profile", profileName: "Indoor", mgmtIp: null, snmp: true, https: false });
  });
});

describe("local-access policy edges", () => {
  it("rows with a blank or non-string name are skipped", () => {
    const map = parseLocalAccessPolicies([{ name: "  " }, { name: 5 }, { name: "default", "internal-allowaccess": "https" }]);
    expect([...map.keys()]).toEqual(["default"]);
  });

  it("pickLocalAccessPolicy treats a null map as no policy", () => {
    expect(pickLocalAccessPolicy(null)).toBeNull();
    expect(pickLocalAccessPolicy(undefined)).toBeNull();
  });

  it("buildSwitchSummary: an empty-list policy half is a real 'nothing permitted' and names the policy", () => {
    const policies = parseLocalAccessPolicies([{ name: "default", "internal-allowaccess": "" }]);
    const s = buildSwitchSummary("internal", "10.1.1.5", AT, policies);
    expect(s).toMatchObject({ protocols: [], profileName: "default", https: false, ssh: false });
  });

  it("buildSwitchSummary with no policies is unknown and keeps profileName null; empty ip → null", () => {
    const s = buildSwitchSummary("internal", "", AT);
    expect(s).toMatchObject({ source: "fortiswitch", interfaceName: "internal", protocols: null, profileName: null, mgmtIp: null });
  });

  it("an operator SVI named 'mgmt-vlan' reads the mgmt half (prefix match)", () => {
    const policies = parseLocalAccessPolicies([{ name: "default", "mgmt-allowaccess": "ssh", "internal-allowaccess": "https" }]);
    expect(buildSwitchSummary("mgmt-vlan", null, AT, policies).protocols).toEqual(["ssh"]);
  });
});

describe("summarizeGateManagementAccess — defaults and gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
  });
  afterEach(() => vi.useRealTimers());

  it("a blank management interface name falls back to 'mgmt'", () => {
    const out = summarizeGateManagementAccess({
      firewall: { serial: "FGT1" },
      interfaceRows: [{ name: "mgmt", allowaccess: "https" }],
      mgmtInterfaceName: "   ",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.summary.interfaceName).toBe("mgmt");
  });

  it("a blank switch management interface falls back to the internal half", () => {
    const out = summarizeGateManagementAccess({
      switches: [{ serial: "S1", ipAddress: "10.0.0.2" }],
      localAccessRows: [{ name: "default", "mgmt-allowaccess": "ssh", "internal-allowaccess": "https" }],
      switchManagementInterface: " ",
    });
    expect(out[0]!.summary).toMatchObject({ interfaceName: "internal", protocols: ["https"] });
  });

  it("stamps checkedAt with the current time when none is given", () => {
    const out = summarizeGateManagementAccess({ switches: [{ serial: "S1" }] });
    expect(out[0]!.summary.checkedAt).toBe(AT);
  });

  it("skips APs and switches without a serial", () => {
    const out = summarizeGateManagementAccess({
      aps: [{ serial: "" }, { serial: "FP1" }],
      wtpRows: [{ serial: "FP1", "wtp-profile": "P" }],
      wtpProfileRows: [{ name: "P", allowaccess: "https" }],
      switches: [{ serial: "" }],
      checkedAt: AT,
    });
    expect(out.map((d) => d.serial)).toEqual(["FP1"]);
  });

  it("APs whose wtp table was read but the profile table was not stay unknown", () => {
    const out = summarizeGateManagementAccess({
      aps: [{ serial: "FP1", ipAddress: "10.0.0.9" }],
      wtpRows: [{ serial: "FP1", "wtp-profile": "P" }],
      checkedAt: AT,
    });
    expect(out[0]!.summary).toMatchObject({ protocols: null, profileName: "P", mgmtIp: "10.0.0.9" });
  });

  it("a firewall whose named interface is missing produces no entry (keeps what it had)", () => {
    const out = summarizeGateManagementAccess({
      firewall: { serial: "FGT1" },
      interfaceRows: [{ name: "port1", allowaccess: "https" }],
      mgmtInterfaceName: "mgmt",
    });
    expect(out).toEqual([]);
  });
});

describe("shapeManagementAccessForClient — strict booleans", () => {
  it("only literal true turns a verb on; a non-string mgmtIp is dropped", () => {
    expect(shapeManagementAccessForClient({ https: "true", ssh: 1, mgmtIp: 10, protocols: "https" })).toEqual({
      mgmtIp: null,
      protocols: null,
      https: false,
      ssh: false,
    });
  });

  it("a primitive blob is null", () => {
    expect(shapeManagementAccessForClient("x")).toBeNull();
    expect(shapeManagementAccessForClient(0)).toBeNull();
  });
});
