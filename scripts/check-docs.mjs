#!/usr/bin/env node
// Doc-drift guard for the project memory: CLAUDE.md (always loaded) plus every Markdown
// file under .claude/skills/** (the twelve project skills and their references). Catches the
// *mechanically-checkable* drift that accumulated badly before the 2026-05 docs overhaul —
// it CANNOT judge whether prose is still accurate, only structural coverage + reference
// hygiene. The prose review is /polaris-docs-sync.
//
// Run:  npm run check:docs    (or: node scripts/check-docs.mjs)
// Wired as a pre-commit hook via .githooks/pre-commit and as a CI job.
// Bypass a single commit with:  git commit --no-verify
//
// Exit 0 = all checks pass; exit 1 = at least one failure (with a report).
//
// Checks (see .claude/skills/polaris-docs-sync/references/check-docs-reference.md):
//   docs-present               CLAUDE.md + each of the twelve SKILL.md files exist.
//   no-line-numbers            No `file.ext:NNN` or prose "(line N)" references in any doc.
//   models-documented          Every Prisma model in schema.prisma is named in some doc.
//   files-documented           Every src/ service, job, route, util file is named in some doc.
//   paths-exist                Every concrete src/ public/ prisma/ scripts/ deploy/ docs/
//                              .claude/skills/ path referenced in the docs exists on disk.
//   index-casing / retired-doc No references to touches.md / primaries.md / TEMPLATES.md, nor
//                              to the retired root files ARCHITECTURE.md / TOUCHES.md /
//                              BUSINESS-RULES.md / UI-CANON.md (split into skills 2026-09-06).
//   touches-service-coverage   Every src/services file has a `## services/<name>.ts` entry
//                              under polaris-change-impact/references/services/.
//   skill-frontmatter          Every SKILL.md has name == directory + a description; known keys only.
//   reference-size             No reference .md over 1500 lines (fail); over 100 KB warns.
//   orphan-reference           Every references/**/*.md and scripts/* is linked from its SKILL.md.
//   claude-md-size             CLAUDE.md under 25 KB (fail); over 15 KB warns.
//   util-tests (warn)          src/utils files with exports lacking tests/unit/<name>.test.ts.
//   api-plugin-fresh (warn)    public/api.html changed since the polaris-api-conventions plugin
//                              was generated from it (skipped when that clone isn't present).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => join(ROOT, p);
const read = (p) => readFileSync(r(p), "utf8");
const exists = (p) => existsSync(r(p));
const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

const SKILLS_DIR = ".claude/skills";
const SKILLS = [
  "polaris-domain-model", "polaris-business-rules", "polaris-api-rbac", "polaris-change-impact",
  "polaris-ui-canon", "polaris-monitoring-discovery", "polaris-deploy", "polaris-agent",
  "polaris-docs-sync", "polaris-worktree-workflow", "polaris-tech-lifecycle",
  "polaris-design-sync",
];
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "user-invocable", "disable-model-invocation", "allowed-tools", "argument-hint"]);

const failures = [];
const fail = (check, msg) => failures.push({ check, msg });

// design/POLARIS-UI-GUIDE.md is deliberately NOT policed here: it is a drop-in snapshot of
// the external UI kit, so its paths describe a NEW app's layout, and editing it to satisfy a
// check here would just be clobbered by the next kit re-sync. The Polaris-only half lives in
// polaris-ui-canon, which IS policed.

// --- collect the doc set: CLAUDE.md + every .md under .claude/skills/** ---
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const docText = {};
if (!exists("CLAUDE.md")) fail("docs-present", "CLAUDE.md is missing from the repo root.");
else docText["CLAUDE.md"] = read("CLAUDE.md").replace(/\r\n/g, "\n");
for (const s of SKILLS) {
  if (!exists(`${SKILLS_DIR}/${s}/SKILL.md`)) fail("docs-present", `${SKILLS_DIR}/${s}/SKILL.md is missing.`);
}
for (const abs of walk(r(SKILLS_DIR))) {
  // Normalize CRLF: Windows checkouts (core.autocrlf) hand us \r\n, and the frontmatter and
  // heading regexes below anchor on \n. Without this every SKILL.md read as "no frontmatter".
  if (abs.endsWith(".md")) docText[rel(abs)] = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}
