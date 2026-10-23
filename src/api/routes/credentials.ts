/**
 * src/api/routes/credentials.ts
 *
 * CRUD for the named-credential store used by monitoring probes.
 * Read is open to any role with `credentials=read` so the Asset Monitoring
 * tab can populate its credential picker and label (secrets masked).
 *
 * Writes carry the OWNERSHIP dimension (see polaris-api-rbac -> auth-rbac.md "Ownership model"),
 * the fourth key to do so after subnets / reservations / contacts:
 *
 *   write     — create; edit / delete / test-with ONLY rows you created
 *   fullwrite — edit / delete / test-with any row
 *
 * `createdBy` is stamped once at create and no update path rewrites it, so
 * ownership cannot be adopted by saving someone else's row. A null
 * `createdBy` (every row that predates the column, and anything created by
 * a bearer token, which has no username) is UNOWNED and therefore
 * fullwrite-only — `assertOwnership` already treats null that way.
 *
 * POST /test is gated the same way, and not merely as a courtesy: passing
 * `id` merges that credential's STORED secrets into the probe, so a
 * write-level caller who could test any row could aim someone else's
 * password at any host in inventory. Testing an unsaved form (no `id`) is
 * always allowed at write — the secret in that body is one the caller typed.
 */

import { Router } from "express";
import { z } from "zod";
import * as credentialService from "../../services/credentialService.js";
import { requirePermission, requireOwnership, assertOwnership } from "../middleware/permissions.js";
import { credentialTestLimiter } from "../middleware/rateLimits.js";
import { logEvent } from "./events.js";
import { AppError } from "../../utils/errors.js";
import { assetDialAddress } from "../../utils/assetDialAddress.js";
import { ipv6Enabled } from "../../services/ipv6GateService.js";
import { probeCredentialAgainstHost } from "../../services/monitoringService.js";
import { isDeviceLoginCredential, type HttpAuthConfig, type HttpProbeDiagnostics } from "../../utils/httpCheck.js";
import { normalizeProbeTarget } from "../../utils/probeTarget.js";
import { resolveAllowedHost, guardedLookup } from "../../utils/netGuard.js";

const router = Router();

const CredentialTypeEnum = z.enum(["snmp", "winrm", "ssh", "restapi", "http"]);

const CreateSchema = z.object({
  name:   z.string().min(1),
  type:   CredentialTypeEnum,
  config: z.record(z.unknown()),
});

