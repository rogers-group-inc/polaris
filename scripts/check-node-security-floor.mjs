#!/usr/bin/env node
/**
 * Is the Node running this script below its track's security floor?
 *
 * Called by the deploy/ setup scripts after the clone, and by
 * deploy/upgrade-node.sh after an upgrade. Reads the floor from
 * src/data/platformEol.json — the same entry the in-app Platform Lifecycle
 * card grades — so there is no second copy of the number to drift.
 *
 * Prints one line when the runtime is unpatched and nothing otherwise. ALWAYS
 * exits 0: a distro repository commonly trails an upstream security release by
 * days, and refusing to install until it catches up would strand a fresh host.
 * The caller decides how loudly to say it.
 *
 * Deliberately dependency-free (runs before `npm ci` has necessarily finished).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function compare(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(readFileSync(join(here, "..", "src", "data", "platformEol.json"), "utf8"));
  const node = data.technologies.find((t) => t.id === "node");
  const running = process.versions.node;
  const track = running.split(".")[0];
  const floor = node?.tracks.find((t) => t.track === track)?.securityFloor;
  if (floor && compare(running, floor.version) < 0) {
    console.log(
      `Node.js ${running} has open security advisories (${floor.advisories.map((a) => `${a.id} ${a.severity}`).join(", ")}). ` +
        `Update to ${floor.version} or later as soon as this host's package repository carries it: ${floor.source}`,
    );
  }
} catch {
  // An unreadable dataset is the in-app card's problem to report, not a reason
  // to fail an install.
}
