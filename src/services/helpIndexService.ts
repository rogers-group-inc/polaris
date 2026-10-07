/**
 * src/services/helpIndexService.ts — keyword search over the operator wiki.
 *
 * Backs the assistant's `search_help` tool (business rule 95): "how do I…" and
 * "how is X configured" questions are answered from Polaris's own operator
 * documentation in docs/wiki/, never from the model's guesswork.
 *
 * The wiki is ~45 Markdown pages (~0.7 MB). It is read ONCE, lazily, on the
 * first search in this process and split into heading-delimited sections;
 * ranking is a BM25-style keyword score with a boost for terms that appear in
 * the page title or section heading. No embeddings, no extra dependency, and
 * nothing to keep in sync — a docs edit ships with the build.
 *
 * The folder ships on every install path: the RHEL tree is a git checkout, and
 * the Docker image COPYs docs/wiki. When it is missing anyway (a stripped
 * image) the search answers `available: false` and the assistant says help is
 * not available on this install rather than inventing an answer.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Same base URL the account menu's Help entry opens (public/js/app.js WIKI_URL). */
export const WIKI_BASE_URL = "https://github.com/rogers-group-inc/polaris/wiki";

// src/services → ../../docs/wiki, and dist/services → ../../docs/wiki: the
// same relative hop from both the dev tree and the built image.
const DEFAULT_WIKI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "wiki");

export interface HelpSection {
  page: string;     // "Integrations" (file name without .md, hyphens kept)
  title: string;    // the page's H1, or the page name
  heading: string;  // the section heading ("" for the page intro)
  anchor: string;   // GitHub wiki anchor for the heading ("" for the intro)
  text: string;     // the section body, Markdown
}

export interface HelpHit {
  page: string;
  title: string;
  heading: string;
  url: string;
  text: string;
  score: number;
}

export interface HelpSearchResult {
  available: boolean;
  hits: HelpHit[];
}

interface IndexedSection extends HelpSection {
  terms: Map<string, number>;
  headTerms: Set<string>;
  length: number;
}

interface HelpIndex {
  sections: IndexedSection[];
  docFreq: Map<string, number>;
  avgLength: number;
}

// Words too common in this corpus to discriminate between sections.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on",
  "or", "set", "that", "the", "this", "to", "up", "use", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your", "polaris",
]);

// Pages that are navigation chrome, not documentation.
const SKIP_PAGES = new Set(["_Sidebar", "_Footer", "README"]);

/** Lower-case word tokens, stopwords dropped, a light plural fold applied. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    // "integrations" and "integration" should meet; keep "ss"/"us" endings.
    const word = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") && !raw.endsWith("us")
      ? raw.slice(0, -1)
      : raw;
    out.push(word);
  }
  return out;
}

/** GitHub's heading-anchor slug: lower-case, punctuation dropped, spaces → "-". */
export function wikiAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Split one wiki page into sections at its `##` / `###` headings. Text before
 * the first such heading (under the `#` title) is the intro section. Fenced
 * code is kept as body text but its `#` lines are never taken for headings.
 */
export function splitWikiPage(page: string, markdown: string): HelpSection[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let title = page.replace(/-/g, " ");
  const sections: HelpSection[] = [];
  let heading = "";
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = body.join("\n").trim();
    if (text || heading) {
      sections.push({ page, title, heading, anchor: heading ? wikiAnchor(heading) : "", text });
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1 && sections.length === 0 && !heading && body.every((l) => !l.trim())) {
        title = h1[1];
        continue;
      }
      const h = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        heading = h[1];
        body = [];
        continue;
      }
    }
    body.push(line);
  }
  flush();
  return sections;
}

