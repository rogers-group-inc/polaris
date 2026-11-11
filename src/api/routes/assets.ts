/**
 * src/api/routes/assets.ts — Asset management CRUD, mounted at /api/v1/assets.
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 *
 * CQ-B062: the ~110 routes live in the sub-routers under ./assets/, each a
 * contiguous block of the original file moved verbatim. They are mounted here
 * IN THE ORIGINAL ORDER, and that order is load-bearing: Express tries routes in
 * registration order, so the collection router (literal paths such as
 * /ip-check, /tags, /sighting-settings) must come before the detail router's
 * GET /:id, or a literal would be read as an asset id. Add a new route to the
 * sub-router whose concern it shares; a new literal GET goes in list.ts.
 */

import { Router } from "express";
import assetListRouter from "./assets/list.js";
import assetDetailRouter from "./assets/detail.js";
import assetSystemRouter from "./assets/system.js";
import assetTelemetryRouter from "./assets/telemetry.js";
import assetWriteRouter from "./assets/write.js";
import assetLookupsRouter from "./assets/lookups.js";
import assetAddressesRouter from "./assets/addresses.js";
import assetSourcesRouter from "./assets/sources.js";
import assetDependenciesRouter from "./assets/dependencies.js";
import assetQuarantineRouter from "./assets/quarantine.js";
import assetAgentRouter from "./assets/agent.js";

const router = Router();

router.use(assetListRouter);
router.use(assetDetailRouter);
router.use(assetSystemRouter);
router.use(assetTelemetryRouter);
router.use(assetWriteRouter);
router.use(assetLookupsRouter);
router.use(assetAddressesRouter);
router.use(assetSourcesRouter);
router.use(assetDependenciesRouter);
router.use(assetQuarantineRouter);
router.use(assetAgentRouter);

export default router;
