/**
 * src/jobs/autoBuildAgents.ts — Auto-build agent binaries when the
 * agent's version (NOT Polaris's version) drifts past what's on disk.
 *
 * Fires 60 s after boot, then once on every wake-up if a build is missed
 * — currently a one-shot since builds are infrequent and version bumps
 * land via in-app updates that restart the process anyway.
 *
 * Trigger logic (load-bearing comment; reflects the §12 plan and the
 * polaris-agent skill rebuild contract):
 *
 *   1. Skip if `<STATE_DIR>/data/agents/manifest.json` is missing.
 *      Fresh installs shouldn't fire a ~60 s CPU-pegging build for a
 *      feature the operator hasn't opted into. They click Build the
 *      first time when they actually want agents.
 *
 *   2. Skip if `manifest.currentVersion === getAgentVersion()`. Polaris
 *      patch releases that don't touch `agent/` produce no manifest drift
 *      and no auto-build noise — this is the load-bearing decoupling.
 *
 *   3. Skip + log warning if Go isn't installed. Emit
 *      agent.build.auto_skipped so operators can see the reminder on
 *      the Events page.
 *
 *   4. Skip silently if Setting `agent.autoBuildOnVersionMismatch` is
 *      false. Escape hatch for shops with strict supply-chain controls
 *      who want every binary build to be human-initiated.
 *
 *   5. Otherwise: kick off via the same path as the UI Build button.
 *      Actor stamped as "system:auto-build-on-version-change" so the
 *      audit trail distinguishes this from operator clicks.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { AGENT_BIN_DIR } from "../utils/paths.js";
import { getAgentVersion } from "../utils/version.js";
import { goAvailable, startBuild, GO_MINIMUM } from "../services/agentBuildService.js";
import { logEvent } from "../services/eventLogService.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

const STARTUP_DELAY_MS = 60_000;
const SETTING_KEY = "agent.autoBuildOnVersionMismatch";

async function autoBuildIfStale(): Promise<void> {
  // (1) Manifest gate — operator must have opted in by building at least once.
  const manifestPath = resolvePath(AGENT_BIN_DIR, "manifest.json");
  let manifest: { currentVersion?: string } | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  } catch {
    return;
  }
  if (!manifest || typeof manifest.currentVersion !== "string") return;

  // (2) Version-drift gate.
  const wanted = getAgentVersion();
  if (manifest.currentVersion === wanted) return;

  // (3) Go-availability gate. If Go went missing between the operator's
  // first Build and a subsequent Polaris update, surface a warning Event
  // so they see the staleness on the Events page.
  // A toolchain that is present but too old is skipped here too: without this
  // the auto-build burns a queue slot on a compile that cannot succeed, and
  // reports it as a build failure rather than as a host prerequisite.
  const go = await goAvailable();
  if (!go.ok || go.meetsMinimum === false) {
    const why = go.ok
      ? `Go ${go.track ?? "(unknown)"} is installed but the build requires Go ${GO_MINIMUM}+`
      : `Go isn't installed`;
    logger.warn(
      { from: manifest.currentVersion, to: wanted, reason: go.error ?? why, goTrack: go.track },
      "Agent binaries out-of-date but the Go toolchain isn't usable — skipping auto-build",
    );
    await logEvent({
      action:       "agent.build.auto_skipped",
      level:        "warning",
      resourceType: "polaris-agent",
      resourceName: wanted,
      message:
        `Agent binaries v${manifest.currentVersion} are stale relative to agent/VERSION ${wanted}, ` +
        `but ${why}. Install or upgrade Go on the Polaris server and click Build, or run the OS install script which provisions it.`,
      details: { from: manifest.currentVersion, to: wanted, reason: go.error ?? why, goTrack: go.track ?? null },
    }).catch(() => { /* best-effort */ });
    return;
  }

  // (4) Operator kill-switch.
  if (await isAutoBuildDisabled()) {
    logger.info(
      { from: manifest.currentVersion, to: wanted },
      "Auto-build skipped — agent.autoBuildOnVersionMismatch=false",
    );
    return;
  }

  // (5) Fire via the regular path. startBuild handles the queue,
  // emits agent.build.started + agent.build.completed/failed, and runs
  // the post-build prune.
  await logEvent({
    action:       "agent.build.auto_started",
    level:        "info",
    actor:        "system:auto-build-on-version-change",
    resourceType: "polaris-agent",
    resourceName: wanted,
    message:      `Auto-building agent binaries: ${manifest.currentVersion} → ${wanted}`,
    details:      { from: manifest.currentVersion, to: wanted },
  }).catch(() => { /* best-effort */ });
  try {
    await startBuild({ actor: "system:auto-build-on-version-change" });
  } catch (err: any) {
    logger.warn({ err }, "Auto-build kickoff failed");
  }
}

async function isAutoBuildDisabled(): Promise<boolean> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
    if (!row) return false; // default ON
    const v = row.value as { enabled?: boolean } | null;
    if (v && v.enabled === false) return true;
    return false;
  } catch {
    // Defensive: if we can't read the setting, default to enabled.
    return false;
  }
}

// Side-effect registration — runs when the module is imported from app.ts.
setTimeout(() => {
  runInstrumentedJob("autoBuildAgents", autoBuildIfStale)
    .catch((err) => logger.warn({ err }, "Auto-build job crashed"));
}, STARTUP_DELAY_MS);

logger.debug({ delayMs: STARTUP_DELAY_MS }, "Auto-build agent job scheduled");
