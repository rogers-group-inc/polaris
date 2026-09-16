/**
 * tests/unit/sampleAlertDevice.test.ts
 *
 * The invented device a test alert is about, and the TEST marking stitched onto
 * the email that carries it.
 *
 * These are not cosmetic assertions. A "Send Test Email" is fired on demand, by
 * anyone with `automationManagement:fullwrite`, to an address they type, and the
 * result lands in an inbox nobody treats as inventory — so two properties have
 * to hold or the feature leaks: every fact in it is invented (and provably so,
 * via the documentation-reserved ranges), and the reader is told it is a test in
 * a way the automation's own template cannot delete.
 */

import { describe, it, expect } from "vitest";
import {
  SAMPLE_ALERT_DEVICE,
  SAMPLE_ALERT_HOSTNAME,
  SAMPLE_SDWAN_HEALTH_CHECK,
  SAMPLE_SDWAN_LINK,
  SAMPLE_SENSOR_NAME,
  sampleDimensionFor,
} from "../../src/utils/sampleAlertDevice.js";
import { markEmailAsTest, TEST_SUBJECT_PREFIX } from "../../src/utils/alertEmailTemplate.js";
import { sampleChartSeries } from "../../src/services/alertChartService.js";

describe("SAMPLE_ALERT_DEVICE", () => {
  it("addresses come from the documentation-reserved ranges", () => {
    // RFC 5737 TEST-NET-1 and the RFC 7042 documentation MAC block: an address
    // that cannot belong to a real device, anywhere, ever.
    expect(SAMPLE_ALERT_DEVICE.ipAddress).toMatch(/^192\.0\.2\./);
    expect(SAMPLE_ALERT_DEVICE.macAddress).toMatch(/^00:00:5e:00:53:/i);
  });

  it("every name a reader could mistake for their own says Example", () => {
    for (const value of [
      SAMPLE_ALERT_HOSTNAME,
      SAMPLE_ALERT_DEVICE.location,
      SAMPLE_ALERT_DEVICE.description,
      SAMPLE_ALERT_DEVICE.manufacturer,
      SAMPLE_ALERT_DEVICE.serialNumber,
      SAMPLE_ALERT_DEVICE.lastSeenSwitch,
      SAMPLE_SENSOR_NAME,
      SAMPLE_SDWAN_HEALTH_CHECK,
    ]) {
      expect(String(value).toLowerCase()).toContain("example");
    }
    // The Model row renders "{manufacturer} {model}" as one string, which is
    // where the made-up vendor name does the work — the bare part number does
    // not have to carry it.
    expect(`${SAMPLE_ALERT_DEVICE.manufacturer} ${SAMPLE_ALERT_DEVICE.model}`.toLowerCase()).toContain("example");
  });

  it("carries NO id, so the email's Open-device button is pruned", () => {
    // A link to a device page that does not exist is worse than no button;
    // pruneDeadLinks removes it once {asset.link} renders empty.
    expect(SAMPLE_ALERT_DEVICE.id).toBeNull();
  });

  it("fills the same fields a real fire's asset detail does", () => {
    // The point of a specimen is that it prunes the same rows the real thing
    // prunes. A field left undefined here mails a blank row for a fact a real
    // alert prints — which is how a test quietly stops being faithful.
    for (const key of [
      "ipAddress", "macAddress", "lastSeenSwitch", "assetType", "status",
      "location", "description", "manufacturer", "model", "serialNumber",
    ] as const) {
      expect(SAMPLE_ALERT_DEVICE[key], key).toBeTruthy();
    }
  });
});

