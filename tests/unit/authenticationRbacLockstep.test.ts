/**
 * tests/unit/authenticationRbacLockstep.test.ts
 *
 * The two-way lockstep adding an RBAC function key requires — the key in
 * FUNCTION_KEYS **and** a migration seeding it onto every existing Role's
 * matrix — for `authentication`. Same reasoning as
 * savedDashboardsRbacLockstep / networkScanRbacLockstep: `requirePermission`
 * reads the STORED matrix with no admin bypass, so a catalogued-but-unseeded
 * key reads `none` for everyone (admin included) on every existing install
 * while working perfectly on a fresh one.
 *
 * This key is unusual: it is not a NEW capability, it is twelve routes moving
 * off `serverSettingsSystem`. So the seeding is not a policy choice about who
 * should get a new feature — it is a derivation from what each role could
 * already do, and getting it wrong silently hands the login configuration to
 * roles that never had it. That derivation is what this file pins.
 *
 *   serverSettingsSystem=fullwrite -> authentication=write   (had all of it)
 *   serverSettingsSystem=read      -> authentication=read    (had the passkey read)
 *   serverSettingsSystem=write     -> authentication=READ    (the one tightening)
 *   anything else                  -> authentication=none
 *
 * The third line is the only place anyone loses something, and it is the point
 * of the change: that rung gated every identity provider while the rest of the
 * System tab sat a rung ABOVE it, so an operator delegating "some server
 * settings" was handing over the install's login path without being asked.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, levelsFor } from "../../src/api/middleware/permissions.js";

const MIGRATION = resolve(
  __dirname,
  "../../prisma/migrations/20260923000000_authentication_function_key/migration.sql",
);
const sql = () => readFileSync(MIGRATION, "utf8");

describe("authentication function key — lockstep", () => {
  it("is in the FUNCTION_KEYS catalogue", () => {
    expect(FUNCTION_KEYS.map((f) => f.key)).toContain("authentication");
  });

  it("a migration seeds it onto every existing role", () => {
    const text = sql();
    expect(text).toMatch(/'\{authentication\}'/);
    // Guarded on absence, so it is a seed rather than a reset: re-running it
    // must not stamp over a level an admin has since chosen by hand.
    expect(text).toMatch(/NOT \("permissions" \? 'authentication'\)/);
  });

  it("derives each level from the OLD serverSettingsSystem level", () => {
    const text = sql();
    const seedBlock = text.slice(text.indexOf("'{authentication}'"));
    const caseArm = (from: string) =>
      new RegExp(`WHEN '${from}'\\s*THEN '"(\\w+)"'`).exec(seedBlock)?.[1] ?? null;

    expect(caseArm("fullwrite")).toBe("write");
    expect(caseArm("read")).toBe("read");
    // The tightening. If this ever reads "write", a role that could edit the
    // providers only because they sat on the wrong rung keeps that power
    // silently, and the split has bought nothing.
    expect(caseArm("write")).toBe("read");
    expect(seedBlock).toMatch(/ELSE '"none"'/);
  });

  it("seeds authentication BEFORE it rewrites serverSettingsSystem", () => {
    // Step 2 folds serverSettingsSystem fullwrite -> write. If it ran first,
    // every admin-equivalent role would look like a plain `write` holder to
    // step 1 and be seeded authentication=read — locking every install out of
    // its own login configuration, with no error anywhere.
    const text = sql();
    expect(text.indexOf("'{authentication}'")).toBeLessThan(
      text.indexOf("'{serverSettingsSystem}'"),
    );
  });

  it("folds serverSettingsSystem down to write in the same migration", () => {
    expect(sql()).toMatch(/'\{serverSettingsSystem\}',\s*'"write"'/);
    expect(levelsFor("serverSettingsSystem")).toEqual(["none", "read", "write"]);
  });

  it("holds none|read|write and no ownership dimension", () => {
    const def = FUNCTION_KEYS.find((f) => f.key === "authentication")!;
    expect(levelsFor("authentication")).toEqual(["none", "read", "write"]);
    expect(def.hasOwnershipDimension).toBeUndefined();
  });
});

describe("authentication — every route it should own, and none it should not", () => {
  const routeFile = (name: string) =>
    readFileSync(resolve(__dirname, `../../src/api/routes/${name}`), "utf8");

  it("gates all four identity providers' settings and test routes", () => {
    const auth = routeFile("auth.ts");
    for (const provider of ["azure", "oidc", "ldap", "entra-proxy"]) {
      expect(auth, provider).toMatch(
        new RegExp(`"/${provider}/settings".*requirePermission\\("authentication"`),
      );
    }
    // A test button dials the IdP, often with stored secrets merged in, so it
    // is a write-level act rather than a read.
    for (const provider of ["azure", "oidc", "ldap", "entra-proxy"]) {
      expect(auth, provider).toMatch(
        new RegExp(`"/${provider}/test".*requirePermission\\("authentication", "write"\\)`),
      );
    }
  });

  it("gates the passkey and password policies", () => {
    const auth = routeFile("auth.ts");
    expect(auth).toMatch(/"\/passkey-settings".*requirePermission\("authentication", "read"\)/);
    // The two PUTs are multi-line route declarations, so match the pair loosely.
    expect(auth).toMatch(/"\/password-policy",\s*\n\s*requireAuth,\s*\n\s*requirePermission\("authentication", "write"\)/);
    expect(auth).toMatch(/"\/passkey-settings",\s*\n\s*requireAuth,\s*\n\s*requirePermission\("authentication", "write"\)/);
  });

  it("leaves nothing in auth.ts still gated on serverSettingsSystem", () => {
    expect(routeFile("auth.ts")).not.toMatch(/requirePermission\("serverSettingsSystem"/);
  });

  it("does NOT take the IdP group mappings", () => {
    // A mapping decides which ROLE an IdP group receives. That is granting
    // authority, not configuring authentication, and it is already the
    // documented path to admin outside the last-admin guard — so it stays on
    // `users=fullwrite` where the escalation guards can see it.
    const router = readFileSync(resolve(__dirname, "../../src/api/router.ts"), "utf8");
    expect(router).toMatch(/"\/group-mappings",\s*requirePermission\("users", "fullwrite"\)/);
  });
});
