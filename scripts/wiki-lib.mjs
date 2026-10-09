// Shared logic for the operator wiki tooling — scripts/check-wiki.mjs (the structural guard
// over docs/wiki/) and scripts/wiki-publish.mjs (the one-way copy into <repo>.wiki.git).
// Pure functions over { pageName → markdown } maps, so both scripts — and the unit test —
// run the exact same rules whether the pages come off disk or out of `git show <ref>:…`.
//
// A GitHub wiki is flat, and three of its rules fail silently when broken:
//   - a page not linked from _Sidebar.md is unreachable;
//   - links between pages are bare page names — no path, no `.md`;
//   - a `Page#anchor` link must match a real heading's slug (Business-Rules#rule-N alone
//     is cited ~90 times, so one renamed heading breaks dozens of inbound links).
// Plus one that looks fine until it is live: a relative image path resolves in the repo and
// 404s on the wiki, because publishing copies docs/wiki/*.md and nothing else.

/** Repo-only scaffolding under docs/wiki/ — never published, never a link target. */
export const REPO_ONLY_PAGES = new Set(["README"]);

/** Normalise line endings. `git archive` / a CRLF checkout on Windows otherwise turns every page into a whole-file rewrite. */
export function toLf(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Blank fenced code blocks (keeping line count) so nothing inside one is read as a heading
 * or a link. Inline code spans are dropped too unless `keepInline` — a heading's slug keeps
 * their text (`### \`agent\`` → #agent), a link scan must not see inside them.
 */
function stripCode(markdown, { keepInline = false } = {}) {
  const out = [];
  let fence = null;
  for (const line of toLf(markdown).split("\n")) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push("");
    } else if (m) {
      fence = m[1];
      out.push("");
    } else {
      out.push(keepInline ? line : line.replace(/(`+)(?:(?!\1).)+?\1/g, ""));
    }
  }
  return out.join("\n");
}

/** GitHub's heading slug: rendered text, lowercased, punctuation dropped (hyphens and underscores kept), spaces → hyphens. */
export function githubSlug(headingText) {
  const rendered = headingText
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<[^>]+>/g, "") // inline HTML
    .replace(/`/g, "")
    .replace(/\*+/g, "");
  return rendered
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a page exposes: heading slugs (duplicates suffixed -1, -2 … as GitHub does) plus explicit `id=` / `name=` anchors. */
export function pageAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  const text = stripCode(markdown, { keepInline: true });
  for (const line of text.split("\n")) {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = githubSlug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<a\s[^>]*(?:name|id)="([^"]+)"/gi)) anchors.add(m[1]);
  return anchors;
}

/** Every Markdown link / image on a page, outside code: { target, image, line }. */
export function pageLinks(markdown) {
  const links = [];
  const lines = stripCode(markdown).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ target: m[2], image: m[1] === "!", line: i + 1 });
    }
  });
  return links;
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target);

/**
 * Structural check over a full set of wiki pages.
 * @param {Map<string, string>} pages pageName (file name without .md) → markdown, README included or not
 * @returns {{ failures: {page: string, line?: number, msg: string}[], warnings: {page: string, line?: number, msg: string}[] }}
 */
export function checkWikiPages(pages) {
  const failures = [];
  const warnings = [];
  const published = [...pages.keys()].filter((p) => !REPO_ONLY_PAGES.has(p));
  const byLower = new Map(published.map((p) => [p.toLowerCase(), p]));
  const anchorCache = new Map();
  const anchorsOf = (p) => {
    if (!anchorCache.has(p)) anchorCache.set(p, pageAnchors(pages.get(p)));
    return anchorCache.get(p);
  };

  for (const page of published) {
    for (const { target, image, line } of pageLinks(pages.get(page))) {
      if (isExternal(target)) continue;
      const at = { page, line };
      if (image) {
        failures.push({ ...at, msg: `image "${target}" is a relative path — it 404s on the published wiki; use an absolute raw.githubusercontent.com URL` });
        continue;
      }
      const hash = target.indexOf("#");
      const name = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
      if (name.includes("/") || /\.md$/i.test(name)) {
        failures.push({ ...at, msg: `link "${target}" is a path — wiki links are bare page names, e.g. [Automations](Automations)` });
        continue;
      }
      const dest = name === "" ? page : name;
      if (REPO_ONLY_PAGES.has(dest)) {
        failures.push({ ...at, msg: `link "${target}" points at ${dest}.md, which is repo-only and never published` });
        continue;
      }
      if (!pages.has(dest)) {
        const near = byLower.get(dest.toLowerCase());
        failures.push({ ...at, msg: near ? `link "${target}" — no page "${dest}"; did you mean "${near}"?` : `link "${target}" — no page "${dest}" in docs/wiki/` });
        continue;
      }
      if (anchor !== null && anchor !== "" && !anchorsOf(dest).has(anchor.toLowerCase())) {
        failures.push({ ...at, msg: `link "${target}" — ${dest} has no heading with anchor #${anchor}` });
      }
    }
  }

  const sidebar = pages.get("_Sidebar");
  if (sidebar === undefined) {
    failures.push({ page: "_Sidebar", msg: "_Sidebar.md is missing — every page would be unreachable from the nav rail" });
  } else {
    const linked = new Set(
      pageLinks(sidebar)
        .filter((l) => !l.image && !isExternal(l.target))
        .map((l) => decodeURIComponent(l.target.split("#")[0])),
    );
    for (const page of published) {
      if (page.startsWith("_") || page === "Home") continue;
      if (!linked.has(page)) failures.push({ page, msg: `not linked from _Sidebar.md — the page is unreachable from the nav rail` });
    }
  }

  if (!pages.has("Home")) warnings.push({ page: "Home", msg: "Home.md is missing — the wiki's landing page would be GitHub's placeholder" });
  return { failures, warnings };
}

/**
 * What a one-way publish would change in the wiki repo.
 * @param {Map<string, string>} source pageName → markdown from docs/wiki/ (README excluded by the caller or here)
 * @param {Map<string, string>} wiki pageName → markdown currently on the wiki's master
 * @returns {{ added: string[], changed: string[], deleted: string[], unchanged: string[] }}
 */
export function planPublish(source, wiki) {
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [page, text] of source) {
    if (REPO_ONLY_PAGES.has(page)) continue;
    if (!wiki.has(page)) added.push(page);
    else if (toLf(wiki.get(page)) !== toLf(text)) changed.push(page);
    else unchanged.push(page);
  }
  const deleted = [...wiki.keys()].filter((p) => !source.has(p) || REPO_ONLY_PAGES.has(p));
  const sort = (a) => a.sort((x, y) => x.localeCompare(y));
  return { added: sort(added), changed: sort(changed), deleted: sort(deleted), unchanged: sort(unchanged) };
}

/** The `polaris@<sha>` marker a publish commit carries, or null. */
export function parsePublishMarker(subject) {
  const m = subject.match(/\bpolaris@([0-9a-f]{7,40})\b/);
  return m ? m[1] : null;
}
