/**
 * src/utils/sparklineSvg.ts — the small time-series charts embedded in alert
 * emails (last-hour CPU, memory, response time).
 *
 * Pure: points in, SVG string out. The caller rasterizes with @resvg/resvg-js
 * (already a dependency, used by appIconService) and attaches the PNG inline,
 * because an SVG in an email body is not renderable anywhere that matters —
 * Gmail strips it, Outlook's Word engine never supported it.
 *
 * Everything is drawn with explicit geometry and no text measurement: resvg
 * ships no system fonts in this context, so labels are drawn at fixed
 * positions in a generic family and kept short enough that clipping is
 * impossible rather than merely unlikely.
 */

export interface SparkPoint {
  /** Epoch ms. */
  t: number;
  /** The reading. Nulls are omitted by the caller, not passed as gaps. */
  v: number;
}

export interface SparklineOptions {
  /** Chart title, drawn top-left (e.g. "CPU"). */
  label: string;
  /** Appended to every rendered number (e.g. "%", " ms"). */
  unit?: string;
  /** Line + fill colour. */
  color?: string;
  width?: number;
  height?: number;
  /**
   * Force the y-axis top. CPU/memory pass 100 so a quiet hour doesn't render
   * a 3% blip as a dramatic climb — the shape of a percentage chart has to be
   * comparable between messages. Response time leaves it off (no natural max).
   */
  yMax?: number;
  /** Force the y-axis floor. Percentages pass 0 for the same reason. */
  yMin?: number;
  /** Drawn as a dashed horizontal rule — the automation's threshold. */
  threshold?: number | null;
  /** Window start/end in epoch ms, so the x-axis is the WINDOW, not the data. */
  from?: number;
  to?: number;
  /**
   * Replace the caption's "avg" with a pre-computed one.
   *
   * For the packet-loss chart the plotted points are per-bucket RATIOS, and the
   * mean of ratios is not the ratio over the window: a short burst of total
   * loss among many quiet buckets averages far below the fraction of probes
   * that actually failed — and that fraction is what the automation compared to
   * its threshold, so an alert would state one number over a chart captioned
   * another (prod 2026-08-20: "18.3 %" over "avg 6.7 %"). Charts whose points
   * are already the quantity itself (CPU, memory, latency) leave this unset.
   */
  avgOverride?: number | null;
  /**
   * Spans (epoch ms) to shade red behind the plot — where a hardware sensor's
   * own alarm bit was set. An alarm-triggered alert charts the sensor's VALUE,
   * and this is what ties the two together: it shows whether the device raised
   * its alarm because the reading moved, or while the reading sat still (a
   * failed fan reads 0 RPM either way, but a PSU can alarm at a value that
   * never changes).
   */
  alarmSpans?: Array<{ from: number; to: number }>;
  /**
   * The centred note on a chart with NO points but with `alarmSpans` — the
   * bands still draw (see sparklineSvg). Defaults to "no readings in this
   * window".
   */
  emptyNote?: string;
  /**
   * Spans (epoch ms) where the device's polls FAILED. Rendered as the DIVE:
   * the line drops to the chart baseline in red across the span and climbs
   * back out, each transition fading between the series color and red, with a
   * red dot on every failure point. This is the one missed-poll treatment —
   * UI-GUIDE section 15 — shared with the in-app and phone charts, so an
   * outage looks the same in an alert email as it does on the device page.
   *
   * Deliberately NOT a red band. Bands mean "the gap is explained" (the in-app
   * charts shade maintenance windows purple), and a missed poll is the
   * opposite: the thing the operator is looking for. `alarmSpans` keeps its
   * band because a sensor's own alarm bit is a different claim about a reading
   * that is still arriving.
   *
   * A span still open at the last point rides to the right edge, because a
   * device that is down as the email sends is down up to "now".
   *
   * `kind` picks the colour, not the shape: "outage" dives in the covering
   * automation's severity colour — RED unless `downColor` says otherwise, and
   * red is simply what `critical` looks like — because nobody knows why the
   * device stopped answering; "dependency" dives GREY (it was
   * dependency-suppressed — its parent was dark, so the miss is accounted for
   * and the device itself is not being accused of anything), "missed" dives
   * AMBER (the probes failed, but the count has not reached the covering
   * automation's threshold, so Polaris has not called the device down —
   * business rule 36). All three still dive, because in none of them was
   * anything measured. Omitted = "outage", which keeps every existing caller's
   * behaviour.
   */
  failSpans?: Array<{ from: number; to: number; kind?: "outage" | "dependency" | "missed" }>;
  /**
   * Spans (epoch ms) during which the device was ANSWERING but had not yet paid
   * off its missed polls — the climb back out of an outage (business rule 30's
   * leaky bucket). A plotted point inside one takes the recovering purple
   * instead of the series colour, and the transitions in and out of it fade
   * like every other colour change here.
   *
   * This is what completes the response-time chart's four-colour vocabulary in
   * an email: green up, purple paying it back, red down, grey explained — the
   * same four the Status pill, the Last-30-min strip and the device page's own
   * response-time chart speak. An operator must not have to learn a recovery
   * twice any more than they have to learn an outage twice.
   *
   * Response time is the one caller. Every other chart is about a READING
   * rather than a verdict, so recolouring those would make purple mean two
   * things — the same reason the in-app charts leave CPU and memory alone.
   */
  recoverSpans?: Array<{ from: number; to: number }>;
  /**
   * The colour an "outage" span is drawn in — the covering down automation's
   * SEVERITY colour (business rule 36), resolved by the caller through
   * `downSeverityCss` in utils/severityStyle.ts.
   *
   * Down is not inherently red: red is what `critical` looks like, and critical
   * is merely the default severity of a seeded down automation. An operator who
   * rated an outage on this device class `warning` has said something about how
   * it should read, and the email must not override that when the device page
   * honours it.
   *
   * Only the "outage" kind moves. "missed" keeps the amber (it is not a verdict
   * yet, so there is no severity to express) and "dependency" keeps the grey
   * (that miss is not being counted against this device at all). Omitted ⇒
   * FAIL_COLOR, which is both the critical colour and the right answer for a
   * chart drawn without a resolved automation.
   */
  downColor?: string;
  /**
   * A PROJECTION drawn after the history, dashed in the series colour — the
   * storage forecast's trend line carried forward to the automation's horizon.
   * Its points may run past `now`; the axis range folds them in, the caption's
   * numbers do not (they describe what was measured). The last point is marked,
   * red when it reaches `ceiling` — that dot IS the projected full date.
   */
  projection?: SparkPoint[];
  /**
   * Where "now" sits on the x-axis, when the window runs past it (a
   * projection). The axis then reads "-30 d … now … +7 d" with a faint marker
   * at now, instead of the usual "-60 min … now" at the right edge. Omitted, or
   * not before `to`, keeps the usual labels.
   */
  now?: number;
  /**
   * A hard limit drawn as a solid grey rule labelled "full" — a filesystem's
   * capacity (100% on a percent axis). Unlike `threshold` it is not anybody's
   * choice, so it is drawn differently from the automation's dashed red line.
   */
  ceiling?: number | null;
  /** Replace the "now · avg · peak" caption with this text. A projection chart
   *  states its growth and fill date instead, which is what the alert is about. */
  caption?: string;
}

