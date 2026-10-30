/**
 * tests/unit/snmpPollingCredential.test.ts — the SNMP Walk tab's default
 * credential: the one the asset's SNMP polling actually authenticates with.
 * Each case pins one step of the collector chain it mirrors
 * (`resolveSnmpConfigForStream` and the custom-widget chain in
 * monitoringService).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  pickSnmpPollingCredentialId,
  snmpPollingCredentialCandidates,
} from "../../src/services/assetCredentialScopeService.js";

const types = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("pickSnmpPollingCredentialId", () => {
  it("is null when no stream polls over SNMP", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { monitorCredentialId: "snmp-a" },
      resolved: { responseTimePolling: "icmp", cpuMemoryPolling: "rest_api" },
      integration: null,
      credentialTypes: types({ "snmp-a": "snmp" }),
    })).toBeNull();
  });

  it("uses the stream's own credential over the default", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { monitorCredentialId: "snmp-default", cpuMemoryCredentialId: "snmp-cpu" },
      resolved: { responseTimePolling: "icmp", cpuMemoryPolling: "snmp" },
      integration: null,
      credentialTypes: types({ "snmp-default": "snmp", "snmp-cpu": "snmp" }),
    })).toBe("snmp-cpu");
  });

  it("falls back to the default monitor credential when the stream has none", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { monitorCredentialId: "snmp-default" },
      resolved: { interfacesPolling: "snmp" },
      integration: null,
      credentialTypes: types({ "snmp-default": "snmp" }),
    })).toBe("snmp-default");
  });

  it("a non-SNMP stream credential skips the default and reaches the class override", () => {
    // `asset.cpuMemoryCredential ?? asset.monitorCredential` — the default is
    // never consulted once the stream has a credential of its own.
    expect(pickSnmpPollingCredentialId({
      asset: { monitorCredentialId: "snmp-default", cpuMemoryCredentialId: "ssh-cpu" },
      resolved: { cpuMemoryPolling: "snmp", cpuMemoryCredentialId: "snmp-class" },
      integration: null,
      credentialTypes: types({ "snmp-default": "snmp", "ssh-cpu": "ssh", "snmp-class": "snmp" }),
    })).toBe("snmp-class");
  });

  it("storage authenticates as the interfaces stream", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { interfacesCredentialId: "snmp-if" },
      resolved: { storagePolling: "snmp" },
      integration: null,
      credentialTypes: types({ "snmp-if": "snmp" }),
    })).toBe("snmp-if");
  });

  it("ends on a Fortinet integration's monitor credential", () => {
    expect(pickSnmpPollingCredentialId({
      asset: {},
      resolved: { responseTimePolling: "snmp" },
      integration: { type: "fortimanager", config: { monitorCredentialId: "snmp-fmg" } },
      credentialTypes: types({ "snmp-fmg": "snmp" }),
    })).toBe("snmp-fmg");
  });

  it("ignores another integration type's monitor credential", () => {
    expect(pickSnmpPollingCredentialId({
      asset: {},
      resolved: { responseTimePolling: "snmp" },
      integration: { type: "vcenter", config: { monitorCredentialId: "snmp-x" } },
      credentialTypes: types({ "snmp-x": "snmp" }),
    })).toBeNull();
  });

  it("ignores a credential id that no longer exists", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { monitorCredentialId: "snmp-default", lldpCredentialId: "gone" },
      resolved: { lldpPolling: "snmp" },
      integration: null,
      credentialTypes: types({ "snmp-default": "snmp" }),
    })).toBe("snmp-default");
  });

  it("custom MIB widgets walk widget → sensors → CPU/memory → default", () => {
    expect(pickSnmpPollingCredentialId({
      asset: { customWidgetPolling: "snmp", customWidgetCredentialId: "ssh-w", temperatureCredentialId: "snmp-temp", monitorCredentialId: "snmp-default" },
      resolved: {},
      integration: null,
      credentialTypes: types({ "ssh-w": "ssh", "snmp-temp": "snmp", "snmp-default": "snmp" }),
    })).toBe("snmp-temp");
  });
});

describe("snmpPollingCredentialCandidates", () => {
  it("lists asset, class-override and integration ids once each", () => {
    const ids = snmpPollingCredentialCandidates({
      asset: { monitorCredentialId: "a", cpuMemoryCredentialId: "a", customWidgetPolling: "snmp" },
      resolved: { lldpCredentialId: "b", responseTimePolling: "snmp" },
      integration: { type: "fortigate", config: { monitorCredentialId: "c" } },
    });
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });
});
