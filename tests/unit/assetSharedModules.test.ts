/**
 * tests/unit/assetSharedModules.test.ts — the two modules the desktop asset
 * slide-over (public/js/assets.js) and the phone's asset sheet
 * (public/js/mobile/*.js) share instead of carrying "change one, change
 * both" copies (docs/CODE-QUALITY-LEDGER.md CQ-F024):
 *
 *   public/js/asset-shared.js  → window.PolarisAssetShared
 *   public/js/chart-shared.js  → window.PolarisChartShared
 *
 * Pins every helper, the behaviour chosen where the two copies had drifted
 * (fwWhenText's year + zone, derivePerIntervalSeries' `timestamp` key and
 * unparseable-pair skip, memBandsFor's strict numbers + table/free,
 * poolMemberUnhealthy's boolean), the phone's source labels against the
 * desktop's, and the script order on every page that runs them.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { appSource } from "./_appSource.js";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

type Fn = (...args: any[]) => any;
let AS: Record<string, any>;
let CS: Record<string, any>;

beforeAll(() => {
  const win: Record<string, any> = {};
  const timeAgo = (iso: string) => `AGO(${iso})`;
  new Function("window", "timeAgo", read("public/js/asset-shared.js"))(win, timeAgo);
  new Function("window", read("public/js/chart-shared.js"))(win);
  AS = win.PolarisAssetShared;
  CS = win.PolarisChartShared;
});

afterEach(() => { vi.useRealTimers(); });

// ─── asset-shared.js ────────────────────────────────────────────────────────

describe("PolarisAssetShared.arpAgeLabel", () => {
  const f = () => AS.arpAgeLabel as Fn;
  it("formats seconds, minutes, hours", () => {
    expect(f()(45)).toBe("45s");
    expect(f()(12 * 60 + 5)).toBe("12m");
    expect(f()(3 * 3600 + 4 * 60)).toBe("3h 04m");
  });
  it("is null for a missing or bad age, never zero", () => {
    for (const v of [null, undefined, "60", -1, NaN, Infinity]) expect(f()(v)).toBeNull();
  });
});

describe("PolarisAssetShared IPsec helpers", () => {
  it("ipsecIsRemoteAccess: FortiClient over IPsec or SSL-VPN only", () => {
    expect(AS.ipsecIsRemoteAccess({ kind: "remote-access" })).toBe(true);
    expect(AS.ipsecIsRemoteAccess({ kind: "ssl-vpn" })).toBe(true);
    expect(AS.ipsecIsRemoteAccess({ kind: "advpn-spoke" })).toBe(false);
  });
  it("ipsecUptimeLabel: m / h m / d h, null without a start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
    expect(AS.ipsecUptimeLabel(null)).toBeNull();
    expect(AS.ipsecUptimeLabel("")).toBeNull();
    expect(AS.ipsecUptimeLabel("2026-11-06T11:59:50Z")).toBe("1m");
    expect(AS.ipsecUptimeLabel("2026-11-06T11:20:00Z")).toBe("40m");
    expect(AS.ipsecUptimeLabel("2026-11-06T06:48:00Z")).toBe("5h 12m");
    expect(AS.ipsecUptimeLabel("2026-11-03T08:00:00Z")).toBe("3d 04h");
  });
});

describe("PolarisAssetShared.childFilterMatches", () => {
  const m = (text: string[], macs: string[], filter: string) => AS.childFilterMatches(text, macs, filter);
  it("an empty filter matches everything", () => expect(m([], [], "")).toBe(true));
  it("substring over every field", () => {
    expect(m(["10.41.30.7"], [], "41.30")).toBe(true);
    expect(m(["host"], ["aa:bb:a0:12:00:01"], "a0:12")).toBe(true);
  });
  it("MAC fragments match without separators, on an octet boundary only", () => {
    expect(m([], ["AA:BB:A0:12:00:01"], "a012")).toBe(true);
    expect(m([], ["AA:BB:A0:12:00:01"], "a0-12")).toBe(true);
    expect(m([], ["AA:BB:A0:12:00:01"], "a0.12")).toBe(true);
    expect(m([], ["AA:BA:01:00:00:00"], "a0")).toBe(false);
  });
  it("a non-hex filter does not take the MAC path", () => expect(m([], ["AA:BB:CC:DD:EE:FF"], "zz")).toBe(false));
});

describe("PolarisAssetShared.buildWirelessTree", () => {
  const radios = [
    { radioIndex: 1, vaps: [{ ssid: "Corp", bssid: "aa:aa:aa:aa:aa:01" }, { ssid: "Guest", bssid: null }] },
    { radioIndex: 2, vaps: [] },
  ];
  it("files by BSSID first, then (radio, SSID), and returns what it cannot file", () => {
    const tree = AS.buildWirelessTree(radios, [
      { mac: "1", bssid: "AA:AA:AA:AA:AA:01", radioId: 2, ssid: "Wrong" },
      { mac: "2", bssid: null, radioId: 1, ssid: "guest" },
      { mac: "3", bssid: null, radioId: 2, ssid: "Corp" },
    ]);
    expect(tree.radios).toHaveLength(2);
    expect(tree.radios[0].vaps[0].stations.map((s: any) => s.mac)).toEqual(["1"]);
    expect(tree.radios[0].vaps[1].stations.map((s: any) => s.mac)).toEqual(["2"]);
    expect(tree.unplaced.map((s: any) => s.mac)).toEqual(["3"]);
  });
});

describe("PolarisAssetShared booking helpers (rule 93)", () => {
  it("fwLocalInputValue is a datetime-local value in the local zone", () => {
    expect(AS.fwLocalInputValue(new Date(2030, 0, 2, 8, 5))).toBe("2030-01-02T08:05");
  });
  it("fwParseEmails splits on commas, semicolons and whitespace", () => {
    expect(AS.fwParseEmails(" a@x.com, b@x.com;c@x.com\nd@x.com ,, ")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
    expect(AS.fwParseEmails(null)).toEqual([]);
  });
  // DRIFT PIN: the phone's copy dropped the year and the zone name. Both
  // surfaces now say both — a booking is an absolute instant.
  it("fwWhenText carries the year and the zone name, then the relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    const at = new Date("2026-10-07T09:00:00Z");
    const expected = at.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    const txt = AS.fwWhenText(at.toISOString());
    expect(txt).toBe(expected + " (in 9 h)");
    expect(txt).toContain("2026");
  });
  it("fwWhenText relative buckets and a bad date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    expect(AS.fwWhenText("2026-10-06T23:00:00Z")).toMatch(/\(due now\)$/);
    expect(AS.fwWhenText("2026-10-07T00:30:00Z")).toMatch(/\(in 30 min\)$/);
    expect(AS.fwWhenText("2026-10-12T00:00:00Z")).toMatch(/\(in 5 days\)$/);
    expect(AS.fwWhenText("nope")).toBe("");
  });
});

describe("PolarisAssetShared storage helpers", () => {
  it("storageHealthState: good / bad / neutral", () => {
    for (const w of ["ONLINE", "healthy", "STARTED", "DISK_OK", "OK", "PASSED"]) expect(AS.storageHealthState(w)).toBe("good");
    for (const w of ["FAULTED", "UNAVAIL", "DEGRADED", "STOPPED", "DISK_DSBL", "FAILED"]) expect(AS.storageHealthState(w)).toBe("bad");
    for (const w of ["SCRUBBING", "", null, undefined]) expect(AS.storageHealthState(w)).toBe("neutral");
  });
  // DRIFT PIN: the desktop copy could return a SMART string or undefined;
  // the verdict is a boolean on both surfaces now.
  it("poolMemberUnhealthy is a boolean verdict", () => {
    expect(AS.poolMemberUnhealthy({ health: "ONLINE" })).toBe(false);
    expect(AS.poolMemberUnhealthy({ health: "ONLINE", smart: "" })).toBe(false);
    expect(AS.poolMemberUnhealthy({ health: "ONLINE", smart: "PASSED" })).toBe(false);
    expect(AS.poolMemberUnhealthy({ health: "ONLINE", smart: "FAILING" })).toBe(true);
    expect(AS.poolMemberUnhealthy({ health: "ONLINE", checksumErrors: 1 })).toBe(true);
    expect(AS.poolMemberUnhealthy({ health: "FAULTED" })).toBe(true);
    expect(AS.poolMemberUnhealthy({})).toBe(false);
  });
  it("poolScanText", () => {
    expect(AS.poolScanText(null)).toBe("");
    expect(AS.poolScanText({ kind: "scrub", state: "finished", at: "T", errors: 0 })).toBe("Scrub: finished AGO(T), 0 errors");
    expect(AS.poolScanText({ kind: "parity-check", state: "running", percent: 41.25, at: "T" })).toBe("Parity check: running (41.3%) started AGO(T)");
    expect(AS.poolScanText({ kind: "resilver", errors: 1 })).toBe("Resilver: —, 1 error");
  });
});

describe("PolarisAssetShared.sdwanMemberColor", () => {
  it("colours by position in the member list, wrapping; unknown → first; none → grey", () => {
    const pal = AS.SDWAN_MEMBER_COLORS;
    const members = Array.from({ length: 10 }, (_, i) => "wan" + i);
    expect(AS.sdwanMemberColor("wan1", members)).toBe(pal[1]);
    expect(AS.sdwanMemberColor("wan9", members)).toBe(pal[9 % pal.length]);
    expect(AS.sdwanMemberColor("nope", members)).toBe(pal[0]);
    expect(AS.sdwanMemberColor("", members)).toBe("#7b8794");
  });
});

// ─── chart-shared.js ────────────────────────────────────────────────────────

describe("PolarisChartShared verdict colours", () => {
  it("match the alert email's (src/utils/sparklineSvg.ts)", () => {
    const src = read("src/utils/sparklineSvg.ts");
    for (const k of ["FAIL_COLOR", "DEP_COLOR", "MISS_COLOR", "RECOVER_COLOR"]) {
      const m = new RegExp(`const ${k} = "(#[0-9a-fA-F]{6})"`).exec(src);
      expect(m, k).not.toBeNull();
      expect(CS[k]).toBe(m![1]);
    }
  });
  it("chartPointColor: rec blue, dep grey, miss amber, down severity or red; null-safe", () => {
    expect(CS.chartPointColor({ ok: true }, "S")).toBe("S");
    expect(CS.chartPointColor({ ok: true, rec: true }, "S")).toBe(CS.RECOVER_COLOR);
    expect(CS.chartPointColor({ ok: false, dep: true, down: false }, "S")).toBe(CS.DEP_COLOR);
    expect(CS.chartPointColor({ ok: false, down: false }, "S")).toBe(CS.MISS_COLOR);
    expect(CS.chartPointColor({ ok: false, down: true, downColor: "#123456" }, "S")).toBe("#123456");
    expect(CS.chartPointColor({ ok: false }, "S")).toBe(CS.FAIL_COLOR);
    expect(CS.chartPointColor(null, "S")).toBe(CS.FAIL_COLOR);
  });
});

describe("PolarisChartShared outage helpers", () => {
  const min = 60_000;
  it("medianCadenceMs needs three stamps", () => {
    expect(CS.medianCadenceMs([0, min])).toBe(0);
    expect(CS.medianCadenceMs([0, min, 2 * min, 5 * min])).toBe(min);
    expect(CS.medianCadenceMs(null)).toBe(0);
  });
  it("seriesReportedThrough: interior sample, or no hole around the window", () => {
    expect(CS.seriesReportedThrough([0, 5 * min, 10 * min], min, 4 * min, 6 * min)).toBe(true);
    expect(CS.seriesReportedThrough([0, min, 2 * min], min, min, 2 * min)).toBe(true);
    expect(CS.seriesReportedThrough([0, min, 10 * min], min, 2 * min, 3 * min)).toBe(false);
    expect(CS.seriesReportedThrough([0, 10 * min], 0, 2 * min, 3 * min)).toBe(false);
  });
  it("outageMarkers: both ends, dep flag, sorted; a reported-through window is dropped whole", () => {
    const ts = Array.from({ length: 20 }, (_, i) => i * min);
    const sampled = ts.filter((t) => t < 5 * min || t > 9 * min);
    const out = CS.outageMarkers([{ from: new Date(6 * min).toISOString(), to: new Date(8 * min).toISOString(), kind: "dependency" }], sampled);
    expect(out).toEqual([{ t: 6 * min, dep: true }, { t: 8 * min, dep: true }]);
    expect(CS.outageMarkers([{ from: new Date(6 * min).toISOString(), to: new Date(8 * min).toISOString() }], ts)).toEqual([]);
    expect(CS.outageMarkers([{ from: "nope", to: "nope" }], sampled)).toEqual([]);
    expect(CS.outageMarkers(undefined, sampled)).toEqual([]);
  });
});

describe("PolarisChartShared.inChartWindow", () => {
  const rows = [{ timestamp: "2026-11-06T00:59:00Z" }, { timestamp: "2026-11-06T01:00:00Z" }, { timestamp: "2026-11-06T01:01:00Z" }];
  it("keeps rows at or after `since` (ISO or ms), any key", () => {
    expect(CS.inChartWindow(rows, "2026-11-06T01:00:00Z")).toEqual(rows.slice(1));
    expect(CS.inChartWindow(rows, Date.parse("2026-11-06T01:00:00Z"))).toEqual(rows.slice(1));
    const pts = [{ t: 1 }, { t: 5 }];
    expect(CS.inChartWindow(pts, 3, "t")).toEqual([pts[1]]);
  });
  it("no or bad `since` keeps every row; no rows is []", () => {
    expect(CS.inChartWindow(rows, null)).toBe(rows);
    expect(CS.inChartWindow(rows, "not a date")).toBe(rows);
    expect(CS.inChartWindow(undefined, "2026-11-06T01:00:00Z")).toEqual([]);
  });
});

describe("PolarisChartShared.derivePerIntervalSeries", () => {
  // DRIFT PIN: the phone's copy keyed points `ts`; both read `timestamp` now.
  it("detail tier: pairwise rates keyed `timestamp`, wraps dropped", () => {
    const out = CS.derivePerIntervalSeries([
      { timestamp: "2026-11-06T00:00:00Z", inOctets: 0, outOctets: 100, inErrors: 0, outErrors: 5 },
      { timestamp: "2026-11-06T00:01:00Z", inOctets: 600, outOctets: 50, inErrors: 2, outErrors: 5 },
    ], { bucketSeconds: 0 });
    expect(out).toEqual([{ timestamp: "2026-11-06T00:01:00Z", inBps: 80, outBps: null, inErr: 2, outErr: 0 }]);
  });
  // DRIFT PIN: the desktop copy threw on null samples and emitted NaN rates
  // for an unparseable pair; both now skip.
  it("detail tier: null samples → [], a non-advancing or unparseable pair yields no point", () => {
    expect(CS.derivePerIntervalSeries(null, null)).toEqual([]);
    expect(CS.derivePerIntervalSeries([
      { timestamp: "bad", inOctets: 0 }, { timestamp: "2026-11-06T00:01:00Z", inOctets: 10 },
      { timestamp: "2026-11-06T00:01:00Z", inOctets: 20 },
    ], {})).toEqual([]);
  });
  it("rollup tier: per-bucket rates, errors × bucket, the bucket max", () => {
    const out = CS.derivePerIntervalSeries([
      { timestamp: "T", inBytesPerSec: 10, outBytesPerSec: null, inErrorsPerSec: 0.5, outErrorsPerSec: 0, maxInBytesPerSec: 20 },
    ], { bucketSeconds: 60 });
    expect(out).toEqual([{ timestamp: "T", inBps: 80, outBps: null, inErr: 30, outErr: 0, inMaxBps: 160, outMaxBps: null }]);
  });
});

describe("PolarisChartShared memory bands", () => {
  it("agent sample → agent vocabulary with table + free", () => {
    const b = CS.memBandsFor({ memTotalBytes: 100, memUsedBytes: 40, memBuffersBytes: 10, memCachedBytes: 20, swapUsedBytes: 1, swapTotalBytes: 2 });
    expect(b).toEqual({
      kind: "agent", table: CS.MEM_BANDS_AGENT, values: { processes: 40, buffers: 10, cache: 20 },
      total: 100, free: 30, inUse: 70, swapUsed: 1, swapTotal: 2,
    });
  });
  it("vSphere columns switch the vocabulary; unreported bands are null", () => {
    const b = CS.memBandsFor({ memTotalBytes: 100, memPrivateBytes: 50, memBalloonedBytes: 10 });
    expect(b.kind).toBe("vsphere");
    expect(b.table).toBe(CS.MEM_BANDS_VSPHERE);
    expect(b.values.consumed).toBeNull();
    expect(b.inUse).toBe(60);
  });
  // DRIFT PIN: the phone's copy coerced numeric strings; the API sends
  // numbers, so anything else is "not reported" on both surfaces.
  it("a non-number reading is not reported, never coerced", () => {
    expect(CS.memBandsFor({ memTotalBytes: "100", memUsedBytes: 40 })).toBeNull();
    expect(CS.memBandsFor({ memTotalBytes: 100, memUsedBytes: "40" })).toBeNull();
    expect(CS.memBandsFor({ memPct: 50 })).toBeNull();
    expect(CS.numOrNull(NaN)).toBeNull();
  });
  it("memAgentBandsFor relabels for TrueNAS / Proxmox hosts, same keys + colours", () => {
    expect(CS.memAgentBandsFor(null)).toBe(CS.MEM_BANDS_AGENT);
    const tn = CS.memAgentBandsFor({ virtualization: { platform: "truenas", role: "host" } });
    const px = CS.memAgentBandsFor({ virtualization: { platform: "proxmox", role: "host" } });
    expect(tn.map((b: any) => b.label)).toEqual(["Services", "Buffers", "ZFS Cache"]);
    expect(px.map((b: any) => b.label)).toEqual(["Used", "Buffers", "ZFS ARC"]);
    for (const t of [tn, px]) {
      expect(t.map((b: any) => [b.key, b.color])).toEqual(CS.MEM_BANDS_AGENT.map((b: any) => [b.key, b.color]));
    }
    expect(CS.memAgentBandsFor({ virtualization: { platform: "truenas", role: "guest" } })).toBe(CS.MEM_BANDS_AGENT);
  });
});

// ─── Parity that stays a parity (not shared on purpose) ─────────────────────

describe("source labels: phone vs desktop", () => {
  // The desktop map lives in app.js (every desktop page; the phone loads its
  // own mobile/app.js instead), so the phone keeps a copy — held equal here.
  function objectLiteral(src: string, marker: string): Record<string, string> {
    const start = src.indexOf(marker);
    expect(start, marker).toBeGreaterThan(-1);
    const open = src.indexOf("{", start);
    const close = src.indexOf("};", open);
    return new Function("return " + src.slice(open, close + 1))();
  }
  it("mobile SOURCE_LABELS equals app.js _assetSourceLabels", () => {
    const desktop = objectLiteral(appSource(), "var _assetSourceLabels = {");
    const phone = objectLiteral(read("public/js/mobile/asset-detail.js"), "var SOURCE_LABELS = {");
    expect(phone).toEqual(desktop);
  });
});

// ─── Script order ───────────────────────────────────────────────────────────

function scriptOrder(html: string): string[] {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
}
function expectBefore(list: string[], first: string, then: string, where: string) {
  const a = list.indexOf(first), b = list.indexOf(then);
  expect(a, `${where}: ${first} missing`).toBeGreaterThan(-1);
  expect(b, `${where}: ${then} missing`).toBeGreaterThan(-1);
  expect(a, `${where}: ${first} must load before ${then}`).toBeLessThan(b);
}

describe("every page that runs a consumer loads the shared modules first", () => {
  const pages = readdirSync(resolve(root, "public")).filter((f) => f.endsWith(".html"));
  const desktop = pages.filter((p) => scriptOrder(read("public/" + p)).includes("/js/assets.js"));

  it("the desktop pages are the ones we expect (a new one must be added here on purpose)", () => {
    expect(desktop.sort()).toEqual(["appmap.html", "assets.html", "automations.html", "index.html", "map.html", "path-monitor.html"]);
  });
  it.each(desktop)("%s loads chart-shared.js and asset-shared.js before assets.js", (page) => {
    const list = scriptOrder(read("public/" + page));
    expectBefore(list, "/js/chart-shared.js", "/js/assets.js", page);
    expectBefore(list, "/js/asset-shared.js", "/js/assets.js", page);
    // The To / Cc / Bcc picker the wizard binds and the upgrade / reboot dialogs use (rule 93).
    expectBefore(list, "/js/recipient-picker.js", "/js/automations-wizard.js", page);
  });
  it("mobile.html loads them before every phone file that reads them", () => {
    const list = scriptOrder(read("public/mobile.html"));
    for (const user of ["/js/mobile/charts.js", "/js/mobile/telemetry-charts.js", "/js/mobile/asset-detail.js"]) {
      expectBefore(list, "/js/chart-shared.js", user, "mobile.html");
      expectBefore(list, "/js/asset-shared.js", user, "mobile.html");
    }
    expectBefore(list, "/js/recipient-picker.js", "/js/mobile/asset-detail.js", "mobile.html");
    // endpointNodeColor lives on PolarisTopologyRender now.
    expectBefore(list, "/js/topology-render.js", "/js/mobile/topology-tab.js", "mobile.html");
  });
  it("the on-demand asset-panel bundle in app.js loads them before assets.js", () => {
    const src = appSource();
    const start = src.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
    const asset = src.slice(src.indexOf("asset: [", start), src.indexOf("]", src.indexOf("asset: [", start)));
    const list = [...asset.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
    expectBefore(list, "/js/chart-shared.js", "/js/assets.js", "app.js asset bundle");
    expectBefore(list, "/js/asset-shared.js", "/js/assets.js", "app.js asset bundle");
    expectBefore(list, "/js/recipient-picker.js", "/js/automations-wizard.js", "app.js asset bundle");
  });
});

describe("no copy creeps back", () => {
  it("the phone files no longer define the shared helpers", () => {
    const detail = read("public/js/mobile/asset-detail.js");
    for (const n of ["arpAgeLabel", "ipsecIsRemoteAccess", "ipsecUptime", "tableFilterMatches", "buildWirelessTree",
      "fwLocalInputValue", "fwWhenText", "fwParseEmails", "memberUnhealthy", "poolScanText", "inWindow",
      "deriveInterfaceSeries", "sdwanColor"]) {
      expect(detail, n).not.toMatch(new RegExp(`function ${n}\\(`));
    }
    const charts = read("public/js/mobile/charts.js");
    for (const n of ["pointColorFor", "medianCadenceMs", "outageMarkers", "seriesReportedThrough"]) {
      expect(charts, n).not.toMatch(new RegExp(`function ${n}\\(`));
    }
    expect(read("public/js/mobile/telemetry-charts.js")).not.toMatch(/function memBandsFor\(/);
    expect(read("public/js/mobile/topology-tab.js")).not.toMatch(/function endpointNodeColor\(/);
    expect(read("public/js/map.js")).not.toMatch(/function endpointNodeColor\(/);
  });
});
