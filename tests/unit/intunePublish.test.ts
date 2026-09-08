/**
 * tests/unit/intunePublish.test.ts
 *
 * Publishing the Windows SSH onboarding pair to Intune as a Remediation.
 *
 * The load-bearing test in this file is "never assigns". Everything else here
 * is ordinary upsert/validation coverage; that one is a security property —
 * assignment is the human review gate for a script that grants fleet-wide
 * administrative SSH, and a future refactor that "helpfully" adds an /assign
 * call must fail loudly here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Doubles ──────────────────────────────────────────────────────────────

interface FakeIntegration { id: string; name: string; type: string; config: Record<string, unknown> }
const db = { integrations: [] as FakeIntegration[] };

vi.mock("../../src/db.js", () => ({
  prisma: {
    integration: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        db.integrations.filter((i) => (where?.type ? i.type === where.type : true)),
      ),
      findUnique: vi.fn(async ({ where }: any) => db.integrations.find((i) => i.id === where.id) ?? null),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

/** Every Graph call the service makes, in order. */
const graphCalls: Array<{ url: string; method: string; body?: any }> = [];
/** Queue of responses; a function may throw to simulate an error status. */
let graphResponder: (url: string, opts: any) => any = () => ({ value: [] });

vi.mock("../../src/services/entraIdService.js", () => ({
  graphApiRequest: vi.fn(async (_cfg: any, url: string, opts: any = {}) => {
    graphCalls.push({ url, method: opts.method ?? "GET", body: opts.body });
    return graphResponder(url, opts);
  }),
}));

vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingScript: vi.fn(async (_platform: string, kind: string) => ({
    platform: "windows", kind,
    filename: kind === "detection" ? "detect.ps1" : "onboard.ps1",
    script: kind === "detection" ? "DETECTION-SCRIPT-BODY" : "REMEDIATION-SCRIPT-BODY",
  })),
  getOnboardingState: vi.fn(async () => ({ fingerprint: "SHA256:abc123" })),
}));

import {
  publishOnboardingScripts,
  listPublishTargets,
  INTUNE_POLICY_NAME,
  _resetResolvedBase,
} from "../../src/services/intunePublishService.js";
import { logEvent } from "../../src/services/eventLogService.js";

const V1 = "https://graph.microsoft.com/v1.0/deviceManagement/deviceHealthScripts";
const BETA = "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts";

function seedEnabledIntegration(overrides: Partial<FakeIntegration> = {}) {
  db.integrations.push({
    id: "11111111-1111-1111-1111-111111111111",
    name: "Corp Entra",
    type: "entraid",
    config: { tenantId: "t", clientId: "c", clientSecret: "s", publishToIntune: true },
    ...overrides,
  });
}

beforeEach(() => {
  db.integrations = [];
  graphCalls.length = 0;
  _resetResolvedBase();
  vi.clearAllMocks();
  // Default: v1.0 serves the endpoint, nothing published yet.
  graphResponder = () => ({ value: [] });
});

// ─── The invariant ────────────────────────────────────────────────────────

describe("never assigns the policy", () => {
  it("makes no /assign call on create", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) =>
      opts.method === "POST" ? { id: "policy-1" } : { value: [] };

    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");

    expect(res.assigned).toBe(false);
    // Assignment is the human review gate. If this ever fails, someone added
    // an /assign call and that is a security decision, not a bug fix.
    expect(graphCalls.some((c) => c.url.includes("/assign"))).toBe(false);
    expect(graphCalls.some((c) => c.url.includes("assignments"))).toBe(false);
  });

  it("makes no /assign call on update either", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) =>
      opts.method === "GET" ? { value: [{ id: "existing-9", displayName: INTUNE_POLICY_NAME }] } : null;

    await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(graphCalls.some((c) => c.url.includes("/assign"))).toBe(false);
  });
});

// ─── Upsert ───────────────────────────────────────────────────────────────

