/**
 * tests/unit/alertEmailManagedBy.test.ts
 *
 * `{asset.managedBy}` — the owning integration, in the words of the asset
 * page's System-tab "Managed by" row — and its row in the default alert email.
 * The row must survive an INTERFACE alert (a PoE fault is where it was first
 * missed), which blanks every other device fact.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { buildComposedEmail } from "../../src/services/notificationRecipientService.js";
import { buildTemplateContext, managedByLabel } from "../../src/utils/notificationTemplate.js";

const fmg = { type: "fortimanager", name: "FMG-PROD" };

describe("managedByLabel", () => {
  it("names the integration type and name", () => {
    expect(managedByLabel({ assetType: "server", discoveredByIntegration: { type: "vcenter", name: "VC-01" } }))
      .toBe("vCenter: VC-01");
  });

  it("appends the controller FortiGate on a managed switch or AP", () => {
    const topo = { role: "fortiswitch", controllerFortigate: "FGT-SITE-01" };
    expect(managedByLabel({ assetType: "switch", discoveredByIntegration: fmg, fortinetTopology: topo }))
      .toBe("FortiManager: FMG-PROD → FGT-SITE-01");
    expect(managedByLabel({ assetType: "access_point", discoveredByIntegration: fmg, fortinetTopology: topo }))
      .toBe("FortiManager: FMG-PROD → FGT-SITE-01");
  });

  it("drops the controller when a standalone FortiGate integration IS the controller", () => {
    expect(managedByLabel({
      assetType: "switch",
      discoveredByIntegration: { type: "fortigate", name: "FGT-Site-01" },
      fortinetTopology: { controllerFortigate: "fgt-site-01" },
    })).toBe("FortiGate: FGT-Site-01");
  });

  it("ignores the controller on anything that is not a switch or AP, or not Fortinet-owned", () => {
    const topo = { controllerFortigate: "FGT-SITE-01" };
    expect(managedByLabel({ assetType: "firewall", discoveredByIntegration: fmg, fortinetTopology: topo }))
      .toBe("FortiManager: FMG-PROD");
    expect(managedByLabel({ assetType: "switch", discoveredByIntegration: { type: "activedirectory", name: "AD" }, fortinetTopology: topo }))
      .toBe("Active Directory: AD");
    expect(managedByLabel({ assetType: "switch", discoveredByIntegration: fmg, fortinetTopology: null }))
      .toBe("FortiManager: FMG-PROD");
  });

  it("says Manual when no integration owns it, and nothing when it wasn't loaded or there is no device", () => {
    expect(managedByLabel({ assetType: "server", discoveredByIntegration: null })).toBe("Manual");
    expect(managedByLabel({ assetType: "server" })).toBe("");
    expect(managedByLabel(null)).toBe("");
    expect(managedByLabel(undefined)).toBe("");
  });

  it("falls back to the raw type for an integration it has no label for", () => {
    expect(managedByLabel({ discoveredByIntegration: { type: "newthing", name: "X" } })).toBe("newthing: X");
  });
});

const ctxFor = (metric: string, discoveredByIntegration: { type: string; name: string } | null | undefined) =>
  buildTemplateContext({
    asset: "FS-248E-01",
    metric,
    dimension: "port12",
    dimensionNoun: "Interface",
    severity: "critical",
    message: "PoE fault on port12",
    time: new Date("2026-09-30T15:00:00Z"),
    ruleName: "PoE fault",
    assetDetail: {
      id: "a-1",
      assetType: "switch",
      ipAddress: "10.20.30.40",
      discoveredByIntegration,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: "FGT-SITE-01" },
    },
  });

describe("the Managed by row in the default email", () => {
  it("survives a PoE-fault (interface) alert in both bodies, where the device IP does not", () => {
    const email = buildComposedEmail({}, ctxFor("poeStatus", fmg));
    expect(email.html).toContain("Managed by");
    expect(email.html).toContain("FortiManager: FMG-PROD → FGT-SITE-01");
    expect(email.text).toContain("Managed by: FortiManager: FMG-PROD → FGT-SITE-01");
    expect(email.html).not.toContain("10.20.30.40");
  });

  it("prints on a whole-device alert", () => {
    const email = buildComposedEmail({}, ctxFor("responseTime", fmg));
    expect(email.text).toContain("Managed by: FortiManager: FMG-PROD → FGT-SITE-01");
  });

  it("says Manual for an unowned device and prunes away when the owner wasn't loaded", () => {
    expect(buildComposedEmail({}, ctxFor("responseTime", null)).text).toContain("Managed by: Manual");
    const unloaded = buildComposedEmail({}, ctxFor("responseTime", undefined));
    expect(unloaded.text).not.toContain("Managed by");
    expect(unloaded.html).not.toContain("Managed by");
  });
});
