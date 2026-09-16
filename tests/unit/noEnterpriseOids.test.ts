/**
 * tests/unit/noEnterpriseOids.test.ts — the vendor SNMP knowledge boundary.
 *
 * The rule (2026-09-15): an OID under the SNMP enterprises arc
 * (`1.3.6.1.4.1.*`) never appears as a literal in `src/`. A vendor's OIDs come
 * from the MIB the operator uploads and resolve BY SYMBOL NAME through
 * `oidRegistry.ts → resolveOidSync()`; Polaris ships the engine and the
 * IETF/IEEE standards, nothing vendor-specific. A vendor changing or adding an
 * object is then fixed by uploading a MIB, never by a Polaris release.
 *
 * The one thing that LOOKS like an exception is `src/utils/snmpIdentity.ts`,
 * where a prefix regex (`1\.3\.6\.1\.4\.1\.(\d+)`) extracts an IANA enterprise
 * NUMBER out of `sysObjectID` to name the vendor. That is an IANA registry
 * fact, not vendor MIB knowledge, and the OID is never walked. Because it is
 * an escaped regex and not a dotted string it never matches the literal
 * pattern, so it needs no allowlist entry — the dedicated case at the bottom
 * pins that it stays in that shape and grows no walked OID behind the
 * identity story.
 *
 * This lands as a BURN-DOWN, not a big bang: `ENTERPRISE_OID_ALLOWLIST` names
 * the files that carry literals in code today, and each later phase of the
 * uniform-SNMP work removes one entry. Two properties keep the list honest —
 * a file may not leave the list while it still has a literal, and a file may
 * not STAY on the list once its literals are gone (the second is what stops
 * the list from rotting into a standing exemption). Terminal state: the
 * allowlist is EMPTY.
 *
 * Comments are stripped before matching. Several files quote OIDs in
 * docblocks to explain what a symbol is ("fsSysVersion @ 12356.106.4.1.1"),
 * and prose about a number is not a dependency on it.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC_DIR = join(__dirname, "..", "..", "src");

/**
 * Files still carrying an enterprise-arc literal in CODE. Repo-relative,
 * forward slashes. Shrinks phase by phase; see the uniform-SNMP plan.
 *
 *   oidRegistry.ts        — BUILT_IN_OIDS vendor anchors + leaf seeds  (Phase 3)
 *   monitoringService.ts  — the hardcoded `OID` map's Fortinet tables    (Phase 5a)
 *   fortiapRadioSnmp.ts   — FortiAP radio / VAP column tables            (Phase 5a)
 */
export const ENTERPRISE_OID_ALLOWLIST: ReadonlySet<string> = new Set([
  "src/services/oidRegistry.ts",
  "src/services/monitoringService.ts",
  "src/utils/fortiapRadioSnmp.ts",
]);

/** The identity file — allowed the escaped prefix REGEX, never a walked OID. */
const IDENTITY_FILE = "src/utils/snmpIdentity.ts";

// A digit must follow the arc: `1.3.6.1.4.1.` alone is the `enterprises` node
// itself, which is IETF scaffolding and stays legal.
const ENTERPRISE_LITERAL_RE = /1\.3\.6\.1\.4\.1\.\d/g;

/**
 * Drop block and line comments, keep everything else (including string
 * literals — an OID IS a string literal, so the apiClientReferences idiom of
 * blanking strings would erase the very thing this test looks for). The
 * `(^|[^:])` guard keeps `https://…` inside a string from reading as a line
 * comment.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "generated") continue; // Prisma client — not ours to police
      walkTs(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(full: string): string {
  return relative(join(SRC_DIR, ".."), full).split(sep).join("/");
}

function enterpriseLiterals(source: string): string[] {
  return stripComments(source).match(ENTERPRISE_LITERAL_RE) ?? [];
}

describe("vendor SNMP knowledge boundary — no enterprise-arc OID literals in src/", () => {
  const files = walkTs(SRC_DIR).map((full) => ({ full, rel: repoRelative(full) }));

  it("finds source files to scan", () => {
    // If the walk silently produced nothing, every assertion below would pass
    // for the wrong reason.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.rel === "src/services/oidRegistry.ts")).toBe(true);
  });

  it("would catch a planted literal (the scanner is not vacuous)", () => {
    const planted = `const OID = { fooBar: "1.3.6.1.4.1.12356.101.4.1.3" };`;
    expect(enterpriseLiterals(planted)).toHaveLength(1);
    // …and ignores the same number when it only appears in prose.
    expect(enterpriseLiterals(`// fgSysCpuUsage @ 1.3.6.1.4.1.12356.101.4.1.3\nconst x = 1;`)).toHaveLength(0);
    expect(enterpriseLiterals(`/** lives under 1.3.6.1.4.1.12356 */\nconst x = 1;`)).toHaveLength(0);
    // The enterprises node itself is scaffolding, not a vendor fact.
    expect(enterpriseLiterals(`enterprises: "1.3.6.1.4.1",`)).toHaveLength(0);
  });

  for (const { full, rel } of files) {
    if (ENTERPRISE_OID_ALLOWLIST.has(rel)) continue;
    it(`${rel}: carries no enterprise-arc OID literal`, () => {
      const hits = enterpriseLiterals(readFileSync(full, "utf8"));
      expect(
        hits,
        `${rel} hardcodes ${hits.length} enterprise-arc OID(s) (${[...new Set(hits)].join(", ")}…). ` +
          `Vendor OIDs are data: name the MIB symbol and resolve it through oidRegistry.resolveOidSync() ` +
          `at the asset's scope, so the operator's uploaded MIB — not a Polaris release — decides the number.`,
      ).toHaveLength(0);
    });
  }

  it("every allowlisted file still needs its exemption", () => {
    // A file that no longer carries a literal must leave the list in the same
    // commit that cleaned it — otherwise the list rots into a standing
    // exemption nobody re-examines.
    const stale: string[] = [];
    for (const rel of ENTERPRISE_OID_ALLOWLIST) {
      const full = join(SRC_DIR, "..", rel);
      const hits = enterpriseLiterals(readFileSync(full, "utf8"));
      if (hits.length === 0) stale.push(rel);
    }
    expect(stale, `remove from ENTERPRISE_OID_ALLOWLIST — no literal remains: ${stale.join(", ")}`).toEqual([]);
  });

  it("snmpIdentity.ts keeps the enterprise arc only as an escaped prefix regex", () => {
    // The identity path may name a vendor from its IANA number; it may not
    // hold a walked OID. The escaped form is the only legal shape there — a
    // dotted string would be telemetry knowledge hiding behind the identity
    // story, and the per-file case above already fails on it.
    expect(ENTERPRISE_OID_ALLOWLIST.has(IDENTITY_FILE)).toBe(false);
    const code = stripComments(readFileSync(join(SRC_DIR, "..", IDENTITY_FILE), "utf8"));
    expect(code).toMatch(/1\\\.3\\\.6\\\.1\\\.4\\\.1\\\.\(\\d\+\)/);
  });
});