describe("upsert", () => {
  it("POSTs a new policy when none exists", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "policy-1" } : { value: [] });

    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.created).toBe(true);
    expect(res.policyId).toBe("policy-1");

    const post = graphCalls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(V1);
    expect(post.body.displayName).toBe(INTUNE_POLICY_NAME);
  });

  it("PATCHes the existing policy when one matches by name — no duplicate", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) =>
      opts.method === "GET" ? { value: [{ id: "existing-9", displayName: INTUNE_POLICY_NAME }] } : null;

    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.created).toBe(false);
    expect(res.policyId).toBe("existing-9");
    expect(graphCalls.some((c) => c.method === "POST")).toBe(false);
    expect(graphCalls.find((c) => c.method === "PATCH")!.url).toBe(`${V1}/existing-9`);
  });

  it("ignores unrelated policies when matching by name", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) =>
      opts.method === "GET"
        ? { value: [{ id: "other", displayName: "Someone else's remediation" }] }
        : { id: "policy-new" };

    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.created).toBe(true);
  });

  it("pages the lookup rather than only reading the first page", async () => {
    seedEnabledIntegration();
    let page = 0;
    graphResponder = (url, opts) => {
      if (opts.method !== "GET") return null;
      page += 1;
      if (page === 1) return { value: [{ id: "x", displayName: "nope" }], "@odata.nextLink": `${V1}?page=2` };
      return { value: [{ id: "found-on-page-2", displayName: INTUNE_POLICY_NAME }] };
    };
    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.policyId).toBe("found-on-page-2");
  });
});

// ─── Payload ──────────────────────────────────────────────────────────────

describe("payload", () => {
  it("base64-encodes both scripts into the right fields", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "p" } : { value: [] });

    await publishOnboardingScripts(db.integrations[0].id, "tester");
    const body = graphCalls.find((c) => c.method === "POST")!.body;

    expect(Buffer.from(body.remediationScriptContent, "base64").toString("utf8"))
      .toBe("REMEDIATION-SCRIPT-BODY");
    expect(Buffer.from(body.detectionScriptContent, "base64").toString("utf8"))
      .toBe("DETECTION-SCRIPT-BODY");
  });

  it("runs as system in the 64-bit host", async () => {
    // Both matter: the script writes to %ProgramData% and registers a service,
    // and Get-WindowsCapability/New-LocalUser misbehave under 32-bit redirection.
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "p" } : { value: [] });
    await publishOnboardingScripts(db.integrations[0].id, "tester");
    const body = graphCalls.find((c) => c.method === "POST")!.body;
    expect(body.runAsAccount).toBe("system");
    expect(body.runAs32Bit).toBe(false);
  });

  it("carries the key fingerprint and a review warning in the description", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "p" } : { value: [] });
    await publishOnboardingScripts(db.integrations[0].id, "tester");
    const body = graphCalls.find((c) => c.method === "POST")!.body;
    expect(body.description).toContain("SHA256:abc123");
    expect(body.description).toMatch(/review before assigning/i);
  });
});

// ─── Opt-in gate ──────────────────────────────────────────────────────────

describe("opt-in gate", () => {
  it("refuses when the integration has not enabled publishing, naming the checkbox", async () => {
    seedEnabledIntegration({ config: { tenantId: "t", clientId: "c", clientSecret: "s" } });
    await expect(publishOnboardingScripts(db.integrations[0].id, "t"))
      .rejects.toThrow(/Script Publishing tab/i);
    expect(graphCalls).toHaveLength(0); // nothing reached the tenant
  });

  it("refuses a non-Entra integration", async () => {
    seedEnabledIntegration({ type: "azurearc" });
    await expect(publishOnboardingScripts(db.integrations[0].id, "t"))
      .rejects.toThrow(/Entra ID integration/i);
  });

  it("404s an unknown integration", async () => {
    await expect(publishOnboardingScripts("22222222-2222-2222-2222-222222222222", "t"))
      .rejects.toThrow(/not found/i);
  });
});

// ─── Graph version probe ──────────────────────────────────────────────────

