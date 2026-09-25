/**
 * The Path Monitor page (agent-run path checks) is its own page under
 * Application Map, gated pathChecks:read. The sidebar entry and the
 * server's typed-URL bounce must name the same key, or a role sees a link to a
 * page it is refused (or is refused a link to a page it may open).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const appJs = readFileSync(path.join(root, "public/js/app.js"), "utf8");
const appTs = readFileSync(path.join(root, "src/app.ts"), "utf8");
const html = readFileSync(path.join(root, "public/path-monitor.html"), "utf8");

describe("Path Monitor page gate", () => {
  it("sits in NAV_ITEMS directly after Application Map, gated pathChecks:read", () => {
    const appmap = appJs.indexOf('href: "/appmap.html"');
    const conn = appJs.indexOf('href: "/path-monitor.html"');
    expect(appmap).toBeGreaterThan(-1);
    expect(conn).toBeGreaterThan(appmap);
    const between = appJs.slice(appmap, conn);
    expect(between.match(/href:/g)?.length).toBe(1);
    const entry = appJs.slice(conn, appJs.indexOf("}", conn));
    expect(entry).toMatch(/perm:\s*\["pathChecks",\s*"read"\]/);
  });

  it("is gated the same way server-side and requires a session", () => {
    expect(appTs).toMatch(/"\/path-monitor\.html":\s*\{\s*key:\s*"pathChecks",\s*level:\s*"read"\s*\}/);
    const protectedIdx = appTs.indexOf("protectedPages");
    expect(protectedIdx).toBeGreaterThan(-1);
    expect(appTs.slice(protectedIdx).includes('"/path-monitor.html"')).toBe(true);
  });

  it("left the Automations page on automationManagement alone", () => {
    expect(appTs).toMatch(/"\/automations\.html":\s*\{\s*key:\s*"automationManagement",\s*level:\s*"read"\s*\}/);
  });

  it("carries the mount point path-checks.js boots on", () => {
    expect(html).toContain('id="path-page"');
    expect(html).toContain('id="path-tbody"');
    expect(html).toContain("js/path-checks.js");
  });
});
