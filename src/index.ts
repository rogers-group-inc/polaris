/**
 * src/index.ts — Application entry point
 *
 * Checks if the app needs first-run setup (no DATABASE_URL configured).
 * If so, starts a lightweight setup wizard server.
 * Otherwise, starts the full application.
 *
 * Also installs the process-level last-resort crash handlers — see
 * installCrashHandlers below. They go here, before any subsystem imports, so
 * every role (web / monitor / discovery / dash / setup wizard) inherits them.
 */

import { getSetupState, markSetupComplete } from "./setup/detectSetup.js";
import { getRole } from "./utils/role.js";
import { installCrashHandlers } from "./utils/crashHandlers.js";
import { NODE_MINIMUM_MAJOR, checkNodeVersionAtBoot } from "./utils/platformVersions.js";

installCrashHandlers();

// Advisory only — deliberately NOT process.exit(1).
//
// `engines.node` is advisory anyway (there is no .npmrc with
// engine-strict=true, so npm warns and installs regardless), and the running
// Node version was previously unreadable from anywhere in the app:
// process.version appears nowhere outside generated code, so an operator on an
// unsupported major got no signal at all until something in Express 5, Prisma 7
// or node:fs.statfs misbehaved in a way that looked like a Polaris bug.
//
// Refusing to boot would strand that operator mid-upgrade with no UI to read
// the reason, and the same fact reaches them twice more through the Platform
// Lifecycle card and its Event. So: warn loudly, once, and start.
// Do not "harden" this into a hard failure.
checkNodeVersionAtBoot(NODE_MINIMUM_MAJOR, (msg) => {
  console.warn("");
  console.warn(`  WARNING: ${msg}`);
  console.warn("");
});

(async () => {
  const state = getSetupState();
  const role = getRole();

  // Only the web/all role may run the unauthenticated first-run wizard (it
  // writes .env / DATABASE_URL and must be a single surface). A monitor,
  // discovery, or dash process requires the DB to be configured already — if
  // it isn't, fail clearly instead of idling or starting a second wizard.
  // This also enforces unit ordering: worker units can't usefully start until
  // the web node (or operator) has provisioned the host.
  if ((role === "monitor" || role === "discovery" || role === "dash") && state !== "configured") {
    console.error("");
    console.error(`  ERROR: POLARIS_ROLE=${role} requires DATABASE_URL to be configured already.`);
    console.error("  Run first-run setup on the web node (or set DATABASE_URL), then start this process.");
    console.error("");
    process.exit(1);
  }

  if (state === "locked") {
    console.error("");
    console.error("  ERROR: DATABASE_URL is missing but this host has already");
    console.error("  been configured (.setup-complete marker is present).");
    console.error("");
    console.error("  Restore .env or pass DATABASE_URL via the environment.");
    console.error("  To re-run first-run setup, delete .setup-complete — but");
    console.error("  only do that if you intend to reconfigure from scratch.");
    console.error("");
    process.exit(1);
  }

  if (state === "needs-setup") {
    const { startSetupServer } = await import("./setup/setupServer.js");
    startSetupServer();
    return;
  }

  // Back-fill the marker on already-configured installs.
  markSetupComplete();
  const { startApp } = await import("./app.js");
  startApp();
})();
