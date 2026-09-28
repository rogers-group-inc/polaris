/**
 * tests/unit/alertSensorChart.test.ts
 *
 * The hardware-sensor chart in an alert email — the one an operator gets when
 * a `hwSensorValue` or `hwSensorAlarm` automation fires.
 *
 * Both trigger types chart the sensor's VALUE, which is the only reading a
 * human can act on: an alarm bit says "something is wrong with TMP1", the
 * value says whether it climbed, dropped, or never moved. Whether the device
 * ALSO had its own alarm bit set is drawn as shading over the same series.
 *
 * The pure halves are tested here; the Prisma-backed loader is covered by the
 * delivery integration path.
 */

import { describe, it, expect, vi } from "vitest";
import { sparklineSvg } from "../../src/utils/sparklineSvg.js";
import {
  chartTokenForMetric,
  failSpansFrom,
  substituteChartTokens,
  type RenderedChart,
  type ChartToken,
} from "../../src/services/alertChartService.js";
import {
  convertSensorForDisplay,
  sensorDisplayUnit,
  isCelsiusUnit,
} from "../../src/utils/hardwareSensors.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const T0 = Date.parse("2026-08-12T10:00:00Z");
const pts = (vals: number[]) => vals.map((v, i) => ({ t: T0 + i * 60_000, v }));

describe("display-unit conversion (server side)", () => {
  it("converts a Celsius reading only when the install asks for Fahrenheit", () => {
    expect(convertSensorForDisplay(50, "C", "f")).toBe(122);
    expect(convertSensorForDisplay(50, "°C", "f")).toBe(122);
    expect(convertSensorForDisplay(50, "C", "c")).toBe(50);
  });

  it("keys on the reading's own unit, never its class — RPM and volts pass through", () => {
    // A fan tray at 4200 RPM must not become 7592 anything.
    expect(convertSensorForDisplay(4200, "RPM", "f")).toBe(4200);
    expect(convertSensorForDisplay(12.1, "V", "f")).toBe(12.1);
    // A device that reported no unit is left alone rather than guessed at.
    expect(convertSensorForDisplay(50, null, "f")).toBe(50);
  });

  it("drops a null/absent reading instead of plotting a zero", () => {
    expect(convertSensorForDisplay(null, "C", "f")).toBeNull();
    expect(convertSensorForDisplay(undefined, "C", "c")).toBeNull();
    expect(convertSensorForDisplay(Number.NaN, "C", "c")).toBeNull();
  });

  it("agrees with the browser's isCelsiusUnit, or a sensor reads differently in each place", () => {
    for (const u of ["C", "c", "°C", " °c ", "°  C"]) expect(isCelsiusUnit(u)).toBe(true);
    for (const u of ["RPM", "V", "W", "", null, undefined, "F"]) expect(isCelsiusUnit(u as string)).toBe(false);
  });

  it("swaps the axis label only for Celsius", () => {
    expect(sensorDisplayUnit("C", "f")).toBe("°F");
    expect(sensorDisplayUnit("C", "c")).toBe("°C");
    expect(sensorDisplayUnit("RPM", "f")).toBe("RPM");
    expect(sensorDisplayUnit(null, "f")).toBe("");
  });
});

describe("alarm shading", () => {
  it("shades the window where the device raised its own alarm", () => {
    const svg = sparklineSvg(pts([40, 42, 80, 82, 45]), {
      label: "TMP1",
      unit: " °C",
      alarmSpans: [{ from: T0 + 120_000, to: T0 + 180_000 }],
      from: T0,
      to: T0 + 240_000,
    });
    expect(svg).toContain('fill="#dc2626"');
    expect(svg).toContain("fill-opacity=\"0.13\"");
  });

  it("draws the band BEHIND the line, so the reading stays readable", () => {
    const svg = sparklineSvg(pts([40, 80]), { label: "TMP1", alarmSpans: [{ from: T0, to: T0 + 60_000 }] });
    expect(svg.indexOf('fill="#dc2626"')).toBeLessThan(svg.indexOf("<polyline"));
  });

  it("keeps a single alarming sample visible instead of a zero-width sliver", () => {
    const svg = sparklineSvg(pts([40, 41, 42]), {
      label: "TMP1",
      alarmSpans: [{ from: T0 + 60_000, to: T0 + 60_000 }], // one sample, zero width
      from: T0,
      to: T0 + 120_000,
    });
    const w = Number(/<rect x="[\d.]+" y="\d+" width="([\d.]+)"/.exec(svg.replace(/^.*?<rect[^>]*fill="#ffffff"[^>]*>/, ""))![1]);
    expect(w).toBeGreaterThanOrEqual(2);
  });

  it("clamps a span that started before the window", () => {
    const svg = sparklineSvg(pts([40, 41]), {
      label: "TMP1",
      alarmSpans: [{ from: T0 - 3_600_000, to: T0 + 30_000 }],
      from: T0,
      to: T0 + 60_000,
    });
    // The band never starts left of the plot area (PAD_L = 40).
    const x = Number(/<rect x="([\d.]+)" y="22"/.exec(svg)![1]);
    expect(x).toBeGreaterThanOrEqual(40);
  });

  it("draws nothing when the device never alarmed", () => {
    const svg = sparklineSvg(pts([40, 41]), { label: "TMP1" });
    expect(svg).not.toContain('fill="#dc2626"');
  });
});

