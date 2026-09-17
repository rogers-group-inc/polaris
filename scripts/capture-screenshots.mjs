#!/usr/bin/env node
/**
 * scripts/capture-screenshots.mjs — drive a local Polaris instance with a real
 * browser and save one PNG per page, per theme, for README.md and docs/wiki/.
 *
 * Screenshots are captured from a DEV STACK SEEDED WITH SYNTHETIC DATA, never
 * from a production install: a real one's hostnames, serials, addresses and —
 * once GAL directory sync has run — employee names would all be published with
 * the image. Every device, address and alert in these shots is invented by the
 * prisma/*.ts seeds.
 *
 * Prerequisites
 * -------------
 *   1. A dev stack with the demo data in place, in this order:
 *        npm run db:seed
 *        node --env-file=.env --import tsx/esm prisma/seed-review-assets.ts
 *        npm run mock:compare
 *        npm run mock:notifications
 *        npm run mock:demo          # presentation pass — see prisma/mock-demo.ts
 *   2. Playwright on the host running this script. It is deliberately NOT a
 *      devDependency — it is a docs-only tool and would otherwise sit in the
 *      lockfile and the dependency-target guard forever:
 *        npm install --no-save playwright
 *      It drives the locally installed Chrome (channel: "chrome") rather than a
 *      downloaded Chromium build, so `playwright install` is not needed.
 *
 * Usage
 * -----
 *   node scripts/capture-screenshots.mjs --base http://127.0.0.1:3000 \
 *        --out docs/img/screenshots --themes noon,nightfall
 *
 * Re-run it after any UI change that the docs show; the filenames are stable,
 * so the images are overwritten in place.
 */

import { mkdir } from "node:fs/promises";

let chromium;
try {
  ({ chromium } = await import("playwright"));
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

const BASE = arg("base", "http://127.0.0.1:3000");
const OUT = arg("out", "docs/img/screenshots");
const USER = arg("user", "admin");
const PASS = arg("pass", "admin");
// The three selectable themes are morning / noon / nightfall (js/theme-init.js).
// The docs ship the neutral light one and the dark one; morning is a warm tint
// that reads as a colour cast in a screenshot rather than a deliberate look.
const THEMES = arg("themes", "noon,nightfall").split(",");

// `settle` is extra quiet time for pages that fetch and then render charts
// after load.
const DESKTOP = [
  { slug: "dashboard",    path: "/index.html",        settle: 4500 },
  { slug: "assets",       path: "/assets.html",       settle: 3500 },
  { slug: "ipam",         path: "/ipam.html",         settle: 3000 },
  { slug: "subnets",      path: "/subnets.html",      settle: 3000 },
  { slug: "blocks",       path: "/blocks.html",       settle: 2500 },
  { slug: "automations",  path: "/automations.html",  settle: 3000 },
  { slug: "events",       path: "/events.html",       settle: 2500 },
];

// Not captured yet, and why:
//   integrations.html  — no seed creates Integration rows, so the page is the
//                        "No integrations configured" empty state.
//   map.html / appmap.html — the demo assets carry no lat/lng, no region
//                        polygons and no topology edges, so both maps render
//                        empty. scripts/seed-topology-mock.ts and
//                        scripts/seed-fortilink-demo.ts are the starting point.
//   server-settings.html — install-specific figures (disk, capacity, versions)
//                        and the place a stray real value is most likely to
//                        appear; needs a review pass of its own.

const MOBILE = [{ slug: "mobile", path: "/mobile.html", settle: 3500 }];

// Two half-width stacks. A widget's height is a fixed number of pixel rows
// (dashboard.js sets article.style.height from ROW_HEIGHT_PX), so a short
// widget keeps its full row height whatever its width — at width 12 the status
// tiles read as a band of empty card, at width 6 they wrap and fill it.
//
// `capacityHealth` is deliberately absent: its content is the running install's
// own disk figures and configuration warnings (container paths, "POLARIS_SECRET_KEY
// is not set, so … secrets are stored as plaintext"), which is exactly what must
// not be published in a screenshot.
const DASH_LAYOUT = [
  { width: 6, widgets: ["statusSummary", "activeAlerts", "topCpu", "diskUsage"] },
  { width: 6, widgets: ["downNodes", "slowestResponse", "topMemory", "blockUtilization"] },
];

// Pre-stamped in localStorage before any page script runs. Both would otherwise
// land in every screenshot:
//   polaris-theme                    — else theme-init.js follows the host OS.
//   polaris.welcome.dismissed.<user> — the first-run "Welcome to Polaris" modal,
//                                      shown to an admin until the instance has
//                                      both an IP block and an integration.
function seedBrowserState({ theme, user }) {
  try {
    localStorage.setItem("polaris-theme", theme);
    localStorage.setItem("polaris.welcome.dismissed." + user, new Date().toISOString());
  } catch (e) {}
}

async function login(page) {
  await page.goto(`${BASE}/login.html`, { waitUntil: "load" });
  await page.fill("#username", USER);
  await page.fill("#password", PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith("/login.html"), { timeout: 30000 }),
    page.click("#login-form button[type=submit]"),
  ]);
}

