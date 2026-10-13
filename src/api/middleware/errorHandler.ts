/**
 * src/api/middleware/errorHandler.ts
 */

import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import multer from "multer";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({ error: err.message });
  }

  if (err instanceof ZodError) {
    const message = err.errors.map(e => {
      const field = e.path.length ? e.path.join(".") : undefined;
      return field ? `${field}: ${e.message}` : e.message;
    }).join("; ");
    return res.status(400).json({ error: message });
  }

  // multer rejects a bad upload before the route handler runs, so a route
  // that doesn't map these itself would otherwise answer a bare 500.
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "The uploaded file is larger than this upload accepts" });
    }
    return res.status(400).json({ error: `Upload rejected: ${err.message}` });
  }

  logger.error(err, "Unhandled error");
  return res.status(500).json({ error: "Internal server error" });
}
