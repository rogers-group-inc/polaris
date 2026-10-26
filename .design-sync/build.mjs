#!/usr/bin/env node
/**
 * Assemble ds-bundle/ — the files of the two Polaris design systems published
 * as claude.ai artifacts: Polaris UI (the desktop app) and Polaris Mobile (the
 * phone PWA). See .design-sync/NOTES.md for the publish procedure.
 *
 * The repo is the standard. Each system is built from:
 *   design/<system>/README.md       the system's brand book (hand-written)
 *   design/<system>/tokens.json     token NAMES, usage notes and type styles
 *                                   (hand-written); colour, radius and shadow
 *                                   VALUES are overwritten here from the app CSS
 *   design/<system>/components/     example pages: <Name>/preview.html + README.md
 *   public/css/<sheet>              the stylesheet the app itself serves,
 *                                   published verbatim as components/bundle.css
 *
 * Output: ds-bundle/<system>/project/… at the paths the artifact serves them.
 * Run from the repo root:  node .design-sync/build.mjs
 * Exits 1 when a page uses a class the stylesheet does not define, or a token
 * value cannot be resolved — fix the source, never the output.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const config = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const out = join(repo, config.localDir);

// ── CSS custom-property extraction ────────────────────────────────────────────

/** Top-level rule blocks: [{selector, body}]. Nested at-rules are skipped whole. */
function topLevelBlocks(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  let depth = 0, start = 0, sel = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (depth === 0) { sel = src.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) { blocks.push({ selector: sel, body: src.slice(start, i) }); start = i + 1; }
    } else if (ch === ';' && depth === 0) {
      start = i + 1; // a top-level @import / @charset
    }
  }
  return blocks;
}

/** `--name: value` declarations directly in a block body (not in nested rules). */
function declarations(body) {
  const vars = {};
  let depth = 0, buf = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; buf = ''; continue; }
    if (depth > 0) continue;
    if (ch === ';') {
      const m = buf.match(/^\s*--([A-Za-z0-9_-]+)\s*:\s*([\s\S]+?)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/\s+/g, ' ');
      buf = '';
    } else buf += ch;
  }
  return vars;
}

/** The custom properties in effect for each theme, in cascade order. */
function themeVars(css, themes) {
  const blocks = topLevelBlocks(css);
  const pick = (selectors) => {
    const vars = {};
    for (const b of blocks) {
      const s = b.selector.replace(/\s+/g, '');
      if (selectors.includes(s)) Object.assign(vars, declarations(b.body));
    }
    return vars;
  };
  const out = {};
  for (const [id, chain] of Object.entries(themes)) {
    out[id] = {};
    for (const selectors of chain) Object.assign(out[id], pick(selectors.map((x) => x.replace(/\s+/g, ''))));
  }
  return out;
}

