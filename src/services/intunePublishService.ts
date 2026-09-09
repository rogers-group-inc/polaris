/**
 * src/services/intunePublishService.ts — publish the Windows SSH onboarding
 * scripts to Microsoft Intune as a Remediation (deviceHealthScript).
 *
 * WHY. The SSH Deployment card already generates a remediation + detection
 * pair whose shape maps exactly onto an Intune Remediation. Getting it there
 * meant downloading two files, base64-ing nothing (Intune does that for you in
 * the console), and hand-setting runAsAccount/runAs32Bit — small steps, but
 * ones that are easy to get subtly wrong and that have to be repeated every
 * time the key is rotated. This closes that loop.
 *
 * ─── THE INVARIANT THAT MATTERS ──────────────────────────────────────────
 * THIS SERVICE NEVER ASSIGNS THE POLICY. It creates or updates the
 * Remediation and stops. Assignment — choosing which devices actually run a
 * script that grants fleet-wide administrative SSH — stays a human decision
 * made in the Intune console, which is the review gate the generated script
 * headers demand and the operator's review policy requires for deployed code.
 *
 * If you are here to "finish" this by adding an /assign call: that is a
 * product decision with a security review attached, not an oversight.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Opt-in. Refuses unless the Entra integration carries
 * `config.publishToIntune === true`, which the operator sets on that
 * integration's Script Publishing tab after granting the app registration
 * `DeviceManagementScripts.ReadWrite.All` (Graph application permission, admin
 * consent). That grant upgrades the credential from "reads device inventory"
 * to "creates device-management policy tenant-wide" — the tab says so, and so
 * does this comment.
 *
 * WHICH SCOPE. Observed in a live tenant (2026-09-08): Graph rejects these
 * calls with "must have one of DeviceManagementScripts.Read.All,
 * DeviceManagementScripts.ReadWrite.All" — NOT the
 * DeviceManagementConfiguration.* scope this file used to name, which is what
 * the published v1.0 reference lists for deviceHealthScripts. Which of the two
 * a tenant enforces tracks the API version it answers `deviceHealthScripts` on,
 * and that is exactly what resolveGraphBase probes for. So: tell operators to
 * grant the Scripts scope, and let the 403 text — which names the scope the
 * tenant actually wants — settle any disagreement. Do not "correct" this back
 * to one scope on the strength of the docs alone.
 */

import { createHash } from "node:crypto";

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { graphApiRequest, type EntraIdConfig } from "./entraIdService.js";
import { getOnboardingScript } from "./windowsSshOnboardingService.js";

/**
 * Display name of the managed Remediation. Also the fallback lookup key when
 * no policy id is stored, so it must stay stable — renaming it strands the
 * previously-published policy and the next publish creates a second one.
 */
export const INTUNE_POLICY_NAME = "Polaris — SSH onboarding (Windows)";
const INTUNE_PUBLISHER = "Polaris";

/**
 * Graph has served deviceHealthScripts from /beta far longer than from /v1.0,
 * and which one a given tenant answers on is not something to guess. Probe in
 * preference order, once per process, and cache.
 *
 * A 404 means "wrong version, try the next". Anything else — including 403 —
 * means the path EXISTS and we simply may not be allowed to read it yet, so
 * that base is the right one and the permission error surfaces later with a
 * message the operator can act on.
 */
const GRAPH_BASES = [
  "https://graph.microsoft.com/v1.0",
  "https://graph.microsoft.com/beta",
] as const;

/**
 * Probe result PER TENANT. Which API version serves `deviceHealthScripts` is a
 * property of the tenant, not of this process, so a single module-level string
 * would let the first tenant probed decide for every other one — an install
 * with two Entra integrations (prod + test tenant, or post-acquisition pair)
 * would publish against whichever base the other tenant happened to answer on
 * and fail confusingly. Keyed by tenantId; unbounded growth isn't a concern
 * since the key space is "Entra integrations an operator configured".
 */
const resolvedBaseByTenant = new Map<string, string>();

export function _resetResolvedBase(): void {
  resolvedBaseByTenant.clear();
}

