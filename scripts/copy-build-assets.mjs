#!/usr/bin/env node
/**
 * scripts/copy-build-assets.mjs — copy non-TypeScript runtime assets into dist/.
 *
 * `tsc` only emits .js / .d.ts and silently ignores data files, so any file
 * the server reads at runtime *relative to its own compiled location*
 * (import.meta.url) must be copied into dist/ by hand after the compile.
 *
 * Today that's the bundled standard-MIB text files consumed by
 * src/services/stdMibLibrary.ts (STD_MIBS_DIR resolves to
 * dist/services/stdMibs/ in a built install). Without this step every "std"
 * SNMP-walk on a built/production install — including LLDP-MIB — fails with
 * `Standard MIB "<NAME>" is not installed on the server`, because the .txt
 * files never made it into dist/. Dev (`npm run dev` via tsx) reads straight
 * from src/, which is why the gap is invisible until you ship. The platform
 * end-of-life dataset under src/data/ is here for the same reason.
 *
 * This runs as the second half of `npm run build` (tsc && node <this>). Every
 * build site — Dockerfile, deploy/setup-*, deploy/update-*, and the in-app
 * updater in src/services/updateService.ts — invokes `npm run build` so the
 * copy is guaranteed wherever a build happens. The Docker runtime image ships
 * only dist/ (no src/), so copying into dist/ is the only correct strategy —
 * a runtime fallback to src/ would break in a container.
 *
 * Add a new entry to ASSETS whenever a service starts reading a non-.ts asset
 * from a dist-relative path. See cross-cutting/deployment in TOUCHES.md.
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Asset groups to mirror from src/<dir> into dist/<dir>, filtered by extension. */
const ASSETS = [
  { dir: "services/stdMibs", exts: [".txt"] },
  // src/data/platformEol.json — the committed platform end-of-life dataset read by
  // src/services/platformLifecycleService.ts. Same dist-relative story as the MIBs:
  // without this entry the Platform Lifecycle card is empty in a container and on
  // any built install, while dev (tsx, reading from src/) looks fine.
  { dir: "data", exts: [".json"] },
];

let copied = 0;
for (const { dir, exts } of ASSETS) {
  const srcDir = join(ROOT, "src", dir);
  const outDir = join(ROOT, "dist", dir);

  let names;
  try {
    names = readdirSync(srcDir);
  } catch (err) {
    console.error(`copy-build-assets: cannot read source dir ${srcDir}: ${err.message}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    if (!exts.some((e) => name.endsWith(e))) continue;
    const from = join(srcDir, name);
    if (!statSync(from).isFile()) continue;
    cpSync(from, join(outDir, name));
    copied++;
  }
}

console.log(`copy-build-assets: copied ${copied} asset file(s) into dist/`);

// Tripwire: copying zero files means the source assets vanished or the build
// layout changed — fail loudly rather than ship a build whose std MIB walks
// are silently broken.
if (copied === 0) {
  console.error("copy-build-assets: copied 0 files — expected the bundled std MIBs. Failing build.");
  process.exit(1);
}
