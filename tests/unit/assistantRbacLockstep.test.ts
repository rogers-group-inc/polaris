/**
 * tests/unit/assistantRbacLockstep.test.ts
 *
 * Business rule 94 — the RBAC halves of the AI assistant that must move
 * together:
 *   - the `assistant` key is catalogued READ_ONLY and seeded by its migration
 *     onto every role except the api-* / llm-* token roles (including the
 *     protected `readonly`, which could otherwise never be granted it);
 *   - the bot role an llm integration mints (rule 94(f)) reads everything
 *     with a read rung EXCEPT secrets, identities and server administration,
 *     can never write, and is never admin-equivalent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, levelsFor, isAdminEquivalentPermissions } from "../../src/api/middleware/permissions.js";
import { botPermissions, botRoleBaseName, BOT_EXCLUDED_KEYS } from "../../src/services/llmIntegrationService.js";

const sql = readFileSync(resolve(__dirname, "../../prisma/migrations/20261007000000_assistant/migration.sql"), "utf8");
const block = (() => {
  const start = sql.indexOf("'{assistant}'");
  const from = sql.lastIndexOf('UPDATE "roles"', start);
  return sql.slice(from, sql.indexOf(";", start) + 1);
})();

describe("assistant function key — lockstep", () => {
  it("is catalogued none|read", () => {
    expect(FUNCTION_KEYS.some((f) => f.key === "assistant")).toBe(true);
    expect(levelsFor("assistant")).toEqual(["none", "read"]);
  });

  it("seeds read on every role except the api-* and llm-* token roles", () => {
    expect(block).toMatch(/"name" LIKE 'api-%' OR "name" LIKE 'llm-%'/);
    expect(block).toMatch(/THEN '"none"'::jsonb/);
    expect(block).toMatch(/ELSE '"read"'::jsonb/);
  });

  it("only touches rows that lack the key, and bumps updatedAt", () => {
    expect(block).toMatch(/WHERE NOT \("permissions" \? 'assistant'\)/);
    expect(block).toMatch(/"updatedAt" = CURRENT_TIMESTAMP/);
  });
});

describe("the llm integration's bot role", () => {
  const perms = botPermissions();

  it("covers every function key", () => {
    expect(Object.keys(perms).sort()).toEqual(FUNCTION_KEYS.map((f) => f.key).sort());
  });

  it("never writes", () => {
    for (const level of Object.values(perms)) expect(["none", "read"]).toContain(level);
  });

  it("cannot read secrets, identities, scripts or server administration", () => {
    for (const k of ["credentials", "apiTokens", "users", "roles", "authentication", "automationScripts", "serverSettingsSystem", "serverSettingsData", "assistant"]) {
      expect(BOT_EXCLUDED_KEYS.has(k)).toBe(true);
      expect(perms[k]).toBe("none");
    }
  });

  it("reads the operational data the model server would look up", () => {
    for (const k of ["assets", "subnets", "reservations", "ipBlocks", "alerts", "events", "deviceMap"]) {
      expect(perms[k]).toBe("read");
    }
  });

  it("is never admin-equivalent", () => {
    expect(isAdminEquivalentPermissions(perms)).toBe(false);
  });

  it("names itself within roleService's ^[A-Za-z0-9_-]{2,32}$", () => {
    for (const n of ["Ollama on gpu-01", "LLM / Prod (Nashville) ★", "", "x".repeat(80)]) {
      expect(botRoleBaseName(n)).toMatch(/^llm-[a-z0-9_-]{1,24}$/);
    }
    expect(botRoleBaseName("Ollama on gpu-01")).toBe("llm-ollama-on-gpu-01");
  });
});
