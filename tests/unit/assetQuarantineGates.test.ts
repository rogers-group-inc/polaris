/**
 * tests/unit/assetQuarantineGates.test.ts — every UI surface that reaches the
 * quarantine routes must gate on the `assetsQuarantine` function key.
 *
 * Quarantine pushes a MAC block to every FortiGate that has seen a device, and
 * it has its OWN key: every /assets/:id/quarantine* route and both bulk routes
 * gate on `assetsQuarantine`, never on `assets`. Three surfaces shipped gated on
 * `canManageAssets()` (= `assets:write`) instead — the asset-details Quarantine
 * tab (visibility AND wiring) and the two bulk-bar buttons. Because a role may
 * hold either key without the other, that broke both ways:
 *
 *   - `assets:write` with no quarantine grant → controls visible, every click 403s.
 *   - `assetsQuarantine:write` with `assets:read` → the SOC shape, allowed to
 *     contain a device but not to edit inventory, saw NO quarantine UI at all.
 *
 * No built-in role is affected (all five have `assets` >= `assetsQuarantine`), so
 * this only bit operator-defined roles — which is what dynamic roles are for.
 *
 * The assertions are STATIC against the shipped sources rather than behavioural:
 * these are one-line gates buried in an ~18k-line render path, and standing up
 * the asset-details machinery to observe them would test the harness more than
 * the gate. Each negative assertion has been verified to fail when the old gate
 * is planted back in, so none of them passes vacuously.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clampLevelToKey, levelsFor } from "../../src/api/middleware/permissions.js";

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const appSrc = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
const assetsHtml = readFileSync(resolve(__dirname, "../../public/assets.html"), "utf8");
const mobileSrc = readFileSync(resolve(__dirname, "../../public/js/mobile/asset-detail.js"), "utf8");
const apiSrc = readFileSync(resolve(__dirname, "../../public/js/api.js"), "utf8");
const assetsRouteSrc = readFileSync(resolve(__dirname, "../../src/api/routes/assets.ts"), "utf8");

describe("quarantine reason dialog", () => {
  // Three desktop paths can start a quarantine — the row menu, the bulk bar and
  // the asset-details Quarantine tab — and each carried its own window.prompt
  // with slightly different wording. They now share _promptQuarantineReason so
  // the warning, the 500-char cap (the route's own limit) and the
  // null-vs-empty-string cancel contract are identical wherever an operator
  // lands. window.prompt is also unstyled, absent in the mobile PWA and
  // suppressed by some browsers, which for a containment action means the
  // operator silently cannot act.
  it("is defined once and used by all three desktop paths", () => {
    expect(assetsSrc).toMatch(/function _promptQuarantineReason\(assetCount\)/);
    const calls = assetsSrc.match(/_promptQuarantineReason\(/g) ?? [];
    // One declaration + three call sites.
    expect(calls.length).toBe(4);
  });

  it("caps the reason at the route's own limit", () => {
    // The route validates z.string().max(500); a looser cap here would let the
    // operator type a reason the server then rejects.
    expect(assetsSrc).toMatch(/maxLength: 500, \/\/ matches the route's/);
  });

  it("no quarantine path still uses window.prompt", () => {
    for (const marker of [
      "Reason for quarantine (optional):",
      "Reason for quarantine (optional, applies to all selected):",
    ]) {
      expect(assetsSrc, marker).not.toContain(`window.prompt("${marker}")`);
      expect(assetsSrc, marker).not.toContain(`window.prompt('${marker}')`);
    }
  });
});

describe("quarantine UI gates", () => {
  it("app.js exposes canQuarantineAssets bound to the assetsQuarantine key", () => {
    expect(appSrc).toMatch(/function canQuarantineAssets\(\)\s*\{\s*return permAtLeast\("assetsQuarantine",\s*"write"\)/);
  });

  it("the Quarantine tab's visibility and wiring both use it", () => {
    // Visibility: the tabs.push condition.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\) && \(a\.status === "quarantined"/);
    // Wiring: without this the tab renders but its buttons do nothing.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\)\) _wireQuarantineTab\(a\);/);
    expect(assetsSrc).not.toMatch(/if \(canManageAssets\(\)\) _wireQuarantineTab\(a\);/);
  });

  it("the bulk-bar quarantine block uses it", () => {
    // The guard is load-bearing: without the key the block never runs, so the
    // buttons keep the display:none the attribute applier set at load.
    expect(assetsSrc).toMatch(/if \(canQuarantineAssets\(\)\) \{[\s\S]*?assets-bulk-quarantine-btn/);
    // And the old wrong gate is gone from that block.
    expect(assetsSrc).not.toMatch(/if \(canManageAssets\(\)\) \{[\s\S]*?assets-bulk-quarantine-btn/);
  });

  it("the bulk-bar buttons carry data-quarantine-assets, not data-manage-assets", () => {
    for (const id of ["assets-bulk-quarantine-btn", "assets-bulk-unquarantine-btn"]) {
      const tag = assetsHtml.split(`id="${id}"`)[1]!.split(">")[0]!;
      expect(tag, id).toContain("data-quarantine-assets");
      expect(tag, id).not.toContain("data-manage-assets");
    }
  });

  it("app.js hides data-quarantine-assets elements without the key", () => {
    expect(appSrc).toMatch(/\[data-quarantine-assets\][\s\S]{0,200}canQuarantineAssets\(\)/);
  });
});

describe("quarantine push availability gates", () => {
  // `config.pushQuarantine` is per-integration and off by default; with it off
  // everywhere a push resolves to zero targets and 502s with "0/0 FortiGate(s)
  // accepted the push". Every surface that OFFERS a quarantine therefore checks
  // availability first — and no surface that RELEASES one does, because
  // releaseQuarantine unpushes from the targets recorded on the asset without
  // consulting the toggle.
  it("assets.js caches the answer and fails open", () => {
    expect(assetsSrc).toMatch(/function _quarantinePushAvailable\(\) \{ return _qtnPushEnabled !== false; \}/);
    // Fetched once per page load behind the quarantine key, and a failed probe
    // returns to the fail-open null rather than latching "unavailable".
    expect(assetsSrc).toMatch(/if \(!canQuarantineAssets\(\)\) return null;[\s\S]{0,200}quarantineAvailability\(\)/);
    expect(assetsSrc).toMatch(/catch\(function \(\) \{ _qtnPushEnabled = null; \}\)/);
  });

  it("the row menu withholds Quarantine but never Release", () => {
    // The function is ~20 lines; a generous slice keeps the assertion off
    // any brace-matching cleverness.
    const fn = assetsSrc.split("function _quarantineMenuItems(a) {")[1]!.slice(0, 1200);
    const releaseAt = fn.indexOf("Release quarantine");
    const gateAt = fn.indexOf("_quarantinePushAvailable()");
    expect(gateAt).toBeGreaterThan(-1);
    // The gate sits AFTER the already-quarantined early return.
    expect(gateAt).toBeGreaterThan(releaseAt);
  });

  it("the bulk bar gates Quarantine and not Release", () => {
    expect(assetsSrc).toMatch(/bQ\.style\.display\s*=\s*count > 0 && hasQuarantineable && _quarantinePushAvailable\(\)/);
    const unq = assetsSrc.match(/bUQ\.style\.display.*/)![0];
    expect(unq).not.toContain("_quarantinePushAvailable");
  });

  it("the details tab still shows for an already-quarantined asset", () => {
    // ...so Release and the recorded push targets stay reachable after an
    // operator turns the toggle off.
    expect(assetsSrc).toMatch(
      /if \(canQuarantineAssets\(\) && \(a\.status === "quarantined" \|\| \(hasMac && !isInfraQ && _quarantinePushAvailable\(\)\)\)\)/,
    );
  });

  it("the mobile sheet gates its Quarantine button the same way", () => {
    expect(mobileSrc).toMatch(/if \(hasMac && !isInfra && quarantinePushAvailable\(\)\)/);
    expect(mobileSrc).toMatch(/function quarantinePushAvailable\(\) \{ return _qtnPushEnabled !== false; \}/);
    // Release is rendered before that branch and must stay ungated.
    const html = mobileSrc.split("function quarantineButtonHtml(asset) {")[1]!.slice(0, 1200);
    expect(html.indexOf("Release Quarantine")).toBeLessThan(html.indexOf("quarantinePushAvailable()"));
  });

  it("the API client points at the route, which is declared above GET /:id", () => {
    expect(apiSrc).toContain('request("GET", "/assets/quarantine-availability")');
    // Express matches in declaration order — below /:id the literal path would
    // be swallowed as an asset id.
    expect(assetsRouteSrc.indexOf('"/quarantine-availability"')).toBeGreaterThan(-1);
    expect(assetsRouteSrc.indexOf('"/quarantine-availability"'))
      .toBeLessThan(assetsRouteSrc.indexOf('router.get("/:id"'));
  });
});