// Sign in ONCE and hand the session cookie to every later context.
//
// Logging in per context (two per theme — desktop and mobile) trips the login
// rate limiter partway through a multi-theme run, and the failure looks like a
// navigation timeout rather than a 429 because the page simply stays put.
// Only the cookies are carried over: localStorage would drag the previous
// theme along with them.
async function authenticate(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  const { cookies } = await ctx.storageState();
  await ctx.close();
  return { cookies, origins: [] };
}

// Write a populated dashboard for this user, composing each widget's config
// from the registry the page itself loaded. The dashboard page only applies a
// widget's `defaultConfig` when it is added through the library, so a layout
// written without those defaults renders half-empty.
async function composeDashboard(page, spec) {
  await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.PolarisWidgets && window.api, null, { timeout: 30000 });
  const result = await page.evaluate(async (layout) => {
    const uuid = () => window.PolarisWidgets.uuid();
    const missing = [];
    const columns = layout.map((col) => ({
      id: uuid(),
      width: col.width,
      widgets: col.widgets
        .map((type) => {
          const mod = window.PolarisWidgets.getByType(type);
          if (!mod) {
            missing.push(type);
            return null;
          }
          return { id: uuid(), type, height: 1, config: Object.assign({}, mod.defaultConfig || {}) };
        })
        .filter(Boolean),
    }));
    const id = uuid();
    await window.api.me.dashboard.put({
      version: 3,
      dashboards: [{ id, name: "Overview", columns }],
      activeId: id,
    });
    return { missing, widgets: columns.reduce((n, c) => n + c.widgets.length, 0) };
  }, spec);
  if (result.missing.length) console.log(`  ! unknown widget types: ${result.missing.join(", ")}`);
  console.log(`  dashboard written: ${result.widgets} widgets`);
}

async function shoot(page, { slug, path, settle }, label) {
  const errors = [];
  const onErr = (m) => { if (m.type() === "error") errors.push(m.text()); };
  page.on("console", onErr);
  try {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 45000 });
    if (res && res.status() >= 400) console.log(`  ! ${slug}: HTTP ${res.status()}`);
    if (new URL(page.url()).pathname === "/login.html") {
      console.log(`  ! ${slug}: bounced to login — session lost`);
      return false;
    }
    await page.waitForTimeout(settle);
    // Dashboard widgets run a NOC-wall auto-scroll (dashboard.js
    // startAutoScroll): every 80ms it creeps the widget body down 1px, so by
    // capture time the top row is half out of frame. Setting scrollTop alone is
    // futile — the next tick overwrites it. The loop holds while the pointer is
    // over the widget, so synthesize that hover first (the listener is on the
    // widget article), then rewind.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelectorAll(".dashboard-widget").forEach((w) => {
        w.dispatchEvent(new MouseEvent("mouseenter"));
        const body = w.querySelector(".dashboard-widget-body");
        if (body) body.scrollTop = 0;
      });
    });
    await page.waitForTimeout(250); // prove the rewind stuck rather than racing the tick
    const file = `${OUT}/${label}-${slug}.png`;
    await page.screenshot({ path: file });
    console.log(`  ok ${file}${errors.length ? `  (${errors.length} console errors)` : ""}`);
    errors.slice(0, 3).forEach((e) => console.log(`       ${e.slice(0, 160)}`));
    return true;
  } catch (e) {
    console.log(`  ! ${slug}: ${e.message.split("\n")[0]}`);
    return false;
  } finally {
    page.off("console", onErr);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  const session = await authenticate(browser);
  console.log(`signed in as ${USER} at ${BASE} (session reused across themes)`);
  let dashboardWritten = false;

  for (const theme of THEMES) {
    console.log(`\n=== theme: ${theme} ===`);
    const ctx = await browser.newContext({
      viewport: { width: 1680, height: 1050 },
      deviceScaleFactor: 2,
      // Only decides what the OS-follow fallback would pick; the init script
      // pins the theme regardless. Kept in step so any unthemed surface
      // matches the rest of the shot.
      colorScheme: theme === "nightfall" ? "dark" : "light",
      storageState: session,
    });
    await ctx.addInitScript(seedBrowserState, { theme, user: USER });
    const page = await ctx.newPage();

    // The login page still renders for a signed-in caller, so it can be shot
    // without dropping the session.
    await page.goto(`${BASE}/login.html`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/desktop-${theme}-login.png` });
    console.log(`  ok ${OUT}/desktop-${theme}-login.png`);

    if (!dashboardWritten) {
      await composeDashboard(page, DASH_LAYOUT);
      dashboardWritten = true; // stored server-side per user — once is enough
    }

    for (const p of DESKTOP) await shoot(page, p, `desktop-${theme}`);

    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: theme === "nightfall" ? "dark" : "light",
      storageState: session,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    await mctx.addInitScript(seedBrowserState, { theme, user: USER });
    const mpage = await mctx.newPage();
    for (const p of MOBILE) await shoot(mpage, p, `mobile-${theme}`);

    await mctx.close();
    await ctx.close();
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
