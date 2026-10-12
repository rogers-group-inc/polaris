/**
 * tests/unit/adBindFallback.test.ts
 *
 * The Active Directory bind account backs WinRM / SSH probes of AD-discovered
 * hosts only while DISCOVERY chose the destination. An operator who pins an
 * address or a name (assets:write) must not be able to redirect that account's
 * password to a host they run.
 */

import { describe, it, expect } from "vitest";
import { adBindFallbackAllowed, adBindFallbackIntegration } from "../../src/utils/adBindFallback.js";

const integration = { type: "activedirectory", config: { bindDn: "svc", bindPassword: "s3cret" } };

describe("adBindFallbackAllowed", () => {
  it("allows an asset whose address and name both came from discovery", () => {
    expect(adBindFallbackAllowed({})).toBe(true);
    expect(adBindFallbackAllowed({ ipOverride: null, hostnameOverride: null })).toBe(true);
  });

  it("refuses once an operator pinned the address", () => {
    expect(adBindFallbackAllowed({ ipOverride: "203.0.113.9" })).toBe(false);
  });

  it("refuses once an operator pinned the hostname, which is the WinRM / SSH target when there is no IP", () => {
    expect(adBindFallbackAllowed({ hostnameOverride: "attacker.example.net" })).toBe(false);
  });

  it("treats an empty-string pin as unset, matching how the columns are cleared", () => {
    expect(adBindFallbackAllowed({ ipOverride: "", hostnameOverride: "" })).toBe(true);
  });
});

describe("adBindFallbackIntegration", () => {
  it("hands back the integration for a discovery-addressed asset", () => {
    expect(adBindFallbackIntegration({}, integration)).toBe(integration);
  });

  it("hands back null for a pinned asset, so the resolver finds no fallback credential", () => {
    expect(adBindFallbackIntegration({ ipOverride: "203.0.113.9" }, integration)).toBeNull();
    expect(adBindFallbackIntegration({ hostnameOverride: "x.example.net" }, integration)).toBeNull();
  });

  it("passes a missing integration straight through", () => {
    expect(adBindFallbackIntegration({}, null)).toBeNull();
  });
});
