import { describe, it, expect } from "vitest";
import { buildManifest, shortNameFor } from "../../src/api/routes/pwa.js";

const DEFAULT = { appName: "Polaris", subtitle: "Network Management Tool" };

describe("shortNameFor", () => {
  it("keeps short names verbatim", () => {
    expect(shortNameFor("Polaris")).toBe("Polaris");
    expect(shortNameFor("Acme NetOps")).toBe("Acme NetOps"); // exactly 11
  });

  it("falls back to the first word, then a hard truncation", () => {
    // Android home-screen labels clip around 12 chars.
    expect(shortNameFor("Acme Corp Network Manager")).toBe("Acme");
    expect(shortNameFor("Supercalifragilistic")).toBe("Supercalifra");
    expect(shortNameFor("Supercalifragilistic Expialidocious")).toBe("Supercalifra");
  });

  it("survives empty/blank input", () => {
    expect(shortNameFor("")).toBe("Polaris");
    expect(shortNameFor("   ")).toBe("Polaris");
  });
});

describe("buildManifest", () => {
  const m = buildManifest(DEFAULT, "abc12345");

  it("pins the install identity and the mobile start_url", () => {
    // id must never change: it keys the install, and changing it forks every
    // existing installation into a second app.
    expect(m.id).toBe("/mobile.html");
    expect(m.start_url).toBe("/mobile.html");
  });

  it("scopes to / so in-app navigations never eject the installed window", () => {
    // A narrow scope would eject on "Desktop view", on /login.html, and on a
    // push click deep-linking to /automations.html.
    expect(m.scope).toBe("/");
  });

  it("declares standalone portrait with matching chrome colors", () => {
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("portrait");
    // Must equal mobile.html's <meta name="theme-color"> or Android's
    // task-switcher chrome flickers.
    expect(m.theme_color).toBe("#1d2244");
    expect(m.background_color).toBe("#141427");
  });

  it("takes name, short_name and description from branding", () => {
    const branded = buildManifest({ appName: "Acme Corp Network Manager", subtitle: "IP + asset management" }, "v1");
    expect(branded.name).toBe("Acme Corp Network Manager");
    expect(String(branded.short_name).length).toBeLessThanOrEqual(12);
    expect(branded.description).toBe("IP + asset management");
  });

  it("ships both any and maskable icons at 192 and 512", () => {
    const icons = m.icons as Array<{ src: string; sizes: string; purpose: string }>;
    expect(icons).toHaveLength(4);
    expect(icons.filter((i) => i.purpose === "any").map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
    expect(icons.filter((i) => i.purpose === "maskable").map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  });

  it("cache-busts every icon URL with the version", () => {
    const icons = m.icons as Array<{ src: string }>;
    for (const i of icons) expect(i.src).toContain("?v=abc12345");
    const shortcuts = m.shortcuts as Array<{ icons: Array<{ src: string }> }>;
    for (const s of shortcuts) expect(s.icons[0].src).toContain("?v=abc12345");
  });

  it("offers in-scope hash shortcuts only", () => {
    const shortcuts = m.shortcuts as Array<{ name: string; url: string }>;
    expect(shortcuts.map((s) => s.url)).toEqual([
      "/mobile.html#assets", "/mobile.html#map", "/mobile.html#reservations",
    ]);
  });

  it("serializes to valid JSON even with hostile branding text", () => {
    // appName is operator-typed and lands in a JSON document the browser parses.
    const nasty = `Acme "</script><script>alert(1)</script>" \\   Ltd`;
    const built = buildManifest({ appName: nasty, subtitle: "x" }, "v1");
    const round = JSON.parse(JSON.stringify(built));
    expect(round.name).toBe(nasty);
  });

  it("escapes a version containing URL-significant characters", () => {
    const built = buildManifest(DEFAULT, "a&b=c");
    const icons = built.icons as Array<{ src: string }>;
    expect(icons[0].src).toContain("?v=a%26b%3Dc");
  });
});
