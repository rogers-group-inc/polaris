/**
 * The Connections page (agent-run connectivity checks) is its own page under
 * Application Map, gated connectivityChecks:read. The sidebar entry and the
 * server's typed-URL bounce must name the same key, or a role sees a link to a
 * page it is refused (or is refused a link to a page it may open).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const appJs = readFileSync(path.join(root, "public/js/app.js"), "utf8");
const appTs = readFileSync(path.join(root, "src/app.ts"), "utf8");
const html = readFileSync(path.join(root, "public/connections.html"), "utf8");

describe("Connections page gate", () => {
  it("sits in NAV_ITEMS directly after Application Map, gated connectivityChecks:read", () => {
    const appmap = appJs.indexOf('href: "/appmap.html"');
    const conn = appJs.indexOf('href: "/connections.html"');
    expect(appmap).toBeGreaterThan(-1);
    expect(conn).toBeGreaterThan(appmap);
    const between = appJs.slice(appmap, conn);
    expect(between.match(/href:/g)?.length).toBe(1);
    const entry = appJs.slice(conn, appJs.indexOf("}", conn));
    expect(entry).toMatch(/perm:\s*\["connectivityChecks",\s*"read"\]/);
  });

  it("is gated the same way server-side and requires a session", () => {
    expect(appTs).toMatch(/"\/connections\.html":\s*\{\s*key:\s*"connectivityChecks",\s*level:\s*"read"\s*\}/);
    const protectedIdx = appTs.indexOf("protectedPages");
    expect(protectedIdx).toBeGreaterThan(-1);
    expect(appTs.slice(protectedIdx).includes('"/connections.html"')).toBe(true);
  });

  it("left the Automations page on automationManagement alone", () => {
    expect(appTs).toMatch(/"\/automations\.html":\s*\{\s*key:\s*"automationManagement",\s*level:\s*"read"\s*\}/);
  });

  it("carries the mount point connectivity-checks.js boots on", () => {
    expect(html).toContain('id="conn-page"');
    expect(html).toContain('id="conn-tbody"');
    expect(html).toContain("js/connectivity-checks.js");
  });
});