const UpdateSchema = z.object({
  name:   z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

// Body for POST /credentials/test. Drives the Test Connection button on the
// add/edit credential modal. The operator picks an asset for its host (the
// asset's monitor settings are intentionally ignored — this exercises the
// credential as configured in the form, not what the asset would normally
// use). When `id` is set, masked secrets in `config` are filled in from the
// stored credential so editing without retyping the password still works.
// The target is EITHER an asset (borrow its address) or a hand-typed host.
// Both are accepted because the two answer different questions: an asset test
// exercises the credential against real inventory, while a typed host is what
// you need before the device is onboarded — or when it will never be an asset
// at all (a staging box, a vendor's demo unit, a loopback stub). `assetId` stays
// first-class and unchanged; `host` is validated by normalizeProbeTarget.
const TestSchema = z.object({
  assetId: z.string().uuid("assetId must be a UUID").optional(),
  host:    z.string().min(1).max(300).optional(),
  type:    CredentialTypeEnum,
  config:  z.record(z.unknown()),
  id:      z.string().uuid().optional(),
  // `http` only: the check to exercise (path / expected status / expected body
  // / TLS). It is supplied per-test rather than read off the credential because
  // the credential carries authentication only — and supplying it here is what
  // lets an operator dial a check in against a real device before saving it to
  // a manufacturer widget.
  check:   z.record(z.unknown()).optional(),
}).refine((v) => !!v.assetId || !!v.host || v.type === "restapi", {
  // restapi is the exception it has always been: the credential carries its own
  // baseUrl, so it needs no target of either kind.
  message: "Provide either an assetId or a host to test against",
});

// GET /credentials — any authenticated session may list (secrets masked)
router.get("/", requirePermission("credentials", "read"), async (_req, res, next) => {
  try {
    res.json(await credentialService.listCredentials());
  } catch (err) { next(err); }
});

// GET /credentials/usage — effective-usage asset count per credential, keyed by
// credential id. Drives the Assets column on the Stored Credentials table in
// one round-trip. Registered before /:id so "usage" isn't read as an id.
router.get("/usage", requirePermission("credentials", "read"), async (_req, res, next) => {
  try {
    res.json(await credentialService.getCredentialUsageCounts());
  } catch (err) { next(err); }
});

// GET /credentials/:id
router.get("/:id", requirePermission("credentials", "read"), async (req, res, next) => {
  try {
    res.json(await credentialService.getCredential(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /credentials/:id/usage — full usage breakdown grouped by level
// (asset / class / integration) for the usage slide-in.
router.get("/:id/usage", requirePermission("credentials", "read"), async (req, res, next) => {
  try {
    res.json(await credentialService.getCredentialUsage(req.params.id as string));
  } catch (err) { next(err); }
});

// POST /credentials — any write-level caller may create; the row is stamped
// with their username so they (and fullwrite callers) can edit it later.
router.post("/", requireOwnership("credentials"), async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const saved = await credentialService.createCredential({
      name: input.name,
      type: input.type,
      config: input.config,
      createdBy: req.session?.username ?? null,
    });
    logEvent({
      action: "credential.created",
      resourceType: "credential",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Credential "${saved.name}" (${saved.type}) created${credentialService.credentialAllowsReboot(saved.type, saved.config) ? " — reboots allowed" : ""}`,
      ...(credentialService.credentialAllowsReboot(saved.type, saved.config) ? { details: { allowReboot: true } } : {}),
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

// PUT /credentials/:id — own rows at write, any row at fullwrite.
router.put("/:id", requireOwnership("credentials"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await credentialService.getCredential(id);
    assertOwnership(req, existing.createdBy, "edit credentials");
    const input = UpdateSchema.parse(req.body);
    const saved = await credentialService.updateCredential(id, {
      name: input.name,
      config: input.config,
    });
    // Granting or withdrawing the right to reboot devices (rule 115) is named
    // in the record, not folded into a bare "updated".
    const rebootBefore = credentialService.credentialAllowsReboot(existing.type, existing.config);
    const rebootAfter = credentialService.credentialAllowsReboot(saved.type, saved.config);
    const rebootNote = rebootBefore === rebootAfter ? "" : rebootAfter ? " — reboots now allowed" : " — reboots no longer allowed";
    logEvent({
      action: "credential.updated",
      resourceType: "credential",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      level: rebootBefore !== rebootAfter ? "warning" : "info",
      message: `Credential "${saved.name}" updated${rebootNote}`,
      ...(rebootBefore !== rebootAfter ? { details: { allowReboot: rebootAfter } } : {}),
    });
    res.json(saved);
  } catch (err) { next(err); }
});

// POST /credentials/test — exercise a credential against a chosen asset's IP
// without persisting anything. Body { assetId, type, config, id? }. When `id`
// is set, masked secrets in `config` are merged from the stored credential so
// the operator doesn't have to retype the password on edit. Returns the same
// shape as a probe: { success, responseTimeMs, error?, host }.
router.post("/test", credentialTestLimiter, requireOwnership("credentials"), async (req, res, next) => {
  try {
    const input = TestSchema.parse(req.body);

    // Testing a STORED credential is an ownership-scoped act — the merge
    // below fills the form's masked fields from the row's real secrets, so
    // this is the difference between "test my credential" and "borrow
    // yours". Checked before any target resolution or device I/O.
    if (input.id) {
      const owner = await credentialService.getCredential(input.id);
      assertOwnership(req, owner.createdBy, "test credentials");
    }

    // Resolve the target. An assetId wins when both are sent, so a stale `host`
    // left in a request body can never redirect a probe the operator aimed at
    // an asset.
    let asset: Awaited<ReturnType<typeof credentialService.getTestAssetTarget>> | null = null;
    let host: string | null | undefined;
    let hostSource: "asset" | "manual";
    let typedHostLookup: import("node:net").LookupFunction | undefined;

    if (input.assetId) {
      hostSource = "asset";
      asset = await credentialService.getTestAssetTarget(input.assetId);
      host = assetDialAddress(asset, ipv6Enabled()) || asset.dnsName || asset.hostname; // rule 127
      // restapi credentials carry their own baseUrl, so a host on the asset is
      // optional — the credential is tested against its own URL. Every other
      // type still needs a routable target.
      if (!host && input.type !== "restapi") {
        throw new AppError(400, "Asset has no IP, DNS name, or hostname to test against");
      }
    } else {
      hostSource = "manual";
      // A typed target is validated rather than salvaged — see probeTarget.ts.
      // The refusal is returned as a test RESULT, not a 4xx, so the modal renders
      // it inline next to the field the operator just typed in.
      const target = normalizeProbeTarget(input.host);
      if (target.error && input.type !== "restapi") {
        res.json({ success: false, responseTimeMs: 0, error: target.error, host: null });
        return;
      }
      host = target.host;
      // A typed target is a host the caller chose freely, and an `http` test hands the
      // response back — so it may not be this host, a link-local or metadata address, by
      // literal or by what its name resolves to (rule 110). An asset-targeted test is
      // aimed at known inventory and is not judged here. Answered as a RESULT, like the
      // refusal above.
      if (host) {
        try {
          // Re-scan F58: the check must be what the probe connects to. A name
          // that does not resolve now is refused (it used to be waved through
          // and resolved again, unguarded, by the probe). SSH / SNMP / ICMP
          // then dial the checked ADDRESS; `http` (which hands the response
          // back) connects through guardedLookup, keeping the name for the
          // Host header and TLS. WinRM keeps the name for its certificate
          // check and is pinned (rule 113).
          const checked = await resolveAllowedHost(host);
          if (!checked) {
            res.json({ success: false, responseTimeMs: 0, error: `${host} does not resolve. Check the name, or test against its address.`, host: null });
            return;
          }
          if (input.type === "ssh" || input.type === "snmp") host = checked;
          typedHostLookup = guardedLookup();
        } catch (err: any) {
          if (err?.code !== "BLOCKED_HOST") throw err;
          res.json({
            success: false,
            responseTimeMs: 0,
            error: `${host} is a loopback / link-local / metadata address. Test against the device's routable address, or pick the asset.`,
            host: null,
          });
          return;
        }
      }
    }

    let config = input.config || {};
    if (input.id) {
      const existing = await credentialService.getCredential(input.id, { revealSecrets: true });
      if (existing.type !== input.type) {
        throw new AppError(400, `Credential "${existing.name}" is type "${existing.type}", but the form sent "${input.type}"`);
      }
      config = credentialService.mergeConfigPreservingSecrets(
        input.type,
        (existing.config as Record<string, unknown>) || {},
        config,
      );
    }

    // The check definition is validated with the same function the widget uses,
    // so a check cannot pass here and be rejected when it is saved.
    const check: Record<string, unknown> = { ...(input.check || {}) };
    // An `http` test with an EMPTY config is testing an unauthenticated check —
    // the state of a widget with no credential attached, which is a legitimate
    // and common thing to want to try. Validating it as a credential would
    // demand an authMode and make that untestable, so the credential half is
    // validated only when the caller actually supplied one.
    const skipCredentialValidation =
      input.type === "http" && Object.keys(config).length === 0;
    try {
      if (!skipCredentialValidation) credentialService.validateConfig(input.type, config);
      if (input.type === "http") credentialService.validateHttpCheckDefinition(check);
    } catch (err: any) {
      // Surface validation errors as the test result rather than a 4xx so
      // the modal renders them inline like a probe failure.
      res.json({
        success: false,
        responseTimeMs: 0,
        error: err?.message || "Credential config is invalid",
        host,
      });
      return;
    }

    // A restapi credential is aimed at its own baseUrl, not at the typed host or
    // the asset — so the rule 110 guard above never saw where it goes. Same
    // check on the baseUrl's host (re-scan F73). Answered as a RESULT.
    if (input.type === "restapi" && typeof (config as Record<string, unknown>).baseUrl === "string") {
      let baseHost = "";
      try { baseHost = new URL(String((config as Record<string, unknown>).baseUrl)).hostname; } catch { baseHost = ""; }
      if (baseHost) {
        try {
          await resolveAllowedHost(baseHost);
        } catch (err: any) {
          if (err?.code !== "BLOCKED_HOST") throw err;
          res.json({
            success: false,
            responseTimeMs: 0,
            error: `The base URL points at ${baseHost}, a loopback / link-local / metadata address. Use the API's routable address.`,
            host,
          });
          return;
        }
      }
    }

    // A device admin login (authMode "form") has no HTTP check to run: it is
    // the password a switch or AP's login page takes, and the only thing that
    // can prove it is the firmware engine logging in (business rule 87).
    // Answered as a RESULT, not a 4xx, so the modal renders it inline.
    if (input.type === "http" && isDeviceLoginCredential(config as HttpAuthConfig)) {
      res.json({
        success: false,
        responseTimeMs: 0,
        error: "Device admin logins are used by the firmware repository and are verified when an upgrade signs in to the device",
        host,
      });
      return;
    }

    // `http` credentials get diagnostics back — the request line, status,
    // content-type and a body excerpt — because an HTTP check's whole point is
    // a string the operator has to pick OUT of the response, and pass/fail
    // alone gives them nothing to pick from. Nothing else fills this.
    const probeOut: { diag?: HttpProbeDiagnostics } = {};
    const result = await probeCredentialAgainstHost(host || "", input.type, config, probeOut, check, typedHostLookup);
    // A typed target has no asset to name, so the host IS the label. Keeping the
    // asset's own label when there is one means the audit trail reads the same
    // as it always has for the inventory path.
    const label = asset
      ? (asset.hostname || asset.ipAddress || asset.id)
      : (host || "(no target)");
    logEvent({
      action: "credential.tested",
      resourceType: "credential",
      resourceId: input.id,
      actor: req.session?.username,
      level: result.success ? "info" : "warning",
      message: result.success
        ? `Credential test succeeded against ${label} (${result.responseTimeMs} ms)`
        : `Credential test failed against ${label}: ${result.error || "unknown error"}`,
      // The response BODY is deliberately not in the Event: it is arbitrary
      // device output of unbounded sensitivity, it would land in every pg_dump
      // and every syslog forward, and the operator who needs it is already
      // looking at it in the modal. Only the shape of the answer is audited.
      details: {
        // `hostSource` is audited because the two are materially different acts:
        // an asset test is aimed at known inventory, a manual one at an address
        // the operator chose freely. Reviewing "who probed what from Polaris"
        // needs to be able to tell them apart.
        assetId: input.assetId ?? null, host, hostSource, type: input.type,
        ...(probeOut.diag
          ? { httpStatus: probeOut.diag.statusCode, httpUrl: probeOut.diag.url, httpMatched: probeOut.diag.matched }
          : {}),
      },
    });
    res.json({ ...result, host, ...(probeOut.diag ? { httpDiagnostics: probeOut.diag } : {}) });
  } catch (err) { next(err); }
});

// DELETE /credentials/:id — own rows at write, any row at fullwrite.
router.delete("/:id", requireOwnership("credentials"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await credentialService.getCredential(id);
    assertOwnership(req, existing.createdBy, "delete credentials");
    await credentialService.deleteCredential(id);
    logEvent({
      action: "credential.deleted",
      resourceType: "credential",
      resourceId: id,
      resourceName: existing.name,
      actor: req.session?.username,
      message: `Credential "${existing.name}" deleted`,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
