// prisma.config.ts hands `prisma generate` a placeholder URL when DATABASE_URL is unset, so
// `npm ci` (postinstall runs generate) works in a checkout without a .env — a fresh worktree, a
// first clone. Every other command must still fail loudly on the missing variable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

vi.mock("dotenv/config", () => ({})); // a developer's .env must not mask the unset variable

const savedArgv = process.argv;
const savedUrl = process.env.DATABASE_URL;

async function loadConfig(argv: string[]) {
  process.argv = [savedArgv[0], "prisma", ...argv];
  vi.resetModules();
  return (await import("../../prisma.config.ts")).default;
}

describe("prisma.config.ts DATABASE_URL fallback", () => {
  beforeEach(() => { delete process.env.DATABASE_URL; });
  afterEach(() => {
    process.argv = savedArgv;
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  });

  it("gives generate a placeholder when DATABASE_URL is unset", async () => {
    const cfg = await loadConfig(["generate"]);
    expect(cfg.datasource?.url).toMatch(/^postgresql:\/\/generate:generate@/);
  });

  it("uses the real DATABASE_URL for generate when one is set", async () => {
    process.env.DATABASE_URL = "postgresql://real:real@db:5432/real";
    const cfg = await loadConfig(["generate"]);
    expect(cfg.datasource?.url).toBe("postgresql://real:real@db:5432/real");
  });

  it("still refuses a connecting command without DATABASE_URL", async () => {
    await expect(loadConfig(["migrate", "deploy"])).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("worktree-start.mjs argument checks", () => {
  const script = resolve(".claude/skills/polaris-worktree-workflow/scripts/worktree-start.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("refuses a missing purpose", () => {
    const r = run("some-slug");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/usage:/);
  });

  it("refuses a slug that is not lowercase letters, digits, dots and dashes", () => {
    const r = run("Bad_Slug", "purpose");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be lowercase/);
  });

  it("refuses an unknown flag before touching git", () => {
    const r = run("ok-slug", "purpose", "--frobnicate");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown flag --frobnicate/);
  });
});
