/**
 * tests/unit/sparklineSvg.test.ts
 *
 * The last-hour charts embedded in alert emails. Pure geometry, so the things
 * worth pinning are the ones that silently produce a misleading picture: a
 * percentage chart that rescales itself per message, a flat line collapsing
 * onto the axis, and an empty window rendering as a blank box the reader
 * mistakes for a blocked image.
 */

import { describe, it, expect } from "vitest";
import { sparklineSvg, seriesStats, formatReading, niceCeil, timeAxisLabel, type SparkPoint } from "../../src/utils/sparklineSvg.js";

const T0 = Date.parse("2026-08-12T10:00:00Z");
const series = (vals: number[]): SparkPoint[] => vals.map((v, i) => ({ t: T0 + i * 60_000, v }));

describe("formatReading", () => {
  it("drops a pointless decimal but keeps a meaningful one", () => {
    expect(formatReading(97)).toBe("97");
    expect(formatReading(97.04)).toBe("97");
    expect(formatReading(97.25, "%")).toBe("97.3%");
    expect(formatReading(12.5, " ms")).toBe("12.5 ms");
  });
});

describe("niceCeil", () => {
  it("rounds an auto-scaled axis top to a readable number", () => {
    // 183ms + 10% headroom = 200.1, which printed as "200.1 ms" on the axis —
    // a decimal that reads as precision the chart doesn't have.
    expect(niceCeil(200.1)).toBe(500);
    expect(niceCeil(183)).toBe(200);
    expect(niceCeil(42)).toBe(50);
    expect(niceCeil(7.3)).toBe(10);
    expect(niceCeil(1)).toBe(1);
  });

  it("leaves nothing to round alone", () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(-5)).toBe(-5);
  });
});

describe("timeAxisLabel", () => {
  it("labels the window the chart was actually given, minutes up to 90 then hours", () => {
    // The left axis label was a hardcoded "-60 min" until the loss chart's
    // window started following the automation's History.
    expect(timeAxisLabel(60 * 60_000)).toBe("60 min");
    expect(timeAxisLabel(15 * 60_000)).toBe("15 min");
    expect(timeAxisLabel(89 * 60_000)).toBe("89 min");
    expect(timeAxisLabel(90 * 60_000)).toBe("1.5 h");
    expect(timeAxisLabel(120 * 60_000)).toBe("2 h");
    // A 24-hour History must not print "-1440 min".
    expect(timeAxisLabel(24 * 60 * 60_000)).toBe("24 h");
  });

  it("rides the rendered SVG's x-axis", () => {
    const hour = sparklineSvg(series([10, 50, 90]), { label: "CPU", unit: "%", from: T0, to: T0 + 60 * 60_000 });
    expect(hour).toContain(">-60 min<");
    const quarter = sparklineSvg(series([10, 50, 90]), { label: "Loss", unit: "%", from: T0, to: T0 + 15 * 60_000 });
    expect(quarter).toContain(">-15 min<");
  });
});

describe("avgOverride", () => {
  it("replaces only the caption's avg, leaving now and peak from the series", () => {
    // The packet-loss chart plots per-bucket RATIOS, whose mean is not the
    // ratio over the window — and the window's ratio is what the automation
    // fired on, so the caption has to quote that instead (prod 2026-08-20:
    // an alert reading "18.3 %" over a chart captioned "avg 6.7 %").
    const svg = sparklineSvg(series([0, 100, 0]), { label: "Packet loss", unit: "%", yMin: 0, yMax: 100, avgOverride: 18.3 });
    expect(svg).toContain("avg 18.3%");
    expect(svg).toContain("now 0%");
    expect(svg).toContain("peak 100%");
    // Without it the mean of the points is printed, as every other chart wants.
    const plain = sparklineSvg(series([0, 100, 0]), { label: "Packet loss", unit: "%", yMin: 0, yMax: 100 });
    expect(plain).toContain("avg 33.3%");
  });

  it("falls back to the series mean when null (no ratio to state)", () => {
    const svg = sparklineSvg(series([10, 20, 30]), { label: "CPU", unit: "%", avgOverride: null });
    expect(svg).toContain("avg 20%");
  });
});

describe("seriesStats", () => {
  it("summarizes what the caption and the text fallback both quote", () => {
    expect(seriesStats(series([10, 30, 20]))).toEqual({ min: 10, max: 30, avg: 20, last: 20, count: 3 });
  });

  it("is null for an empty window, so callers can say so instead of drawing zero", () => {
    expect(seriesStats([])).toBeNull();
  });
});

