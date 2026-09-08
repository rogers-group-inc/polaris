/**
 * src/api/routes/ha.ts — the High Availability tab's API, mounted /api/v1/ha.
 *
 * Two routers, because two very different callers reach this feature:
 *
 *   haRouter        an operator with a session. Reads need
 *                   serverSettingsSystem=read; everything that changes the
 *                   cluster, mints a token, or approves a node needs
 *                   fullwrite — these hand over the keys to the install.
 *
 *   haEnrollRouter  a node being built, with no session and no bearer. It
 *                   presents a single-use token in the body, is rate limited,
 *                   and is mounted above requireAuth in router.ts (the
 *                   /agents/enroll precedent).
 *
 * The unauthenticated surface is deliberately tiny: register, poll, download
 * once. It cannot enumerate anything, and every rejection returns the same
 * text so a caller learns nothing about whether a token existed.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { makeRateLimiter } from "../middleware/rateLimits.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "./events.js";
import {
  getHaConfig,
  redactHaConfig,
  computeAdvisories,
  getClusterStatus,
  enableHa,
  disableHa,
  detectLocalAddresses,
  type HaRole,
} from "../../services/haService.js";
import {
  mintNodeToken,
  renderNodeScript,
  renderTeardownScript,
  listEnrollments,
  approveEnrollment,
  rejectEnrollment,
  registerEnrollment,
  pollEnrollment,
  claimBundle,
} from "../../services/haEnrollmentService.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const AddrSchema = z.string().trim().min(1).max(255).regex(
  /^[a-zA-Z0-9._:-]+$/,
  "must be an IP address or a hostname",
);
const NameSchema = z.string().trim().min(1).max(63).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  "must start with a letter or digit and contain only letters, digits, dots, dashes or underscores",
);
const NodeInputSchema = z.object({
  name: NameSchema,
  clusterAddr: AddrSchema,
  extraSans: z.array(AddrSchema).max(8).optional(),
  reachPrimaryVia: AddrSchema.optional(),
});
const GslbSchema = z.object({
  monitorIntervalSec: z.number().int().min(1).max(300).optional(),
  monitorRetries: z.number().int().min(1).max(10).optional(),
  dnsTtlSec: z.number().int().min(0).max(3600).optional(),
});
const EnableSchema = z.object({
  scope: z.string().trim().min(1).max(63).optional(),
  witnessPlacement: z.enum(["third-site", "standby-dc", "primary-dc"]),
  primary: NodeInputSchema,
  standby: NodeInputSchema,
  witness: NodeInputSchema,
  gslb: GslbSchema.optional(),
});
const ProbeSchema = z.object({
  standbyAddr: AddrSchema.optional(),
  witnessAddr: AddrSchema.optional(),
  gslb: GslbSchema.optional(),
});
const RoleSchema = z.enum(["primary", "standby", "witness"]);
const TokenSchema = z.object({ role: RoleSchema });

const RegisterSchema = z.object({
  token: z.string().min(1).max(128),
  nodeName: z.string().trim().max(255).optional(),
  // Fingerprints as ssh-keygen -lf prints them.
  sshHostKeyFingerprints: z.array(z.string().trim().max(128)).max(8).optional(),
});

// ─── Operator router ────────────────────────────────────────────────────────

export const haRouter = Router();

/** Everything the tab renders: config, live cluster, advisories, enrollments. */
haRouter.get("/status", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const [cfg, cluster, enrollments] = await Promise.all([
      getHaConfig(),
      getClusterStatus(),
      listEnrollments(),
    ]);
    // Advisories run socket probes and shell-outs, so they are only computed
    // when the operator asks — a 10s status poll must stay cheap.
    res.json({
      config: redactHaConfig(cfg),
      cluster,
      enrollments,
      localAddresses: detectLocalAddresses(),
    });
  } catch (err) {
    next(err);
  }
});

