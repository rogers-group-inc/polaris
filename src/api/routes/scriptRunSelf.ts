/**
 * src/api/routes/scriptRunSelf.ts — what a RUNNING automation script may ask
 * of Polaris about itself (business rule 190).
 *
 * Mounted at /api/v1/script-runs/self ABOVE requireAuth: the caller is a
 * script process on the Polaris host, not a user. It authenticates with its
 * run's pass (`Authorization: Bearer $POLARIS_RUN_TOKEN`, which also exempts
 * it from CSRF) and must call from loopback — the runner hands it
 * POLARIS_API_URL = http://127.0.0.1:<port>/api/v1.
 *
 *   POST /email   the run's pass   send one email through the action's channel
 *                                  to the action's recipients (≤ 3 per run)
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { isLoopbackIp } from "../../utils/cidr.js";
import {
  sendRunEmail,
  MAX_EMAIL_FILES,
  MAX_EMAIL_TEXT_CHARS,
} from "../../services/scriptRunEmailService.js";

const scriptRunSelfRouter = Router();

const emailSchema = z.object({
  subject: z.string().min(1).max(200),
  text: z.string().max(MAX_EMAIL_TEXT_CHARS),
  files: z
    .array(z.object({
      filename: z.string().min(1).max(200),
      contentType: z.string().max(100).optional().nullable(),
      contentBase64: z.string().max(1024 * 1024),
    }).strict())
    .max(MAX_EMAIL_FILES)
    .optional(),
}).strict();

function bearer(req: Request): string {
  const m = (req.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
}

/** The script runs on this host; anything else asking is not a script run. */
function assertLoopback(req: Request): void {
  const ip = (req.ip || "").replace(/^::ffff:/, "");
  const sock = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!isLoopbackIp(ip) || !isLoopbackIp(sock)) {
    throw new AppError(403, "A script run's pass is accepted only from the Polaris host itself");
  }
}

scriptRunSelfRouter.post("/email", async (req, res, next) => {
  try {
    assertLoopback(req);
    const input = emailSchema.parse(req.body ?? {});
    res.json(await sendRunEmail(bearer(req), input));
  } catch (err) { next(err); }
});

export default scriptRunSelfRouter;