describe("quarantine RBAC defaults", () => {
  // Quarantine is its own function key rather than a level of `assets`, so the
  // built-in matrices are the only thing that decides who can reach it out of
  // the box. Asset admins are the intended default holder — containing a device
  // is asset work — while the network/user roles get read (they can see the
  // Quarantine tab's state, not push). Pinned against the seed because a role
  // matrix is a wall of JSON where a dropped key reads as `none` and silently
  // takes the feature away from the role it exists for.
  const seed = readFileSync(
    resolve(__dirname, "../../prisma/migrations/20260524000000_roles_table_cutover/migration.sql"),
    "utf8",
  );
  const matrixFor = (role: string) => {
    const after = seed.split(`'${role}',`)[1]!;
    return after.slice(0, after.indexOf("::jsonb"));
  };

  it("seeds assetsadmin with quarantine write", () => {
    expect(matrixFor("assetsadmin")).toContain('"assetsQuarantine":"write"');
  });

  it("seeds admin with the top rung and the read-only roles with read", () => {
    // The 2026-05 seed wrote `fullwrite` here. The catalogue sweep of
    // 2026-09-22 shortened this key's ladder to none|read|write — no route
    // ever asked for the fourth rung — and migration
    // 20260922000000_rbac_catalogue_hygiene folds the stored value down, so
    // admin's EFFECTIVE level today is `write`. Both are "the top of the
    // ladder"; the seed text below is history and is asserted as such.
    expect(matrixFor("admin")).toContain('"assetsQuarantine":"fullwrite"');
    expect(levelsFor("assetsQuarantine")).toEqual(["none", "read", "write"]);
    expect(clampLevelToKey("assetsQuarantine", "fullwrite")).toBe("write");
    for (const role of ["readonly", "networkadmin", "user"]) {
      expect(matrixFor(role), role).toContain('"assetsQuarantine":"read"');
    }
  });

  it("every quarantine route gates on the key, never on assets", () => {
    // Includes the availability probe the frontends read: a route that answered
    // to `assets:read` would hand the fleet's quarantine posture to any viewer.
    for (const path of [
      '"/:id/quarantine-status"',
      '"/:id/quarantine"',
      '"/:id/quarantine/verify"',
      '"/bulk-quarantine"',
      '"/bulk-quarantine/release"',
      '"/quarantine-availability"',
    ]) {
      // EVERY declaration of the path, not just the first — /:id/quarantine is
      // both the POST that pushes and the DELETE that releases.
      let at = assetsRouteSrc.indexOf(path);
      expect(at, path).toBeGreaterThan(-1);
      while (at > -1) {
        // The gate rides the same route declaration, within a couple of lines.
        expect(assetsRouteSrc.slice(at, at + 260), path).toContain('requirePermission("assetsQuarantine"');
        at = assetsRouteSrc.indexOf(path, at + 1);
      }
    }
  });
});
