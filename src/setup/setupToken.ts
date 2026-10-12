/**
 * src/setup/setupToken.ts — proof of host access for the first-run wizard.
 *
 * The wizard runs before any account exists, so it cannot authenticate a user.
 * Until it finishes it will, for whoever reaches it first, connect to a database
 * of their choosing, create the administrator and write the install's `.env`
 * (scan finding F178). On a host where the operator works at a console or over
 * SSH, binding it to loopback would remove that race — but the default cannot be
 * loopback: in a container the wizard is reachable only through a published port.
 *
 * So the wizard demands a one-time SETUP TOKEN instead. It is generated when the
 * wizard starts, printed to the console (which is the journal, or `docker logs`)
 * and kept in `<state dir>/.setup-token`, mode 0600, so reading it proves access
 * to the host, not to the network. Every route that touches the host requires it;
 * `/status` does not, so the page can tell the operator to ask for it. It is
 * deleted when setup completes.
 *
 * `POLARIS_SETUP_TOKEN` pre-sets it for unattended provisioning (16+ characters
 * of letters, digits, `-` and `_`). Business rule 108.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { STATE_DIR } from "../utils/paths.js";

export const SETUP_TOKEN_FILE = resolve(STATE_DIR, ".setup-token");
export const SETUP_TOKEN_HEADER = "x-setup-token";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

let current: string | null = null;

/** Constant-time comparison, safe against a supplied value of any type or length. */
export function setupTokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type SetupTokenSource = "env" | "file" | "new";

/**
 * The token for this wizard run: `POLARIS_SETUP_TOKEN` if valid, else the one
 * already on disk (so a restart does not strand an operator who has copied it),
 * else a fresh one, written to the state dir when it is writable.
 */
export function loadOrCreateSetupToken(): { token: string; source: SetupTokenSource; file: string | null } {
  const fromEnv = process.env.POLARIS_SETUP_TOKEN?.trim();
  if (fromEnv && TOKEN_RE.test(fromEnv)) {
    current = fromEnv;
    return { token: fromEnv, source: "env", file: null };
  }

  try {
    if (existsSync(SETUP_TOKEN_FILE)) {
      const stored = readFileSync(SETUP_TOKEN_FILE, "utf8").trim();
      if (TOKEN_RE.test(stored)) {
        current = stored;
        return { token: stored, source: "file", file: SETUP_TOKEN_FILE };
      }
    }
  } catch {
    /* unreadable — fall through to a fresh one */
  }

  const token = randomBytes(18).toString("base64url");
  current = token;
  try {
    mkdirSync(dirname(SETUP_TOKEN_FILE), { recursive: true });
    writeFileSync(SETUP_TOKEN_FILE, token + "\n", { mode: 0o600 });
    try { chmodSync(SETUP_TOKEN_FILE, 0o600); } catch { /* not supported on this platform */ }
    return { token, source: "new", file: SETUP_TOKEN_FILE };
  } catch {
    // A read-only state dir: the console is then the only place it appears.
    return { token, source: "new", file: null };
  }
}

/** The active token, or null before the wizard has started. */
export function currentSetupToken(): string | null {
  return current;
}

/** Forget the token and delete its file. Called when setup completes. */
export function discardSetupToken(): void {
  current = null;
  try { unlinkSync(SETUP_TOKEN_FILE); } catch { /* already gone */ }
}

/**
 * Express guard for every wizard route that acts on the host. With no token
 * loaded it fails CLOSED: a wizard that never generated one must not run open.
 */
export function requireSetupToken(req: Request, res: Response, next: NextFunction): void {
  const expected = current;
  if (!expected || !setupTokenMatches(req.get(SETUP_TOKEN_HEADER), expected)) {
    res.status(401).json({
      ok: false,
      tokenRequired: true,
      message:
        "A setup token is required. It is printed in the console where Polaris started " +
        "(the journal, or `docker logs`) and saved in the state directory as .setup-token.",
    });
    return;
  }
  next();
}
