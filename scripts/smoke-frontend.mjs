#!/usr/bin/env node
/**
 * scripts/smoke-frontend.mjs — drive a running Polaris dev stack with real
 * Chrome and fail on anything a unit test in happy-dom cannot see: a script
 * that throws on one page, a load-order mistake, a failed request, a theme
 * engine that will not move, a slide-over that will not close.
 *
 * Built 2026-11-06 to verify the shared theme engine (theme-core.js), the
 * slide-over factory (buildSlideover) and the desktop/phone shared modules
 * (asset-shared.js, chart-shared.js) before they reached production.
 *
 * Setup
 * -----
 *   A dev stack with the demo data (DEVELOPMENT.md → "Demo data and
 *   documentation screenshots"): db:seed → seed-review-assets → mock:compare →
 *   mock:notifications → mock:demo. The Dash wallboard checks need dashConfig
 *   enabled (Server Settings → Web Server → Dash Wallboard), or pass --no-dash.
 *
 *        npm install --no-save playwright
 *
 * Usage
 * -----
 *   node scripts/smoke-frontend.mjs --base http://127.0.0.1:3000 \
 *        --dash http://127.0.0.1:3001 --out audit-reports/smoke
 *
 *   --user / --pass   login (default admin / admin)
 *   --no-dash         skip the wallboard section
 *
 * It signs in ONCE and reuses the session for every page and the phone (a
 * login per page trips the login rate limiter). Exit code 1 when any check
 * fails; every check is printed and written to <out>/report.json, with a
 * screenshot per page and per step.
 *
 * What it checks
 * --------------
 *   - every desktop page that loads app.js (found by scanning public/*.html)
 *     loads with no page error, console error or failed request, has the
 *     shared theme engine and a theme, and — where assets.js loads — the two
 *     shared modules before it;
 *   - the desktop theme band cycles, saves the landed theme (never the
 *     transit "afternoon"), keeps it across a reload, survives a resize;
 *   - Compare Assets (built by buildSlideover) opens and closes on Escape; the
 *     asset panel opens on assets.html, and on events.html / ipam.html through
 *     the on-demand panel bundle; the Events Alerts panel closes on Escape;
 *   - the wallboard loads and its corner ribbon cycles themes;
 *   - the phone boots, has the engine and shared modules, an asset sheet and
 *     its tabs render, and the More tab's theme strip cycles.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let chromium, devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed. It is intentionally not a devDependency —\n" +
      "install it just for this run:  npm install --no-save playwright",
  );
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = arg("base", "http://127.0.0.1:3000");
const DASH = arg("dash", "http://127.0.0.1:3001");
const OUT = arg("out", "audit-reports/smoke");
const USER = arg("user", "admin");
const PASS = arg("pass", "admin");
const SKIP_DASH = flag("no-dash");
mkdirSync(OUT, { recursive: true });

// Every page that boots the full desktop shell (app.js) is a page to load.
const PAGES = readdirSync("public")
  .filter((f) => f.endsWith(".html"))
  .filter((f) => /<script src="\/js\/app\.js"><\/script>/.test(readFileSync(join("public", f), "utf8")))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

const report = [];
const log = (area, check, ok, detail = "") => {
  report.push({ area, check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${area} :: ${check}${detail ? "  — " + detail : ""}`);
};

/** Collect page errors, console errors and failed requests (with their URL). */
function watch(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  // A failed fetch also logs a bare "Failed to load resource" console line; the
  // response handler reports it WITH the URL, so the console copy is dropped.
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errs.push("console: " + m.text().slice(0, 300));
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    errs.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
  });
  return errs;
}
const theme = (page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));

