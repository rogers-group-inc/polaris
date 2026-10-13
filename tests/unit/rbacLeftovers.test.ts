/**
 * tests/unit/rbacLeftovers.test.ts
 *
 * Business rule 114 — the pure halves of the phase-6 RBAC fixes:
 *   (b) the asset Alerts tab's rule summary drops everything that delivers
 *   (d) a scoped token's quarantine push keeps other sites' recorded targets
 *   (g) a grant may not exceed the granter — and an edit counts only raised keys
 *   (h) api_call headers: masked in responses, restored only for the same url,
 *       sealed at rest by the `headers` map rule
 */

import { describe, it, expect } from "vitest";
import { summarizeMatchingRule } from "../../src/services/notificationService.js";
import { mergeQuarantineTargets, type QuarantineTargetRecord } from "../../src/services/assetQuarantineService.js";
import { grantsBeyond } from "../../src/api/middleware/permissions.js";
import { maskActionHeaders, restoreMaskedActionHeaders } from "../../src/utils/actionHeaderMask.js";
import { transformSecretFields, containsSecretField } from "../../src/utils/configSecretFields.js";
import { SECRET_MASK } from "../../src/utils/secretMask.js";

describe("summarizeMatchingRule (114(b))", () => {
  it("keeps what watches the device and drops what delivers", () => {
    const s = summarizeMatchingRule({
      id: "r1", name: "CPU high", enabled: true, severity: "warning",
      trigger: { type: "metric" }, scope: { tags: ["core"] },
      actions: [{ type: "api_call", url: "https://x", headers: { Authorization: "Bearer t" } }],
      escalation: { tiers: [] }, emailComposition: { to: ["a@b"] },
      severityBands: [{ threshold: 90, severity: "critical", operator: "gt", actions: [{ type: "script", scriptId: "s" }] }],
    });
    expect(s).toEqual({
      id: "r1", name: "CPU high", description: null, enabled: true, severity: "warning",
      trigger: { type: "metric" }, scope: { tags: ["core"] },
      severityBands: [{ threshold: 90, severity: "critical", operator: "gt" }],
    });
    expect(JSON.stringify(s)).not.toMatch(/Bearer|scriptId|a@b/);
  });
});

describe("mergeQuarantineTargets (114(d))", () => {
  const t = (integrationId: string, dev: string): QuarantineTargetRecord =>
    ({ integrationId, fortigateDevice: dev, pushedMacs: ["AA"], pushedAt: "x", status: "synced" });

  it("an unscoped push replaces the record", () => {
    expect(mergeQuarantineTargets([t("i1", "fw1"), t("i2", "fw2")], [t("i1", "fw1b")], undefined)).toEqual([t("i1", "fw1b")]);
  });

  it("a scoped push replaces only its own integrations and keeps the rest", () => {
    const out = mergeQuarantineTargets([t("i1", "fw1"), t("i2", "fw2")], [t("i1", "fw1b")], ["i1"]);
    expect(out).toEqual([t("i2", "fw2"), t("i1", "fw1b")]);
  });
});

describe("grantsBeyond (114(g))", () => {
  const caller = { assets: "write", roles: "write", automationScripts: "none" };

  it("lists every key the target grants above the caller", () => {
    expect(grantsBeyond(caller, { assets: "read", automationScripts: "write" })).toEqual([{ key: "automationScripts", level: "write" }]);
    expect(grantsBeyond(caller, { assets: "write" })).toEqual([]);
  });

  it("does not count a key the edited role already held at that level", () => {
    const existing = { automationScripts: "write" };
    expect(grantsBeyond(caller, { automationScripts: "write", assets: "write" }, existing)).toEqual([]);
    expect(grantsBeyond(caller, { automationScripts: "write", serverSettingsData: "write" }, existing))
      .toEqual([{ key: "serverSettingsData", level: "write" }]);
  });
});

describe("api_call header masking (114(h))", () => {
  const stored = { actions: [{ type: "api_call", url: "https://tickets.example/api", method: "POST", headers: { Authorization: "Bearer real", "X-Org": "42" } }] };

  it("masks every header value of every api_call action, and nothing else", () => {
    const masked = maskActionHeaders({ ...stored, escalation: { tiers: [{ actions: [{ type: "api_call", url: "u", headers: { K: "v" } }] }] }, headers: { keep: "me" } });
    expect(masked.actions[0].headers).toEqual({ Authorization: SECRET_MASK, "X-Org": SECRET_MASK });
    expect((masked.escalation as any).tiers[0].actions[0].headers).toEqual({ K: SECRET_MASK });
    expect((masked as any).headers).toEqual({ keep: "me" });
    expect(stored.actions[0].headers.Authorization).toBe("Bearer real");
  });

  it("restores a masked header for the same url and header name", () => {
    const input = { actions: [{ type: "api_call", url: "https://tickets.example/api", headers: { authorization: SECRET_MASK, "X-Org": "43" } }] };
    restoreMaskedActionHeaders(input, stored);
    expect(input.actions[0].headers).toEqual({ authorization: "Bearer real", "X-Org": "43" });
  });

  it("refuses a masked header whose url changed — the token does not follow the destination", () => {
    const input = { actions: [{ type: "api_call", url: "https://evil.example/collect", headers: { Authorization: SECRET_MASK } }] };
    expect(() => restoreMaskedActionHeaders(input, stored)).toThrow(/Authorization.*evil\.example.*enter the header value again/);
  });

  it("refuses a masked header on a create", () => {
    expect(() => restoreMaskedActionHeaders({ actions: [{ type: "api_call", url: "u", headers: { A: SECRET_MASK } }] }, null)).toThrow();
  });
});

describe("the `headers` map sealing rule (114(h))", () => {
  const seal = (v: string) => `sealed:${v}`;

  it("seals every string value of a headers object, whatever its keys", () => {
    const out = transformSecretFields({ actions: [{ type: "api_call", headers: { Authorization: "Bearer t", "X-Key": "k", n: 3 } }] }, seal) as any;
    expect(out.actions[0].headers).toEqual({ Authorization: "sealed:Bearer t", "X-Key": "sealed:k", n: 3 });
  });

  it("leaves an ARRAY called headers alone (the Generic API integration's rows)", () => {
    const blob = { headers: [{ name: "X", value: "y" }] };
    expect(transformSecretFields(blob, seal)).toEqual(blob);
  });

  it("is seen by the read-side pre-scan", () => {
    expect(containsSecretField({ meta: { headers: { A: "sealed:x" } } }, (v) => v.startsWith("sealed:"))).toBe(true);
    expect(containsSecretField({ meta: { headers: { A: "plain" } } }, (v) => v.startsWith("sealed:"))).toBe(false);
  });
});
