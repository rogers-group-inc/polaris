#!/usr/bin/env node
// One-way publish of docs/wiki/ into the GitHub wiki repo (<repo>.wiki.git). docs/wiki/ is
// the source of truth; the wiki is the rendering. Every trap the hand-run procedure hit is
// handled here instead of remembered:
//
//   - publishes from a git REF (default origin/main, fetched first), read with `git show`,
//     never from the working tree — images are raw `main` URLs, so unpushed pages would go
//     live pointing at screenshots that do not exist yet;
//   - writes LF bytes into a clone with core.autocrlf=false, then re-reads every committed
//     blob and compares — a CRLF leak would otherwise turn every page into a whole-file rewrite;
//   - MIRRORS: a page removed or renamed in docs/wiki/ (or hand-made in the web UI) is
//     deleted from the wiki, not left behind as a stale duplicate;
//   - skips docs/wiki/README.md (repo-only scaffolding);
//   - runs the scripts/check-wiki.mjs rules over the ref first and refuses on a failure;
//   - targets `master` — the wiki's branch, which GitHub never renamed. Pushing `main` would
//     succeed, create a branch nobody reads and leave the wiki stale with no error anywhere;
//   - "nothing changed" is success (exit 0), not a commit failure.
//
// Usage:
//   node scripts/wiki-publish.mjs                     plan only: what would be added / changed / deleted
//   node scripts/wiki-publish.mjs --apply             write + commit in the wiki clone; prints the push command
//   node scripts/wiki-publish.mjs --apply --push      …and push it to master
// Options:
//   --ref <ref>        what to publish (default origin/main; an origin/* ref is fetched first)
//   --no-fetch         skip that fetch
//   --wiki-dir <dir>   reuse an existing clone (must be clean); default: a fresh temp clone
//   --wiki-url <url>   default: this repo's origin with .git → .wiki.git (a fork publishes its own)
//
// The push is outward-facing: the release pipeline (/polaris-deploy) asks the user before
// running --push. The commit carries the `polaris@<sha>` marker the next run reports from.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ONLY_PAGES, checkWikiPages, parsePublishMarker, planPublish, toLf } from "./wiki-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI_BRANCH = "master";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const apply = flag("--apply") || flag("--push");
const push = flag("--push");
const ref = opt("--ref", "origin/main");