describe("sparklineSvg", () => {
  it("renders a self-contained SVG with no external references", () => {
    const svg = sparklineSvg(series([10, 50, 90]), { label: "CPU", unit: "%", yMin: 0, yMax: 100 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    // Nothing to fetch: an email client would block it, and resvg has no
    // network access anyway.
    expect(svg).not.toMatch(/href=|url\(|<image/);
    expect(svg).toContain("<polyline");
  });

  it("says so when the window is empty rather than drawing an empty box", () => {
    const svg = sparklineSvg([], { label: "CPU" });
    expect(svg).toContain("no data in this window");
    expect(svg).not.toContain("<polyline");
  });

  it("pins a percentage axis to 0-100 so two messages are comparable", () => {
    // A quiet hour (2-4%) must not be rescaled into a dramatic climb.
    const quiet = sparklineSvg(series([2, 3, 4]), { label: "CPU", yMin: 0, yMax: 100 });
    const busy = sparklineSvg(series([80, 90, 95]), { label: "CPU", yMin: 0, yMax: 100 });
    // Same axis labels in both → same scale.
    expect(quiet).toContain(">100<");
    expect(busy).toContain(">100<");
    // The quiet series sits near the bottom of the plot in absolute coords.
    const quietY = Number(/points="[^"]*?,(\d+\.\d)/.exec(quiet)![1]);
    const busyY = Number(/points="[^"]*?,(\d+\.\d)/.exec(busy)![1]);
    expect(quietY).toBeGreaterThan(busyY);
  });

  it("gives an open-ended metric headroom instead of clipping its peak", () => {
    const svg = sparklineSvg(series([10, 400, 30]), { label: "Response", unit: " ms" });
    // The peak is inside the plot, not on the frame.
    const ys = Array.from(svg.matchAll(/(\d+\.\d),(\d+\.\d)/g)).map((m) => Number(m[2]));
    expect(Math.min(...ys)).toBeGreaterThan(20); // below the title band, not at y=0
  });

  it("keeps a flat line off the axis", () => {
    const svg = sparklineSvg(series([50, 50, 50]), { label: "CPU", unit: "%" });
    expect(svg).toContain("<polyline");
    // A zero span would divide by zero and stack every point at one y.
    expect(svg).not.toContain("NaN");
  });

  it("marks a single sample, which has no line to draw", () => {
    const svg = sparklineSvg(series([42]), { label: "CPU" });
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
  });

  it("draws the automation's threshold as a dashed rule when it's in range", () => {
    const inRange = sparklineSvg(series([10, 90]), { label: "CPU", yMin: 0, yMax: 100, threshold: 80 });
    expect(inRange).toContain("stroke-dasharray");
    // Out of range it is omitted rather than clamped onto the frame, where it
    // would read as a threshold the device is sitting exactly at.
    const outOfRange = sparklineSvg(series([10, 20]), { label: "CPU", yMin: 0, yMax: 100, threshold: 400 });
    expect(outOfRange).not.toContain("stroke-dasharray");
  });

  it("spans the WINDOW on x, not just the samples that exist", () => {
    // One sample at the start of an hour must not stretch across the chart.
    const from = T0;
    const to = T0 + 3_600_000;
    const svg = sparklineSvg([{ t: T0 + 60_000, v: 5 }], { label: "CPU", from, to });
    const cx = Number(/<circle cx="([\d.]+)"/.exec(svg)![1]);
    expect(cx).toBeLessThan(100); // near the left edge of a 520-wide chart
  });

  it("escapes a label rather than letting it break the document", () => {
    const svg = sparklineSvg(series([1]), { label: 'CPU <script>&"' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("quotes now / avg / peak in the caption", () => {
    const svg = sparklineSvg(series([10, 90, 50]), { label: "CPU", unit: "%" });
    expect(svg).toContain("now 50%");
    expect(svg).toContain("avg 50%");
    expect(svg).toContain("peak 90%");
  });
});

describe("failed-poll spans", () => {
  // A flat line through an outage is the misleading picture this exists to
  // prevent: the samples on either side are real, the straight segment between
  // them is an interpolation across the exact minutes nothing answered.
  const fiveMin = series([10, 20, 30, 40, 50]); // T0 .. T0+4min

  // What an outage actually looks like in the data: samples for three minutes,
  // nothing for the next six (the heavy cadence doesn't run while the device is
  // down), then samples again. The failure window sits inside that hole.
  const withHole = [
    { t: T0, v: 10 }, { t: T0 + 60_000, v: 20 }, { t: T0 + 120_000, v: 30 },
    { t: T0 + 480_000, v: 40 }, { t: T0 + 540_000, v: 50 }, { t: T0 + 600_000, v: 60 },
  ];
  const holeSpan = [{ from: T0 + 180_000, to: T0 + 420_000 }];
  const holeWindow = { from: T0, to: T0 + 600_000 };

  it("dives to the baseline in red instead of shading a band", () => {
    // Bands mean "the gap is explained" — that vocabulary belongs to
    // maintenance windows. A missed poll is the opposite, so it gets the dive.
    const svg = sparklineSvg(withHole, { label: "CPU", failSpans: holeSpan, ...holeWindow });
    expect(svg).toContain('#d32f2f');
    expect(svg).not.toContain('fill="#dc2626"');
  });

  it("dives GREY, not red, when the miss was dependency-suppressed", () => {
    // Same dive — nothing was measured either way — with the alarm taken out:
    // the parent was dark, so the device itself is not being accused.
    const svg = sparklineSvg(withHole, {
      label: "CPU",
      failSpans: [{ ...holeSpan[0]!, kind: "dependency" as const }],
      ...holeWindow,
    });
    expect(svg).toContain('#9aa0a6');
    expect(svg).not.toContain('#d32f2f');
    // Still a dive, not a bridge: samples, the grey baseline run, samples.
    expect((svg.match(/<polyline/g) ?? []).length).toBe(3);
  });

  it("splits red from grey when a parent goes dark mid-outage", () => {
    // Two spans back to back: unexplained first, then explained. One stroke
    // colour for the pair would claim the whole stretch had one reason.
    const svg = sparklineSvg(withHole, {
      label: "CPU",
      failSpans: [
        { from: T0 + 180_000, to: T0 + 240_000 },
        { from: T0 + 300_000, to: T0 + 420_000, kind: "dependency" as const },
      ],
      ...holeWindow,
    });
    expect(svg).toContain('#d32f2f');
    expect(svg).toContain('#9aa0a6');
  });

  it("plots the failure at the chart baseline, never at a value", () => {
    const svg = sparklineSvg(withHole, { label: "CPU", failSpans: holeSpan, ...holeWindow });
    // PAD_T (22) + plotH (120 - 22 - 18) = 102.
    const dots = [...svg.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)" r="3" fill="#d32f2f"\/>/g)];
    expect(dots).toHaveLength(2);
    dots.forEach((m) => expect(Number(m[1])).toBeCloseTo(102, 1));
  });

  it("breaks the line across the gap instead of interpolating through it", () => {
    const solid = sparklineSvg(withHole, { label: "CPU", ...holeWindow });
    const dived = sparklineSvg(withHole, { label: "CPU", failSpans: holeSpan, ...holeWindow });
    // Without the outage the hole is bridged by one unbroken line.
    expect((solid.match(/<polyline/g) ?? []).length).toBe(1);
    // With it: samples, the red baseline run, samples again.
    expect((dived.match(/<polyline/g) ?? []).length).toBe(3);
    expect(dived).toContain('stroke="#d32f2f"');
  });

  it("fades each transition between the series color and red", () => {
    // A hard color jump would read as two unrelated lines; the fade keeps the
    // dive legible as one.
    const svg = sparklineSvg(withHole, { label: "CPU", color: "#2563eb", failSpans: holeSpan, ...holeWindow });
    // One gradient in, one back out.
    expect((svg.match(/<linearGradient/g) ?? []).length).toBe(2);
    expect(svg).toContain('stop-color="#2563eb"');
    expect(svg).toContain('stop-color="#d32f2f"');
    expect(svg).toMatch(/stroke="url\(#polaris-fade-\d+\)"/);
  });

  it("rides the dive to the right edge when the device is still down as the email sends", () => {
    const svg = sparklineSvg(fiveMin, {
      label: "CPU",
      failSpans: [{ from: T0 + 300_000, to: T0 + 600_000 }],
      from: T0,
      to: T0 + 600_000,
    });
    // The samples' run, plus a failure run along the baseline out to "now".
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
    expect(svg).toContain('stroke="#d32f2f"');
    // The failure run reaches the right edge of the plot (width 520 - PAD_R 12).
    expect(svg).toMatch(/508\.0,102\.0/);
  });

  it("does not fill the area under a gap", () => {
    // The translucent fill is what makes an outage look like a period of
    // readings; each OK run closes at its own extent instead, and the failure
    // run — which sits ON the baseline — gets no fill at all.
    const svg = sparklineSvg(withHole, { label: "CPU", failSpans: holeSpan, ...holeWindow });
    expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
  });

  it("ignores a window the series has data inside — an agent kept pushing", () => {
    // The probe transport failed but the host's agent is not gated on
    // monitorStatus and kept reporting. Diving a line that HAS data would
    // misreport what we hold — and marking only the window's edges would leave
    // the interior samples in place, zigzagging in and out of the baseline.
    const svg = sparklineSvg(fiveMin, {
      label: "CPU",
      failSpans: [{ from: T0 + 60_000, to: T0 + 180_000 }],
      from: T0,
      to: T0 + 240_000,
    });
    expect(svg).not.toContain("#d32f2f");
    expect((svg.match(/<polyline/g) ?? []).length).toBe(1);
  });

  it("ignores a span outside the charted window", () => {
    const svg = sparklineSvg(fiveMin, {
      label: "CPU",
      failSpans: [{ from: T0 - 7_200_000, to: T0 - 3_600_000 }],
      from: T0,
      to: T0 + 240_000,
    });
    expect(svg).not.toContain('fill="#d32f2f"');
    expect((svg.match(/<polyline/g) ?? []).length).toBe(1);
  });

  it("draws nothing extra when no poll failed", () => {
    const svg = sparklineSvg(fiveMin, { label: "CPU", failSpans: [], from: T0, to: T0 + 240_000 });
    expect(svg).not.toContain('fill="#d32f2f"');
    expect(svg).not.toContain("<linearGradient");
  });

  it("still stays self-contained and NaN-free with gaps", () => {
    const svg = sparklineSvg(withHole, { label: "CPU", failSpans: holeSpan, ...holeWindow });
    expect(svg).not.toContain("NaN");
    // The gradient is an in-document reference, not a fetch — resvg has no
    // network and a mail client would block one.
    expect(svg).not.toMatch(/href=|<image/);
    expect(svg).toMatch(/url\(#polaris-fade-\d+\)/);
  });
});

describe("missed-but-not-down spans", () => {
  const window = { from: T0, to: T0 + 600_000 };
  const answered = [
    { t: T0, v: 10 }, { t: T0 + 60_000, v: 12 },
    { t: T0 + 480_000, v: 40 }, { t: T0 + 540_000, v: 42 },
  ];

  it("dives AMBER while the count is short of the automation's threshold", () => {
    // The probes failed, but Polaris has not called the device down — the same
    // "Missed" the Status pill shows and the same amber cell the Last-30-min
    // strip draws. Red would assert a verdict two polls early.
    const svg = sparklineSvg(answered, {
      label: "Response time",
      failSpans: [{ from: T0 + 120_000, to: T0 + 240_000, kind: "missed" as const }],
      ...window,
    });
    expect(svg).toContain("#ffc107");
    expect(svg).not.toContain("#d32f2f");
  });

  it("turns red at the probe that reaches the count", () => {
    // Two spans back to back: the misses that were only misses, then the ones
    // that are the verdict. One colour for the pair would lose where the
    // device actually became Down.
    const svg = sparklineSvg(answered, {
      label: "Response time",
      failSpans: [
        { from: T0 + 120_000, to: T0 + 180_000, kind: "missed" as const },
        { from: T0 + 240_000, to: T0 + 420_000, kind: "outage" as const },
      ],
      ...window,
    });
    expect(svg).toContain("#ffc107");
    expect(svg).toContain("#d32f2f");
    // And it fades between them rather than jumping, like every other change.
    expect(svg).toContain('stop-color="#ffc107"');
  });

  it("leaves an unlabelled span red, so nothing that never asked for amber gets it", () => {
    const svg = sparklineSvg(answered, {
      label: "CPU",
      failSpans: [{ from: T0 + 120_000, to: T0 + 240_000 }],
      ...window,
    });
    expect(svg).toContain("#d32f2f");
    expect(svg).not.toContain("#ffc107");
  });
});

describe("recovering spans", () => {
  // A device answering again but still short of paying off its missed polls.
  // The device page draws that stretch purple; an email about the same outage
  // has to as well, or the operator learns the recovery twice.
  const window = { from: T0, to: T0 + 600_000 };
  const answered = [
    { t: T0, v: 10 },
    { t: T0 + 300_000, v: 40 },
    { t: T0 + 360_000, v: 42 },
    { t: T0 + 420_000, v: 20 },
    { t: T0 + 480_000, v: 18 },
  ];
  const outage = [{ from: T0 + 60_000, to: T0 + 240_000 }];
  const climb = [{ from: T0 + 300_000, to: T0 + 360_000 }];

  it("paints the climb back out purple, not the series colour", () => {
    const svg = sparklineSvg(answered, {
      label: "Response time", color: "#2e7d32", failSpans: outage, recoverSpans: climb, ...window,
    });
    expect(svg).toContain('stroke="#0288d1"');
  });

  it("returns to the series colour once the bucket is empty", () => {
    // The points after the recovery span are Up again — the purple must not
    // run to the end of the chart.
    const svg = sparklineSvg(answered, {
      label: "Response time", color: "#2e7d32", failSpans: outage, recoverSpans: climb, ...window,
    });
    expect(svg).toContain('stroke="#2e7d32"');
    // Red dive, purple climb, green tail — three strokes, and a fade at each
    // colour change rather than a jump.
    expect((svg.match(/<polyline/g) ?? []).length).toBe(3);
    expect(svg).toContain('stop-color="#0288d1"');
  });

  it("fills the area under a recovering run in its own colour", () => {
    // The fill follows the stroke; green pooling under a purple line would
    // claim two things about the same minutes.
    const svg = sparklineSvg(answered, {
      label: "Response time", color: "#2e7d32", failSpans: outage, recoverSpans: climb, ...window,
    });
    expect(svg).toContain('<polygon fill="#0288d1"');
  });

  it("is inert when no recovery spans are passed", () => {
    // Every other chart is about a reading, not a verdict — purple must not
    // leak into CPU or memory.
    const svg = sparklineSvg(answered, { label: "CPU", color: "#2563eb", failSpans: outage, ...window });
    expect(svg).not.toContain("#0288d1");
  });
});

describe("the retired measuredFrom marker", () => {
  const T0 = Date.parse("2026-08-28T09:00:00Z");
  const hour = 60 * 60_000;
  const points = Array.from({ length: 13 }, (_, i) => ({ t: T0 + i * 5 * 60_000, v: i < 6 ? 100 : 0 }));

  it("draws no measurement rule — caption and line now cover the same window", () => {
    // The loss chart used to plot the whole window but caption the ANCHORED
    // ratio, so a dashed rule had to explain why the outage on the left was
    // outside the "avg 0 %" on the right. The anchor is gone (2026-09-01):
    // both halves cover the window, and an option that no longer exists must
    // not leave a stray rule behind if some caller still passes it.
    const svg = sparklineSvg(points, {
      label: "Packet loss", from: T0, to: T0 + hour,
      ...({ measuredFrom: T0 + 30 * 60_000 } as Record<string, unknown>),
    });
    expect(svg).not.toContain("measured");
    expect(svg).not.toContain("NaN");
  });
});

describe("state spans — a reading coloured by the verdict over it", () => {
  // The packet-loss chart: 100 % while the parent was dark, then the climb back
  // down, then a quiet 0 %. It was one fixed red, so the explained stretch read
  // as an alarm and the 0 % read as Down.
  const B = 120_000;
  const loss = [100, 100, 100, 40, 0, 0].map((v, i) => ({ t: T0 + i * B, v }));
  const opts = {
    label: "Packet loss", unit: "%", color: "#2e7d32", yMin: 0, yMax: 100,
    from: T0, to: T0 + 6 * B, pointSpanMs: B, seriesLegend: "Up",
    stateSpans: [
      { from: T0, to: T0 + 3 * B - 1, kind: "dependency" as const },
      { from: T0 + 3 * B, to: T0 + 4 * B + 30_000, kind: "recovering" as const },
    ],
  };

  it("draws each stretch in its state's colour and the quiet tail in the series colour", () => {
    const svg = sparklineSvg(loss, opts);
    expect(svg).toContain('stroke="#9aa0a6"');
    expect(svg).toContain('stroke="#0288d1"');
    expect(svg).toMatch(/stroke="#2e7d32"|fill="#2e7d32"/);
  });

  it("gives a span opening exactly at a bucket boundary to the later bucket only", () => {
    // [T0+2B, T0+3B) ends where the recovery span opens: it stays grey.
    const svg = sparklineSvg(loss.slice(0, 3), { ...opts, to: T0 + 3 * B });
    expect(svg).not.toContain("#0288d1");
  });

  it("lets the strongest claim win where spans overlap", () => {
    const svg = sparklineSvg(series([50, 50]), {
      label: "Packet loss", color: "#2e7d32", pointSpanMs: 60_000,
      stateSpans: [
        { from: T0, to: T0 + 120_000, kind: "recovering" },
        { from: T0, to: T0 + 120_000, kind: "outage" },
      ],
      downColor: "#123456",
    });
    expect(svg).toContain('stroke="#123456"');
    expect(svg).not.toContain("#0288d1");
  });
});

describe("legend", () => {
  const svgHeight = (svg: string): number => Number(svg.match(/<svg [^>]*height="(\d+)"/)![1]);

  it("names only the colours drawn, under the plot, and grows the canvas for them", () => {
    const B = 120_000;
    const svg = sparklineSvg([100, 0].map((v, i) => ({ t: T0 + i * B, v })), {
      label: "Packet loss", color: "#2e7d32", yMin: 0, yMax: 100, pointSpanMs: B, seriesLegend: "Up",
      stateSpans: [{ from: T0, to: T0 + B - 1, kind: "dependency" }],
    });
    expect(svg).toContain(">Up<");
    expect(svg).toContain(">Parent down<");
    expect(svg).not.toContain(">Recovering<");
    expect(svg).not.toContain(">Down<");
    expect(svgHeight(svg)).toBeGreaterThan(120);
  });

  it("draws no key under a plain single-series chart — the title already names it", () => {
    const svg = sparklineSvg(series([10, 20, 30]), { label: "CPU", color: "#2563eb" });
    expect(svgHeight(svg)).toBe(120);
  });

  it("names the threshold only when it is ruled inside the axis", () => {
    const on = sparklineSvg(series([10, 20]), { label: "CPU", yMin: 0, yMax: 100, threshold: 90 });
    expect(on).toContain(">Threshold<");
    const off = sparklineSvg(series([10, 20]), { label: "CPU", yMin: 0, yMax: 100, threshold: 150 });
    expect(off).not.toContain(">Threshold<");
  });

  it("names a dive that was drawn, and not one the series had data inside", () => {
    const pts = series([10, 20, 30, 40]);
    const drawn = sparklineSvg(pts, {
      label: "Response time", seriesLegend: "Up", from: T0, to: T0 + 10 * 60_000,
      failSpans: [{ from: T0 + 6 * 60_000, to: T0 + 9 * 60_000, kind: "missed" }],
    });
    expect(drawn).toContain(">Missed poll<");
    const skipped = sparklineSvg(pts, {
      label: "Response time", seriesLegend: "Up",
      failSpans: [{ from: T0 + 60_000, to: T0 + 2 * 60_000, kind: "outage" }],
    });
    expect(skipped).not.toContain(">Down<");
  });

  it("keys a dead SD-WAN member's band-only chart with the band's own name", () => {
    const svg = sparklineSvg([], {
      label: "SD-WAN latency", from: T0, to: T0 + 3_600_000, alarmLegend: "Member down",
      alarmSpans: [{ from: T0, to: T0 + 3_600_000 }],
    });
    expect(svg).toContain(">Member down<");
  });

  it("keys per-core lines once each, however many cores there are", () => {
    const svg = sparklineSvg(series([10, 20]), {
      label: "CPU per core", seriesLegend: "All cores",
      backgroundSeries: [
        { points: series([5, 6]), color: "#111111", legend: "Other cores" },
        { points: series([7, 8]), color: "#222222", legend: "Other cores" },
        { points: series([30, 40]), color: "#333333", strong: true, legend: "Busiest core" },
      ],
    });
    expect(svg.match(/>Other cores</g)).toHaveLength(1);
    expect(svg).toContain(">Busiest core<");
    expect(svg).toContain(">All cores<");
  });

  it("wraps a long key onto a second row instead of running off the image", () => {
    const svg = sparklineSvg(series([10, 20]), {
      label: "x", seriesLegend: "Up", yMin: 0, yMax: 100, threshold: 50,
      backgroundSeries: Array.from({ length: 6 }, (_, i) => ({
        points: series([i, i + 1]), color: "#111111", legend: `A rather long series name ${i}`,
      })),
    });
    expect(svgHeight(svg)).toBeGreaterThan(120 + 20);
    for (const m of svg.matchAll(/<text x="([\d.]+)"[^>]*font-size="10" fill="#4b5563">([^<]*)</g)) {
      expect(Number(m[1]) + m[2]!.length * 5.8).toBeLessThanOrEqual(520);
    }
  });
});