describe("the sensor chart labels itself from the sensor", () => {
  it("titles the chart with the sensor name the operator picked", () => {
    // The automation's dimension IS the sensor name, so the chart reads like
    // the rule that fired it.
    const svg = sparklineSvg(pts([61, 62]), { label: "CPU ON-DIE Temperature", unit: " °C" });
    expect(svg).toContain("CPU ON-DIE Temperature");
    expect(svg).toContain("°C");
  });
});

describe("failSpansFrom", () => {
  const probe = (min: number, success: boolean) => ({ timestamp: new Date(T0 + min * 60_000), success });
  const END = T0 + 10 * 60_000;

  it("merges consecutive failures into one span, not a sliver per probe", () => {
    const { spans, failedCount } = failSpansFrom(
      [probe(0, true), probe(1, false), probe(2, false), probe(3, false), probe(4, true)],
      END,
    );
    expect(spans).toEqual([{ from: T0 + 60_000, to: T0 + 180_000, kind: "outage" }]);
    expect(failedCount).toBe(3);
  });

  it("keeps separate outages separate", () => {
    const { spans } = failSpansFrom([probe(0, false), probe(1, true), probe(2, false), probe(3, true)], END);
    expect(spans).toHaveLength(2);
  });

  it("leaves a still-failing run OPEN to the window's end", () => {
    // A device that is down as the email sends is down up to the right edge of
    // the chart, not up to whenever its last poll happened to land — otherwise
    // the shading stops short and the line looks like it merely ended.
    const { spans } = failSpansFrom([probe(0, true), probe(8, false), probe(9, false)], END);
    expect(spans).toEqual([{ from: T0 + 8 * 60_000, to: END, kind: "outage" }]);
  });

  it("labels a run of dependency-suppressed misses so the email dives grey", () => {
    // The parent was dark: the probes did fail, but nothing about THIS device
    // is in question, and an alert email that paints it red says otherwise.
    const dep = (min: number) => ({ ...probe(min, false), dependencyDown: true });
    const { spans } = failSpansFrom([probe(0, true), dep(1), dep(2), probe(3, true)], END);
    expect(spans).toEqual([{ from: T0 + 60_000, to: T0 + 120_000, kind: "dependency" }]);
  });

  it("is empty when everything answered", () => {
    expect(failSpansFrom([probe(0, true), probe(1, true)], END)).toEqual({ spans: [], recoverySpans: [], failedCount: 0 });
    expect(failSpansFrom([], END)).toEqual({ spans: [], recoverySpans: [], failedCount: 0 });
  });

  it("reports the climb back out, ending at the poll that empties the bucket", () => {
    // Two misses cost two answers. The first answer still has one outstanding
    // and is the purple stretch; the second drains it and is already Up, so the
    // recovery span ends at the FIRST answer — the same point the device page's
    // own chart stops drawing purple.
    const { recoverySpans } = failSpansFrom(
      [probe(0, true), probe(1, false), probe(2, false), probe(3, true), probe(4, true), probe(5, true)],
      END,
    );
    expect(recoverySpans).toEqual([{ from: T0 + 180_000, to: T0 + 180_000 }]);
  });

  it("does not call a device recovering when nothing was outstanding", () => {
    expect(failSpansFrom([probe(0, true), probe(1, true), probe(2, true)], END).recoverySpans).toEqual([]);
  });

  it("splits a run into the misses that were only misses and the ones that were the verdict", () => {
    // Threshold 3: the first two failures are amber, the third is where the
    // device became Down. An email that paints all five red says the outage
    // started two polls before Polaris agreed it had.
    const { spans } = failSpansFrom(
      [probe(0, true), probe(1, false), probe(2, false), probe(3, false), probe(4, false), probe(5, true)],
      END,
      3,
    );
    expect(spans).toEqual([
      { from: T0 + 60_000, to: T0 + 120_000, kind: "missed" },
      { from: T0 + 180_000, to: T0 + 240_000, kind: "outage" },
    ]);
  });

  it("never goes red for a passive device", () => {
    // No automation defines down here (business rule 36), so the misses show
    // and the verdict does not.
    const { spans } = failSpansFrom(
      [probe(0, true), probe(1, false), probe(2, false), probe(3, false), probe(4, true)],
      END,
      null,
    );
    expect(spans).toEqual([{ from: T0 + 60_000, to: T0 + 180_000, kind: "missed" }]);
  });

  it("keeps every miss red when the threshold could not be resolved", () => {
    // Unknown is not passive. Without a count there is nothing to be amber
    // ABOUT, so the dive stays exactly what it was before the split existed.
    const { spans } = failSpansFrom(
      [probe(0, true), probe(1, false), probe(2, false), probe(3, true)],
      END,
    );
    expect(spans).toEqual([{ from: T0 + 60_000, to: T0 + 120_000, kind: "outage" }]);
  });

  it("still calls a dependency-explained miss grey, whatever the count says", () => {
    // Attribution outranks severity: how close a miss sits to the threshold
    // says nothing worth colouring when it is not being counted against this
    // device at all.
    const dep = (min: number) => ({ ...probe(min, false), dependencyDown: true });
    const { spans } = failSpansFrom([probe(0, true), dep(1), dep(2), dep(3), probe(4, true)], END, 3);
    expect(spans).toEqual([{ from: T0 + 60_000, to: T0 + 180_000, kind: "dependency" }]);
  });
});