describe("sampleDimensionFor", () => {
  it("names a sensor for a hardware-sensor automation", () => {
    expect(sampleDimensionFor("hwSensorValue")).toBe(SAMPLE_SENSOR_NAME);
    expect(sampleDimensionFor("hwSensorAlarm")).toBe(SAMPLE_SENSOR_NAME);
  });

  it("names a health-check/member PAIR for an SD-WAN automation", () => {
    // alertChartService parses this apart; a bare name charts nothing.
    expect(sampleDimensionFor("sdwanLatency")).toBe(`${SAMPLE_SDWAN_HEALTH_CHECK}|${SAMPLE_SDWAN_LINK}`);
  });

  it("is null for a whole-device metric", () => {
    expect(sampleDimensionFor("cpuPct")).toBeNull();
    expect(sampleDimensionFor(null)).toBeNull();
  });
});

describe("markEmailAsTest", () => {
  const msg = { subject: "[WARNING] EXAMPLE-SWITCH-01 — Slow response", text: "body", html: "<table>body</table>" };

  it("marks all three surfaces a forwarded alert is read on", () => {
    const out = markEmailAsTest(msg);
    expect(out.subject.startsWith(TEST_SUBJECT_PREFIX)).toBe(true);
    expect(out.text).toContain("TEST MESSAGE");
    expect(out.html).toContain("Test message");
  });

  it("puts the banner ABOVE the composed body, not inside it", () => {
    // Stitched on after every substitution and pruning pass, so a fully
    // customized template still carries it.
    const out = markEmailAsTest(msg);
    expect(out.html!.indexOf("Test message")).toBeLessThan(out.html!.indexOf("<table>body</table>"));
    expect(out.text.indexOf("TEST MESSAGE")).toBeLessThan(out.text.indexOf("body"));
  });

  it("does not say TEST twice", () => {
    const once = markEmailAsTest(msg);
    expect(markEmailAsTest(once).subject).toBe(once.subject);
  });

  it("leaves a text-only message without an html half", () => {
    const out = markEmailAsTest({ subject: "s", text: "t" });
    expect(out).not.toHaveProperty("html");
  });
});

describe("sampleChartSeries", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const base = { since, now, lossSince: since, lossBucketMs: 5 * 60 * 1000, displayUnit: "c" as const };

  it("generates only the series the body asked for", () => {
    const s = sampleChartSeries(["chart.cpu"], base);
    expect(s.cpu.length).toBeGreaterThan(30);
    // No query happened and none should have: the untouched series stay empty
    // so their tokens render away exactly as on a real alert with no samples.
    expect(s.mem).toEqual([]);
    expect(s.rt).toEqual([]);
    expect(s.sdwan).toBeNull();
  });

  it("is deterministic — the same test email twice draws the same picture", () => {
    expect(sampleChartSeries(["chart.cpu"], base)).toEqual(sampleChartSeries(["chart.cpu"], base));
  });

  it("keeps percentages inside the pinned 0-100 axis", () => {
    const s = sampleChartSeries(["chart.cpu", "chart.memory"], base);
    for (const p of [...s.cpu, ...s.mem]) {
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(p.v).toBeLessThanOrEqual(100);
    }
  });

  it("charts the sensor in the install's display unit", () => {
    expect(sampleChartSeries(["chart.sensor"], base).sensor.unit).toBe("°C");
    const f = sampleChartSeries(["chart.sensor"], { ...base, displayUnit: "f" });
    expect(f.sensor.unit).toBe("°F");
    // ~46 °C sampled; in Fahrenheit every reading must land well above it.
    expect(Math.min(...f.sensor.points.map((p) => p.v))).toBeGreaterThan(100);
  });

  it("invents no outage — a made-up device has not missed any polls", () => {
    // The red dives mean "Polaris measured nothing here". Teaching that to a
    // reader on a device that does not exist is the wrong lesson.
    const s = sampleChartSeries(["chart.sdwanLatency"], base);
    expect(s.sdwan!.downSpans).toEqual([]);
  });

  it("gives the loss chart a quiet stretch and a burst to compare", () => {
    const s = sampleChartSeries(["chart.probeLoss"], base);
    expect(s.loss.points.some((p) => p.v === 0)).toBe(true);
    expect(s.loss.points.some((p) => p.v > 0)).toBe(true);
    expect(s.loss.ratioPct).toBeGreaterThan(0);
  });
});
