/**
 * src/api/routes/proxySettings.ts — endpoints for the in-app nginx reverse-
 * proxy GUI. Mounted at /api/v1/server-settings/proxy.
 *
 * All endpoints are proxy-mode gated: if POLARIS_PROXY_CERT_PATH is not set,
 * every request 409s with PROXY_MODE_REQUIRED_MESSAGE. This mirrors the
 * existing PROXY_LEAF_LOCKED_MESSAGE pattern in serverSettings.ts (just
 * inverted — those routes 409 IN proxy mode, these routes 409 OUT of it).
 *
 * Permission model: read operations need serverSettingsSystem=read;
 * mutating operations (PUT, POST /apply, POST /adopt-managed-mode,
 * POST /cert/rotate) need serverSettingsSystem=fullwrite — these are
 * high-blast-radius operations that can lock out the operator from the
 * very UI they'd use to fix it.
 */

import { Router } from "express";
import multer from "multer";
import {
  getProxyConfig,
  saveProxyConfig,
} from "../../services/proxyConfigService.js";
import {
  applyProxyConfig,
  rotateCertAndKey,
  preflightCertRotation,
  getDriftStatus,
} from "../../services/nginxApplyService.js";
import { getServerCertFingerprint } from "../../services/certInfo.js";
import { isProxyMode } from "../../utils/proxyMode.js";
import { requirePermission } from "../middleware/permissions.js";
import { truncate } from "../../utils/text.js";
import { AppError } from "../../utils/errors.js";
import { logEvent } from "./events.js";
import type { ProxyConfig } from "../../types/proxyConfig.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const PROXY_MODE_REQUIRED_MESSAGE =
  "Polaris is not in proxy mode (POLARIS_PROXY_CERT_PATH is unset). The nginx GUI is only available when nginx fronts Polaris.";

// Middleware: every route here requires proxy mode.
router.use((_req, res, next) => {
  if (!isProxyMode()) {
    return res.status(409).json({ error: PROXY_MODE_REQUIRED_MESSAGE });
  }
  next();
});

// ─── GET / : configuration + drift + fingerprint ───────────────────────────

router.get("/", requirePermission("serverSettingsSystem", "read"), async (_req, res, next) => {
  try {
    const [config, drift] = await Promise.all([getProxyConfig(), getDriftStatus()]);
    res.json({
      config,
      drift,
      currentFingerprint: getServerCertFingerprint(),
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT / : save without applying ─────────────────────────────────────────

router.put("/", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    // TS-level cast only — runtime validation lives in the service
    // (saveProxyConfig → mergeProxyConfig + validateProxyConfig field-checks
    // every value and 400s on bad input).
    const body = req.body as Partial<ProxyConfig>;
    // Block direct PUTs from flipping managedMode — that's what
    // /adopt-managed-mode is for. Everything else flows through.
    if (body.managedMode !== undefined) {
      throw new AppError(400, "Use POST /adopt-managed-mode to flip managedMode");
    }
    const saved = await saveProxyConfig(body);
    res.json({ config: saved });
  } catch (err) {
    next(err);
  }
});

// ─── POST /adopt-managed-mode ──────────────────────────────────────────────
// Operator clicks "Adopt managed mode" in the drift banner; flips the gate
// so subsequent /apply calls are allowed.

router.post("/adopt-managed-mode", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const saved = await saveProxyConfig({ managedMode: true });
    await logEvent({
      action: "proxy.managed_mode_adopted",
      level: "info",
      resourceType: "setting",
      resourceName: "proxyConfig",
      message: "Operator adopted Polaris-managed nginx config mode",
      actor: req.session?.username ?? "system",
    });
    res.json({ config: saved });
  } catch (err) {
    next(err);
  }
});

// ─── POST /apply : render + stage + sudo apply ─────────────────────────────

router.post("/apply", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    // Cast is TS-level only — applyProxyConfig routes through saveProxyConfig's
    // field-checked merge/validate before anything touches nginx.
    const result = await applyProxyConfig(req.body as Partial<ProxyConfig> | undefined);
    await logEvent({
      action: result.ok ? "proxy.config_applied" : "proxy.config_apply_failed",
      level: result.ok ? "info" : "warning",
      resourceType: "setting",
      resourceName: "proxyConfig",
      message: result.ok
        ? `Applied nginx config (sha256=${result.hash.slice(0, 12)}…)`
        : `nginx config apply failed: ${truncate(result.wrapperOutput)}`,
      actor: req.session?.username ?? "system",
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /cert/preflight : validate pair, return metadata ────────────────
// Multipart upload: fields { cert: file, key: file }. Returns the new
// fingerprint + CN/SANs/expiry + the current canonical fingerprint so the
// frontend's orchestration modal can drive the dual-pin stage→swap→retire
// workflow against the existing /agents/cert-pins/{bulk-add,bulk-remove}
// routes in serverSettings.ts.

router.post(
  "/cert/preflight",
  requirePermission("serverSettingsSystem", "write"),
  upload.fields([{ name: "cert", maxCount: 1 }, { name: "key", maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const { certPem, keyPem } = extractCertKeyFromMultipart(req);
      const preflight = preflightCertRotation(certPem, keyPem);
      // Echo back the PEM bytes so /cert/rotate doesn't need re-upload. The
      // frontend holds them in JS memory across the multi-step modal.
      res.json({ ...preflight, certPem, keyPem });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /cert/rotate : file-swap step of the dual-pin rotation flow ────
// Body: { certPem, keyPem }. Validates the pair once more under the wrapper's
// flock, atomic-renames /etc/polaris-nginx/{cert,key}.pem, reloads nginx.
// The frontend must have already called /agents/cert-pins/bulk-add for the
// new fingerprint BEFORE this step so the dual-pin acceptance set on every
// agent already covers the new cert; otherwise agents will refuse the new
// cert at next reconnect.

router.post("/cert/rotate", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const certPem = String(req.body?.certPem ?? "");
    const keyPem = String(req.body?.keyPem ?? "");
    if (!certPem || !keyPem) throw new AppError(400, "certPem and keyPem are required");
    const result = await rotateCertAndKey(certPem, keyPem);
    await logEvent({
      action: result.ok ? "proxy.cert_rotated" : "proxy.cert_rotate_failed",
      level: "warning",
      resourceType: "certificate",
      resourceName: "proxy-leaf",
      message: result.ok
        ? `Server cert rotated (new fingerprint=${result.fingerprint}); the dual-pin staged set must already cover the new pin or agents will fail at next reconnect`
        : `Cert rotation failed: ${truncate(result.wrapperOutput)}`,
      actor: req.session?.username ?? "system",
    });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    next(err);
  }
});

// ─── helpers ───────────────────────────────────────────────────────────────

function extractCertKeyFromMultipart(req: any): { certPem: string; keyPem: string } {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const certFile = files?.cert?.[0];
  const keyFile = files?.key?.[0];
  if (!certFile || !keyFile) {
    throw new AppError(400, "Both `cert` and `key` files are required");
  }
  return {
    certPem: certFile.buffer.toString("utf8"),
    keyPem: keyFile.buffer.toString("utf8"),
  };
}


export default router;