const git = (cwd, args, opts = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
const die = (msg) => {
  console.error(`wiki-publish: ${msg}`);
  process.exit(1);
};

// --- source: docs/wiki/*.md at <ref> ---------------------------------------
if (ref.startsWith("origin/") && !flag("--no-fetch")) {
  try {
    git(ROOT, ["fetch", "--quiet", "origin"]);
  } catch (e) {
    die(`git fetch origin failed — publish from a stale ${ref}? Re-run with --no-fetch to accept that.\n${e.stderr ?? e.message}`);
  }
}
let sha;
try {
  sha = git(ROOT, ["rev-parse", "--short=8", `${ref}^{commit}`]).trim();
} catch {
  die(`cannot resolve --ref ${ref}`);
}
const source = new Map();
for (const path of git(ROOT, ["ls-tree", "--name-only", ref, "docs/wiki/"]).split("\n").filter(Boolean)) {
  const file = path.slice("docs/wiki/".length);
  if (file.endsWith(".md")) source.set(file.slice(0, -3), toLf(git(ROOT, ["show", `${ref}:${path}`])));
}
if (source.size === 0) die(`no docs/wiki/*.md at ${ref}`);

const { failures } = checkWikiPages(source);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.page}.md${f.line ? ` (line ${f.line})` : ""}: ${f.msg}`);
  die(`${failures.length} check-wiki failure(s) at ${ref} — fix them in docs/wiki/ before publishing.`);
}
for (const p of REPO_ONLY_PAGES) source.delete(p);

// --- target: the wiki clone at master --------------------------------------
const wikiUrl = opt("--wiki-url", git(ROOT, ["remote", "get-url", "origin"]).trim().replace(/(\.git)?\/?$/, ".wiki.git"));
let wikiDir = opt("--wiki-dir", null);
if (wikiDir) {
  wikiDir = resolve(wikiDir);
  if (!existsSync(join(wikiDir, ".git"))) die(`--wiki-dir ${wikiDir} is not a git clone`);
  if (git(wikiDir, ["status", "--porcelain"]).trim()) die(`--wiki-dir ${wikiDir} has uncommitted changes`);
  git(wikiDir, ["config", "core.autocrlf", "false"]);
  git(wikiDir, ["checkout", "--quiet", WIKI_BRANCH]);
  git(wikiDir, ["pull", "--quiet", "--ff-only", "origin", WIKI_BRANCH]);
} else {
  wikiDir = mkdtempSync(join(tmpdir(), "polaris-wiki-"));
  try {
    git(tmpdir(), ["clone", "--quiet", "-c", "core.autocrlf=false", "--branch", WIKI_BRANCH, wikiUrl, wikiDir]);
  } catch (e) {
    die(
      `clone of ${wikiUrl} failed. A bare "repository not found" usually means the wiki was never ` +
        `initialised — create a page titled Home in the GitHub UI once — not a permissions problem.\n${e.stderr ?? e.message}`,
    );
  }
}

const wiki = new Map();
const otherFiles = [];
for (const f of git(wikiDir, ["ls-tree", "--name-only", "HEAD"]).split("\n").filter(Boolean)) {
  if (f.endsWith(".md")) wiki.set(f.slice(0, -3), git(wikiDir, ["show", `HEAD:${f}`]));
  else otherFiles.push(f);
}

// --- plan -------------------------------------------------------------------
const marker = parsePublishMarker(git(wikiDir, ["log", "-1", "--format=%s"]).trim());
const plan = planPublish(source, wiki);
console.log(`wiki-publish: ${ref} (polaris@${sha}) → ${wikiUrl} ${WIKI_BRANCH}`);
if (marker) {
  let since = "";
  try {
    since = `, ${git(ROOT, ["rev-list", "--count", `${marker}..${ref}`, "--", "docs/wiki"]).trim()} commit(s) to docs/wiki/ since`;
  } catch {
    // the marker commit may not exist locally (a fork, a shallow clone) — the plan below is exact regardless
  }
  console.log(`  last published from polaris@${marker}${since}`);
}
const list = (label, pages) => pages.length && console.log(`  ${label} (${pages.length}): ${pages.join(", ")}`);
list("add", plan.added);
list("update", plan.changed);
list("DELETE", plan.deleted);
console.log(`  unchanged: ${plan.unchanged.length}`);
if (otherFiles.length) console.log(`  left alone (not .md): ${otherFiles.join(", ")}`);

const total = plan.added.length + plan.changed.length + plan.deleted.length;
if (total === 0) {
  console.log("wiki-publish: the wiki is current — nothing to publish.");
  process.exit(0);
}
if (!apply) {
  console.log(`wiki-publish: plan only. Re-run with --apply to commit in a wiki clone, --push to also publish.`);
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
for (const p of [...plan.added, ...plan.changed]) writeFileSync(join(wikiDir, `${p}.md`), Buffer.from(source.get(p), "utf8"));
if (plan.deleted.length) git(wikiDir, ["rm", "--quiet", "--", ...plan.deleted.map((p) => `${p}.md`)]);
git(wikiDir, ["add", "--", ...[...plan.added, ...plan.changed].map((p) => `${p}.md`)]);
const body = [
  plan.added.length ? `Added: ${plan.added.join(", ")}` : "",
  plan.changed.length ? `Updated: ${plan.changed.join(", ")}` : "",
  plan.deleted.length ? `Deleted: ${plan.deleted.join(", ")}` : "",
].filter(Boolean);
git(wikiDir, ["commit", "--quiet", "-m", `wiki: sync from polaris@${sha}`, "-m", body.join("\n")]);

// Verify the committed bytes, not the intent: a CRLF leak passes every step above.
const bad = [...source].filter(([p, text]) => git(wikiDir, ["show", `HEAD:${p}.md`]) !== text).map(([p]) => p);
if (bad.length) die(`committed blobs differ from source for: ${bad.join(", ")} — line endings? Nothing was pushed; inspect ${wikiDir}.`);
const stat = git(wikiDir, ["show", "--stat", "--format=%h %s", "HEAD"]).trim();
console.log(`\n${stat}`);

if (!push) {
  console.log(`\nwiki-publish: committed in ${wikiDir}, NOT pushed. Publish with:\n  git -C "${wikiDir}" push origin HEAD:${WIKI_BRANCH}`);
  process.exit(0);
}
try {
  git(wikiDir, ["push", "--quiet", "origin", `HEAD:${WIKI_BRANCH}`]);
} catch (e) {
  die(`push failed — the commit is still in ${wikiDir}.\n${e.stderr ?? e.message}`);
}
console.log(`wiki-publish: published polaris@${sha} to ${wikiUrl} ${WIKI_BRANCH}.`);