const DOCS = Object.keys(docText);
const ALL = DOCS.map((d) => docText[d]).join("\n");

// --- helper: list *.ts basenames in a dir, skipping _helpers and .d.ts ---
function tsFiles(dir) {
  if (!exists(dir)) return [];
  return readdirSync(r(dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => f.replace(/\.ts$/, ""));
}

// === no-line-numbers: no file:line refs and no prose "(line N)" refs in any doc ===
const LINE_REF = /\.(ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1):\d+/g;
const PROSE_LINE_REF = /\((?:around\s+)?lines?\s+~?\d+/gi;
for (const d of DOCS) {
  const hits = [...docText[d].matchAll(LINE_REF)].map((m) => m[0]);
  const prose = [...docText[d].matchAll(PROSE_LINE_REF)].map((m) => m[0]);
  if (hits.length || prose.length) {
    fail(
      "no-line-numbers",
      `${d} has ${hits.length + prose.length} line-number reference(s) (e.g. ${[...new Set([...hits, ...prose])].slice(0, 5).join(", ")}). ` +
        `Use "path/file.ts -> symbolName()" instead — line numbers drift.`,
    );
  }
}

// === models-documented: every Prisma model is named in some doc ===
if (exists("prisma/schema.prisma")) {
  const models = [...read("prisma/schema.prisma").matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
  const undocModels = models
    // *Hourly / *Daily rollup companions are intentionally summarized as a group, not given
    // 12 separate blocks. The base sample model is still required to be documented.
    .filter((name) => !/(Hourly|Daily)$/.test(name))
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(ALL));
  if (undocModels.length) {
    fail(
      "models-documented",
      `${undocModels.length} Prisma model(s) not named in any skill doc: ${undocModels.join(", ")}. ` +
        `Add a Definitions bullet + Schema block to the right ${SKILLS_DIR}/polaris-domain-model/references/<domain>.md.`,
    );
  }
}

// === files-documented: every significant src/ file is named in some doc ===
const codeDirs = [
  ["src/services", "service"],
  ["src/jobs", "job"],
  ["src/api/routes", "route"],
  ["src/utils", "util"],
];
const undocFiles = [];
for (const [dir, kind] of codeDirs) {
  for (const base of tsFiles(dir)) {
    if (!ALL.includes(`${base}.ts`) && !ALL.includes(base)) undocFiles.push(`${kind}: ${dir}/${base}.ts`);
  }
}
if (undocFiles.length) {
  fail(
    "files-documented",
    `${undocFiles.length} source file(s) not named in any skill doc:\n      ` +
      undocFiles.join("\n      ") +
      `\n    Add them to the file map (${SKILLS_DIR}/polaris-change-impact/references/file-map/) and, for a job, the jobs table.`,
  );
}

// === paths-exist: every concrete repo path in the docs exists ===
// Templated paths (containing < > or *) are skipped — they're illustrative. Lookbehind
// `(?<![\w/.])` prevents matching a path-root keyword in the MIDDLE of a longer path.
const PATH_REF = /(?<![\w/.-])(?:src|public|prisma|scripts|deploy|docs|agent|\.claude\/skills)\/[A-Za-z0-9_./-]+\.(?:ts|js|tsx|jsx|mjs|prisma|sql|sh|ps1|html|css|json|md|go)\b/g;
const deadPaths = new Set();
for (const d of DOCS) {
  const docDir = dirname(d);
  for (const m of docText[d].matchAll(PATH_REF)) {
    const p = m[0];
    if (p.includes("<") || p.includes(">") || p.includes("*")) continue;
    if (exists(p)) continue;
    // a skill file may cite a sibling relatively (references/x.md is caught by orphan-reference; here only rooted paths)
    if (existsSync(join(r(docDir), p))) continue;
    deadPaths.add(`${p}  (referenced in ${d})`);
  }
}
if (deadPaths.size) {
  fail("paths-exist", `${deadPaths.size} doc-referenced path(s) don't exist on disk:\n      ` + [...deadPaths].join("\n      "));
}

// === index-casing / retired-doc ===
// The five-file era ended 2026-09-06: ARCHITECTURE.md, TOUCHES.md, BUSINESS-RULES.md and
// UI-CANON.md were split into .claude/skills/. A reference to one is a dead pointer. The
// docs-sync skill's check-docs reference explains the retirement and is allow-listed.
const RETIRED_ALLOWLIST = new Set([`${SKILLS_DIR}/polaris-docs-sync/references/check-docs-reference.md`, `${SKILLS_DIR}/polaris-docs-sync/references/change-routing.md`]);
for (const d of DOCS) {
  const bad = [...docText[d].matchAll(/\b(touches|primaries)\.md\b/g)].map((m) => m[0]);
  if (bad.length) fail("index-casing", `${d} references the old lowercase name(s): ${[...new Set(bad)].join(", ")}.`);
  const templates = [...docText[d].matchAll(/\bTEMPLATES\.md\b/g)].length;
  if (templates) fail("retired-doc", `${d} has ${templates} reference(s) to the retired TEMPLATES.md. Point UI patterns at polaris-ui-canon and backend patterns at polaris-change-impact -> patterns.`);
  if (RETIRED_ALLOWLIST.has(d)) continue;
  // A provenance statement ("Verbatim from ARCHITECTURE.md", "the retired TOUCHES.md") is not a
  // pointer and is allowed; anything else naming one of the four files is a dead link.
  const PROVENANCE = /\b(?:from|retired|pre-skills|formerly|was)\s+(?:the\s+)?(?:retired\s+)?(?:ARCHITECTURE|TOUCHES|BUSINESS-RULES|UI-CANON)\.md\b/g;
  const retired = [...docText[d].replace(PROVENANCE, "").matchAll(/\b(ARCHITECTURE|TOUCHES|BUSINESS-RULES|UI-CANON)\.md\b/g)].map((m) => m[0]);
  if (retired.length) {
    fail(
      "retired-doc",
      `${d} has ${retired.length} reference(s) to retired root doc(s) (${[...new Set(retired)].join(", ")}). ` +
        `Point at the skill that now holds the content (domain-model / change-impact / business-rules / ui-canon).`,
    );
  }
}

// === touches-service-coverage: every src/services file has a per-service entry ===
// A service with no `## services/<name>.ts` section is invisible to "if I change X, what else
// touches it?". Add an entry under polaris-change-impact/references/services/<group>.md or,
// for a genuinely trivial/standalone module, add it to TOUCHES_EXEMPT with a reason.
// The touches index = the whole change-impact skill plus the three cross-cutting sections that
// moved into the agent and deploy skills (they were part of TOUCHES.md before the split).
const TOUCHES_DOCS = DOCS.filter((d) =>
  d.startsWith(`${SKILLS_DIR}/polaris-change-impact/references/`) ||
  /\/polaris-agent\/references\/cross-cutting-polaris-agent(-build)?\.md$/.test(d) ||
  d === `${SKILLS_DIR}/polaris-deploy/references/cross-cutting-deployment.md`);
const TOUCHES_TEXT = TOUCHES_DOCS.map((d) => docText[d]).join("\n");
const TOUCHES_EXEMPT = new Set([
  // (none today — every service carries an entry)
]);
const serviceBases = tsFiles("src/services").filter((base) => !TOUCHES_EXEMPT.has(base));
const undocServices = serviceBases.filter((base) => !TOUCHES_TEXT.includes(`services/${base}.ts`));
if (undocServices.length) {
  fail(
    "touches-service-coverage",
    `${undocServices.length} service(s) are not mentioned anywhere under ${SKILLS_DIR}/polaris-change-impact/references/services/:\n      ` +
      undocServices.map((s) => `services/${s}.ts`).join("\n      ") +
      `\n    Add a per-service entry (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this).`,
  );
}
// Mentioned but without a section of its own — visible only through another service's entry.
// Warn (the pre-skills check accepted this) so the gap is seen when someone next touches the service.
const headingless = serviceBases.filter((base) => !undocServices.includes(base) && !new RegExp(`^## services/${base}\\.ts\\s*$`, "m").test(TOUCHES_TEXT));
if (headingless.length) {
  console.warn(
    `\n⚠ check-docs (warn): ${headingless.length} service(s) are mentioned in the touches index but have no "## services/<name>.ts" section of their own:\n      ` +
      headingless.map((s) => `services/${s}.ts`).join("\n      ") +
      `\n    Add a per-service entry when you next change one of them.\n`,
  );
}

// === skill-frontmatter ===
for (const s of SKILLS) {
  const p = `${SKILLS_DIR}/${s}/SKILL.md`;
  if (!docText[p]) continue;
  const m = /^---\n([\s\S]*?)\n---\n/.exec(docText[p]);
  if (!m) { fail("skill-frontmatter", `${p} has no YAML frontmatter block.`); continue; }
  const fm = Object.fromEntries(m[1].split("\n").filter((l) => /^[\w-]+:/.test(l)).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (fm.name !== s) fail("skill-frontmatter", `${p}: name "${fm.name}" must equal the directory name "${s}".`);
  if (!fm.description || fm.description.replace(/^"|"$/g, "").length < 40) fail("skill-frontmatter", `${p}: description is missing or too short — it is the only auto-load signal.`);
  for (const k of Object.keys(fm)) if (!KNOWN_FRONTMATTER_KEYS.has(k)) fail("skill-frontmatter", `${p}: unknown frontmatter key "${k}".`);
}

// === reference-size ===
const bigWarn = [];
for (const d of DOCS) {
  if (d === "CLAUDE.md" || d.endsWith("/SKILL.md")) continue;
  const lines = docText[d].split("\n").length;
  const bytes = Buffer.byteLength(docText[d]);
  if (lines > 1500) fail("reference-size", `${d} is ${lines} lines (limit 1500). Split it by heading and link both halves from the SKILL.md.`);
  else if (bytes > 100 * 1024) bigWarn.push(`${d} (${Math.round(bytes / 1024)} KB)`);
}
if (bigWarn.length) console.warn(`\n⚠ check-docs (warn): ${bigWarn.length} reference file(s) over 100 KB — consider splitting by heading:\n      ${bigWarn.join("\n      ")}\n`);

// === orphan-reference: every references/** and scripts/* file is linked from its SKILL.md ===
for (const s of SKILLS) {
  const skillDir = r(`${SKILLS_DIR}/${s}`);
  const skillMd = docText[`${SKILLS_DIR}/${s}/SKILL.md`];
  if (!skillMd) continue;
  const linked = new Set([...skillMd.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1].replace(/^\.\//, "")));
  for (const abs of walk(skillDir)) {
    const relToSkill = relative(skillDir, abs).split(sep).join("/");
    if (relToSkill === "SKILL.md") continue;
    if (!/^(references|scripts)\//.test(relToSkill)) { fail("orphan-reference", `${SKILLS_DIR}/${s}/${relToSkill}: only SKILL.md, references/ and scripts/ belong in a skill directory.`); continue; }
    if (!linked.has(relToSkill)) fail("orphan-reference", `${SKILLS_DIR}/${s}/${relToSkill} is not linked from ${s}/SKILL.md — add it to the routing table or delete it.`);
  }
}

// === claude-md-size ===
if (docText["CLAUDE.md"]) {
  const kb = Buffer.byteLength(docText["CLAUDE.md"]) / 1024;
  if (kb > 25) fail("claude-md-size", `CLAUDE.md is ${kb.toFixed(1)} KB (limit 25 KB). It holds conventions and the skills index only — move reference material into a skill.`);
  else if (kb > 15) console.warn(`\n⚠ check-docs (warn): CLAUDE.md is ${kb.toFixed(1)} KB (target ≤ 15 KB).\n`);
}

// === util-tests (WARN-only): src/utils with exports lacking a unit test ===
const utilTestWarnings = [];
for (const base of tsFiles("src/utils")) {
  const src = read(`src/utils/${base}.ts`);
  if (!/\bexport\s+(async\s+)?(function|const|class)\b/.test(src)) continue;
  if (!exists(`tests/unit/${base}.test.ts`)) utilTestWarnings.push(`src/utils/${base}.ts`);
}
if (utilTestWarnings.length) {
  console.warn(
    `\n⚠ check-docs (warn): ${utilTestWarnings.length} src/utils file(s) with exports lack a tests/unit/<name>.test.ts:\n      ` +
      utilTestWarnings.join("\n      ") +
      `\n    Not a failure — but add coverage when you next touch one.\n`,
  );
}

// === api-plugin-fresh (WARN-only): the polaris-api-conventions plugin vs public/api.html ===
// That plugin is generated from public/api.html and lives in its OWN repo, cloned beside this
// one. Its import script stamps the source file's sha256 into plugin.json, which is the only
// mechanical signal that the published client guide has fallen behind this repo's API page.
// Deliberately a warning that SKIPS when the clone is absent: the plugin is not a build input,
// so CI, a fresh clone and anyone who has not cloned it must not be failed by its absence.
const API_HTML = "public/api.html";
// The clone sits BESIDE the main checkout, but this script also runs from a worktree under
// .claude/worktrees/<slug>, where "../polaris-api-conventions" resolves inside the worktrees
// folder and finds nothing. Walking up instead finds the clone from either place — otherwise
// the check would silently pass in exactly the trees where the work happens.
function findApiPluginManifest() {
  let dir = ROOT;
  for (;;) {
    const candidate = join(dir, "polaris-api-conventions", ".claude-plugin", "plugin.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const apiPluginManifest = findApiPluginManifest();
if (exists(API_HTML) && apiPluginManifest) {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(apiPluginManifest, "utf8")).sourceApiHtmlSha256;
  } catch {
    recorded = undefined; // a hand-edited or half-written manifest is not this check's business
  }
  // The stamp is over the file's RAW bytes, so a checkout whose line endings differ from the
  // one that last ran the generator would mismatch on whitespace alone. Compare all three
  // renderings and treat any match as current — the question is whether the CONTENT moved.
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const rawBytes = readFileSync(r(API_HTML));
  const asLf = Buffer.from(rawBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const asCrlf = Buffer.from(asLf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
  const current = new Set([sha(rawBytes), sha(asLf), sha(asCrlf)]);
  if (!recorded) {
    console.warn(
      `\n⚠ check-docs (warn): polaris-api-conventions/.claude-plugin/plugin.json has no sourceApiHtmlSha256, so nothing can tell whether the` +
        `\n    polaris-api-conventions plugin still matches ${API_HTML}. Re-run its import script to stamp one.\n`,
    );
  } else if (!current.has(recorded)) {
    console.warn(
      `\n⚠ check-docs (warn): the polaris-api-conventions plugin was generated from a different ${API_HTML}` +
        `\n    (plugin ${recorded.slice(0, 12)}… vs this checkout ${sha(rawBytes).slice(0, 12)}…).` +
        `\n    From the folder holding both clones:  node polaris-api-conventions/scripts/import-api-html.mjs polaris/${API_HTML}` +
        `\n    then bump plugin.json version, commit and push IN THAT REPO (it is a separate git repo).\n`,
    );
  }
}

// --- report ---
if (failures.length === 0) {
  console.log(`✓ check-docs: all structural doc checks passed (${DOCS.length} docs scanned).`);
  process.exit(0);
}
console.error(`\n✗ check-docs: ${failures.length} issue(s) found.\n`);
for (const { check, msg } of failures) console.error(`  [${check}] ${msg}\n`);
console.error(
  "These are structural checks (coverage + reference hygiene) — they don't judge prose accuracy.\n" +
    "Fix the docs (see /polaris-docs-sync), or bypass this one commit with:  git commit --no-verify\n",
);
process.exit(1);