/** The guidance card's figures. Separate because it probes the network. */
haRouter.post("/advisories", requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    const body = ProbeSchema.parse(req.body ?? {});
    res.json({ advisories: await computeAdvisories(body) });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enable", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const body = EnableSchema.parse(req.body);
    const actor = requestActor(req) ?? "unknown";
    const cfg = await enableHa(body, actor);
    await logEvent({
      action: "ha.enabled",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: `High availability enabled — witness at the ${body.witnessPlacement}`,
      details: {
        primary: body.primary.name,
        standby: body.standby.name,
        witness: body.witness.name,
        witnessPlacement: body.witnessPlacement,
      },
    });
    res.json({ config: redactHaConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/disable", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const actor = requestActor(req) ?? "unknown";
    const cfg = await disableHa(actor);
    await logEvent({
      action: "ha.disabled",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: "High availability disabled in configuration — run the teardown script on each host",
    });
    res.json({ config: redactHaConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

/**
 * Mint a token and return the bootstrap script in one call.
 *
 * One call rather than two because the raw token exists only in this response:
 * storing it to serve a later download would defeat hashing it.
 */
haRouter.post("/tokens", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const { role } = TokenSchema.parse(req.body);
    const actor = requestActor(req) ?? "unknown";
    const minted = await mintNodeToken(role as HaRole, actor);
    const script = await renderNodeScript(role as HaRole, minted.token);
    await logEvent({
      action: "ha.token_minted",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: `HA bootstrap script generated for the ${role} node (${minted.nodeName})`,
      details: { role, nodeName: minted.nodeName, enrollmentId: minted.id, expiresAt: minted.expiresAt.toISOString() },
    });
    res.json({
      enrollmentId: minted.id,
      role,
      nodeName: minted.nodeName,
      expiresAt: minted.expiresAt,
      filename: script.filename,
      script: script.script,
    });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enrollments/:id/approve", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const actor = requestActor(req) ?? "unknown";
    await approveEnrollment(id, actor);
    await logEvent({
      action: "ha.enrollment_approved",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: "HA node approved — its bundle may now be downloaded once",
      details: { enrollmentId: id },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

haRouter.post("/enrollments/:id/reject", requirePermission("serverSettingsSystem", "fullwrite"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const actor = requestActor(req) ?? "unknown";
    await rejectEnrollment(id, actor);
    await logEvent({
      action: "ha.enrollment_rejected",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: "HA node rejected",
      details: { enrollmentId: id },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** The teardown script. Returned as JSON so one route feeds preview and download. */
haRouter.get("/teardown-script", requirePermission("serverSettingsSystem", "fullwrite"), async (_req, res, next) => {
  try {
    res.json(await renderTeardownScript());
  } catch (err) {
    next(err);
  }
});

// ─── Node router (unauthenticated) ──────────────────────────────────────────

/**
 * A node registers once and then polls every 5s for up to 30 minutes, so the
 * ceiling has to allow a full wait plus retries while still bounding someone
 * guessing tokens. 400 per 5 minutes is roughly one node polling flat out.
 */
const haEnrollLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 400,
  message: "Too many enrollment requests. Please try again shortly.",
});

export const haEnrollRouter = Router();
haEnrollRouter.use(haEnrollLimiter);

/** Spend the token, record a pending request, return the poll handle. */
haEnrollRouter.post("/", async (req, res, next) => {
  try {
    const body = RegisterSchema.parse(req.body);
    const sourceIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const { requestId } = await registerEnrollment({
      token: body.token,
      nodeName: body.nodeName ?? "",
      sshHostKeyFingerprints: body.sshHostKeyFingerprints ?? [],
      sourceIp,
    });
    await logEvent({
      action: "ha.enrollment_pending",
      resourceType: "setting",
      resourceId: "ha.config",
      level: "warning",
      message: `An HA node registered from ${sourceIp ?? "an unknown address"} and is awaiting approval`,
      details: { nodeName: body.nodeName ?? null, sourceIp },
    });
    res.json({ requestId });
  } catch (err) {
    next(err);
  }
});

/**
 * Poll for approval, or download the bundle once approved.
 *
 * Same path for both so the script holds one handle: `?download=1` claims the
 * archive and flips the row to delivered.
 */
haEnrollRouter.get("/:requestId", async (req, res, next) => {
  try {
    const requestId = String(req.params.requestId);
    if (!/^[0-9a-f]{64}$/.test(requestId)) throw new AppError(404, "Unknown enrollment request");

    if (req.query.download === "1") {
      const { archive, filename } = await claimBundle(requestId);
      await logEvent({
        action: "ha.node_enrolled",
        resourceType: "setting",
        resourceId: "ha.config",
        level: "warning",
        message: `An HA node bundle was delivered (${filename})`,
        details: { filename, bytes: archive.length },
      });
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Length", String(archive.length));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");
      return res.end(archive);
    }

    res.setHeader("Cache-Control", "no-store");
    res.json(await pollEnrollment(requestId));
  } catch (err) {
    next(err);
  }
});
