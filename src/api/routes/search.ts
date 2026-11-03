/**
 * src/api/routes/search.ts — Global search endpoint
 */

import { Router } from "express";
import { z } from "zod";
import { searchAll } from "../../services/searchService.js";
import { ensureRoleSnapshot, hasPermission } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// A comma-separated list of known values. Present-but-empty (`status=`) is a
// real choice — the empty set, which matches no asset — so it is kept as [].
const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string()
    .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

const SearchQuerySchema = z.object({
  q: z.string().optional(),
  // The global search gear: which assets the asset / Device Map groups may
  // return. Absent = no narrowing (the API's and the phone's search).
  monitored: csvOf(["monitored", "unmonitored"] as const).optional(),
  status: csvOf(["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] as const).optional(),
});

// GET /api/v1/search?q=<query>[&monitored=monitored,unmonitored][&status=active,maintenance]
//
// Filter, don't 403 — the search box renders on every page for every role.
// Each result group is gated on the read access of the function that owns it;
// denied groups come back empty and their query helpers never run. Bearer
// tokens resolve their bound role's snapshot, so a token sees exactly the
// groups its role can read (e.g. an assets-read role gets asset hits only).
router.get("/", async (req, res, next) => {
  try {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    }
    const { q = "", monitored, status } = parsed.data;
    await ensureRoleSnapshot(req);
    const results = await searchAll(q, {
      blocks:       hasPermission(req, "ipBlocks", "read"),
      subnets:      hasPermission(req, "subnets", "read"),
      reservations: hasPermission(req, "reservations", "read"),
      assets:       hasPermission(req, "assets", "read"),
      sites:        hasPermission(req, "deviceMap", "read"),
      // IPsec tunnels + VPN connections are the asset IPsec tab's rows.
      ipsec:        hasPermission(req, "assets", "read"),
      // A thumbprint → the asset it is pinned for: the pins are Server
      // Settings data (the Pinned server identities list's own gate).
      pins:         hasPermission(req, "serverSettingsSystem", "read"),
    }, {
      monitored: monitored?.map((m) => m === "monitored"),
      statuses: status,
    });
    res.json(results);
  } catch (err) {
    next(err);
  }
});

export default router;
