/**
 * tests/unit/assetDeviceQueryTab.test.ts — the asset slide-over's tab order
 * and its Device Query tab (SNMP Walk + API Query sub-tabs):
 *   - every tab the slide-over pushes has a slot in _ASSET_VIEW_TAB_ORDER,
 *   - the operator's order (2026-11-04) holds whatever order tabs are pushed in,
 *   - the API Query sub-tab picks its transport from the discovering
 *     integration and the integrations=write gate,
 *   - each transport's request body is the shape POST /integrations/:id/query
 *     reads for that integration type, and every one is a GET.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const src = readFileSync(resolve(ROOT, "public/js/assets.js"), "utf8");

function sliceFn(name: string): string {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

function sliceArrayVar(name: string): string {
  const start = src.indexOf("var " + name + " = [");
  if (start < 0) throw new Error("no var " + name);
  return src.slice(start, src.indexOf("];", start) + 2);
}

function load(perm: (key: string, level: string) => boolean) {
  const names = ["_orderAssetViewTabs", "_assetApiQueryTransport", "_assetApiQueryParseParams", "_assetApiQueryPayload"];
  const body = sliceArrayVar("_ASSET_VIEW_TAB_ORDER") + "\n" +
    names.map(sliceFn).join("\n") +
    "\nreturn { order: _ASSET_VIEW_TAB_ORDER, " + names.join(",") + " };";
  return new Function("permAtLeast", body)(perm);
}

const all = load(() => true);

describe("asset slide-over tab order", () => {
  it("names every tab the slide-over pushes", () => {
    const keys = new Set<string>();
    for (const m of src.matchAll(/tabs\.push\(\{ key: "(\w+)"/g)) keys.add(m[1]);
    keys.add("general");
    keys.add("system");
    const missing = [...keys].filter((k) => !all.order.includes(k));
    expect(missing).toEqual([]);
  });

  it("puts the operator's list in order regardless of push order", () => {
    const pushed = ["general", "system", "stations", "sdwan", "ipsec", "mactable", "arptable",
      "events", "notifications", "devicequery", "sources"].map((key) => ({ key }));
    expect(all._orderAssetViewTabs(pushed).map((t: { key: string }) => t.key)).toEqual([
      "general", "system", "sdwan", "ipsec", "arptable", "mactable", "stations",
      "events", "notifications", "devicequery", "sources",
    ]);
  });

  it("sorts an unknown key just before Sources and keeps it", () => {
    const out = all._orderAssetViewTabs([{ key: "sources" }, { key: "brandNew" }, { key: "general" }]);
    expect(out.map((t: { key: string }) => t.key)).toEqual(["general", "brandNew", "sources"]);
  });
});

describe("API Query transport", () => {
  const fgt = { id: "a1", assetType: "firewall", hostname: "gw", discoveredByIntegration: { id: "i1", type: "fortigate", name: "Edge" } };
  const fmg = (useProxy: boolean, topo: Record<string, unknown> = { deviceName: "FMG-NAME" }) => ({
    id: "a2", assetType: "firewall", hostname: "gate-host", fortinetTopology: topo,
    discoveredByIntegration: { id: "i2", type: "fortimanager", name: "FMG", useProxy, adom: "corp" },
  });

  it("is absent without integrations=write", () => {
    expect(load(() => false)._assetApiQueryTransport(fgt)).toBeNull();
  });

  it("is absent on a non-firewall or a non-Fortinet integration", () => {
    expect(all._assetApiQueryTransport({ ...fgt, assetType: "switch" })).toBeNull();
    expect(all._assetApiQueryTransport({ ...fgt, discoveredByIntegration: { id: "v", type: "vcenter" } })).toBeNull();
    expect(all._assetApiQueryTransport({ ...fgt, discoveredByIntegration: null })).toBeNull();
  });

  it("goes direct on a standalone FortiGate integration", () => {
    expect(all._assetApiQueryTransport(fgt)).toMatchObject({ kind: "fortigate", integrationId: "i1" });
  });

  it("uses FMG's device name, not the hostname, and the integration's proxy mode", () => {
    expect(all._assetApiQueryTransport(fmg(true))).toMatchObject({ kind: "fmg-proxy", deviceName: "FMG-NAME", adom: "corp" });
    expect(all._assetApiQueryTransport(fmg(false))).toMatchObject({ kind: "fmg-direct", deviceName: "FMG-NAME" });
  });

  it("falls back to the hostname for a row with no device-name stamp", () => {
    expect(all._assetApiQueryTransport(fmg(true, {}))).toMatchObject({ deviceName: "gate-host" });
  });
});

describe("API Query request bodies", () => {
  const params = all._assetApiQueryParseParams("vdom=root\n\nformat=name|ip\nbare");

  it("parses key=value lines", () => {
    expect(params).toEqual({ vdom: "root", format: "name|ip", bare: "" });
  });

  it("standalone FortiGate: a plain GET", () => {
    expect(all._assetApiQueryPayload({ kind: "fortigate" }, "/api/v2/monitor/system/status", params))
      .toEqual({ method: "GET", path: "/api/v2/monitor/system/status", query: params });
  });

  it("FMG direct: mode fortigate with the device name", () => {
    expect(all._assetApiQueryPayload({ kind: "fmg-direct", deviceName: "GW1" }, "/p", { vdom: "root" }))
      .toEqual({ mode: "fortigate", deviceName: "GW1", method: "GET", path: "/p", query: { vdom: "root" } });
  });

  it("FMG proxy: a JSON-RPC exec whose proxied resource carries the query string", () => {
    const p = all._assetApiQueryPayload({ kind: "fmg-proxy", deviceName: "GW 1", adom: "corp" }, "/api/v2/monitor/system/dhcp", params);
    expect(p.mode).toBe("fmg");
    expect(p.method).toBe("exec");
    expect(p.params).toEqual([{
      url: "/sys/proxy/json",
      data: {
        target: ["/adom/corp/device/GW 1"],
        action: "get",
        resource: "/api/v2/monitor/system/dhcp?vdom=root&format=name%7Cip&bare",
      },
    }]);
  });
});