describe("chart ordering follows the trigger", () => {
  it("maps each alertable metric to the chart that explains it", () => {
    expect(chartTokenForMetric("responseTimeMs")).toBe("chart.responseTime");
    expect(chartTokenForMetric("cpuPct")).toBe("chart.cpu");
    expect(chartTokenForMetric("memPct")).toBe("chart.memory");
    expect(chartTokenForMetric("memUsedBytes")).toBe("chart.memory");
    expect(chartTokenForMetric("hwSensorValue")).toBe("chart.sensor");
    // An ALARM automation charts the sensor's VALUE — the reading is the part
    // a human can act on.
    expect(chartTokenForMetric("hwSensorAlarm")).toBe("chart.sensor");
    expect(chartTokenForMetric("probeLossPct")).toBe("chart.probeLoss");
  });

  it("charts a DOWN device's probes — the one alert with no metric behind it", () => {
    // "Asset down" is asset_state, not asset_metric, so nothing used to point
    // it at a chart. Response time is the picture: the climb before the device
    // stopped answering. (When every probe failed there is no latency to plot
    // and the loss chart, which is in the body unconditionally, carries it.)
    expect(chartTokenForMetric("monitorStatus")).toBe("chart.responseTime");
    expect(chartTokenForMetric("consecutiveFailures")).toBe("chart.responseTime");
  });

  it("has no chart for metrics that don't have one yet", () => {
    // The trigger token renders away and the generic charts still tell the
    // device's story. (Storage got its own chart on 2026-09-28 —
    // alertStorageChart.test.ts; interface counters still have none.)
    expect(chartTokenForMetric("ifInErrorRate")).toBeNull();
    expect(chartTokenForMetric(null)).toBeNull();
  });

  it("never renders the same graph twice when the alias and its own token both appear", () => {
    // The default body lists {chart.trigger} first AND every specific chart
    // after it, so a response-time alert would otherwise show it twice.
    const rt: RenderedChart = {
      token: "chart.responseTime",
      cid: "polaris-chart-responseTime@polaris",
      hasData: true,
      summary: "Response time (last hour): now 760 ms",
      attachment: { cid: "polaris-chart-responseTime@polaris", filename: "r.png", contentType: "image/png", content: Buffer.from("x") },
    };
    const charts = new Map<ChartToken, RenderedChart>([
      ["chart.trigger", { ...rt, token: "chart.trigger" }],
      ["chart.responseTime", rt],
    ]);
    const out = substituteChartTokens("A{chart.trigger}B{chart.responseTime}C", charts, { html: true });
    expect((out.match(/<img /g) ?? []).length).toBe(1);
    expect(out.startsWith("A<img")).toBe(true);
    expect(out.endsWith("BC")).toBe(true);
  });
});
