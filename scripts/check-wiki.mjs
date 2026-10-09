#!/usr/bin/env node
// Structural guard over the operator wiki source, docs/wiki/. The checks a flat GitHub wiki
// needs and nothing else enforces — every one of them fails silently on the published wiki:
//
//   sidebar        every page (bar Home and the _Sidebar/_Footer chrome) is linked from
//                  _Sidebar.md, or it is unreachable from the nav rail.
//   page-links     links between pages are bare page names — no path, no `.md` — and name a
//                  page that exists (README.md is repo-only, never a target).
//   anchors        a `Page#anchor` / `#anchor` link matches a heading slug on the target page.
//   images         no relative image path: publishing copies *.md only, so it would 404.
//
// Run:  npm run check:wiki    (or: node scripts/check-wiki.mjs)
// Wired into .githooks/pre-commit (docs/wiki/ changes) and the Check docs CI workflow.
// scripts/wiki-publish.mjs runs the same rules over the ref it publishes and refuses on failure.
// It cannot judge whether a page is still TRUE — that is /polaris-docs-sync's wiki row.
//
// Exit 0 = pass (warnings allowed); exit 1 = at least one failure.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { checkWikiPages } from "./wiki-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIKI_DIR = join(ROOT, "docs", "wiki");

if (!existsSync(WIKI_DIR)) {
  console.log("check-wiki: no docs/wiki/ directory — nothing to check.");
  process.exit(0);
}

const pages = new Map();
for (const f of readdirSync(WIKI_DIR)) {
  if (f.endsWith(".md")) pages.set(f.slice(0, -3), readFileSync(join(WIKI_DIR, f), "utf8"));
}

const { failures, warnings } = checkWikiPages(pages);
const where = (x) => `docs/wiki/${x.page}.md${x.line ? ` (line ${x.line})` : ""}`;
for (const w of warnings) console.log(`  warn  ${where(w)}: ${w.msg}`);
if (failures.length === 0) {
  console.log(`check-wiki: ${pages.size} pages OK${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`);
  process.exit(0);
}
for (const f of failures) console.log(`  FAIL  ${where(f)}: ${f.msg}`);
console.log(`\ncheck-wiki: ${failures.length} failure(s). Fix the page(s) in docs/wiki/ — the wiki is published from there.`);
process.exit(1);
