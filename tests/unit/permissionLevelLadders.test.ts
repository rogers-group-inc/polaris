/**
 * tests/unit/permissionLevelLadders.test.ts
 *
 * The per-key access ladder (2026-09-04). Most function keys hold the full
 * none < read < write < fullwrite ladder; a key may declare a SHORTER one
 * when the levels above its top would be indistinguishable from it.
 * `assetsProbe` is the first: a probe dials the device and writes nothing in
 * Polaris, so Read is the whole grant and the two cells above it were dead
 * radio buttons an operator could nonetheless set.
 *
 * Three failure modes are pinned, all of them silent:
 *
 *  - clamping UPWARD. A stored `fullwrite` on a read-only key means "as much
 *    as possible"; rounding it up (or resolving it to none) would either
 *    grant more than the ladder admits or revoke a capability the role had.
 *  - a route asking for a level the key cannot hold. That route would be
 *    permanently unreachable — nothing can grant it — so it has to fail at
 *    module load, not 403 at 3am.
 *  - the ownership dimension drifting off `credentials`, which is what makes
 *    `write` mean "your own rows" there rather than "every row".
 */

import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS,
  FUNCTION_KEYS,
  clampLevelToKey,
  keySupportsLevel,
  levelsFor,
  normalizePermissions,
  permissionOf,
  requirePermission,
} from "../../src/api/middleware/permissions.js";

describe("per-key access ladders", () => {
  it("assetsProbe holds none|read and nothing above", () => {
    expect(levelsFor("assetsProbe")).toEqual(["none", "read"]);
    expect(keySupportsLevel("assetsProbe", "read")).toBe(true);
    expect(keySupportsLevel("assetsProbe", "write")).toBe(false);
    expect(keySupportsLevel("assetsProbe", "fullwrite")).toBe(false);
  });

  it("a key without a declared ladder holds all four levels", () => {
    expect(levelsFor("assets")).toEqual(ACCESS_LEVELS);
    for (const lvl of ACCESS_LEVELS) expect(keySupportsLevel("assets", lvl)).toBe(true);
  });

  it("an unknown key answers the full ladder rather than throwing", () => {
    expect(levelsFor("notAKey")).toEqual(ACCESS_LEVELS);
  });

  it("clamps DOWN into the ladder, never up", () => {
    expect(clampLevelToKey("assetsProbe", "fullwrite")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "write")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "read")).toBe("read");
    expect(clampLevelToKey("assetsProbe", "none")).toBe("none");
    // Untouched on a full-ladder key.
    expect(clampLevelToKey("assets", "fullwrite")).toBe("fullwrite");
  });

  it("normalizePermissions folds a stored over-level value", () => {
    const out = normalizePermissions({ assetsProbe: "fullwrite", assets: "write" });
    expect(out.assetsProbe).toBe("read");
    expect(out.assets).toBe("write");
  });

  it("permissionOf folds a pre-deploy session snapshot too", () => {
    // A session stamped before the ladder narrowed carries the old value and
    // is trusted at boot (cold role-version cache), so the read path clamps.
    expect(permissionOf({ assetsProbe: "write" }, "assetsProbe")).toBe("read");
  });

  it("requirePermission refuses to build a gate the key can never satisfy", () => {
    expect(() => requirePermission("assetsProbe", "write")).toThrow(/cannot hold/i);
    expect(() => requirePermission("assetsProbe", "read")).not.toThrow();
  });
});

describe("ownership-dimensioned keys", () => {
  it("credentials carries the ownership dimension", () => {
    const def = FUNCTION_KEYS.find(f => f.key === "credentials");
    expect(def).toBeDefined();
    expect(def?.hasOwnershipDimension).toBe(true);
  });

  it("the ownership set includes the four keys whose routes call assertOwnership", () => {
    // Deliberately a CONTAINS check, not an exact set: the dimension keeps
    // being added to more keys (networkScan took it in the Discovery
    // visibility cutover), and pinning the whole list turns every future
    // addition into an unrelated red test.
    const owned = FUNCTION_KEYS.filter(f => f.hasOwnershipDimension).map(f => f.key);
    for (const key of ["subnets", "reservations", "contacts", "credentials"]) {
      expect(owned).toContain(key);
    }
  });

  it("an ownership-dimensioned key must be able to hold both write and fullwrite", () => {
    // The dimension IS the distinction between the two levels, so a shortened
    // ladder on one of these keys would silently collapse it.
    for (const def of FUNCTION_KEYS.filter(f => f.hasOwnershipDimension)) {
      expect(keySupportsLevel(def.key, "write")).toBe(true);
      expect(keySupportsLevel(def.key, "fullwrite")).toBe(true);
    }
  });
});