/** The missed-poll red. Shared with the in-app charts' _CHART_FAIL_COLOR so
 *  one outage is one color across email, desktop and phone. Distinct from the
 *  #dc2626 used for alarm bands and the threshold line, which are different
 *  claims. */
const FAIL_COLOR = "#d32f2f";

/** The missed-poll amber — the probes are failing but the count is still short
 *  of the covering automation's threshold, so the device is not Down yet. Same
 *  meaning as the Last-30-min strip's amber cell and the "Missed" Status pill,
 *  and the SAME value — one yellow across the product, the way there is one red
 *  and one grey. It is the lightest of the five against a white card, which is
 *  the price of not having two ambers a shade apart mean two different things;
 *  the 2px stroke and the 3px dot carry it. */
const MISS_COLOR = "#ffc107";

/** The recovering blue — a poll that ANSWERED while missed polls were still
 *  outstanding. Same meaning and same value as the blue cell on the Last-30-min
 *  strip and the in-app charts' _CHART_RECOVER_COLOR: the device is answering,
 *  it just has not paid the debt off yet. The deeper light-blue 700 rather than
 *  the pale tint the Recovering pill uses, because this has to hold up as a 2px
 *  line on a WHITE card. Purple until 2026-08-29 — see _CHART_RECOVER_COLOR in
 *  public/js/assets.js for why the series going green freed the blue. */
