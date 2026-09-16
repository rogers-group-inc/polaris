/**
 * tests/unit/pollingCompatibility.test.ts
 *
 * Locks down the compatibility matrix between asset sources and polling
 * methods. The matrix is operator-confirmed (see polaris-monitoring-discovery -> polling-methods-streams.md) and has
 * direct UX consequences — getting a value wrong here would silently
 * disable a working method on the asset edit modal or class-override
 * editor.
 */

import { describe, it, expect } from "vitest";
import {
  isPollingMethodCompatible,
  compatibleMethodsFor,
  allPollingMethods,
  isPollingMethod,
  pollingMethodLabel,
  assetSourceKindFromIntegrationType,
  isMethodValidForStream,
  methodsForStream,
  responseTimeProbeShouldQueue,
  credentialTypeForPollingMethod,
} from "../../src/utils/pollingCompatibility.js";

describe("compatibility matrix — locked values per asset source", () => {
  it("FortiManager: REST API + SNMP + SSH + ICMP + Disabled, no WinRM or Agent", () => {
    // "fortimanager" (ask FMG's own device roster) belongs to this source and
    // no other — nothing else has a FortiManager to ask.
    expect(compatibleMethodsFor("fortimanager")).toEqual(["rest_api", "snmp", "ssh", "icmp", "disabled", "fortimanager"]);
    expect(isPollingMethodCompatible("fortimanager", "winrm")).toBe(false);
    expect(isPollingMethodCompatible("fortimanager", "agent")).toBe(false);
    expect(isPollingMethodCompatible("fortimanager", "disabled")).toBe(true);
  });
  it("FortiGate: same as FortiManager", () => {
    expect(compatibleMethodsFor("fortigate")).toEqual(["rest_api", "snmp", "ssh", "icmp", "disabled"]);
    expect(isPollingMethodCompatible("fortigate", "winrm")).toBe(false);
    expect(isPollingMethodCompatible("fortigate", "agent")).toBe(false);
    expect(isPollingMethodCompatible("fortigate", "disabled")).toBe(true);
  });
  it("Active Directory: WinRM + SSH + ICMP + Disabled + Agent + vCenter (display order), no REST API or SNMP", () => {
    // "vcenter" is allowed on the directory sources because a VM those
    // integrations discovered FIRST can be vCenter-merged; the vcenter-vm
    // AssetSource requirement is enforced at save/collect time.
    expect(compatibleMethodsFor("activedirectory")).toEqual(["winrm", "ssh", "icmp", "disabled", "agent", "vcenter"]);
    expect(isPollingMethodCompatible("activedirectory", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("activedirectory", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "agent")).toBe(true);
    expect(isPollingMethodCompatible("activedirectory", "vcenter")).toBe(true);
  });
  it("Entra ID: same as AD", () => {
    expect(isPollingMethodCompatible("entraid", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("entraid", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "ssh")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "agent")).toBe(true);
    expect(isPollingMethodCompatible("entraid", "vcenter")).toBe(true);
  });
  it("Windows Server: same as AD", () => {
    expect(isPollingMethodCompatible("windowsserver", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("windowsserver", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "icmp")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "disabled")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "agent")).toBe(true);
    expect(isPollingMethodCompatible("windowsserver", "vcenter")).toBe(true);
  });
  it("Azure Arc: same as AD — Arc-enabled machines are ordinary Windows/Linux hosts", () => {
    // Locked as an exact ordered array: a source kind missing from
    // COMPATIBILITY silently resolves to "manual" (the most permissive
    // matrix), which would offer REST API and SNMP on a Windows host.
    expect(compatibleMethodsFor("azurearc")).toEqual(["winrm", "ssh", "icmp", "disabled", "agent", "vcenter"]);
    expect(isPollingMethodCompatible("azurearc", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("azurearc", "snmp")).toBe(false);
    expect(isPollingMethodCompatible("azurearc", "winrm")).toBe(true);
    expect(isPollingMethodCompatible("azurearc", "agent")).toBe(true);
    // An Arc machine can also be a vCenter-merged VM — in fact the Arc<->vCenter
    // vmUuid cross-link makes that MORE likely, not less.
    expect(isPollingMethodCompatible("azurearc", "vcenter")).toBe(true);
  });
  it("vCenter: ICMP + SNMP + WinRM + SSH + Agent + vCenter (VMs are guest OSes; ESXi answers SNMP/SSH)", () => {
    expect(compatibleMethodsFor("vcenter")).toEqual(["snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter"]);
    expect(isPollingMethodCompatible("vcenter", "rest_api")).toBe(false);
    expect(isPollingMethodCompatible("vcenter", "vcenter")).toBe(true);
  });
  it("Fortinet appliance sources never get the vcenter method (their telemetry rides FortiOS REST)", () => {
    expect(isPollingMethodCompatible("fortimanager", "vcenter")).toBe(false);
    expect(isPollingMethodCompatible("fortigate", "vcenter")).toBe(false);
  });
  // Manual is the most permissive source — the operator picks the credential —
  // but "most permissive" is not "everything that exists". `fortimanager` reads
  // one integration's device roster, and an orphan asset has no integration to
  // read, so it is the one method manual does NOT get.
  it("Manual: every method except the ones that need a specific integration", () => {
    expect(compatibleMethodsFor("manual")).toEqual(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter"]);
    allPollingMethods().forEach((m) => {
      expect(isPollingMethodCompatible("manual", m), m).toBe(m !== "fortimanager");
    });
  });
});

describe("integrationType -> AssetSourceKind mapping", () => {
  it("recognized integration types map cleanly", () => {
    expect(assetSourceKindFromIntegrationType("fortimanager")).toBe("fortimanager");
    expect(assetSourceKindFromIntegrationType("fortigate")).toBe("fortigate");
    expect(assetSourceKindFromIntegrationType("activedirectory")).toBe("activedirectory");
    expect(assetSourceKindFromIntegrationType("entraid")).toBe("entraid");
    expect(assetSourceKindFromIntegrationType("windowsserver")).toBe("windowsserver");
    expect(assetSourceKindFromIntegrationType("vcenter")).toBe("vcenter");
    expect(assetSourceKindFromIntegrationType("azurearc")).toBe("azurearc");
  });
  it("null / undefined / unknown integration types fall back to manual", () => {
    expect(assetSourceKindFromIntegrationType(null)).toBe("manual");
    expect(assetSourceKindFromIntegrationType(undefined)).toBe("manual");
    expect(assetSourceKindFromIntegrationType("")).toBe("manual");
    expect(assetSourceKindFromIntegrationType("some-future-type")).toBe("manual");
  });
});

describe("isPollingMethod type guard", () => {
  it("accepts every valid polling method", () => {
    ["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter"].forEach((m) => {
      expect(isPollingMethod(m)).toBe(true);
    });
  });
  it("rejects non-method strings", () => {
    expect(isPollingMethod("rest")).toBe(false);          // legacy wire value, intentionally rejected
    expect(isPollingMethod("REST_API")).toBe(false);
    // "fortimanager" WAS rejected here as an integration-type-not-a-method.
    // Since 2026-08-28 it is both: the integration type, and a response-time
    // polling method that reads that integration's device roster.
    expect(isPollingMethod("fortimanager")).toBe(true);
    expect(isPollingMethod("")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isPollingMethod(null)).toBe(false);
    expect(isPollingMethod(undefined)).toBe(false);
    expect(isPollingMethod(42)).toBe(false);
    expect(isPollingMethod({})).toBe(false);
  });
});

describe("per-stream method restrictions (cross-transport streams)", () => {
  it("original six streams impose no per-stream restriction beyond the method-scoped rules", () => {
    const vcenterStreams = ["responseTime", "cpuMemory", "interfaces", "storage"];
    const fortimanagerStreams = ["responseTime"];
    (["responseTime", "cpuMemory", "temperature", "interfaces", "lldp", "storage"] as const).forEach((s) => {
      allPollingMethods().forEach((m) => {
        const expected =
          m === "vcenter"      ? vcenterStreams.includes(s) :
          m === "fortimanager" ? fortimanagerStreams.includes(s) :
          true;
        expect(isMethodValidForStream(s, m), `${s}/${m}`).toBe(expected);
      });
    });
    // Response time is the only stream that admits every method — it is the one
    // question every transport can answer.
    expect(methodsForStream("responseTime")).toEqual(allPollingMethods());
    expect(methodsForStream("cpuMemory")).toEqual(allPollingMethods().filter((m) => m !== "fortimanager"));
    expect(methodsForStream("temperature")).toEqual(
      allPollingMethods().filter((m) => m !== "vcenter" && m !== "fortimanager"),
    );
  });

  // FortiManager is a configuration manager, not a metrics store: its device
  // database has reachability, identity and firmware, and no CPU, memory,
  // temperature, interface counter or session count anywhere. So the method
  // answers one question and is scoped to the one stream that asks it.
  it("fortimanager serves exactly the response-time stream", () => {
    expect(isMethodValidForStream("responseTime", "fortimanager")).toBe(true);
    (["cpuMemory", "temperature", "interfaces", "lldp", "storage", "processes", "eventLog"] as const)
      .forEach((s) => {
        expect(isMethodValidForStream(s, "fortimanager"), s).toBe(false);
      });
  });

  // The "http" polling method was RETIRED in 2026-08 — the HTTP check it ran is
  // now a manufacturer custom widget. These assertions exist so the value can't
  // quietly come back as a polling method without someone reading the reason:
  // as a method the check definition had to ride a credential, which made one
  // credential per path; as a widget it is keyed by manufacturer + model, which
  // is the axis a check actually varies on.
  it("http is no longer a polling method anywhere", () => {
    expect(isPollingMethod("http")).toBe(false);
    expect(allPollingMethods()).not.toContain("http");
    (["fortimanager", "fortigate", "activedirectory", "entraid", "windowsserver", "azurearc", "vcenter", "manual"] as const)
      .forEach((src) => {
        expect(compatibleMethodsFor(src), src).not.toContain("http");
      });
  });

  // vCenter answers for four streams and only four. The line is what the
  // vCenter SERVER publishes about a VM or an ESXi host, not what the device
  // could be asked directly: power/connection state, CPU + RAM, the guest's
  // vNICs / the host's pNICs + VMkernel ports, and the guest's filesystems /
  // the host's mounted datastores. It publishes no hardware sensor readings
  // and no LLDP, and it is not a transport into the guest, so processes and
  // event log stay out.
  it("vcenter serves exactly its four streams", () => {
    (["responseTime", "cpuMemory", "interfaces", "storage"] as const).forEach((s) => {
      expect(isMethodValidForStream(s, "vcenter"), s).toBe(true);
    });
    (["temperature", "lldp", "processes", "eventLog"] as const).forEach((s) => {
      expect(isMethodValidForStream(s, "vcenter"), s).toBe(false);
    });
  });
  it("processes: agent/SNMP/SSH/WinRM only — no REST or ICMP", () => {
    expect(methodsForStream("processes")).toEqual(["snmp", "winrm", "ssh", "disabled", "agent"]);
    expect(isMethodValidForStream("processes", "agent")).toBe(true);
    expect(isMethodValidForStream("processes", "snmp")).toBe(true);
    expect(isMethodValidForStream("processes", "ssh")).toBe(true);
    expect(isMethodValidForStream("processes", "winrm")).toBe(true);
    expect(isMethodValidForStream("processes", "rest_api")).toBe(false);
    expect(isMethodValidForStream("processes", "icmp")).toBe(false);
  });
  it("eventLog: agent/SSH/WinRM/REST only — no SNMP or ICMP", () => {
    expect(methodsForStream("eventLog")).toEqual(["rest_api", "winrm", "ssh", "disabled", "agent"]);
    expect(isMethodValidForStream("eventLog", "agent")).toBe(true);
    expect(isMethodValidForStream("eventLog", "ssh")).toBe(true);
    expect(isMethodValidForStream("eventLog", "winrm")).toBe(true);
    expect(isMethodValidForStream("eventLog", "rest_api")).toBe(true);
    expect(isMethodValidForStream("eventLog", "snmp")).toBe(false);
    expect(isMethodValidForStream("eventLog", "icmp")).toBe(false);
  });
});

describe("pollingMethodLabel — UI strings", () => {
  it("renders the operator-friendly forms (locked terminology)", () => {
    expect(pollingMethodLabel("rest_api")).toBe("REST API");
    expect(pollingMethodLabel("snmp")).toBe("SNMP");
    expect(pollingMethodLabel("winrm")).toBe("WinRM");
    expect(pollingMethodLabel("ssh")).toBe("SSH");
    expect(pollingMethodLabel("icmp")).toBe("ICMP");
    expect(pollingMethodLabel("disabled")).toBe("Disabled");
    expect(pollingMethodLabel("agent")).toBe("Polaris Agent");
    expect(pollingMethodLabel("vcenter")).toBe("vCenter");
  });
});

// The probe publishers gate on this. It exists because they previously did
// not: every other stream checked its resolved method before queueing, the
// response-time probe did not, and "disabled" therefore reached probeAsset's
// dispatch, fell past every branch to the unknown-method error, and was
// recorded as a FAILED poll — so switching Response Time off drove the asset
// to Down. The two callers are a required lockstep pair, which is why this is
// a shared predicate rather than the same condition inlined twice.
describe("responseTimeProbeShouldQueue — the probe publishers' gate", () => {
  it('excludes "disabled" — the operator off-switch must not manufacture an outage', () => {
    expect(responseTimeProbeShouldQueue("disabled")).toBe(false);
  });

  it("excludes absent values (null / undefined / empty)", () => {
    expect(responseTimeProbeShouldQueue(null)).toBe(false);
    expect(responseTimeProbeShouldQueue(undefined)).toBe(false);
    expect(responseTimeProbeShouldQueue("")).toBe(false);
  });

  // "agent" deliberately STILL queues: probeAsset returns a synthetic success
  // so the probe counter keeps incrementing under transport="agent", and
  // recordProbeResult early-returns before any DB write. Dropping it here would
  // silently change that metric, which is not this fix's business.
  it("keeps queueing every real transport, agent included", () => {
    (["rest_api", "snmp", "winrm", "ssh", "icmp", "agent", "vcenter"] as const).forEach((m) => {
      expect(responseTimeProbeShouldQueue(m), m).toBe(true);
    });
  });
});

// The server half of the method -> credential-type map. Before this existed the
// mapping lived only in the browser (_credTypeForPolling in public/js/assets.js),
// so PUT /assets/:id accepted an SSH credential on an SNMP-polled stream: the
// asset saved clean and then collected nothing, because the collector's
// resolveSnmpConfigForStream drops a credential whose type doesn't match.
describe("credentialTypeForPollingMethod — which credential type a transport needs", () => {
  it("maps each authenticating transport to its credential type", () => {
    expect(credentialTypeForPollingMethod("snmp")).toBe("snmp");
    expect(credentialTypeForPollingMethod("winrm")).toBe("winrm");
    expect(credentialTypeForPollingMethod("ssh")).toBe("ssh");
    // The one place the names differ: the method is rest_api, the credential
    // type is restapi.
    expect(credentialTypeForPollingMethod("rest_api")).toBe("restapi");
  });

  // These five take no PER-ASSET credential: ICMP carries no auth, "disabled"
  // polls nothing, "agent" uses its own enrollment bearer, and vcenter /
  // fortimanager authenticate with the INTEGRATION's credential. Callers use
  // the null to SKIP the check rather than refuse, so that an operator can
  // stage a credential before flipping the method.
  it("returns null for every method that takes no per-asset credential", () => {
    (["icmp", "disabled", "agent", "vcenter", "fortimanager"] as const).forEach((m) => {
      expect(credentialTypeForPollingMethod(m), m).toBeNull();
    });
  });

  // Guards the lockstep in polling-method-resolver.md: a new method added to
  // the union without a branch here would fall off the end of the switch and
  // return undefined, which reads as "needs no credential" and silently
  // disables the type check for it.
  it("answers for every method in the union — no undefined fall-through", () => {
    allPollingMethods().forEach((m) => {
      const t = credentialTypeForPollingMethod(m);
      expect(t === null || typeof t === "string", m).toBe(true);
      expect(t, m).not.toBeUndefined();
    });
  });
});
