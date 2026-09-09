#!/usr/bin/env node
/**
 * scripts/check-deps.mjs — offline dependency-target guard.
 *
 * npm majors publish no end-of-life dates, and which major an install runs is
 * fixed by its build rather than its host. So dependency currency is a repo
 * fact, checked here and in CI, not a per-install signal warned about in the
 * app. (The platform runtimes — Node, PostgreSQL, Go, nginx, the OS — DO go
 * end-of-life on a calendar and ARE warned about in-app; that is
 * src/data/platformEol.json and check-versions.mjs.)
 *
 * Fully offline: reads package.json, package-lock.json, agent/go.mod and
 * src/data/dependencyTargets.json. No registry, no network — so it runs in CI
 * with no install and cannot be affected by a registry outage.
 *
 * What it fails on:
 *   - an installed major BELOW its recorded targetMajor (we slipped back)
 *   - an installed major ABOVE it (the target was not updated with the bump —
 *     the record is now lying, which is worse than being behind)
 *   - an `overrides` entry in package.json with no matching record, or a record
 *     with no override: the block is a hand-maintained CVE patch set and an
 *     unexplained entry is indistinguishable from a mistake six months later
 *   - a Go module whose go.mod version has drifted from its recorded target
 *
 * What it only warns on:
 *   - an override whose reviewedAt is over a year old (re-verify with
 *     `npm ls <pkg>`; a parent bump can make a floor redundant or insufficient)
 *
 * Wiring: `npm run check:deps`, a CI step, and the pre-commit hook as a WARNING
 * only — a commit must not be blocked on a dependency decision.
 *
 * The procedure this enforces is
 * .claude/skills/polaris-tech-lifecycle/references/dependency-audit.md.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WARN_ONLY = process.argv.includes("--warn-only");
const OVERRIDE_STALE_DAYS = 365;

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  } catch {
    return null;
  }
}

const pkg = readJson("package.json");
const targets = readJson("src/data/dependencyTargets.json");

const failures = [];
const warnings = [];

if (!pkg) failures.push("package.json is missing or does not parse.");
if (!targets) failures.push("src/data/dependencyTargets.json is missing or does not parse.");

/** Leading major from a semver range or exact version: "^8.20.0" -> 8. */
function major(range) {
  const m = String(range).match(/(\d+)\./);
  return m ? Number(m[1]) : null;
}

if (pkg && targets) {
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  // --- npm majors --------------------------------------------------------
  for (const t of targets.npm ?? []) {
    const range = declared[t.name];
    if (!range) {
      failures.push(
        `${t.name} is recorded with targetMajor ${t.targetMajor} but is not in package.json. ` +
          `Remove the record, or restore the dependency.`,
      );
      continue;
    }
    const installed = major(range);
    if (installed === null) {
      warnings.push(`${t.name}: cannot read a major from "${range}" — check the record by hand.`);
      continue;
    }
    if (installed < t.targetMajor) {
      failures.push(
        `${t.name} is on major ${installed} but the recorded target is ${t.targetMajor}. ` +
          `Bump it, or lower the target with a reason in src/data/dependencyTargets.json.`,
      );
    } else if (installed > t.targetMajor) {
      failures.push(
        `${t.name} is on major ${installed}, ahead of the recorded target ${t.targetMajor}. ` +
          `The record was not updated with the bump — update targetMajor so it stops lying` +
          (t.pinFamily ? `, and check the ${t.pinFamily} family with npm run check:versions.` : "."),
      );
    }
  }

  // --- the overrides block ----------------------------------------------
  const actualOverrides = Object.keys(pkg.overrides ?? {});
  const recorded = new Map((targets.overrides ?? []).map((o) => [o.name, o]));

  for (const name of actualOverrides) {
    const rec = recorded.get(name);
    if (!rec) {
      failures.push(
        `package.json overrides "${name}" with no record in src/data/dependencyTargets.json. ` +
          `The block is a hand-maintained CVE patch set; an entry with no rationale is ` +
          `indistinguishable from a mistake later. Record why it is there.`,
      );
      continue;
    }
    if (rec.floor && pkg.overrides[name] !== rec.floor) {
      failures.push(
        `overrides["${name}"] is "${pkg.overrides[name]}" but the record says "${rec.floor}". ` +
          `Update the record in the same commit as the floor.`,
      );
    }
    const reviewed = Date.parse(`${rec.reviewedAt}T00:00:00Z`);
    if (!Number.isNaN(reviewed)) {
      const age = Math.floor((Date.now() - reviewed) / 86_400_000);
      if (age > OVERRIDE_STALE_DAYS) {
        warnings.push(
          `override "${name}" was last reviewed ${age} days ago. Re-verify with \`npm ls ${name}\` — ` +
            `a parent bump can make a floor redundant OR insufficient, and the second one looks patched.`,
        );
      }
    }
  }
  for (const name of recorded.keys()) {
    if (!actualOverrides.includes(name)) {
      failures.push(
        `src/data/dependencyTargets.json records an override for "${name}" that package.json no longer has. ` +
          `If it was deliberately removed, drop the record too.`,
      );
    }
  }

  // --- Go modules --------------------------------------------------------
  const goMod = existsSync(join(ROOT, "agent/go.mod"))
    ? readFileSync(join(ROOT, "agent/go.mod"), "utf8").replace(/\r\n/g, "\n")
    : null;
  if (goMod) {
    for (const t of targets.go ?? []) {
      const re = new RegExp(`${t.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s+(v[\\d][^\\s]*)`);
      const m = goMod.match(re);
      if (!m) {
        failures.push(`${t.name} is recorded as a Go target but is not in agent/go.mod.`);
      } else if (t.target && m[1] !== t.target) {
        failures.push(
          `${t.name} is at ${m[1]} in agent/go.mod but the record says ${t.target}. ` +
            `Update the record — and remember an agent-side bump implies agent/VERSION, a rebuild ` +
            `of every platform binary and a re-sign.`,
        );
      }
    }
  }
}

// --- output ---------------------------------------------------------------
for (const w of warnings) console.log(`⚠ check-deps (warn): ${w}\n`);

if (failures.length > 0) {
  const out = WARN_ONLY ? console.log : console.error;
  out(`${WARN_ONLY ? "⚠" : "✗"} check-deps: ${failures.length} issue(s).\n`);
  for (const f of failures) out(`  ${f}\n`);
  out("Procedure: .claude/skills/polaris-tech-lifecycle/references/dependency-audit.md");
  process.exit(WARN_ONLY ? 0 : 1);
}

const n = (targets?.npm?.length ?? 0) + (targets?.go?.length ?? 0);
console.log(`✓ check-deps: ${n} recorded dependency target(s) and ${Object.keys(pkg?.overrides ?? {}).length} override(s) consistent.`);
process.exit(0);
