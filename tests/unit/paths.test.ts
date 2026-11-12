/**
 * tests/unit/paths.test.ts
 *
 * Where state lives: under POLARIS_STATE_DIR when set (the Docker image),
 * else the project root; PUBLIC_DIR always from the project root; secrets
 * and firmware never under the served uploads dir.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const saved = process.env.POLARIS_STATE_DIR;

async function load(stateDir?: string) {
  if (stateDir === undefined) delete process.env.POLARIS_STATE_DIR; else process.env.POLARIS_STATE_DIR = stateDir;
  vi.resetModules();
  return import("../../src/utils/paths.js");
}

afterEach(() => {
  if (saved === undefined) delete process.env.POLARIS_STATE_DIR; else process.env.POLARIS_STATE_DIR = saved;
});

describe("paths", () => {
  it("falls back to the project root when POLARIS_STATE_DIR is unset", async () => {
    const p = await load();
    expect(p.STATE_DIR).toBe(PROJECT_ROOT);
    expect(p.ENV_FILE).toBe(join(PROJECT_ROOT, ".env"));
    expect(p.UPLOADS_DIR).toBe(join(PROJECT_ROOT, "public", "uploads"));
  });

  it("redirects every state item under POLARIS_STATE_DIR (resolved) but not PUBLIC_DIR", async () => {
    const p = await load("tmp-state/../tmp-state");
    // resolve() of a relative path is against cwd, which in vitest is the checkout root.
    expect(p.STATE_DIR).toBe(resolve("tmp-state"));
    const s = p.STATE_DIR;
    expect(p.ENV_FILE).toBe(join(s, ".env"));
    expect(p.SETUP_COMPLETE_MARKER).toBe(join(s, ".setup-complete"));
    expect(p.BACKUP_DIR).toBe(join(s, "data", "backups"));
    expect(p.UPLOADS_DIR).toBe(join(s, "public", "uploads"));
    expect(p.SIGNING_DIR).toBe(join(s, "data", "signing"));
    expect(p.AGENT_BIN_DIR).toBe(join(s, "data", "agents"));
    expect(p.FIRMWARE_DIR).toBe(join(s, "data", "firmware"));
    expect(p.FIRMWARE_INCOMING_DIR).toBe(join(s, "data", "firmware", ".incoming"));
    expect(p.PUBLIC_DIR).toBe(join(PROJECT_ROOT, "public"));
  });

  it("treats an empty POLARIS_STATE_DIR as unset", async () => {
    const p = await load("");
    expect(p.STATE_DIR).toBe(PROJECT_ROOT);
  });

  it("keeps the signing keystore and firmware out of the served uploads dir", async () => {
    const p = await load();
    for (const d of [p.SIGNING_DIR, p.FIRMWARE_DIR, p.AGENT_BIN_DIR, p.BACKUP_DIR]) {
      expect((d + sep).startsWith(p.UPLOADS_DIR + sep)).toBe(false);
    }
  });
});
