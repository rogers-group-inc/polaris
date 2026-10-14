/**
 * tests/unit/tlsEndpointsForAsset.test.ts — business rule 113(e): which TLS
 * endpoints a FortiGate's discovering integration dials with a token, as the
 * Sources tab lists them. A FortiManager in proxy-bypass mode is TWO
 * endpoints (the FortiManager, and the gate itself); in proxy mode only the
 * FortiManager is ever dialed.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { tlsEndpointsForAsset } from "../../src/services/tlsCertPinService.js";

const gate = { assetType: "firewall", ipAddress: "10.20.0.1" };
const fmg = (cfg: Record<string, unknown>) => ({ type: "fortimanager", name: "FMG", config: { host: "10.0.0.5", port: 443, ...cfg } });

describe("tlsEndpointsForAsset", () => {
  it("FortiManager in proxy mode: only the FortiManager", () => {
    expect(tlsEndpointsForAsset(gate, fmg({ useProxy: true }))).toEqual([
      { label: 'FortiManager "FMG"', host: "10.0.0.5", port: 443 },
    ]);
    // useProxy unset is proxy mode (the default)
    expect(tlsEndpointsForAsset(gate, fmg({}))).toHaveLength(1);
  });

  it("FortiManager in proxy-bypass mode: the FortiManager AND this gate on 443", () => {
    expect(tlsEndpointsForAsset(gate, fmg({ useProxy: false }))).toEqual([
      { label: 'FortiManager "FMG"', host: "10.0.0.5", port: 443 },
      { label: "This FortiGate, direct (FortiManager proxy bypass)", host: "10.20.0.1", port: 443 },
    ]);
  });

  it("a managed switch or AP under FortiManager bypass is not dialed directly", () => {
    expect(tlsEndpointsForAsset({ assetType: "switch", ipAddress: "10.20.0.9" }, fmg({ useProxy: false }))).toHaveLength(1);
  });

  it("standalone FortiGate: the gate, plus the asset's own address when it differs", () => {
    const fg = { type: "fortigate", name: "Edge", config: { host: "10.20.0.1", port: 8443 } };
    expect(tlsEndpointsForAsset(gate, fg)).toEqual([{ label: 'FortiGate "Edge"', host: "10.20.0.1", port: 8443 }]);
    expect(tlsEndpointsForAsset({ assetType: "firewall", ipAddress: "10.20.0.2" }, fg)).toHaveLength(2);
  });

  it("other integrations and undiscovered assets have none", () => {
    expect(tlsEndpointsForAsset(gate, { type: "vcenter", name: "vc", config: { host: "x" } })).toEqual([]);
    expect(tlsEndpointsForAsset(gate, null)).toEqual([]);
  });
});
