/**
 * src/api/routes/assets/addresses.ts — An asset's identity and addresses: MAC split / remove, TLS and SSH host pins,
 * the decommission preview, the primary IPv4 / IPv6 address, and deletion.
 * Split out of routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission } from "../../middleware/permissions.js";
import { scopeAssetParam, scopeAssetIds, idsFromBody } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { isIpv6Address } from "../../../utils/cidr.js";
import { splitMacsToNewAssets } from "../../../services/assetMacSplitService.js";
import { hostPinsForAsset, previewDecommissionPins } from "../../../services/agentHostPinService.js";
import { pinPrimaryAddress, unpinPrimaryAddress } from "../../../services/primaryAddressService.js";
import { pinPrimaryIpv6, unpinPrimaryIpv6 } from "../../../services/primaryIpv6Service.js";
import { checkAddressConfidence } from "../../../services/addressConfidenceService.js";
import { assertIpChangeMayRetargetIntegrationToken } from "./shared.js";
import { removeAssetMac } from "../../../services/assetMacSplitService.js";
import { assetTlsPins } from "../../../services/assetDetailReadService.js";
import { loadIntegrationTokenTarget } from "../../../services/primaryAddressService.js";
import { bulkDeleteAssets, deleteAsset } from "../../../services/assetWriteService.js";

const router = Router();

const PrimaryAddressSchema = z.object({
  mac: z.string().trim().min(1).max(64),
  ip: z.string().trim().min(1).max(64),
});

// PUT /assets/:id/primary-ipv6 — the asset's primary IPv6 (business rule 128).
const PrimaryIpv6Schema = z.object({
  ip: z.string().trim().min(1).max(64),
});

// POST /assets/:id/address-check — a candidate address to score before it is
// pinned or typed in (business rule 103).
const AddressCheckSchema = z.object({
  ip: z.string().trim().min(1).max(64),
  probe: z.boolean().optional(),
});

// DELETE /api/v1/assets/:id/macs/:mac — remove a MAC from an asset's history
// (assets admin). This is the operator's correction for a wrong association —
// a dock or ZTNA-relayed sighting that got attached to the wrong device. It is
// deliberately a ONE-SHOT removal, not a suppression: if the network reports
// the same MAC against this asset again, the next discovery reconcile re-adds
// it. **Business rule 79** — do not add a tombstone here; the returning MAC is
// the signal that the association is live, and suppressing it would leave a
// permanently wrong asset record that looks correct. `:mac` names the row's
// START key, so removing an interface-scrape RANGE row removes the whole
// [mac, macEnd] block.
// Business rule 91(j): split one or more MACs off this asset, each onto a new
// asset of its own (named apart by MAC, rule 91(i)). Same gate as removing a
// MAC: it edits this asset; the new assets are owned by the caller.
const splitMacsSchema = z.object({
  macs: z.array(z.string().min(1).max(64)).min(1).max(500),
});

router.post("/:id/macs/split", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = z.string().min(1).parse(req.params.id);
    const { macs } = splitMacsSchema.parse(req.body);
    const result = await splitMacsToNewAssets({ assetId: id, macs, actor: requestActor(req) || null });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/macs/:mac", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const normalized = String(req.params.mac || "").toUpperCase().replace(/-/g, ":");

    res.json(await removeAssetMac(id, normalized, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/tls-pins — the TLS endpoints this asset's discovering
// integration dials with a token, and the certificate pinned for each (rule
// 113(e)) — FortiManager itself, and in proxy-bypass mode the gate too. Shown
// on the Sources tab. Read-level: fingerprints are public facts about a
// server, and no secret leaves.
router.get("/:id/tls-pins", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json({ endpoints: await assetTlsPins(req.params.id as string) });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/:id/host-pins — the SSH host keys and TLS certificates
// Polaris has pinned on this asset's addresses, plus the archive its agent
// holds while the asset is decommissioned (business rule 123). Read by the
// Sources tab's Polaris Agent card and the decommission warning. Fingerprints
// are public-key digests, so the same `assets:read` as the tls-pins read above.
router.get("/:id/host-pins", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await hostPinsForAsset(req.params.id as string));
  } catch (err) { next(err); }
});

// POST /api/v1/assets/decommission-preview — before the edit form, the bulk
// bar or the phone sets Status to Decommissioned: which of these assets are
// agent hosts, and which pins the change would archive (rule 123). POST only
// because a bulk selection's ids do not fit a query string; it writes nothing.
const DecommissionPreviewSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(5000) });

router.post("/decommission-preview", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const { ids } = DecommissionPreviewSchema.parse(req.body ?? {});
    res.json({ assets: await previewDecommissionPins(ids) });
  } catch (err) { next(err); }
});

// PUT /api/v1/assets/:id/primary-address — pin the (MAC, IP) pair the asset is
// monitored on, chosen from its address list (business rule 102). Replaces the
// typed IP override and the blank pin if either is set. assets:write, the same
// grant as editing the IP in the form.
router.put("/:id/primary-address", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const input = PrimaryAddressSchema.parse(req.body);
    // The IPv4 pin is the address monitoring dials; an IPv6 has its own
    // primary and its own endpoint (business rule 128).
    if (isIpv6Address(input.ip)) throw new AppError(400, "That is an IPv6 address — set it as the primary IPv6 (PUT /assets/:id/primary-ipv6)");
    const pinTarget = await loadIntegrationTokenTarget(req.params.id as string);
    if (pinTarget) assertIpChangeMayRetargetIntegrationToken(req, pinTarget, input.ip);
    const result = await pinPrimaryAddress({
      assetId: req.params.id as string, mac: input.mac, ip: input.ip, actor: requestActor(req) ?? "unknown",
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/address-check — the confidence check the browser
// runs before a pin or a typed IP is applied (business rule 103): the
// candidate's evidence-only score, whether it is below the warn line, and —
// when `probe` is set — whether it answers one ping from this server. Only a
// check: nothing is written, and the pin / PUT endpoints never refuse on it.
// assets:write, the grant of the writes it precedes (and it sends a ping).
router.post("/:id/address-check", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = AddressCheckSchema.parse(req.body);
    res.json(await checkAddressConfidence(req.params.id as string, input.ip, { probe: input.probe }));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/primary-address — release the pin; the asset moves
// to the listed address with the highest evidence score (business rule
// 103(b)), or to the projection only when the list is empty.
router.delete("/:id/primary-address", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const result = await unpinPrimaryAddress({ assetId: req.params.id as string, actor: requestActor(req) ?? "unknown" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/:id/primary-ipv6 — pin the asset's primary IPv6
// (business rule 128). The automatic choice stops until the pin is removed.
// assets:write, like the IPv4 pin. Refused (409) while IPv6 is off for the
// install. An asset with no IPv4 is polled on this address, so the same
// integration-token guard as an IPv4 change applies (rule 111).
router.put("/:id/primary-ipv6", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const input = PrimaryIpv6Schema.parse(req.body);
    const pinTarget = await loadIntegrationTokenTarget(req.params.id as string);
    if (pinTarget && !pinTarget.ipAddress) assertIpChangeMayRetargetIntegrationToken(req, pinTarget, input.ip);
    res.json(await pinPrimaryIpv6({ assetId: req.params.id as string, ip: input.ip, actor: requestActor(req) ?? "unknown" }));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/primary-ipv6 — remove the pin; the automatic
// choice (or none) takes over straight away.
router.delete("/:id/primary-ipv6", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    res.json(await unpinPrimaryIpv6({ assetId: req.params.id as string, actor: requestActor(req) ?? "unknown" }));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets — bulk delete (assets admin)
router.delete("/", requirePermission("assets", "write"), scopeAssetIds("assets", "delete devices", idsFromBody), async (req, res, next) => {
  try {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0) throw new AppError(400, "ids must be a non-empty array");
    if (ids.some((id) => typeof id !== "string")) throw new AppError(400, "All ids must be strings");
    res.json({ deleted: await bulkDeleteAssets(ids as string[], requestActor(req)) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id — delete (assets admin)
router.delete("/:id", requirePermission("assets", "write"), scopeAssetParam("assets", "delete assets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await deleteAsset(id, requestActor(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
