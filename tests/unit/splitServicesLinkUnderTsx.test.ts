/**
 * tests/unit/splitServicesLinkUnderTsx.test.ts — the split services LINK when
 * Node runs the TypeScript sources directly.
 *
 * monitoringService.ts (CQ-B061), notificationEngine.ts and notificationTypes.ts
 * (CQ-B063) re-export the modules they were split into. A re-export of a name
 * that is only a TYPE must say `type`: tsc's build drops it either way, and
 * vitest's transform tolerates a missing binding, but tsx (`npm run dev`, the
 * seed, the design-system build) and Node's own type stripping keep a bare
 * `export { SomeInterface } from "./x.js"`, and the ES loader then refuses to
 * link a module that has no such export — the whole app fails to start in dev.
 * That shipped once (2026-11-10); nothing else in the suite can see it, so this
 * loads each service in a real Node + tsx process.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(__dirname, "..", "..");

describe("split services under tsx", () => {
  for (const rel of ["src/services/monitoringService.ts", "src/services/notificationEngine.ts", "src/services/notificationTypes.ts"]) {
    it(`${rel} links (every type-only re-export is marked \`type\`)`, () => {
      const url = pathToFileURL(join(repo, rel)).href;
      const env = { ...process.env, DATABASE_URL: "postgresql://x:x@127.0.0.1:1/x" };
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", "-e", `await import(${JSON.stringify(url)}); process.exit(0)`], {
        cwd: repo, env, encoding: "utf8", timeout: 120_000,
      });
      expect(r.stderr, rel).not.toMatch(/does not provide an export named/);
      expect(r.status, r.stderr).toBe(0);
    }, 130_000);
  }
});
