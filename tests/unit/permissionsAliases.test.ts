/**
 * tests/unit/permissionsAliases.test.ts — Automations RBAC rename compat:
 * LEGACY_KEY_ALIASES, permissionOf reverse-alias fallback, and
 * normalizePermissions legacy-key folding.
 *
 * The load-bearing case: session snapshots persisted BEFORE the rename
 * deploy carry the old key names (`notifications`, `notificationManagement`)
 * and the cold roleVersionMap deliberately trusts them at boot — without the
 * reverse lookup every live session would 403 on alerts until re-login.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  FUNCTION_KEYS,
  LEGACY_KEY_ALIASES,
  permissionOf,
  normalizePermissions,
  type AccessLevel,
} from "../../src/api/middleware/permissions.js";

const keys = new Set(FUNCTION_KEYS.map(f => f.key));

describe("function-key catalogue (post-rename)", () => {
  it("carries the modern keys and not the legacy ones", () => {
    expect(keys.has("alerts")).toBe(true);
    expect(keys.has("automationManagement")).toBe(true);
    expect(keys.has("automationScripts")).toBe(true);
    expect(keys.has("notifications")).toBe(false);
    expect(keys.has("notificationManagement")).toBe(false);
  });

  it("every legacy alias points at a real modern key", () => {
    for (const modern of Object.values(LEGACY_KEY_ALIASES)) {
      expect(keys.has(modern)).toBe(true);
    }
  });
});

describe("permissionOf", () => {
  it("prefers the modern key when present", () => {
    const perms = { alerts: "write", notifications: "read" } as Record<string, AccessLevel>;
    expect(permissionOf(perms, "alerts")).toBe("write");
  });

  it("falls back to the legacy key for pre-rename snapshots", () => {
    // Exactly what a pre-deploy session snapshot looks like.
    const preRename = {
      assets: "read",
      notifications: "write",
      notificationManagement: "fullwrite",
    } as Record<string, AccessLevel>;
    expect(permissionOf(preRename, "alerts")).toBe("write");
    // Resolves through the alias AND clamps into automationManagement's
    // ladder, which lost its dead fourth rung on 2026-09-22 — a snapshot
    // stamped before either change still lands on the key's top level.
    expect(permissionOf(preRename, "automationManagement")).toBe("write");
  });

  it("returns none when neither key is present or values are invalid", () => {
    expect(permissionOf({}, "alerts")).toBe("none");
    expect(permissionOf({ notifications: "bogus" as AccessLevel }, "alerts")).toBe("none");
    expect(permissionOf({ assets: "read" } as Record<string, AccessLevel>, "automationScripts")).toBe("none");
  });

  it("never resolves a legacy key name directly (catalogue is modern-only)", () => {
    const perms = { alerts: "write" } as Record<string, AccessLevel>;
    // Callers always pass modern keys; a legacy key passed in has no
    // reverse entry and resolves through the direct lookup only.
    expect(permissionOf(perms, "notifications")).toBe("none");
  });
});

describe("normalizePermissions legacy folding", () => {
  it("folds legacy keys onto modern names when the modern key is absent", () => {
    const out = normalizePermissions({ notifications: "write", notificationManagement: "read" });
    expect(out.alerts).toBe("write");
    expect(out.automationManagement).toBe("read");
    expect(out).not.toHaveProperty("notifications");
    expect(out).not.toHaveProperty("notificationManagement");
  });

  it("modern key wins over a conflicting legacy key", () => {
    const out = normalizePermissions({ alerts: "read", notifications: "fullwrite" });
    expect(out.alerts).toBe("read");
  });

  it("does not mutate the caller's input object", () => {
    const input = { notifications: "write" };
    normalizePermissions(input);
    expect(input).toEqual({ notifications: "write" });
  });

  it("defaults automationScripts to none", () => {
    const out = normalizePermissions({ notifications: "fullwrite" });
    expect(out.automationScripts).toBe("none");
  });
});
