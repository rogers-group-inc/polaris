/**
 * src/api/routes/search.ts — Global search endpoint
 */

import { Router } from "express";
import { searchAll } from "../../services/searchService.js";
import { ensureRoleSnapshot, hasPermission } from "../middleware/permissions.js";

const router = Router();

// GET /api/v1/search?q=<query>
//
// Filter, don't 403 — the search box renders on every page for every role.
// Each result group is gated on the read access of the function that owns it;
// denied groups come back empty and their query helpers never run. Bearer
// tokens resolve their bound role's snapshot, so a token sees exactly the
// groups its role can read (e.g. an assets-read role gets asset hits only).
router.get("/", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    await ensureRoleSnapshot(req);
    const results = await searchAll(q, {
      blocks:       hasPermission(req, "ipBlocks", "read"),
      subnets:      hasPermission(req, "subnets", "read"),
      reservations: hasPermission(req, "reservations", "read"),
      assets:       hasPermission(req, "assets", "read"),
      sites:        hasPermission(req, "deviceMap", "read"),
      // IPsec tunnels + VPN connections are the asset IPsec tab's rows.
      ipsec:        hasPermission(req, "assets", "read"),
    });
    res.json(results);
  } catch (err) {
    next(err);
  }
});

export default router;
