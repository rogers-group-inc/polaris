/**
 * tests/unit/assetIntermittencyBar.test.ts — the asset System tab's
 * "Last 30 min" sample strip (_intermittencyStates in public/js/assets.js).
 *
 * The strip is the only place an operator sees the monitor state sample by
 * sample, so it has to speak the same vocabulary as the Status pill above it —
 * which means it is a MIRROR of recordProbeResult, and these cases exist to
 * catch the two drifting apart.
 *
 * The rule under test is the leaky bucket of business rule 30: a miss adds one
 * to the missed count, a success takes one back (floored at 0), the LEVEL picks
 * the color, and this probe's outcome only breaks the tie below the threshold.
 * What's pinned:
 *  - a single missed poll never smears — green, amber, green;
 *  - paying back N misses takes N answers, so the recovery run is N cells;
 *  - the level decides, so one answered packet cannot repaint a deep outage —
 *    this is the case a "success wins outright" machine gets wrong;
 *  - a blip during the climb back out re-fills the bucket and can go red again;
 *  - the pre-window state is fully recovered (count 0), or the first cells of
 *    every bar would be colored as if an outage were already in progress;
 *  - and the covering automation's RECOVERY count (business rule 36): when its
 *    reset asks for more answered polls than the drain provides, the cells stay
 *    purple until the run is served — but only for a device that actually went
 *    down, never for one that merely blipped.
 *
 * The replay itself lives in public/js/monitor-states.js — the Last-30-min
 * strip, the desktop response-time chart and the phone's response-time chart
 * all read it, so it is loaded here as the module it is. assets.js is still
 * sliced by name for the STRIP's colour map, which is a property of the strip
 * rather than of the replay.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { replayProbeStates } from "../../src/services/probeOutageService.js";
import { resolve } from "node:path";

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

const statesSrc = readFileSync(resolve(__dirname, "../../public/js/monitor-states.js"), "utf8");

type Sample = { timestamp: string; success: boolean };
type State = {
  timestamp: string;
  status: string;
  missed: number;
  success: boolean;
  confirming: { done: number; need: number } | null;
};

const _intermittencyStates = new Function(
  `const window = {}; ${statesSrc}; return window.PolarisMonitorStates.replay;`,
)() as (samples: Sample[], threshold?: number, recoveryPolls?: number) => State[];

/** "..X.." → samples, where "." is a success and "x"/"X" a failed probe. */
function states(pattern: string, threshold?: number, recoveryPolls?: number): State[] {
  const samples = pattern.split("").map((c, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    success: c === ".",
  }));
  return _intermittencyStates(samples, threshold, recoveryPolls);
}
/** Colors, one letter per sample. p = purple (recovering / paying the debt). */
function run(pattern: string, threshold?: number, recoveryPolls?: number): string {
  return states(pattern, threshold, recoveryPolls)
    .map((s) => ({ up: "g", recovering: "p", warning: "y", down: "r" }[s.status] ?? "?"))
    .join("");
}
/** The missed-poll count after each probe — what the tooltip reports. */
function counts(pattern: string, threshold?: number): number[] {
  return states(pattern, threshold).map((s) => s.missed);
}