/** Resolve var(--x[, fallback]) chains to a literal, or null when it cannot be. */
function resolve(value, vars, seen = new Set()) {
  let v = value;
  for (let guard = 0; guard < 20 && /var\(/.test(v); guard++) {
    v = v.replace(/var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/, (_, name, fb) => {
      if (seen.has(name)) return 'UNRESOLVED';
      if (name in vars) return resolve(vars[name], vars, new Set([...seen, name])) ?? 'UNRESOLVED';
      return fb !== undefined ? fb.trim() : 'UNRESOLVED';
    });
  }
  if (/UNRESOLVED|var\(|color-mix\(|calc\(/.test(v)) return null;
  return v.trim();
}

// ── Build one system ──────────────────────────────────────────────────────────

const problems = [];
const notes = [];

function buildSystem(name, sys) {
  const srcDir = join(repo, sys.source);
  const dest = join(out, name, 'project');
  mkdirSync(join(dest, 'components'), { recursive: true });

  // 1. The stylesheet the app serves, behind the fonts the app loads.
  const css = readFileSync(join(repo, sys.stylesheet), 'utf8');
  writeFileSync(join(dest, 'components', 'bundle.css'),
    `@import url("${sys.fonts}");\n` +
    `/* ── ${sys.stylesheet} ── published verbatim by .design-sync/build.mjs; edit the app, not this file. */\n` +
    css);

  // 2. Pages and the README, copied.
  cpSync(join(srcDir, 'components'), join(dest, 'components'), { recursive: true });
  cpSync(join(srcDir, 'README.md'), join(dest, 'README.md'));

  // 3. tokens.json: names, usage and type from design/, values from the app CSS.
  const tokens = JSON.parse(readFileSync(join(srcDir, 'tokens.json'), 'utf8'));
  const vars = themeVars(css, sys.themes);
  const themeIds = Object.keys(sys.themes);
  tokens.color.themes = themeIds.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
  const valuesFor = (tokenName) => {
    const value = {};
    for (const id of themeIds) {
      const raw = vars[id][tokenName];
      if (raw === undefined) continue;
      const lit = resolve(raw, vars[id]);
      if (lit === null) problems.push(`${name}: --${tokenName} in ${id} does not resolve to a literal (${raw})`);
      else value[id] = lit.replace(/^#[0-9A-F]+$/, (h) => h.toLowerCase());
    }
    return value;
  };
  const known = new Set(tokens.color.tokens.map((t) => t.name));
  for (const t of tokens.color.tokens) {
    const v = valuesFor(t.name);
    if (Object.keys(v).length === 0) problems.push(`${name}: colour token ${t.name} is not declared in ${sys.stylesheet}`);
    else t.value = v;
  }
  // A colour the app declares that design/ has no note for yet is published
  // anyway, so the system never lags the app; the note is the follow-up.
  const declared = new Set(themeIds.flatMap((id) => Object.keys(vars[id])));
  for (const n of [...declared].sort()) {
    if (known.has(n) || !sys.colorPrefixes.some((p) => n.startsWith(p))) continue;
    const v = valuesFor(n);
    if (Object.keys(v).length === 0) continue;
    tokens.color.tokens.push({ name: n, value: v, usage: 'Declared in the app stylesheet; no usage note in design/ yet.' });
    notes.push(`${name}: added colour ${n} from the app (write its usage note in ${sys.source}/tokens.json)`);
  }
  for (const fam of ['radius', 'shadow']) {
    for (const t of tokens[fam]?.tokens ?? []) {
      const v = valuesFor(t.name);
      if (Object.keys(v).length === 0) { problems.push(`${name}: ${fam} token ${t.name} is not declared in ${sys.stylesheet}`); continue; }
      const distinct = new Set(Object.values(v));
      t.value = distinct.size === 1 ? [...distinct][0] : v;
    }
  }
  writeFileSync(join(dest, 'tokens.json'), JSON.stringify(tokens, null, 2) + '\n');

  // 4. Every class a page uses must exist in the stylesheet, or be defined by
  //    the page's own <style> (its preview-frame helpers).
  const defined = new Set(css.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g)?.map((c) => c.slice(1)) ?? []);
  const allow = new Set(sys.classHooks ?? []);
  for (const comp of readdirSync(join(srcDir, 'components'))) {
    const page = join(srcDir, 'components', comp, 'preview.html');
    if (!existsSync(page)) continue;
    const html = readFileSync(page, 'utf8');
    if (!/^<!-- @dsCard\b/.test(html)) problems.push(`${name}: ${comp}/preview.html must start with an @dsCard comment`);
    const local = new Set((html.match(/<style[\s\S]*?<\/style>/g) ?? []).join('').match(/\.[A-Za-z_][A-Za-z0-9_-]*/g)?.map((c) => c.slice(1)) ?? []);
    for (const attr of html.match(/class="[^"]*"/g) ?? []) {
      for (const c of attr.slice(7, -1).split(/\s+/).filter(Boolean)) {
        if (!defined.has(c) && !local.has(c) && !allow.has(c)) problems.push(`${name}: ${comp}/preview.html uses .${c}, which ${sys.stylesheet} does not define`);
      }
    }
  }
}

// ── The alert email page (desktop), rendered from the template the app sends ──

function buildAlertEmailPage(dest) {
  const json = execFileSync(process.execPath, ['--import', 'tsx/esm', join(here, 'render-email.ts')], { cwd: repo, encoding: 'utf8' });
  const bodies = JSON.parse(json);
  // srcdoc keeps the email's inline styles away from bundle.css (and the page's
  // own body styles away from the email), as a mail client would.
  const frame = (title, html) =>
    `<h3 style="margin:18px 0 8px;font-size:0.9rem;color:var(--color-text-secondary)">${title}</h3>\n` +
    `<iframe title="${title}" style="width:100%;max-width:680px;height:900px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:#fff" srcdoc="${html.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`;
  const page = `<!-- @dsCard group="Email" page -->
<!DOCTYPE html>
<html lang="en" data-theme="nightfall">
<head>
<meta charset="UTF-8">
<title>Alert email</title>
<style>body { padding: 24px; }</style>
</head>
<body>
  <div class="page-header"><h2>Alert email</h2></div>
  <p class="hint" style="max-width:680px">
    Rendered at sync time from the template the app sends (src/utils/alertEmailTemplate.ts),
    composed as a delivered message is. Email is its own surface: a 600px table layout, a fixed
    light palette with no theme, every style inline. Charts are inline images in a real message
    and appear here as labelled placeholders.
  </p>
  ${frame('Critical: an asset down', bodies.critical)}
  ${frame('Warning: an SD-WAN SLA breach', bodies.warning)}
</body>
</html>
`;
  mkdirSync(join(dest, 'components', 'AlertEmail'), { recursive: true });
  writeFileSync(join(dest, 'components', 'AlertEmail', 'preview.html'), page);
}

rmSync(out, { recursive: true, force: true });
for (const [name, sys] of Object.entries(config.systems)) buildSystem(name, sys);
buildAlertEmailPage(join(out, 'desktop', 'project'));

for (const n of notes) console.log('note: ' + n);
if (problems.length) {
  for (const p of problems) console.error('problem: ' + p);
  console.error(`\n${problems.length} problem(s); fix the sources in design/ or the app CSS and rebuild.`);
  process.exit(1);
}
console.log(`Built ${Object.keys(config.systems).join(' + ')} into ${config.localDir}/`);