/**
 * The 2026-09-22 catalogue sweep. Seventeen keys carried a rung no route and
 * no frontend check ever asked for, which let an admin pick a level that
 * granted exactly what the level below it granted. The rule that replaced
 * them is the one pinned here: a fourth rung has to MEAN something.
 */
describe("no dead top rung", () => {
  // Full Read-Write is meaningful on a key only when it either lifts an
  // ownership filter, or reserves an act materially more dangerous than the
  // rest of the key. Everything else tops out at Read-Write. Adding a key
  // here is a deliberate act: say which route reads the fourth rung.
  const FULLWRITE_IS_MEANINGFUL: Record<string, string> = {
    assets: "agent deployment (POST /assets/:id/agent/install and siblings), and merging two assets (POST /assets/:id/merge) — a merge edits one record and deletes another",
    alerts: "clearing an alert, vs. acknowledging it at write",
    assetMonitorSettings: "the outage simulation (POST /assets/:id/dependency-test)",
    integrations: "aborting a discovery in flight (DELETE /integrations/:id/discover)",
    users: "IdP group-mapping CRUD (the /group-mappings mount)",
    roles: "admin-equivalence, together with users=fullwrite",
    savedDashboards: "deleting someone else's dashboard",
    firmware: "starting a firmware upgrade (POST /assets/:id/firmware-upgrade) — the flash reboots a switch or access point (business rule 87)",
    // `serverSettingsSystem` was here until 2026-09-23, excused on the grounds
    // that its `write` rung really did gate something — the identity providers
    // — while `fullwrite` gated the rest of the System tab. That was the key
    // divided in the wrong place, not a rung that had earned its keep, and the
    // providers have since moved to `authentication`. The key now tops out at
    // write like any other.
  };

  it("only an ownership key or a named exception offers Full Read-Write", () => {
    for (const def of FUNCTION_KEYS) {
      if (!keySupportsLevel(def.key, "fullwrite")) continue;
      const excused = def.hasOwnershipDimension || def.key in FULLWRITE_IS_MEANINGFUL;
      expect(
        excused,
        `${def.key} offers Full Read-Write but nothing documents what it grants `
        + "beyond Read-Write. Either gate a route on it and add it to "
        + "FULLWRITE_IS_MEANINGFUL, or give the key a shorter ladder.",
      ).toBe(true);
    }
  });

  it("every exception is still in the catalogue", () => {
    // Keeps the allow-list from outliving the key it excuses.
    const keys = new Set(FUNCTION_KEYS.map(f => f.key));
    for (const key of Object.keys(FULLWRITE_IS_MEANINGFUL)) expect(keys).toContain(key);
  });

  it("serverSettingsData has no Read-Only rung", () => {
    // Its reads (the backup list, the schedule, update status) sit on the
    // serverSettings mount's serverSettingsSystem=read floor. Everything this
    // key gates either changes the database or hands over a copy of it, so a
    // Read-Only grant here would have granted precisely nothing.
    expect(levelsFor("serverSettingsData")).toEqual(["none", "write"]);
    expect(keySupportsLevel("serverSettingsData", "read")).toBe(false);
    expect(clampLevelToKey("serverSettingsData", "read")).toBe("none");
  });

  it("serverSettingsSystem tops out at write, its providers having left", () => {
    // The 2026-09-23 split emptied this key's `write` rung by moving the
    // identity providers to `authentication`, so its ~54 `fullwrite` routes
    // came down onto `write`. A `fullwrite` reappearing here means someone
    // re-divided the key instead of adding one.
    expect(levelsFor("serverSettingsSystem")).toEqual(["none", "read", "write"]);
    expect(keySupportsLevel("serverSettingsSystem", "fullwrite")).toBe(false);
  });

  it("authentication is its own key, none|read|write", () => {
    const def = FUNCTION_KEYS.find(f => f.key === "authentication");
    expect(def).toBeDefined();
    expect(levelsFor("authentication")).toEqual(["none", "read", "write"]);
    // Not an ownership key: there is one set of login providers per install,
    // so there are no "your own" rows for a fourth rung to unlock.
    expect(def?.hasOwnershipDimension).toBeUndefined();
  });

  it("processControl is gone from the catalogue", () => {
    // Process/service control was removed in the Satellite-posture change;
    // the key outlived it by a year, gating nothing.
    expect(FUNCTION_KEYS.map(f => f.key)).not.toContain("processControl");
    expect(normalizePermissions({ processControl: "fullwrite" })).not.toHaveProperty("processControl");
  });
});