describe("_intermittencyStates", () => {
  it("takes as many answers to pay the misses back as it took to accrue them", () => {
    // threshold 3: three misses declare down, and three answers walk 3→2→1→0.
    expect(run("..xxx....", 3)).toBe("ggyyrppgg");
    expect(counts("..xxx....", 3)).toEqual([0, 0, 1, 2, 3, 2, 1, 0, 0]);
  });

  it("never smears a single missed poll", () => {
    expect(run(".x.", 3)).toBe("gyg");
    expect(counts(".x.", 3)).toEqual([0, 1, 0]);
  });

  it("re-fills the bucket on a blip during the climb out, so it can go red again", () => {
    // 1,2,3 → down; one answer pays it to 2; the blip puts it straight back to
    // 3 and it is down again. The run-length machine painted that cell amber,
    // which said "a poll was missed" when the truth was "still fully down".
    expect(run("xxx.x..", 3)).toBe("yyrprpp");
    expect(counts("xxx.x..", 3)).toEqual([1, 2, 3, 2, 3, 2, 1]);
  });

  it("LOCKS the bucket at the cap, so the debt does not track the outage's length", () => {
    // Five misses against a threshold of 3 is a debt of 3, not 5: the third
    // miss declares the outage and every miss after it holds at the cap. That
    // is what bounds recovery by the operator's number instead of by how long
    // the device happened to be dark — unbounded, an overnight outage owed one
    // answered poll per minute it had been down.
    expect(counts("xxxxx.", 3)).toEqual([1, 2, 3, 3, 3, 2]);
    // And the first ANSWER is blue, not red: the level still decides what a
    // MISS means, but a probe that answered is the device climbing back. It
    // used to read `down` here, which the chart had no colour for on an `ok`
    // point and drew in the plain series GREEN — the red→green→blue→green
    // artefact this pair of changes closed.
    expect(run("xxxxx.", 3)).toBe("yyrrrp");
    expect(run("xxxxx.....", 3)).toBe("yyrrrppggg");
  });

  it("goes straight to green at threshold 1 (no recovery window to show)", () => {
    expect(run("x.", 1)).toBe("rg");
  });

  it("assumes the pre-window state is recovered, so a clean stream is all green", () => {
    expect(run("......", 3)).toBe("gggggg");
    expect(counts("......", 3)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("never floors the count below zero on a long clean run", () => {
    expect(counts(".x....", 3)).toEqual([0, 1, 0, 0, 0, 0]);
  });

  it("falls back to threshold 3 when the resolved setting is unusable", () => {
    expect(run("..xxx...", undefined)).toBe("ggyyrppg");
    expect(run("..xxx...", 0)).toBe("ggyyrppg");
    expect(run("..xxx...", Number.NaN)).toBe("ggyyrppg");
  });

  it("runs the bucket for a passive asset but never paints it red", () => {
    // threshold null = no down-detection automation covers the device, so no
    // verdict may be rendered — but the count is still the tooltip's subject.
    expect(run("xxxxx.", null as unknown as number)).toBe("yyyyyp");
    // No threshold means no lock either — a passive device's bucket climbs
    // freely (bounded only by MAX_BUCKET) because there is no outage to declare.
    expect(counts("xxxxx.", null as unknown as number)).toEqual([1, 2, 3, 4, 5, 4]);
  });

  it("returns one state per sample, carrying the timestamp and count through", () => {
    const samples: Sample[] = [
      { timestamp: "2026-08-25T00:00:00.000Z", success: true },
      { timestamp: "2026-08-25T00:01:00.000Z", success: false },
    ];
    expect(_intermittencyStates(samples, 3)).toEqual([
      { timestamp: "2026-08-25T00:00:00.000Z", status: "up", missed: 0, success: true, confirming: null },
      { timestamp: "2026-08-25T00:01:00.000Z", status: "warning", missed: 1, success: false, confirming: null },
    ]);
  });

  it("tolerates an empty or absent sample list", () => {
    expect(_intermittencyStates([], 3)).toEqual([]);
    expect(_intermittencyStates(undefined as unknown as Sample[], 3)).toEqual([]);
  });

  // ── The covering automation's recovery count (business rule 36) ──────────
  //
  // "Down after 3 missed, reset after 5 received" is the shape that forced
  // this: the bar went green on the third answer while the alert was still
  // firing, which is Polaris disagreeing with itself in the one place an
  // operator follows a device probe by probe.

  it("holds purple until the automation's recovery count is served", () => {
    // 3 misses = down. The drain alone would go green on answer 3; a reset
    // asking for 5 keeps the last two cells purple.
    expect(run("xxx.....", 3, 5)).toBe("yyrppppg");
  });

  it("counts the drain toward the recovery run rather than restarting it", () => {
    // The 5 answers include the 3 that paid the debt — an operator who wrote
    // "5 received" means five probes, not three plus five.
    const s = states("xxx.....", 3, 5);
    expect(s.filter((c) => c.success).findIndex((c) => c.status === "up")).toBe(4);
  });

  it("reports the climb's progress in the tooltip's subject", () => {
    // The cap IS the run now, so every recovering cell can state how far
    // through it is — `cap - cf` served of `cap`. There is no longer a separate
    // confirmation phase at cf 0 to distinguish from the drain.
    const s = states("xxx.....", 3, 5);
    expect(s[3].confirming).toEqual({ done: 1, need: 5 });
    expect(s[4].confirming).toEqual({ done: 2, need: 5 });
    expect(s[6].confirming).toEqual({ done: 4, need: 5 });
    // A missed probe is about the debt, not the climb.
    expect(s[2].confirming).toBeNull();
    // And once the run is served it is an ordinary green.
    expect(s[7].confirming).toBeNull();
  });

  it("leaves a blip alone — only a device that went DOWN owes the run", () => {
    // Two misses against a threshold of 3 never reached down, so the second
    // answer is green exactly as it was before the recovery count existed.
    expect(run("xx..", 3, 5)).toBe("yypg");
  });

  it("is a no-op when the reset asks for no more than the drain", () => {
    expect(run("xxx.....", 3, 3)).toBe(run("xxx.....", 3));
    expect(run("xxx.....", 3, 0)).toBe(run("xxx.....", 3));
    expect(run("xxx.....", 3, 2)).toBe(run("xxx.....", 3));
  });

  it("costs the same climb however long the outage ran", () => {
    // 7 misses used to cost 7 answers; the cap makes it 5, which is what the
    // operator asked for. Compare with the same outage under no reset hold,
    // where the cap is the threshold and the climb is 3 — the two now DIFFER,
    // where before the drain swamped the reset on any outage past 5 misses.
    expect(run("xxxxxxx........", 3, 5)).toBe("yyrrrrrppppgggg");
    expect(run("xxxxxxx........", 3)).toBe("yyrrrrrppgggggg");
  });

  it("re-arms after a fresh outage, not once per window", () => {
    expect(run("xxx.....xxx.....", 3, 5)).toBe("yyrppppgyyrppppg");
  });

  it("never paints a healthy window blue", () => {
    // At cf 0 there is nothing to climb out of, so a device that has been up
    // for hours stays green however long its success run. The old machine
    // needed a stored "was down" bit to tell that apart from a drained bucket;
    // the cap removes the ambiguity, because the debt itself carries it.
    expect(run("..........", 3, 5)).toBe("gggggggggg");
  });

  it("the renderer's color map covers every state the replay can emit", () => {
    const src = assetsLines.join("\n");
    const map = /var colors = \{([\s\S]*?)\};/.exec(src)![1];
    for (const state of ["up", "recovering", "warning", "down"]) {
      expect(map).toContain(`${state}:`);
    }
    // Recovering is BLUE on this strip — "answered, misses still outstanding" —
    // and must be the SAME value the response-time chart directly below it uses
    // for the same state, which is the entire reason the two are stacked.
    expect(map).toMatch(/recovering:\s*"rgba\(2,136,209,/);
    const chartBlue = /var _CHART_RECOVER_COLOR = "(#[0-9a-f]{6})";/.exec(src)![1];
    expect(chartBlue).toBe("#0288d1");
    // Never the muted lavender #9575cd (149,117,205), which means MAINTENANCE
    // elsewhere in the product — the trap the old purple sat one shade from.
    expect(map).not.toContain("149,117,205");
  });

  it("greys a miss the upstream explains, and only a miss", () => {
    const src = assetsLines.join("\n");
    const map = /var colors = \{([\s\S]*?)\};/.exec(src)![1];
    // The dependency grey is an OVERLAY on the replay, not a sixth state: the
    // bucket does not know about suppression (business rule 38 — the probe
    // keeps running while suppressed, so the misses are real misses) and the
    // colour is layered on afterwards, the same way the response-time chart
    // stacked directly below does it in _chartPointColor.
    expect(map).toMatch(/dep:\s*_hexWithAlpha\(_CHART_DEP_COLOR,/);
    // One grey across the strip, that chart, and the alert email's chart.
    expect(/var _CHART_DEP_COLOR = "(#[0-9a-f]{6})";/.exec(src)![1]).toBe("#9aa0a6");
    // Grey OUTRANKS the amber/down split — a miss nobody is counting against
    // this device says nothing by sitting near the threshold.
    expect(src).toContain("var color = st.dep ? colors.dep : (colors[st.status] || colors.unknown);");
    // …and an ANSWERED probe under a dark parent keeps its green or blue: it is
    // the one cell that proves the device is still there.
    expect(src).toMatch(/st\.dep\s*=\s*!st\.success\s*&&/);
  });
});

describe("the strip, the response-time chart and the alert email replay ONE machine", () => {
  // Three surfaces draw these states: the Last-30-min strip and the
  // response-time chart from _intermittencyStates in the browser, the alert
  // email's chart from replayProbeStates on the server. The browser copy exists
  // because it runs on a history payload; the server copy because it runs on
  // stored samples in the delivery path. Neither can be deleted, so this pins
  // them together — an operator must not read one story on the device page and
  // a different one in the email about the same outage.
  const server = (pattern: string, threshold: number | null, recoveryPolls = 0): string =>
    replayProbeStates(
      pattern.split("").map((c, i) => ({ timestamp: new Date(1_700_000_000_000 + i * 60_000), failed: c !== "." })),
      threshold,
      recoveryPolls,
    )
      .map((st) => ({ up: "g", recovering: "p", warning: "y", down: "r" })[st])
      .join("");

  const CASES: Array<[string, number | null, number]> = [
    ["..xxx....",   3, 0],   // the plain drain
    [".x.",         3, 0],   // a single miss never smears
    ["xxx.x..",     3, 0],   // a blip on the climb re-fills the bucket
    ["..xxx......", 3, 5],   // the reset asks for more answers than the drain
    ["xxxxxxxxxx.......", 3, 5],  // a deep outage still costs only the cap
    ["xxxxxxxxxx.......", 3, 0],  // and only the threshold with no reset hold
    ["..xx....",    3, 5],   // a blip that never went down earns no hold
    ["xxxxxxx",     3, 0],   // still down at the right edge
    ["..xxxx...",   1, 0],   // down on the first miss
    ["..xxxx...", null, 0],  // passive: never a verdict
  ];

  it.each(CASES)("agrees on %s (threshold %s, recovery %s)", (pattern, threshold, recoveryPolls) => {
    // `null` is passive on BOTH sides — the browser copy takes it too, so it is
    // passed through rather than collapsed to the default.
    expect(server(pattern, threshold, recoveryPolls)).toBe(
      run(pattern, threshold as unknown as number, recoveryPolls),
    );
  });
});