const browser = await chromium.launch({ channel: "chrome" });
let failedHard = null;
try {
  // ── Sign in once ──────────────────────────────────────────────────────
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desk.addInitScript((user) => {
    try {
      localStorage.setItem("polaris.welcome.dismissed." + user, "1");
      if (!localStorage.getItem("polaris-theme")) localStorage.setItem("polaris-theme", "noon");
    } catch (e) {}
  }, USER);
  let assetIds = [];
  {
    const p = await desk.newPage();
    await p.goto(BASE + "/login.html");
    await p.fill("#username", USER);
    await p.fill("#password", PASS);
    await Promise.all([p.waitForURL((u) => !/login\.html/.test(String(u)), { timeout: 20000 }), p.click('button[type="submit"]')]);
    log("login", "signed in once", true);
    assetIds = await p.evaluate(async () => {
      const r = await (await fetch("/api/v1/assets?limit=200")).json();
      return (r.assets || []).filter((a) => a.monitored).slice(0, 2).map((a) => a.id);
    });
    log("login", "found two monitored assets to open", assetIds.length === 2, assetIds.join(", "));
    await p.close();
  }
  const [ASSET_A, ASSET_B] = assetIds;

  // ── 1. Every desktop page loads clean ─────────────────────────────────
  for (const name of PAGES) {
    const page = await desk.newPage();
    const errs = watch(page);
    await page.goto(`${BASE}/${name}.html`, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const shape = await page.evaluate(() => ({
      themeCore: typeof window.createThemeEngine === "function",
      theme: document.documentElement.getAttribute("data-theme"),
      assetsJs: typeof window.openViewModal === "function",
      assetShared: !!window.PolarisAssetShared,
      chartShared: !!window.PolarisChartShared,
    }));
    log("page", `${name}.html loads with no errors`, errs.length === 0, errs.slice(0, 4).join(" | "));
    log("page", `${name}.html runs the shared theme engine`, shape.themeCore && !!shape.theme, `theme=${shape.theme}`);
    if (shape.assetsJs) log("page", `${name}.html has both shared modules with assets.js`, shape.assetShared && shape.chartShared);
    await page.screenshot({ path: `${OUT}/page-${name}.png` });
    await page.close();
  }

  // ── 2. Desktop theme band ─────────────────────────────────────────────
  {
    const page = await desk.newPage();
    const errs = watch(page);
    await page.goto(BASE + "/index.html");
    await page.waitForTimeout(2000);
    const seen = [await theme(page)];
    for (let i = 0; i < 4; i++) {
      await page.click("#btn-theme-band");
      await page.waitForTimeout(2600); // longest leg ≈ 1.6 s, plus the afternoon waypoint
      seen.push(await theme(page));
      await page.screenshot({ path: `${OUT}/theme-desktop-${i}.png`, clip: { x: 0, y: 0, width: 320, height: 900 } });
    }
    log("theme", "desktop band cycles through the themes", new Set(seen).size >= 3 && !seen.includes("afternoon"), seen.join(" → "));
    const saved = await page.evaluate(() => localStorage.getItem("polaris-theme"));
    log("theme", "desktop saves the landed theme (never afternoon)", saved === seen[seen.length - 1] && saved !== "afternoon", String(saved));
    await page.reload();
    await page.waitForTimeout(1500);
    log("theme", "desktop keeps the theme across a reload", (await theme(page)) === saved);
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(800);
    log("theme", "desktop band survives a resize with no errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    await page.close();
  }

  // ── 3. Slide-overs ────────────────────────────────────────────────────
  const escapeCloses = async (page, selector, label) => {
    const open = await page.evaluate((s) => !!document.querySelector(s + ".open"), selector);
    log("slideover", `${label} opened`, open);
    if (!open) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    log("slideover", `${label} closes on Escape`, !(await page.evaluate((s) => !!document.querySelector(s + ".open"), selector)));
  };
  {
    const page = await desk.newPage();
    const errs = watch(page);
    await page.goto(BASE + "/assets.html");
    await page.waitForTimeout(2500);
    await page.evaluate(async ([a, b]) => {
      const one = async (id) => (await fetch(`/api/v1/assets/${id}`)).json();
      await window.openComparePanel({ assets: [await one(a), await one(b)], metrics: ["response"], layout: "stacked" });
    }, [ASSET_A, ASSET_B]).catch((e) => errs.push("openComparePanel: " + e.message));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/slideover-compare.png` });
    await escapeCloses(page, "#compare-panel-overlay", "Compare Assets");
    await page.evaluate((a) => window.PolarisPanels.openAsset(a), ASSET_A);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/slideover-asset.png` });
    log("slideover", "asset panel opens on assets.html", await page.evaluate(() => !!document.querySelector(".slideover-overlay.open")));
    log("slideover", "Compare + asset panel with no errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    await page.close();
  }
  for (const host of ["events", "ipam"]) {
    const page = await desk.newPage();
    const errs = watch(page);
    await page.goto(`${BASE}/${host}.html`);
    await page.waitForTimeout(2000);
    await page.evaluate((a) => window.PolarisPanels.openAsset(a), ASSET_A);
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => ({
      openViewModal: typeof window.openViewModal,
      assetShared: !!window.PolarisAssetShared,
      chartShared: !!window.PolarisChartShared,
      open: !!document.querySelector(".slideover-overlay.open"),
    }));
    await page.screenshot({ path: `${OUT}/ondemand-asset-${host}.png` });
    log("ondemand", `${host}.html: asset panel opens via the on-demand bundle`,
      after.open && after.openViewModal === "function" && after.assetShared && after.chartShared, JSON.stringify(after));
    log("ondemand", `${host}.html: no errors loading the bundle`, errs.length === 0, errs.slice(0, 3).join(" | "));
    if (host === "events") {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      await page.click("#btn-alerts").catch(() => {});
      await page.waitForTimeout(1500);
      await escapeCloses(page, "#alerts-overlay", "Events Alerts panel");
    }
    await page.close();
  }

  // ── 4. Dash wallboard ─────────────────────────────────────────────────
  if (!SKIP_DASH) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    const errs = watch(page);
    await page.goto(DASH + "/dash");
    await page.waitForTimeout(3000);
    const seen = [await theme(page)];
    const band = await page.$(".theme-band");
    if (band) {
      for (let i = 0; i < 3; i++) {
        await band.click();
        await page.waitForTimeout(2600);
        seen.push(await theme(page));
      }
    }
    await page.screenshot({ path: `${OUT}/dash.png` });
    log("dash", "wallboard loads with no errors", errs.length === 0, errs.slice(0, 4).join(" | "));
    log("dash", "wallboard ribbon cycles themes", !!band && new Set(seen).size >= 2, seen.join(" → "));
    await ctx.close();
  }

  // ── 5. Phone ──────────────────────────────────────────────────────────
  {
    const ctx = await browser.newContext({ ...devices["Pixel 7"], storageState: await desk.storageState() });
    const page = await ctx.newPage();
    const errs = watch(page);
    await page.goto(BASE + "/mobile.html");
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${OUT}/mobile-home.png` });
    log("mobile", "mobile.html boots with no errors", errs.length === 0, errs.slice(0, 4).join(" | "));
    const shape = await page.evaluate(() => ({
      themeCore: typeof window.createThemeEngine === "function",
      polarisTheme: !!window.PolarisTheme,
      assetShared: !!window.PolarisAssetShared,
      chartShared: !!window.PolarisChartShared,
    }));
    log("mobile", "phone has the theme engine and both shared modules", Object.values(shape).every(Boolean), JSON.stringify(shape));
    const before = errs.length;
    await page.goto(`${BASE}/mobile.html#asset/${ASSET_A}`);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}/mobile-asset.png`, fullPage: true });
    const tabs = await page.$$eval("[data-tab], .tab-btn, .seg-btn, [role=tab]",
      (els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 12));
    let clicked = 0;
    for (const t of tabs) {
      const el = await page.$(`text="${t}"`);
      if (!el) continue;
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);
      clicked++;
    }
    log("mobile", `asset sheet + ${clicked} tab(s) with no errors`, errs.length === before, errs.slice(before, before + 4).join(" | "));
    await page.close();
    // A fresh page: a hash change alone leaves the asset sheet over the strip.
    const more = await ctx.newPage();
    const errsMore = watch(more);
    await more.goto(`${BASE}/mobile.html#more`);
    await more.waitForTimeout(3000);
    const strip = await more.$(".theme-strip");
    const seen = [await theme(more)];
    if (strip) {
      for (let i = 0; i < 3; i++) {
        await strip.click();
        await more.waitForTimeout(2600);
        seen.push(await theme(more));
      }
    }
    await more.screenshot({ path: `${OUT}/mobile-theme.png` });
    log("mobile", "phone theme strip cycles themes", !!strip && new Set(seen).size >= 2, seen.join(" → "));
    log("mobile", "More tab + theme strip with no errors", errsMore.length === 0, errsMore.slice(0, 4).join(" | "));
    await ctx.close();
  }
} catch (err) {
  failedHard = err;
  log("harness", "run completed", false, err && err.message ? err.message.split("\n")[0] : String(err));
} finally {
  await browser.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const failed = report.filter((r) => !r.ok);
console.log(`\n${report.length - failed.length}/${report.length} checks passed — screenshots and report.json in ${OUT}`);
process.exit(failed.length || failedHard ? 1 : 0);