describe("v1.0 / beta probe", () => {
  it("uses v1.0 when it serves the endpoint", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "p" } : { value: [] });
    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.graphBase).toBe("https://graph.microsoft.com/v1.0");
  });

  it("falls back to beta when v1.0 404s", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => {
      if (url.startsWith(V1) && opts.allow404) return null;   // 404 on v1.0
      if (url.startsWith(BETA) && opts.allow404) return { value: [] };
      return opts.method === "POST" ? { id: "p" } : { value: [] };
    };
    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.graphBase).toBe("https://graph.microsoft.com/beta");
    expect(graphCalls.find((c) => c.method === "POST")!.url).toBe(BETA);
  });

  it("treats a 403 as 'this version exists, permission missing' rather than falling through", async () => {
    // The distinction matters: falling through to beta on a permission error
    // would report the wrong problem and publish to the wrong API version.
    seedEnabledIntegration();
    let probed = false;
    graphResponder = (url, opts) => {
      if (opts.allow404 && !probed) {
        probed = true;
        throw new Error("Graph API permission denied (403): insufficient privileges");
      }
      return opts.method === "POST" ? { id: "p" } : { value: [] };
    };
    const res = await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(res.graphBase).toBe("https://graph.microsoft.com/v1.0");
  });

  it("gives an actionable error when neither version serves it", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.allow404 ? null : { value: [] });
    await expect(publishOnboardingScripts(db.integrations[0].id, "t"))
      .rejects.toThrow(/DeviceManagementScripts\.ReadWrite\.All/);
  });

  it("caches the probe PER TENANT, so a second tenant is probed on its own", async () => {
    // Which API version serves deviceHealthScripts is a tenant property. A
    // process-global cache would let the first tenant decide for the second —
    // an install with a prod + test tenant would publish against the wrong
    // base and fail confusingly.
    seedEnabledIntegration({
      id: "11111111-1111-1111-1111-111111111111",
      config: { tenantId: "tenant-beta", clientId: "c", clientSecret: "s", publishToIntune: true },
    });
    seedEnabledIntegration({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Other Entra",
      config: { tenantId: "tenant-v1", clientId: "c", clientSecret: "s", publishToIntune: true },
    });
    // First tenant only answers on beta; the second answers on v1.0.
    let betaTenant = true;
    graphResponder = (url, opts) => {
      if (opts.allow404) {
        if (betaTenant) return url.startsWith(V1) ? null : { value: [] };
        return { value: [] };
      }
      return opts.method === "POST" ? { id: "p" } : { value: [] };
    };
    const first = await publishOnboardingScripts("11111111-1111-1111-1111-111111111111", "tester");
    expect(first.graphBase).toBe("https://graph.microsoft.com/beta");

    betaTenant = false;
    const second = await publishOnboardingScripts("22222222-2222-2222-2222-222222222222", "tester");
    expect(second.graphBase).toBe("https://graph.microsoft.com/v1.0");
  });

  it("reuses the cached base for repeat publishes to the SAME tenant", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "p" } : { value: [] });
    await publishOnboardingScripts(db.integrations[0].id, "tester");
    const probesAfterFirst = graphCalls.filter((c) => c.url.endsWith("$top=1")).length;
    await publishOnboardingScripts(db.integrations[0].id, "tester");
    expect(graphCalls.filter((c) => c.url.endsWith("$top=1")).length).toBe(probesAfterFirst);
  });
});

// ─── Audit + targets ──────────────────────────────────────────────────────

describe("audit", () => {
  it("stamps a warning event stating the policy is unassigned", async () => {
    seedEnabledIntegration();
    graphResponder = (url, opts) => (opts.method === "POST" ? { id: "policy-1" } : { value: [] });
    await publishOnboardingScripts(db.integrations[0].id, "alice");

    const ev = (logEvent as any).mock.calls.map((c: any[]) => c[0])
      .find((e: any) => e.action === "intune.script_published");
    expect(ev.level).toBe("warning");
    expect(ev.actor).toBe("alice");
    expect(ev.details.assigned).toBe(false);
    expect(ev.message).toMatch(/NOT assigned/);
    expect(ev.details.remediationSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("listPublishTargets", () => {
  it("returns Entra integrations flagged by opt-in state", async () => {
    seedEnabledIntegration();
    db.integrations.push({
      id: "33333333-3333-3333-3333-333333333333", name: "Other", type: "entraid",
      config: { tenantId: "t", clientId: "c", clientSecret: "s" },
    });
    const targets = await listPublishTargets();
    expect(targets).toHaveLength(2);
    // Disabled targets are RETURNED, not filtered — the UI points at the
    // checkbox rather than hiding the feature.
    expect(targets.find((t) => t.integrationName === "Corp Entra")!.enabled).toBe(true);
    expect(targets.find((t) => t.integrationName === "Other")!.enabled).toBe(false);
  });
});
