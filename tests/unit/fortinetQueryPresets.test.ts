/**
 * tests/unit/fortinetQueryPresets.test.ts
 *
 * The FortiManager and FortiGate integrations' API Query consoles ship a
 * Saved Queries list. Every query the discovery code sends must be on it,
 * with the same parameters, so an operator can run exactly what discovery
 * reads when an asset looks wrong. This reads the two discovery services'
 * source, extracts every query they send, and fails on one with no preset.
 *
 * The presets live in public/js/integrations.js between the
 * `// <fortinet-query-presets>` markers — a self-contained block this test
 * slices out and evaluates (the rest of that browser script cannot run here).
 * It also pins the saved-query store: a version bump reseeds the presets and
 * keeps the operator's own saved queries.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { DHCP_MONITOR_FORMAT } from "../../src/utils/fortiosIpv6.js";
import { INVENTORY_QUERY_FORMAT } from "../../src/utils/inventoryLocality.js";
import { FORTIAP_MONITOR_FORMAT } from "../../src/utils/fortiapMonitorRow.js";
import { FORTIOS_INTERFACE_CMDB_FORMAT } from "../../src/utils/fortiosInterfaceRef.js";
import { FORTISWITCH_DISCOVERY_CMDB_FORMAT } from "../../src/utils/fortiswitchCmdb.js";
import {
  DHCP_SERVER_DISCOVERY_FORMAT,
  FIREWALL_VIP_DISCOVERY_FORMAT,
  FORTIAP_WTP_DISCOVERY_FORMAT,
  FORTIAP_WTP_PROFILE_ACCESS_FORMAT,
  SWITCH_LOCAL_ACCESS_FORMAT,
} from "../../src/services/fortigateService.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, "../..", p), "utf8");

interface FmgPreset { name: string; mode?: string; method: string; params?: string; path?: string; query?: string; deviceName?: string; preset?: boolean }
interface FgtPreset { name: string; method: string; path: string; query: string; preset?: boolean }

let fmgProxy: FmgPreset[];
let fmgDirect: FmgPreset[];
let fgt: FgtPreset[];
let sandbox: Record<string, any>;

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeAll(() => {
  const src = read("public/js/integrations.js");
  const start = src.indexOf("// <fortinet-query-presets>");
  const end = src.indexOf("// </fortinet-query-presets>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  sandbox = { localStorage: new MemoryStorage() };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox);
  // Round-trip through JSON so the arrays are plain objects of THIS realm.
  fmgProxy = JSON.parse(JSON.stringify(sandbox._FMG_PROXY_PRESET_QUERIES));
  fmgDirect = JSON.parse(JSON.stringify(sandbox._FMG_DIRECT_PRESET_QUERIES));
  fgt = JSON.parse(JSON.stringify(sandbox._FGT_PRESET_QUERIES));
});

// Every `url` and proxied `resource` in a FortiManager preset's params.
function fmgPresetTargets(): { urls: string[]; resources: string[] } {
  const urls: string[] = [];
  const resources: string[] = [];
  for (const p of fmgProxy) {
    for (const entry of JSON.parse(p.params!) as any[]) {
      if (entry.url === "/sys/proxy/json") resources.push(entry.data.resource);
      else urls.push(entry.url);
    }
  }
  return { urls, resources };
}

// A source template (`/pm/config/device/${deviceName}/…`) as a regex that a
// preset's placeholder URL (`/pm/config/device/<device-name>/…`) must match.
function templateRegex(t: string): RegExp {
  const parts = t.split(/\$\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + parts.join("[^/]+") + "$");
}

const pathOf = (r: string) => r.split("?")[0];

describe("FortiManager presets cover every discovery query", () => {
  const src = read("src/services/fortimanagerService.ts");

  // JSON-RPC urls that are not discovery reads. Adding one here is a decision:
  // say why beside it.
  const NOT_DISCOVERY = [
    "/sys/proxy/json",                                              // the proxy transport itself; its resources are checked below
    "/pm/config/adom/${adom}/obj/fmg/variable/${latKey}/dynamic_mapping", // coordinate write-back (setFmgDeviceMetavarCoords)
    "/pm/config/adom/${adom}/obj/fmg/variable/${lngKey}/dynamic_mapping",
  ];

  const sourceUrls = [...new Set([...src.matchAll(/url: [`"]([^`"]+)[`"]/g)].map((m) => m[1]))]
    .filter((u) => !NOT_DISCOVERY.includes(u));
  const sourceResources = [...new Set([...src.matchAll(/resource: [`"]([^`"]+)[`"]/g)].map((m) => m[1]))];

  it("finds the queries it is meant to check (the extraction still works)", () => {
    expect(sourceUrls.length).toBeGreaterThanOrEqual(12);
    expect(sourceResources.length).toBeGreaterThanOrEqual(7);
  });

  it("has a preset for every native JSON-RPC url", () => {
    const { urls } = fmgPresetTargets();
    const missing = sourceUrls.filter((u) => !urls.some((p) => templateRegex(u).test(p)));
    expect(missing).toEqual([]);
  });

  it("has a proxied preset for every /api/v2 resource", () => {
    const { resources } = fmgPresetTargets();
    const presetPaths = resources.map(pathOf);
    const missing = sourceResources.map(pathOf).filter((p) => !presetPaths.includes(p));
    expect(missing).toEqual([]);
  });

  it("uses discovery's exact literal query string where discovery has one", () => {
    const { resources } = fmgPresetTargets();
    for (const r of sourceResources.filter((x) => x.includes("?") && !x.includes("${"))) {
      expect(resources, r).toContain(r);
    }
  });

  it("asks for the same fields as discovery's native interface read (the `secondaryip` table)", () => {
    const fieldsOf = (s: string, url: string) => {
      const at = s.indexOf(url);
      expect(at, url).toBeGreaterThan(-1);
      const m = /fields: (\[[^\]]*\])/.exec(s.slice(at, at + 400));
      return m ? JSON.parse(m[1]) : null;
    };
    const discovery = fieldsOf(src, "/vdom/root/system/interface`");
    const preset = fmgProxy.flatMap((q) => (q.params ? JSON.parse(q.params) : []))
      .find((p: any) => p.url === "/pm/config/device/<device-name>/vdom/root/system/interface");
    expect(preset?.fields).toEqual(discovery);
    expect(discovery).toContain("secondaryip");
  });

  it("uses discovery's format constant on the proxied switch-config read", () => {
    const { resources } = fmgPresetTargets();
    expect(resources).toContain(`/api/v2/cmdb/switch-controller/managed-switch?format=${FORTISWITCH_DISCOVERY_CMDB_FORMAT}`);
  });

  it("uses the server's format constants for the leases, inventory and FortiAP reads", () => {
    const { resources } = fmgPresetTargets();
    expect(resources).toContain(`/api/v2/monitor/system/dhcp?format=${DHCP_MONITOR_FORMAT}`);
    expect(resources).toContain(`/api/v2/monitor/user/device/query?format=${INVENTORY_QUERY_FORMAT}`);
    expect(resources).toContain(`/api/v2/monitor/wifi/managed_ap?format=${FORTIAP_MONITOR_FORMAT}`);
  });

  it("offers every standalone query in direct-to-FortiGate mode too", () => {
    expect(fmgDirect.map((q) => [q.path, q.query])).toEqual(fgt.map((q) => [q.path, q.query]));
    expect(fmgDirect.every((q) => q.mode === "fortigate" && q.deviceName === "")).toBe(true);
  });

  it("keeps preset names unique per mode", () => {
    const keys = [...fmgProxy, ...fmgDirect].map((q) => `${q.mode}|${q.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("FortiGate presets cover every discovery query", () => {
  const src = read("src/services/fortigateService.ts");
  const CONSTANTS: Record<string, string> = {
    DHCP_MONITOR_FORMAT, INVENTORY_QUERY_FORMAT, FORTIAP_MONITOR_FORMAT,
    FORTIOS_INTERFACE_CMDB_FORMAT, FORTISWITCH_DISCOVERY_CMDB_FORMAT,
    DHCP_SERVER_DISCOVERY_FORMAT, FIREWALL_VIP_DISCOVERY_FORMAT, FORTIAP_WTP_DISCOVERY_FORMAT,
    FORTIAP_WTP_PROFILE_ACCESS_FORMAT, SWITCH_LOCAL_ACCESS_FORMAT,
  };

  // A `format:` naming a constant this map lacks resolves to null and FAILS the
  // format check below — it used to resolve to undefined and be skipped, so a
  // new constant left its preset showing the unfiltered query unnoticed.
  const calls = [...src.matchAll(/fgRequest<[^>]*>\(config, "GET", "([^"]+)",\s*\{\s*query:\s*(\{[^}]*\}|\w+)/g)]
    .map((m) => {
      const fmt = /format:\s*(?:"([^"]+)"|(\w+))/.exec(m[2]);
      return { path: m[1], format: fmt ? (fmt[1] ?? CONSTANTS[fmt[2]] ?? null) : undefined };
    });

  it("finds the queries it is meant to check", () => {
    expect(calls.length).toBeGreaterThanOrEqual(14);
  });

  it("has a preset for every GET path", () => {
    const presetPaths = fgt.map((q) => q.path);
    const missing = [...new Set(calls.map((c) => c.path))].filter((p) => !presetPaths.includes(p));
    expect(missing).toEqual([]);
  });

  it("carries discovery's format string on the preset for that path", () => {
    for (const c of calls.filter((x) => x.format !== undefined)) {
      expect(c.format, `format constant unresolved for ${c.path}`).toBeTruthy();
      const presets = fgt.filter((q) => q.path === c.path);
      expect(presets.some((q) => q.query.split("\n").includes(`format=${c.format}`)), c.path).toBe(true);
    }
  });

  it("keeps preset names unique", () => {
    const names = fgt.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("FortiGate picker suggestions (_fmgGateSuggestions)", () => {
  const gates = [
    { deviceName: "BRANCH-7-61F", hostname: "branch7", ipAddress: "10.7.0.1" },
    { deviceName: "HQ-CLUSTER", hostname: "hq-a", ipAddress: "10.1.1.1" },
    { deviceName: "SITE-HQ-ANNEX", hostname: null, ipAddress: "10.1.9.1" },
  ];
  const names = (q: string) =>
    (JSON.parse(JSON.stringify(sandbox._fmgGateSuggestions(gates, q))) as any[]).map((g) => g.deviceName);

  it("lists every gate for an empty query", () => {
    expect(names("")).toEqual(["BRANCH-7-61F", "HQ-CLUSTER", "SITE-HQ-ANNEX"]);
  });

  it("matches name, hostname or address, case-insensitively, prefix matches first", () => {
    expect(names("hq")).toEqual(["HQ-CLUSTER", "SITE-HQ-ANNEX"]);
    expect(names("BRANCH7")).toEqual(["BRANCH-7-61F"]);
    expect(names("10.1.")).toEqual(["HQ-CLUSTER", "SITE-HQ-ANNEX"]);
  });

  it("returns nothing for no match (the typed name is still sent as typed)", () => {
    expect(names("nowhere")).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ deviceName: `GATE-${i}` }));
    expect(sandbox._fmgGateSuggestions(many, "").length).toBe(sandbox.FMG_GATE_SUGGEST_CAP);
  });
});

describe("saved-query store", () => {
  const make = (version: number, presets: unknown[]) =>
    sandbox._makeSavedQueryStore("test-store", version, presets);

  it("seeds the presets, flagged, on first load", () => {
    sandbox.localStorage.clear();
    const q = make(1, [{ name: "A", path: "/a" }]).load();
    expect(JSON.parse(JSON.stringify(q))).toEqual([{ name: "A", path: "/a", preset: true }]);
  });

  it("keeps the operator's own queries across a version bump", () => {
    sandbox.localStorage.clear();
    const v1 = make(1, [{ name: "A", path: "/a-old" }]);
    const list = v1.load();
    list.push({ name: "Mine", path: "/mine" });
    v1.persist(list);

    const after = JSON.parse(JSON.stringify(make(2, [{ name: "A", path: "/a-new" }, { name: "B", path: "/b" }]).load()));
    expect(after.map((q: any) => q.name)).toEqual(["A", "B", "Mine"]);
    expect(after.find((q: any) => q.name === "A").path).toBe("/a-new");
  });

  it("replaces an unflagged entry (saved before the flag existed) that shares a preset's name and mode", () => {
    sandbox.localStorage.clear();
    sandbox.localStorage.setItem("test-store", JSON.stringify({ v: 4, queries: [
      { name: "System status", mode: "fmg", params: "old" },
      { name: "System status", mode: "fortigate", path: "/old" },
      { name: "My query", mode: "fmg", params: "mine" },
    ] }));
    const after = JSON.parse(JSON.stringify(make(5, [{ name: "System status", mode: "fmg", params: "new" }]).load()));
    expect(after).toEqual([
      { name: "System status", mode: "fmg", params: "new", preset: true },
      // Same name, other mode: not this preset, so it is the operator's.
      { name: "System status", mode: "fortigate", path: "/old" },
      { name: "My query", mode: "fmg", params: "mine" },
    ]);
  });

  it("drops a flagged preset the new version no longer ships", () => {
    sandbox.localStorage.clear();
    make(1, [{ name: "Retired", path: "/r" }]).load();
    const after = JSON.parse(JSON.stringify(make(2, [{ name: "Kept", path: "/k" }]).load()));
    expect(after.map((q: any) => q.name)).toEqual(["Kept"]);
  });

  it("does not reseed when the version matches", () => {
    sandbox.localStorage.clear();
    const s = make(3, [{ name: "A" }]);
    const list = s.load();
    list.splice(0, 1);
    s.persist(list);
    expect(JSON.parse(JSON.stringify(make(3, [{ name: "A" }]).load()))).toEqual([]);
  });
});