const RECOVER_COLOR = "#0288d1";

/** The dependency-down grey. Same dive, drained of alarm: the upstream is what
 *  broke, and this device is only reporting that it sits behind it. Shared with
 *  the in-app charts' _CHART_DEP_COLOR. */
const DEP_COLOR = "#9aa0a6";

const W = 520;
const H = 120;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 22;
const PAD_B = 18;

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Round up to the next 1 / 2 / 5 × 10ⁿ, so an auto-scaled axis is labelled
 * "200 ms" rather than "200.1 ms" — the extra digit reads as precision the
 * chart doesn't have.
 */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return v;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * The x-axis window as an operator reads it: "60 min" up to 90 minutes, then
 * hours ("2 h", "1.5 h") so a 24-hour loss History doesn't print "-1440 min".
 * The left axis label was a hardcoded "-60 min" until the loss chart's window
 * started following the automation's History (2026-08); every chart now labels
 * whatever span it was actually given.
 */
export function timeAxisLabel(spanMs: number): string {
  const mins = Math.round(spanMs / 60_000);
  if (mins < 90) return `${mins} min`;
  // Days from 72 h on — a storage forecast spans weeks, and "720 h" makes the
  // reader do arithmetic. Below that hours still read better ("24 h", "48 h").
  if (mins >= 72 * 60) {
    // Whole days from 10 on: a month of daily points measured from midday
    // otherwise reads "-29.5 d", a precision the axis does not have.
    const raw = mins / 1440;
    const days = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    return `${Number.isInteger(days) ? days.toFixed(0) : days.toFixed(1)} d`;
  }
  const hours = Math.round((mins / 60) * 10) / 10;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)} h`;
}

/** Trim to 1 decimal, then drop a trailing ".0" — "97" reads better than "97.0". */
export function formatReading(v: number, unit = ""): string {
  const rounded = Math.round(v * 10) / 10;
  const s = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${s}${unit}`;
}

export interface SeriesStats {
  min: number;
  max: number;
  avg: number;
  last: number;
  count: number;
}

/** Summary numbers for the chart caption AND the plain-text email fallback. */
export function seriesStats(points: SparkPoint[]): SeriesStats | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    sum += p.v;
  }
  return { min, max, avg: sum / points.length, last: points[points.length - 1]!.v, count: points.length };
}

/**
 * One line chart, ~520×120, self-contained (no external fonts, no CSS).
 * Returns a placeholder card when there is nothing to plot — an email that
 * says "no data in the last hour" is more useful than a missing image the
 * reader assumes their client blocked.
 */
