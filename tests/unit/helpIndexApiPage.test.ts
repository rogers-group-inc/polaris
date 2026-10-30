/**
 * tests/unit/helpIndexApiPage.test.ts — the developer page (public/api.html)
 * as a second corpus of the assistant's search_help.
 *
 * What is pinned:
 *   - the real page splits into one section per endpoint, headed with its
 *     method and full path, carrying its permission gate, linked to /api#id;
 *   - an ordinary how-to still lands on the operator wiki, and an API question
 *     on the endpoint (the down-weighting rule, `asksAboutApi`);
 *   - developer-page sections never count as wiki pages, so the answer link
 *     filter cannot be fooled into allowing an invented wiki URL.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  splitApiPage,
  htmlToText,
  asksAboutApi,
  searchHelp,
  wikiPageNames,
  API_PAGE,
  _resetHelpIndexForTests,
} from "../../src/services/helpIndexService.js";
import { sanitizeAnswerLinks } from "../../src/services/assistantChatService.js";

afterEach(() => _resetHelpIndexForTests());

const html = readFileSync(resolve(__dirname, "../../public/api.html"), "utf8");

describe("splitApiPage on the real page", () => {
  const sections = splitApiPage(html);

  it("has one section per endpoint, headed METHOD /api/v1/path, with its gate", () => {
    const create = sections.find((s) => s.heading === "POST /api/v1/automations");
    expect(create).toBeDefined();
    expect(create!.anchor).toBe("automations");
    expect(create!.text).toMatch(/Permission: automationManagement:write/);
    expect(create!.text).toMatch(/trigger/);
    expect(sections.some((s) => s.heading === "PUT /api/v1/server-settings/manufacturer-profiles/:id/metrics/:metricKey")).toBe(true);
    expect(sections.some((s) => s.heading === "POST /api/v1/server-settings/mibs")).toBe(true);
    expect(sections.every((s) => s.page === API_PAGE && s.source === "api")).toBe(true);
  });

  it("keeps each section's intro as its own section", () => {
    expect(sections.some((s) => s.heading === "Automations (API)" && /trigger/.test(s.text))).toBe(true);
  });
});

describe("htmlToText", () => {
  it("keeps code as code, lists as lines, and decodes entities", () => {
    expect(htmlToText("<p>a <code>x &gt; 1</code> &amp; b</p><ul><li>one</li><li>two</li></ul>"))
      .toBe("a `x > 1` & b\n\n- one\n- two");
  });

  it("leaves no markup behind an unclosed tag, in prose or in code", () => {
    expect(htmlToText("a <script alert(1)")).toBe("a script alert(1)");
    expect(htmlToText("<code>x <script</code>")).toBe("`x script`");
    expect(htmlToText("<p>&lt;tag&gt;</p>")).toBe("<tag>");
  });
});

describe("asksAboutApi", () => {
  it.each([
    ["what endpoint creates an automation", true],
    ["how do I call the API to upload a MIB", true],
    ["POST /automations body", true],
    ["curl example for path checks", true],
    ["how do I delete a network", false],
    ["how do I get an alert when a firewall goes down", false],
    ["set up a maintenance window", false],
  ])("%s → %s", (q, want) => {
    expect(asksAboutApi(q)).toBe(want);
  });
});

describe("ranking across the wiki and the developer page", () => {
  it("an API question reaches the endpoint", async () => {
    // The wiki's own API page (a mirror of the same contract) competes too and
    // may rank first; what matters is that the endpoint itself is returned.
    const r = await searchHelp("API endpoint to create an automation");
    const hit = r.hits.find((h) => h.heading === "POST /api/v1/automations");
    expect(hit).toMatchObject({ source: "api", url: "/api#automations" });
  });

  it("an ordinary how-to returns only operator wiki sections", async () => {
    const r = await searchHelp("how do I create an automation that emails me when a firewall goes down");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.source === "wiki")).toBe(true);
  });

  it("developer-page sections are not wiki pages, and their /api links survive the link filter", async () => {
    const pages = await wikiPageNames();
    expect(pages.has(API_PAGE)).toBe(false);
    expect(pages.has("Automations")).toBe(true);
    expect(sanitizeAnswerLinks("see [Create](/api#automations)", pages)).toBe("see [Create](/api#automations)");
  });
});
