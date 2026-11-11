/**
 * tests/unit/quarantineStranded.test.ts — business rule 164, the pure half:
 * the list of FortiGates that still hold a released asset's quarantine block,
 * and when each is due for another try. Plus the Quarantine tab section that
 * shows it (`_quarantineStrandedHTML` in public/js/assets-sources.js).
 */

import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import { assetsFileSource } from "./_assetsSource.js";
import {
  parseStranded,
  mergeStranded,
  withoutStranded,
  withoutStrandedDevices,
  strandedRetryDelayMs,
  strandedRetryDue,
  STRANDED_RETRY_BASE_MS,
  STRANDED_RETRY_MAX_MS,
} from "../../src/utils/quarantineStranded.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const T0 = new Date("2026-11-11T12:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

describe("mergeStranded", () => {
  it("starts a new gate at one attempt, stamped now", () => {
    const out = mergeStranded([], [{ fortigateDevice: "FG-A", integrationId: "i1", error: "timeout" }], T0);
    expect(out).toEqual([{ fortigateDevice: "FG-A", integrationId: "i1", error: "timeout", since: T0.toISOString(), lastAttemptAt: T0.toISOString(), attempts: 1 }]);
  });

  it("keeps a listed gate's `since`, bumps its attempts and takes the newer reason", () => {
    const first = mergeStranded([], [{ fortigateDevice: "FG-A", integrationId: "i1", error: "timeout" }], T0);
    const again = mergeStranded(first, [{ fortigateDevice: "FG-A", integrationId: "i1", error: "refused" }], later(30 * MIN));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ since: T0.toISOString(), lastAttemptAt: later(30 * MIN).toISOString(), attempts: 2, error: "refused" });
  });

  it("treats the same FortiGate through another integration as its own entry", () => {
    const out = mergeStranded([], [
      { fortigateDevice: "FG-A", integrationId: "i1", error: "x" },
      { fortigateDevice: "FG-A", integrationId: "i2", error: "x" },
    ], T0);
    expect(out).toHaveLength(2);
  });

  it("removes nothing, and reads a damaged stored blob as empty", () => {
    const stored = mergeStranded([], [{ fortigateDevice: "FG-A", integrationId: "i1", error: "x" }], T0);
    expect(mergeStranded(stored, [], later(MIN))).toEqual(stored);
    for (const junk of [null, undefined, "nope", 7, {}, [null, 3, { integrationId: "i1" }]]) {
      expect(parseStranded(junk)).toEqual([]);
    }
  });
});

describe("clearing entries", () => {
  const stored = mergeStranded([], [
    { fortigateDevice: "FG-A", integrationId: "i1", error: "x" },
    { fortigateDevice: "FG-B", integrationId: "i1", error: "x" },
    { fortigateDevice: "FG-A", integrationId: "i2", error: "x" },
  ], T0);

  it("withoutStranded removes exactly the gate + integration named", () => {
    const out = withoutStranded(stored, [{ fortigateDevice: "FG-A", integrationId: "i1" }]);
    expect(out.map((e) => `${e.fortigateDevice}/${e.integrationId}`)).toEqual(["FG-B/i1", "FG-A/i2"]);
  });

  it("withoutStrandedDevices removes a FortiGate whatever integration reached it — a re-quarantine pushed there again", () => {
    expect(withoutStrandedDevices(stored, ["FG-A"]).map((e) => e.fortigateDevice)).toEqual(["FG-B"]);
    expect(withoutStrandedDevices(stored, [])).toEqual(stored);
  });
});

