/**
 * src/setup/setupServer.ts — Minimal Express server for first-run setup
 *
 * This runs instead of the normal app when DATABASE_URL is not configured.
 * It serves setup.html and the setup API endpoints only.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import setupRoutes from "./setupRoutes.js";
import { makeRateLimiter } from "../api/middleware/rateLimits.js";
import { buildHelmetOptions } from "../utils/securityHeaders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startSetupServer(): void {
  const app = express();

  // The same CSP/HSTS/referrer policy the main listener and the Dash listener
  // send. This surface is the one that most needs it: it is unauthenticated,
  // it renders operator-typed database credentials back into a form, and it is
  // the only listener a fresh host exposes. setup.html loads no inline
  // <script>, so the shared `scriptSrc: 'self'` policy fits it unmodified.
  app.use(helmet(buildHelmetOptions()));

  app.use(express.json());

  // The setup server is unauthenticated and single-operator — a generous
  // per-IP ceiling covers the wizard's full asset + API traffic while
  // bounding anyone else poking at it.
  app.use(makeRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 600,
    message: "Too many requests to the setup server — retry shortly.",
  }));

  const publicDir = path.resolve(__dirname, "..", "..", "public");

  // Setup API routes
  app.use("/api/setup", setupRoutes);

  // Pre-static guard: redirect any HTML page request (login.html, index.html,
  // assets.html, etc.) to setup.html so operators can't accidentally land on
  // a half-functional app screen while DATABASE_URL is unset. Asset requests
  // (CSS/JS/images/fonts) fall through to express.static below so setup.html
  // itself can render. setup.html serves directly.
  app.get(/\.html$/, (req, res, next) => {
    if (req.path === "/setup.html") return next();
    return res.redirect(302, "/setup.html");
  });

  // Serve static assets (CSS, JS, images, fonts, setup.html). index:false
  // disables the default index.html resolution so GET / falls through to
  // the catch-all below and serves setup.html instead of the dashboard's
  // index.html.
  app.use(express.static(publicDir, { index: false }));

  // All non-API, non-asset requests fall through to setup.html
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found" });
    }
    res.sendFile(path.join(publicDir, "setup.html"));
  });

  const PORT = 3000;

  // The setup wizard is unauthenticated by construction — it exists to create
  // the first account, so there is nobody to authenticate yet — and it hands
  // out a provisioned install to whoever reaches it first. On a host where the
  // operator works at a console or over SSH, binding it to loopback removes
  // that race entirely.
  //
  // It is NOT the default, because the default has to be the one that works:
  // in a container the wizard is only reachable through a published port, so
  // loopback would make a fresh `docker compose up` unreachable, and on a
  // remote server the usual flow is an operator browsing to its address. So
  // this is opt-in, and the console banner says which way it went.
  const BIND = process.env.POLARIS_SETUP_BIND || "0.0.0.0";

  app.listen(PORT, BIND, () => {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log("  │                                             │");
    console.log("  │   Polaris — First-Run Setup                 │");
    console.log("  │                                             │");
    console.log(`  │   Open \x1b[36mhttp://localhost:${PORT}/setup.html\x1b[0m    │`);
    console.log("  │   to configure the application.             │");
    console.log("  │                                             │");
    console.log("  └─────────────────────────────────────────────┘");
    // Whoever reaches this wizard first owns the install, so say plainly who
    // can reach it. Not a warning to be silenced — a fact the operator needs
    // while deciding how long to leave a half-provisioned host running.
    if (BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1") {
      console.log(`  Listening on ${BIND}:${PORT} — local connections only (POLARIS_SETUP_BIND).`);
    } else {
      console.log(`  Listening on ${BIND}:${PORT} — reachable from the network, and`);
      console.log("  UNAUTHENTICATED until you finish the wizard. Set POLARIS_SETUP_BIND=127.0.0.1");
      console.log("  to restrict it to this host and browse over an SSH tunnel instead.");
    }
    console.log("");
  });
}