export function sparklineSvg(points: SparkPoint[], opts: SparklineOptions): string {
  const width = opts.width ?? W;
  const height = opts.height ?? H;
  const color = opts.color ?? "#2563eb";
  const unit = opts.unit ?? "";
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>` +
    `<text x="4" y="14" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="bold" fill="#1f2430">${esc(opts.label)}</text>`;

  const stats = seriesStats(points);
  // Nothing measured, but the device SAID something about the window: draw the
  // frame and its alarm bands with no line. This is a dead SD-WAN member —
  // FortiOS stops reporting latency / jitter / loss for a member it has
  // declared dead, so an outage older than the window leaves all three series
  // empty while the health check's own verdict covers every sample. A "no data"
  // card there reads as Polaris failing to chart; the band says "down all
  // along", which is the finding.
  if (!stats && opts.alarmSpans?.length && opts.from !== undefined && opts.to !== undefined && opts.to > opts.from) {
    const from = opts.from;
    const tSpan = opts.to - from;
    const baseY = PAD_T + plotH;
    const bands = opts.alarmSpans
      .map((s) => {
        const x1 = Math.max(PAD_L, Math.min(PAD_L + ((s.from - from) / tSpan) * plotW, PAD_L + plotW));
        const x2 = Math.max(PAD_L, Math.min(PAD_L + ((s.to - from) / tSpan) * plotW, PAD_L + plotW));
        return `<rect x="${x1.toFixed(1)}" y="${PAD_T}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="${plotH}" fill="#dc2626" fill-opacity="0.13"/>`;
      })
      .join("");
    return (
      head +
      bands +
      `<line x1="${PAD_L}" y1="${baseY}" x2="${width - PAD_R}" y2="${baseY}" stroke="#e5e7eb" stroke-width="1"/>` +
      `<text x="${PAD_L + plotW / 2}" y="${PAD_T + plotH / 2 + 4}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#6b7280">${esc(opts.emptyNote ?? "no readings in this window")}</text>` +
      `</svg>`
    );
  }
  if (!stats) {
    return (
      head +
      `<text x="${width / 2}" y="${height / 2 + 4}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" fill="#9ca3af">no data in this window</text>` +
      `</svg>`
    );
  }

  // Axis range. Percentages pin 0–100 so two messages are comparable; an
  // open-ended metric gets 10% headroom, and a flat line still gets a band so
  // it renders as a line rather than sitting on the axis.
  // A projection and a ceiling are part of the picture, so the range has to
  // hold them too — but not the caption, which states only what was measured.
  const projection = opts.projection ?? [];
  const projMin = projection.reduce((m, p) => Math.min(m, p.v), Infinity);
  const projMax = projection.reduce((m, p) => Math.max(m, p.v), -Infinity);
  let yMin = opts.yMin ?? Math.min(stats.min, projMin, opts.threshold ?? Infinity);
  let yMax = opts.yMax ?? Math.max(stats.max, projMax, opts.threshold ?? -Infinity, opts.ceiling ?? -Infinity);
  if (opts.yMin === undefined && opts.yMax === undefined) {
    const span = yMax - yMin;
    if (span <= 0) {
      yMin = Math.max(0, yMin - 1);
      yMax = yMax + 1;
    } else {
      yMin = Math.max(0, yMin - span * 0.1);
      // Round the top to a readable number. Without this the 10% headroom
      // prints axis labels like "200.1 ms", which reads as precision that
      // isn't there.
      yMax = niceCeil(yMax + span * 0.1);
    }
  }
  const ySpan = yMax - yMin || 1;

  const from = opts.from ?? points[0]!.t;
  const to = opts.to ?? (projection.length ? projection[projection.length - 1]!.t : points[points.length - 1]!.t);
  const tSpan = to - from || 1;

  const x = (t: number) => PAD_L + ((t - from) / tSpan) * plotW;
  const y = (v: number) => PAD_T + plotH - ((v - yMin) / ySpan) * plotH;

  // Gridlines + y labels at the range ends and the midpoint.
  const gridVals = [yMax, (yMax + yMin) / 2, yMin];
  const grid = gridVals
    .map((v) => {
      const gy = y(v).toFixed(1);
      return (
        `<line x1="${PAD_L}" y1="${gy}" x2="${width - PAD_R}" y2="${gy}" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${PAD_L - 4}" y="${(Number(gy) + 3).toFixed(1)}" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#9ca3af">${esc(formatReading(v))}</text>`
      );
    })
    .join("");

  // Alarm bands sit BEHIND everything (drawn first) so the line stays readable
  // over them. Clamped to the plot, and a zero-width span still gets ~2px so a
  // single alarming sample is visible rather than invisible. Failed polls do
  // NOT get a band — see failSpans below.
  const bandRects = (spans: Array<{ from: number; to: number }>, opacity: string): string =>
    spans
      .map((s) => {
        const x1 = Math.max(PAD_L, Math.min(x(s.from), PAD_L + plotW));
        const x2 = Math.max(PAD_L, Math.min(x(s.to), PAD_L + plotW));
        const w = Math.max(2, x2 - x1);
        return `<rect x="${x1.toFixed(1)}" y="${PAD_T}" width="${w.toFixed(1)}" height="${plotH}" fill="#dc2626" fill-opacity="${opacity}"/>`;
      })
      .join("");
  const failSpans = (opts.failSpans ?? []).filter((s) => s.to > from && s.from < to).sort((a, b) => a.from - b.from);
  const alarmBands = bandRects(opts.alarmSpans ?? [], "0.13");

  const baseY = PAD_T + plotH;

  // Failed polls plot AT the baseline with no value of their own, so an outage
  // reads as the line diving to zero (UI-GUIDE section 15) instead of bridging
  // the hole or hiding behind a shaded band. One marker at each end of a span
  // so the line drops and climbs back; a span narrower than that collapses to
  // a single point, which is what one missed poll is.
  //
  // A window the series has DATA inside is skipped whole. An agent pushes on
  // its own schedule and is not gated on monitorStatus, so an agent host can
  // keep reporting CPU straight through an outage of the server-side probe
  // transport; diving a line that has data would misreport what we hold. Same
  // rule, same half-median-cadence guard, as _outageMarkers in the browser.
  const sampleTimes = points.map((p) => p.t);
  const cadences: number[] = [];
  for (let i = 1; i < sampleTimes.length; i++) {
    const dt = sampleTimes[i]! - sampleTimes[i - 1]!;
    if (dt > 0) cadences.push(dt);
  }
  cadences.sort((a, b) => a - b);
  const guardMs = cadences.length >= 2 ? cadences[Math.floor(cadences.length / 2)]! / 2 : 0;
  // The whole window is skipped when the series has data anywhere in it
  // (padded by the guard), not merely at its edges: dropping only the end
  // markers would leave any interior samples in place and the line would dive,
  // climb back for each of them, and dive again.
  const hasData = (a: number, b: number) =>
    guardMs > 0 && sampleTimes.some((st) => st > a - guardMs && st < b + guardMs);

  const failTimes: Array<{ t: number; kind: "outage" | "dependency" | "missed" }> = [];
  for (const sp of failSpans) {
    const a = Math.max(sp.from, from);
    const b = Math.min(sp.to, to);
    if (hasData(a, b)) continue;
    const kind = sp.kind ?? "outage";
    failTimes.push({ t: a, kind });
    if (b > a) failTimes.push({ t: b, kind });
  }

  // The climb back out. Membership is a time test rather than a per-point flag
  // because the caller reads the recovery windows from the PROBE stream, which
  // holds the failures too — the plotted series is successes only and could not
  // reconstruct the bucket on its own.
  const recoverSpans = (opts.recoverSpans ?? []).filter((s) => s.to >= from && s.from <= to);
  const recovering = (t: number): boolean => recoverSpans.some((s) => t >= s.from && t <= s.to);

  type PlotPoint = { t: number; py: number; ok: boolean; kind?: "outage" | "dependency" | "missed"; rec?: boolean };
  const plot: PlotPoint[] = [
    ...points.map((p) => ({ t: p.t, py: y(p.v), ok: true, rec: recovering(p.t) })),
    ...failTimes.map((f) => ({ t: f.t, py: baseY, ok: false, kind: f.kind })),
  ].sort((a, b) => a.t - b.t);
  // One colour rule for every stroke, fill, dot and gradient stop below, so a
  // dive can never come out half amber and half red, and the climb back out can
  // never come out half purple and half green.
  const downColor = opts.downColor || FAIL_COLOR;
  const colorOf = (p: PlotPoint): string =>
    p.ok
      ? p.rec ? RECOVER_COLOR : color
      : p.kind === "dependency" ? DEP_COLOR
      : p.kind === "missed" ? MISS_COLOR
      : downColor;

  const defs: string[] = [];
  // Gradients are local defs, not external references — resvg resolves them
  // in-document. Stops are in user space so the fade tracks the segment's own
  // geometry.
  const fadeSegment = (a: PlotPoint, b: PlotPoint): string => {
    const x1 = x(a.t), x2 = x(b.t);
    const id = `polaris-fade-${defs.length}`;
    defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${b.py.toFixed(1)}">` +
        `<stop offset="0" stop-color="${colorOf(a)}"/>` +
        `<stop offset="1" stop-color="${colorOf(b)}"/>` +
      `</linearGradient>`,
    );
    return `<line x1="${x1.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${b.py.toFixed(1)}" stroke="url(#${id})" stroke-width="2" stroke-linecap="round"/>`;
  };

  // Runs of same-state points collapse into one polyline rather than a <line>
  // per segment the way the desktop chart emits them: a FortiGate can land
  // thousands of points in an hour, and per-segment elements would balloon the
  // PNG. Same divergence, same reason, as the phone port.
  // Grouped by COLOUR, not by ok-ness: a red outage that runs straight into a
  // grey dependency stretch (the parent went down part-way through) has to
  // break into two runs, or the whole thing takes the first run's stroke.
  const runs: PlotPoint[][] = [];
  for (const p of plot) {
    const cur = runs[runs.length - 1];
    if (cur && colorOf(cur[0]!) === colorOf(p)) cur.push(p);
    else runs.push([p]);
  }

  const lineParts: string[] = [];
  const areaParts: string[] = [];
  const dotParts: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const stroke = colorOf(run[0]!);
    const rp = run.map((p) => `${x(p.t).toFixed(1)},${p.py.toFixed(1)}`);
    if (run.length === 1) {
      // A lone point has no line to draw — mark it so it isn't invisible.
      // Failures get the bigger dot below either way.
      if (run[0]!.ok) dotParts.push(`<circle cx="${x(run[0]!.t).toFixed(1)}" cy="${run[0]!.py.toFixed(1)}" r="3" fill="${stroke}"/>`);
    } else {
      lineParts.push(
        `<polyline fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${rp.join(" ")}"/>`,
      );
      // Only the OK runs carry the area fill: a failure run sits ON the
      // baseline, so filling it would paint a zero-height sliver for nothing,
      // and filling ACROSS the outage is the interpolation we're avoiding.
      if (run[0]!.ok) {
        // The run's OWN colour, not the series colour: a recovering stretch
        // fills purple under its purple line rather than pooling green
        // underneath it.
        areaParts.push(
          `<polygon fill="${stroke}" fill-opacity="0.10" points="${x(run[0]!.t).toFixed(1)},${baseY} ${rp.join(" ")} ${x(run[run.length - 1]!.t).toFixed(1)},${baseY}"/>`,
        );
      }
    }
    // Each OK<->fail transition fades between the two colors instead of
    // jumping, so the dive reads as one line rather than two.
    if (i > 0) {
      const prev = runs[i - 1]!;
      lineParts.push(fadeSegment(prev[prev.length - 1]!, run[0]!));
    }
  }
  // Every failure also carries a dot — bigger than the 1.5px series dots on
  // the in-app chart, scaled here for the smaller plot — so a lone miss is
  // visible and not a hairline notch. Grey when the miss was explained.
  for (const p of plot) {
    if (!p.ok) dotParts.push(`<circle cx="${x(p.t).toFixed(1)}" cy="${p.py.toFixed(1)}" r="3" fill="${colorOf(p)}"/>`);
  }
  const defsBlock = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  const line = lineParts.join("");
  const area = areaParts.join("");
  const dot = dotParts.join("");

  const thresholdLine =
    opts.threshold != null && opts.threshold >= yMin && opts.threshold <= yMax
      ? `<line x1="${PAD_L}" y1="${y(opts.threshold).toFixed(1)}" x2="${width - PAD_R}" y2="${y(opts.threshold).toFixed(1)}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4 3"/>`
      : "";

  // The capacity rule: solid grey, labelled inside the plot just under the
  // line (the caption owns the row above the plot, so a label there collides).
  const ceilingLine =
    opts.ceiling != null && opts.ceiling >= yMin && opts.ceiling <= yMax
      ? `<line x1="${PAD_L}" y1="${y(opts.ceiling).toFixed(1)}" x2="${width - PAD_R}" y2="${y(opts.ceiling).toFixed(1)}" stroke="#6b7280" stroke-width="1"/>` +
        `<text x="${PAD_L + 4}" y="${(y(opts.ceiling) + 10).toFixed(1)}" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#6b7280">full</text>`
      : "";

  // The projection: dashed, in the series colour, from its first point to its
  // last, with the end marked — red when it reached the ceiling, since that
  // point is the projected full date.
  let projectionSvg = "";
  if (projection.length >= 2) {
    const pp = projection.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const end = projection[projection.length - 1]!;
    const hitsCeiling = opts.ceiling != null && end.v >= opts.ceiling;
    projectionSvg =
      `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" opacity="0.85" points="${pp}"/>` +
      `<circle cx="${x(end.t).toFixed(1)}" cy="${y(end.v).toFixed(1)}" r="3.5" fill="${hitsCeiling ? "#dc2626" : color}"/>`;
  }

  const captionAvg = opts.avgOverride ?? stats.avg;
  const captionText = opts.caption ??
    `now ${formatReading(stats.last, unit)} · avg ${formatReading(captionAvg, unit)} · peak ${formatReading(stats.max, unit)}`;
  const caption =
    `<text x="${width - PAD_R}" y="14" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="11" fill="#4b5563">` +
    `${esc(captionText)}</text>`;

  const axis = `<line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${width - PAD_R}" y2="${PAD_T + plotH}" stroke="#d1d5db" stroke-width="1"/>`;
  const label = (lx: number, anchor: "start" | "middle" | "end", text: string) =>
    `<text x="${lx.toFixed(1)}" y="${height - 5}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`} font-family="Helvetica,Arial,sans-serif" font-size="9" fill="#9ca3af">${esc(text)}</text>`;
  // A window that runs past now (a projection) labels both halves and marks
  // now; every other chart keeps "-60 min … now" at the edges.
  const nowAt = opts.now != null && opts.now > from && opts.now < to ? opts.now : null;
  const xLabels = nowAt != null
    ? label(PAD_L, "start", `-${timeAxisLabel(nowAt - from)}`) +
      label(x(nowAt), "middle", "now") +
      label(width - PAD_R, "end", `+${timeAxisLabel(to - nowAt)}`) +
      `<line x1="${x(nowAt).toFixed(1)}" y1="${PAD_T}" x2="${x(nowAt).toFixed(1)}" y2="${PAD_T + plotH}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="2 2"/>`
    : label(PAD_L, "start", `-${timeAxisLabel(tSpan)}`) + label(width - PAD_R, "end", "now");

  return head + defsBlock + alarmBands + grid + area + line + dot + projectionSvg + ceilingLine + thresholdLine + axis + xLabels + caption + `</svg>`;
}