describe("the retry backoff", () => {
  it("is 15 minutes after the first failure, doubling, capped at six hours", () => {
    expect(strandedRetryDelayMs(1)).toBe(STRANDED_RETRY_BASE_MS);
    expect(strandedRetryDelayMs(2)).toBe(2 * STRANDED_RETRY_BASE_MS);
    expect(strandedRetryDelayMs(3)).toBe(4 * STRANDED_RETRY_BASE_MS);
    expect(strandedRetryDelayMs(6)).toBe(STRANDED_RETRY_MAX_MS);
    expect(strandedRetryDelayMs(500)).toBe(STRANDED_RETRY_MAX_MS);
    expect(strandedRetryDelayMs(0)).toBe(STRANDED_RETRY_BASE_MS);
  });

  it("an entry is due only once its own delay has passed", () => {
    const [e] = mergeStranded([], [{ fortigateDevice: "FG-A", integrationId: "i1", error: "x" }], T0);
    expect(strandedRetryDue(e, later(14 * MIN))).toBe(false);
    expect(strandedRetryDue(e, later(15 * MIN))).toBe(true);
    const third = { ...e, attempts: 3 };
    expect(strandedRetryDue(third, later(59 * MIN))).toBe(false);
    expect(strandedRetryDue(third, later(60 * MIN))).toBe(true);
    // An unreadable stamp must not park an entry forever.
    expect(strandedRetryDue({ ...e, lastAttemptAt: "garbage" }, T0)).toBe(true);
  });
});

describe("the Quarantine tab's 'Still blocked on' section", () => {
  const FILE = assetsFileSource("assets-sources.js").replace(/\r\n/g, "\n");
  const START = FILE.indexOf("function _quarantineStrandedHTML(a) {");
  const END = FILE.indexOf("function _assetQuarantineTabHTML(a) {");
  if (START < 0 || END < START) throw new Error("_quarantineStrandedHTML moved in assets-sources.js");

  function render(asset: unknown, mayAct = true): Document {
    const win: any = new Window();
    win.eval(`
      function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
        return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
      function formatDate(v){ return "D:" + String(v).slice(0, 10); }
      function canQuarantineAsset(){ return ${mayAct}; }
      ${FILE.slice(START, END)}
      window.render = function(a){ document.body.innerHTML = _quarantineStrandedHTML(a); };
    `);
    win.render(asset);
    return win.document as Document;
  }

  const entry = { fortigateDevice: "FG-BRANCH", integrationId: "i1", error: "connect ETIMEDOUT", since: "2026-11-10T08:00:00Z", lastAttemptAt: "2026-11-11T09:00:00Z", attempts: 4 };

  it("is absent when nothing is stranded — the normal case", () => {
    expect(render({ quarantineStranded: [] }).body.innerHTML).toBe("");
    expect(render({}).body.innerHTML).toBe("");
  });

  it("names the gate, since when, the last try and why, with Retry and Dismiss", () => {
    const doc = render({ status: "active", quarantineStranded: [entry] });
    const text = doc.body.textContent!;
    expect(text).toContain("Still blocked on 1 FortiGate");
    expect(text).toContain("FG-BRANCH");
    expect(text).toContain("D:2026-11-10");
    expect(text).toContain("D:2026-11-11 (4 tries)");
    expect(text).toContain("connect ETIMEDOUT");
    expect(text).toContain("the device is still blocked there");
    expect(doc.querySelectorAll("[data-qtn-stranded-retry]")).toHaveLength(1);
    expect(doc.querySelectorAll("[data-qtn-stranded-dismiss]")).toHaveLength(1);
  });

  it("shows the list but no buttons to someone who may not release quarantines", () => {
    const doc = render({ status: "active", quarantineStranded: [entry] }, false);
    expect(doc.body.textContent).toContain("FG-BRANCH");
    expect(doc.querySelector("[data-qtn-stranded-retry]")).toBeNull();
    expect(doc.querySelector("[data-qtn-stranded-dismiss]")).toBeNull();
  });

  it("escapes the gate's name and the device's error text", () => {
    const doc = render({ quarantineStranded: [{ ...entry, fortigateDevice: "<img src=x>", error: "<b>x</b>" }] });
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("td b")).toBeNull();
  });
});