function indexSections(sections: HelpSection[]): HelpIndex {
  const docFreq = new Map<string, number>();
  let totalLength = 0;
  const indexed: IndexedSection[] = sections.map((s) => {
    const tokens = tokenize(`${s.heading}\n${s.text}`);
    const terms = new Map<string, number>();
    for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
    for (const t of terms.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    totalLength += tokens.length;
    return {
      ...s,
      terms,
      headTerms: new Set(tokenize(`${s.title} ${s.heading}`)),
      length: tokens.length,
    };
  });
  return { sections: indexed, docFreq, avgLength: indexed.length ? totalLength / indexed.length : 0 };
}

/** Build an index from already-loaded pages. Exported for tests. */
export function buildHelpIndex(pages: Array<{ page: string; markdown: string }>): HelpIndex {
  const sections: HelpSection[] = [];
  for (const p of pages) {
    if (SKIP_PAGES.has(p.page)) continue;
    sections.push(...splitWikiPage(p.page, p.markdown));
  }
  return indexSections(sections);
}

const K1 = 1.2;
const B = 0.75;
const HEADING_BOOST = 2.5;

/** Rank sections against a free-text query. Exported for tests. */
export function rankHelp(index: HelpIndex, query: string, limit: number): Array<{ section: IndexedSection; score: number }> {
  const qTerms = Array.from(new Set(tokenize(query)));
  if (qTerms.length === 0 || index.sections.length === 0) return [];
  const n = index.sections.length;
  const scored: Array<{ section: IndexedSection; score: number }> = [];
  for (const s of index.sections) {
    let score = 0;
    for (const t of qTerms) {
      const tf = s.terms.get(t) ?? 0;
      const inHead = s.headTerms.has(t);
      if (tf === 0 && !inHead) continue;
      const df = index.docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (s.length / (index.avgLength || 1))));
      score += idf * norm + (inHead ? idf * HEADING_BOOST : 0);
    }
    if (score > 0) scored.push({ section: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

let indexPromise: Promise<HelpIndex | null> | null = null;
let wikiDir = DEFAULT_WIKI_DIR;

async function loadIndex(): Promise<HelpIndex | null> {
  let names: string[];
  try {
    names = (await readdir(wikiDir)).filter((n) => n.endsWith(".md"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const pages = await Promise.all(
    names.map(async (name) => ({
      page: name.slice(0, -3),
      markdown: await readFile(join(wikiDir, name), "utf8"),
    })),
  );
  return buildHelpIndex(pages);
}

/**
 * The wiki page names this install ships ("IPAM", "Integrations", …), so the
 * assistant can refuse a link to a help page that does not exist — a model
 * invents plausible ones. Empty when the docs folder is missing.
 */
export async function wikiPageNames(): Promise<Set<string>> {
  if (!indexPromise) indexPromise = loadIndex();
  const index = await indexPromise;
  return new Set(index ? index.sections.map((s) => s.page) : []);
}

/** Test hook: point the index at another folder and drop the cached one. */
export function _resetHelpIndexForTests(dir?: string): void {
  wikiDir = dir ?? DEFAULT_WIKI_DIR;
  indexPromise = null;
}

/**
 * Search the operator wiki. Returns at most `limit` sections whose combined
 * text stays under `maxChars`, so a small local model's context is not
 * flooded; each hit carries the wiki URL to cite.
 */
export async function searchHelp(
  query: string,
  opts: { limit?: number; maxChars?: number } = {},
): Promise<HelpSearchResult> {
  if (!indexPromise) indexPromise = loadIndex();
  const index = await indexPromise;
  if (!index) return { available: false, hits: [] };
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const maxChars = opts.maxChars ?? 6000;
  const hits: HelpHit[] = [];
  let used = 0;
  for (const { section, score } of rankHelp(index, query, limit)) {
    const remaining = maxChars - used;
    if (remaining < 200) break;
    const text = section.text.length > remaining ? section.text.slice(0, remaining) + "…" : section.text;
    used += text.length;
    hits.push({
      page: section.page,
      title: section.title,
      heading: section.heading,
      url: `${WIKI_BASE_URL}/${section.page}${section.anchor ? `#${section.anchor}` : ""}`,
      text,
      score: Math.round(score * 100) / 100,
    });
  }
  return { available: true, hits };
}
