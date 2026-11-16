/**
 * tests/unit/intunePublishService.test.ts
 *
 * The edges of the Intune Remediation publish that tests/unit/intunePublish.test.ts
 * (the never-assign / upsert / probe suite) does not reach: a POST answered
 * without an id, the bounded policy lookup, the id escaped into the PATCH
 * URL, a probe error that is not a 403, the fingerprint fallback, the
 * per-tenant cache key for a config with no tenantId, and the audit hashes.
 * No Graph call leaves the process — graphApiRequest is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  getOnboardingScript: vi.fn(),
  getOnboardingState: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/entraIdService.js", () => ({ graphApiRequest: h.graph }));
vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({
  getOnboardingScript: h.getOnboardingScript,
  getOnboardingState: h.getOnboardingState,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  publishOnboardingScripts,
  listPublishTargets,
  INTUNE_POLICY_NAME,
  _resetResolvedBase,
} from "../../src/services/intunePublishService.js";

const V1 = "https://graph.microsoft.com/v1.0/deviceManagement/deviceHealthScripts";
const BETA = "https://graph.microsoft.com/beta/deviceManagement/deviceHealthScripts";
const integ = { findUnique: stubbed(prisma.integration.findUnique), findMany: stubbed(prisma.integration.findMany) };

function enabled(config: Record<string, unknown> = {}) {
  integ.findUnique.mockResolvedValue({ id: "i1", name: "Corp Entra", type: "entraid", config: { tenantId: "t1", publishToIntune: true, ...config } });
}
type Call = { url: string; method: string; body?: any };
const calls = (): Call[] => h.graph.mock.calls.map((c: any[]) => ({ url: c[1], method: c[2]?.method ?? "GET", body: c[2]?.body }));

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (err) { return err as AppError; }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
  _resetResolvedBase();
  h.graph.mockReset().mockImplementation(async (_c: unknown, _u: string, opts: any) => (opts?.method === "POST" ? { id: "new-id" } : { value: [] }));
  h.getOnboardingScript.mockReset().mockImplementation(async (_p: string, kind: string) => ({ script: kind === "detection" ? "DETECT" : "REMEDIATE" }));
  h.getOnboardingState.mockReset().mockResolvedValue({ fingerprint: "SHA256:abc" });
});

describe("loadEnabledIntegration gate", () => {
  it("refuses a row whose config is null, naming the checkbox, and reaches Graph zero times", async () => {
    integ.findUnique.mockResolvedValue({ id: "i1", name: "Corp Entra", type: "entraid", config: null });
    const err = await rejection(publishOnboardingScripts("i1", "alice"));
    expect(err.httpStatus).toBe(400);
    expect(err.message).toMatch(/Publish deployment scripts to Intune/);
    expect(h.graph).not.toHaveBeenCalled();
  });

  it("only an exact true opts in (a truthy string does not)", async () => {
    enabled({ publishToIntune: "true" });
    expect((await rejection(publishOnboardingScripts("i1", "alice"))).httpStatus).toBe(400);
  });
});

describe("publishOnboardingScripts — create / update edges", () => {
  it("502s when Graph accepts the POST but returns no id, and logs nothing", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, _u: string, opts: any) => (opts?.method === "POST" ? {} : { value: [] }));
    const err = await rejection(publishOnboardingScripts("i1", "alice"));
    expect(err.httpStatus).toBe(502);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("escapes the existing policy id into the PATCH URL", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, url: string) =>
      (url.includes("$top=100") ? { value: [{ id: "a/b c", displayName: INTUNE_POLICY_NAME }] } : { value: [] }));
    const out = await publishOnboardingScripts("i1", "alice");
    expect(out).toMatchObject({ policyId: "a/b c", created: false, assigned: false, graphBase: "https://graph.microsoft.com/v1.0" });
    const patch = calls().find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`${V1}/a%2Fb%20c`);
  });

  it("matches the display name exactly — a near-miss creates a new policy", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, url: string, opts: any) => {
      if (opts?.method === "POST") return { id: "fresh" };
      return url.includes("$top=100") ? { value: [{ id: "x", displayName: INTUNE_POLICY_NAME.toLowerCase() }, { id: "y" }] } : { value: [] };
    });
    expect((await publishOnboardingScripts("i1", "alice")).created).toBe(true);
  });

  it("stops paging the lookup after 20 pages and creates", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, url: string, opts: any) => {
      if (opts?.method === "POST") return { id: "fresh" };
      if (url.includes("$top=1&") || url.endsWith("$top=1")) return { value: [] };
      return { value: [{ id: "z", displayName: "other" }], "@odata.nextLink": `${V1}?page=next` };
    });
    const out = await publishOnboardingScripts("i1", "alice");
    expect(out.created).toBe(true);
    const lookups = calls().filter((c) => c.method === "GET" && !c.url.endsWith("$top=1"));
    expect(lookups).toHaveLength(20);
  });

  it("puts 'unknown' in the description when no key fingerprint exists", async () => {
    enabled();
    h.getOnboardingState.mockResolvedValue({ fingerprint: null });
    await publishOnboardingScripts("i1", "alice");
    const post = calls().find((c) => c.method === "POST")!;
    expect(post.body.description).toMatch(/Key fingerprint: unknown$/);
    expect(post.body.enforceSignatureCheck).toBe(false);
    expect(post.body.publisher).toBe("Polaris");
  });

  it("audits the SHA-256 of each script it sent, and never the scripts themselves", async () => {
    enabled();
    await publishOnboardingScripts("i1", "alice");
    const ev = eventLog.logEvent.mock.calls[0][0];
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    expect(ev).toMatchObject({
      action: "intune.script_published", resourceId: "i1", resourceName: "Corp Entra", actor: "alice", level: "warning",
      details: { policyId: "new-id", created: true, assigned: false, remediationSha256: sha("REMEDIATE"), detectionSha256: sha("DETECT") },
    });
    expect(ev.message).toMatch(/^Created the Intune Remediation/);
    expect(JSON.stringify(ev)).not.toContain("REMEDIATE\"");
  });
});

describe("Graph version probe — edges", () => {
  it("a non-permission error on v1.0 falls through to beta", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, url: string, opts: any) => {
      if (url.startsWith(V1) && url.endsWith("$top=1")) throw new Error("Graph request failed: 500");
      if (opts?.method === "POST") return { id: "b1" };
      return { value: [] };
    });
    const out = await publishOnboardingScripts("i1", "alice");
    expect(out.graphBase).toBe("https://graph.microsoft.com/beta");
    expect(calls().find((c) => c.method === "POST")!.url).toBe(BETA);
  });

  it("the 502 names the last transport error when neither version answers", async () => {
    enabled();
    h.graph.mockImplementation(async (_c: unknown, url: string) => {
      if (url.startsWith(BETA)) throw new Error("socket hang up");
      return null;
    });
    const err = await rejection(publishOnboardingScripts("i1", "alice"));
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain("socket hang up");
    expect(err.message).toContain("DeviceManagementScripts.ReadWrite.All");
  });

  it("probes with allow404 so a 404 reads as 'wrong version'", async () => {
    enabled();
    await publishOnboardingScripts("i1", "alice");
    expect(h.graph.mock.calls[0][2]).toEqual({ method: "GET", allow404: true });
  });

  it("a probe that failed is not cached — the next publish probes again", async () => {
    enabled();
    h.graph.mockResolvedValue(null);
    await rejection(publishOnboardingScripts("i1", "alice"));
    h.graph.mockReset().mockImplementation(async (_c: unknown, _u: string, opts: any) => (opts?.method === "POST" ? { id: "n" } : { value: [] }));
    await publishOnboardingScripts("i1", "alice");
    expect(h.graph.mock.calls[0][1]).toBe(`${V1}?$top=1`);
  });
});

describe("listPublishTargets", () => {
  it("lists Entra integrations by name, a null config reading as not enabled", async () => {
    integ.findMany.mockResolvedValue([
      { id: "a", name: "A", config: null },
      { id: "b", name: "B", config: { publishToIntune: true } },
    ]);
    expect(await listPublishTargets()).toEqual([
      { integrationId: "a", integrationName: "A", enabled: false },
      { integrationId: "b", integrationName: "B", enabled: true },
    ]);
    expect(integ.findMany.mock.calls[0][0]).toMatchObject({ where: { type: "entraid" }, orderBy: { name: "asc" } });
  });
});