async function resolveGraphBase(config: EntraIdConfig): Promise<string> {
  const tenantKey = config.tenantId || "";
  const cached = resolvedBaseByTenant.get(tenantKey);
  if (cached) return cached;
  let lastErr: unknown = null;
  for (const base of GRAPH_BASES) {
    try {
      const res = await graphApiRequest(
        config,
        `${base}/deviceManagement/deviceHealthScripts?$top=1`,
        { method: "GET", allow404: true },
      );
      if (res !== null) {
        resolvedBaseByTenant.set(tenantKey, base);
        logger.info({ base, tenantId: tenantKey }, "Intune deviceHealthScripts resolved");
        return base;
      }
      // null === 404 → this API version does not serve the endpoint.
    } catch (err: any) {
      // 403 = endpoint exists, permission missing. That is THIS base.
      if (typeof err?.message === "string" && err.message.includes("permission denied")) {
        resolvedBaseByTenant.set(tenantKey, base);
        return base;
      }
      lastErr = err;
    }
  }
  throw new AppError(
    502,
    "Could not reach Microsoft Graph deviceHealthScripts on /v1.0 or /beta" +
      (lastErr instanceof Error ? ` — ${lastErr.message}` : "") +
      ". Confirm the app registration has DeviceManagementScripts.ReadWrite.All (some tenants ask " +
      "for DeviceManagementConfiguration.ReadWrite.All instead — the 403 says which) with admin consent.",
  );
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

export interface IntunePublishTarget {
  integrationId: string;
  integrationName: string;
  enabled: boolean;
}

/**
 * Entra integrations, flagged with whether each has opted in. Disabled ones are
 * returned too so the UI can point at the checkbox rather than silently
 * offering nothing.
 */
export async function listPublishTargets(): Promise<IntunePublishTarget[]> {
  const rows = await prisma.integration.findMany({
    where: { type: "entraid" },
    select: { id: true, name: true, config: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    integrationId: r.id,
    integrationName: r.name,
    enabled: ((r.config ?? {}) as Record<string, unknown>).publishToIntune === true,
  }));
}

async function loadEnabledIntegration(integrationId: string): Promise<{ name: string; config: EntraIdConfig }> {
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new AppError(404, "Integration not found");
  if (row.type !== "entraid") {
    throw new AppError(400, "Intune publishing requires an Entra ID integration");
  }
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (config.publishToIntune !== true) {
    throw new AppError(
      400,
      `Script publishing is not enabled on "${row.name}" — turn on "Publish deployment scripts to Intune" ` +
        "on that integration's Script Publishing tab first.",
    );
  }
  return { name: row.name, config: config as unknown as EntraIdConfig };
}

export interface IntunePublishResult {
  policyId: string;
  created: boolean;
  displayName: string;
  /** Always false. Present so the caller can state it in the UI. */
  assigned: false;
  graphBase: string;
}

/**
 * Create or update the Remediation carrying the current Windows onboarding
 * pair. Idempotent: the same keypair republished twice updates one policy.
 */
export async function publishOnboardingScripts(
  integrationId: string,
  actor: string,
): Promise<IntunePublishResult> {
  const { name: integrationName, config } = await loadEnabledIntegration(integrationId);

  // Windows only — Intune does not deploy scripts to Linux this way; that half
  // is Arc's job.
  const [remediation, detection] = await Promise.all([
    getOnboardingScript("windows", "remediation"),
    getOnboardingScript("windows", "detection"),
  ]);

  const base = await resolveGraphBase(config);
  const collection = `${base}/deviceManagement/deviceHealthScripts`;

  // Find an existing policy by name. Graph's $filter on displayName is
  // unreliable across versions for this collection, so page and match exactly.
  const existing = await findPolicyByName(config, collection);

  const payload = {
    displayName: INTUNE_POLICY_NAME,
    description:
      "Managed by Polaris. Authorizes the Polaris SSH deployment key so the Polaris Agent can be " +
      "installed over SSH. Grants administrative SSH access to whatever this policy is assigned to — " +
      "review before assigning. " +
      `Key fingerprint: ${await currentFingerprint()}`,
    publisher: INTUNE_PUBLISHER,
    runAs32Bit: false,
    runAsAccount: "system",
    enforceSignatureCheck: false,
    detectionScriptContent: b64(detection.script),
    remediationScriptContent: b64(remediation.script),
  };

  let policyId: string;
  let created: boolean;
  if (existing?.id) {
    await graphApiRequest(config, `${collection}/${encodeURIComponent(existing.id)}`, {
      method: "PATCH",
      body: payload,
    });
    policyId = existing.id;
    created = false;
  } else {
    const res = await graphApiRequest(config, collection, { method: "POST", body: payload });
    if (!res?.id) throw new AppError(502, "Intune accepted the script but returned no policy id");
    policyId = String(res.id);
    created = true;
  }

  // NOTE: no /assign call. See the header. This is the review gate.

  await logEvent({
    action: "intune.script_published",
    resourceType: "integration",
    resourceId: integrationId,
    resourceName: integrationName,
    actor,
    level: "warning",
    message:
      `${created ? "Created" : "Updated"} the Intune Remediation "${INTUNE_POLICY_NAME}" — ` +
      "it is NOT assigned to any group; assign it in Intune after reviewing the script",
    details: {
      policyId,
      created,
      graphBase: base,
      assigned: false,
      remediationSha256: sha256(remediation.script),
      detectionSha256: sha256(detection.script),
    },
  });

  return { policyId, created, displayName: INTUNE_POLICY_NAME, assigned: false, graphBase: base };
}

async function findPolicyByName(
  config: EntraIdConfig,
  collection: string,
): Promise<{ id: string } | null> {
  let url: string | undefined = `${collection}?$top=100`;
  // Bounded: a tenant with a pathological number of remediations should not
  // page forever on an admin button press.
  for (let page = 0; url && page < 20; page++) {
    const res: any = await graphApiRequest(config, url, { method: "GET" });
    const hit = (res?.value ?? []).find((v: any) => v?.displayName === INTUNE_POLICY_NAME);
    if (hit?.id) return { id: String(hit.id) };
    url = res?.["@odata.nextLink"];
  }
  return null;
}

/** Fingerprint of the key the scripts carry, for the policy description. */
async function currentFingerprint(): Promise<string> {
  const { getOnboardingState } = await import("./windowsSshOnboardingService.js");
  const state = await getOnboardingState();
  return state.fingerprint ?? "unknown";
}
