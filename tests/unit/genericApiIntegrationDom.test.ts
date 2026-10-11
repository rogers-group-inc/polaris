/**
 * tests/unit/genericApiIntegrationDom.test.ts — DOM smoke for the Generic API
 * branches in public/js/integrations.js (the workloadIntegrationDom harness).
 * Targets the failures that are silent in the browser: a missed dispatcher
 * (the FortiManager form renders instead), a tab set that grows a Monitoring
 * tab, the auth / pagination fields not following their pickers, and the
 * four-places round trip (schema / service / form + reader / edit defaults)
 * for every field the dialog collects.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = readFileSync(resolve(__dirname, "../../public/js/integrations.js"), "utf8");
const DOWN_AFTER_SRC = readFileSync(resolve(__dirname, "../../public/js/monitor-down-after.js"), "utf8");
const PORTABILITY_SRC = readFileSync(resolve(__dirname, "../../public/js/genericapi-portability.js"), "utf8");

let scope: Record<string, any>;
let previewCalls: any[] = [];

/** `withPortability` loads genericapi-portability.js first, as integrations.html does. */
function boot(withPortability = false): Record<string, any> {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  const stubs = `
    function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    function showToast(){}
    function openModal(){}
    function closeModal(){}
    function copyTextToClipboard(){ return Promise.resolve(true); }
    function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ""; }
    var api = { integrations: {}, credentials: {}, monitorSettings: {} };
    var permAtLeast = function(){ return true; };
    var __downloads = [];
    function downloadJson(obj, filename){ __downloads.push({ obj: obj, filename: filename }); }
  `;
  (win as any).eval(APP_SHELL_STUBS + "\n" + stubs + "\n" + (withPortability ? PORTABILITY_SRC + "\n" : "") + DOWN_AFTER_SRC + "\n" + SRC + "\n;window.__scope = this;");
  return win as unknown as Record<string, any>;
}

/** Render both form tabs from a stored-config blob, the way the edit flow does. */
function mount(config: Record<string, unknown>, intg: Record<string, unknown> = {}) {
  const spec = scope._intgEditFormSpec({ type: "genericapi", name: "CMDB", enabled: true, autoDiscover: true, pollInterval: 6, ...intg }, config);
  const tabs = scope._integrationTabs({ type: "genericapi", mode: "edit", id: "i1", config, defaults: spec.defaults, generalHtml: spec.body });
  scope.document.body.innerHTML = tabs.map((t: any) => `<div data-key="${t.key}">${t.html}</div>`).join("");
  scope._wireGenericApiForm("i1");
  return { spec, tabs };
}

const stored = {
  host: "cmdb.example.com",
  port: 8443,
  useHttps: true,
  verifySsl: false,
  method: "POST",
  path: "/api/v2/devices?status=active",
  body: '{"filter":{"active":true}}',
  headers: [{ name: "X-Tenant", value: "east" }],
  authType: "header",
  apiToken: "••••••••",
  authHeaderName: "X-Auth",
  authQueryParam: "api_key",
  username: "",
  password: "",
  tokenUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  pagination: { mode: "cursor", pageParam: "", sizeParam: "", pageSize: 100, startPage: 1, cursorPath: "meta.next", cursorParam: "after", maxPages: 40 },
  recordsPath: "data.devices",
  fieldMap: {
    id: "uuid", hostname: "name", ipAddress: "ips", macAddress: "nics[*].mac", serialNumber: "serial", model: "model", assetType: "kind", location: "site.name",
    department: "owner.dept", tags: "labels[*]", warrantyExpiry: "warranty.end", latitude: "geo.lat", longitude: "geo.lng",
  },
  detailQueries: [
    { name: "Hardware", method: "POST", path: "/api/devices/{{uuid}}/hw", body: '{"id":"{{uuid}}"}', fieldMap: { serialNumber: "hw.serial", assetTag: "hw.tag" } },
    { name: "", method: "GET", path: "/api/owners/{{owner.id}}", body: "", fieldMap: { assignedTo: "email" } },
  ],
  detailConcurrency: 6,
  networkQueries: [
    { name: "Prefixes", kind: "subnets", method: "GET", path: "/api/ipam/prefixes", body: "", recordsPath: "results", paginate: true, map: { cidr: "prefix", name: "description", vlan: "vlan.vid" } },
    { name: "Leases", kind: "leases", method: "POST", path: "/api/dhcp/leases", body: '{"active":true}', recordsPath: "", paginate: false, map: { ipAddress: "ip", macAddress: "mac", expiresAt: "ends" } },
  ],
  releaseMissingAddresses: true,
  deprecateMissingSubnets: false,
  readDevices: true,
  monitorQueries: [
    {
      name: "Status", stream: "responseTime", scope: "fleet", method: "GET", path: "/api/status", body: "",
      recordsPath: "items", matchPath: "serial", paginate: true, itemsPath: "",
      map: { up: "state", latencyMs: "rtt" }, upValues: ["online", "ok"], byteUnit: "B", widgets: [], useByDefault: true,
    },
    {
      name: "Ports", stream: "interfaces", scope: "asset", method: "GET", path: "/api/devices/{{identity}}/ports", body: "",
      recordsPath: "", matchPath: "", paginate: false, itemsPath: "ports",
      map: { name: "id", operStatus: "link", inOctets: "rx" }, upValues: [], byteUnit: "B", widgets: [], useByDefault: false,
    },
    {
      name: "Disks", stream: "storage", scope: "fleet", method: "POST", path: "/api/disks", body: '{"all":true}',
      recordsPath: "", matchPath: "device", paginate: false, itemsPath: "volumes",
      map: { mountPath: "label", total: "size", used: "used" }, upValues: [], byteUnit: "GB", widgets: [], useByDefault: true,
    },
    {
      name: "Supplies", stream: "widgets", scope: "asset", method: "GET", path: "/api/devices/{{identity}}", body: "",
      recordsPath: "", matchPath: "", paginate: false, itemsPath: "",
      map: {}, upValues: [], byteUnit: "B", useByDefault: true,
      widgets: [
        { name: "Toner", type: "gauge", path: "supplies.toner", unit: "%", min: 0, max: 100, warningAt: 15 },
        { name: "Pages", type: "line", path: "counters.pages" },
        { name: "Door", type: "state", path: "door", stateMap: { mode: "notEquals", values: ["closed"], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true } },
      ],
    },
  ],
  identityField: "serialNumber",
  assetTypeDefault: "printer",
  assetTypeMap: { "Network Camera": "other", "Core Switch": "switch" },
  manufacturerDefault: "Axis",
  deviceInclude: [],
  deviceExclude: ["lab-*"],
  decommissionMissing: true,
  verifyPresence: false,
  maxRecords: 2500,
  requestTimeoutMs: 45000,
  verboseLogging: false,
};

beforeEach(() => {
  scope = boot();
  previewCalls = [];
  scope.api.integrations.genericApiPreview = async (body: any) => {
    previewCalls.push(body);
    return {
      ok: true,
      message: "First page: 2 record(s)",
      sampleRecord: { uuid: "a", name: "<b>cam</b>" },
      rows: [
        { index: 0, outcome: { ok: true, record: { identity: "SN1", hostname: "<b>cam</b>", ipAddress: "10.0.0.1", rawAssetType: "Network Camera", assetType: "other" } }, filteredOut: false },
        { index: 1, outcome: { ok: false, reason: 'no usable serialNumber at "serial"' }, filteredOut: false },
      ],
      warnings: ["Stopped at the page limit"],
    };
  };
});

describe("registries", () => {
  it("names the product, routes the form + reader, and is NOT a Monitoring-tab type", () => {
    expect(scope._productForType("genericapi")).toBe("Generic API");
    expect(scope._formHTMLForType("genericapi", {})).toContain('id="f-gaAuthType"');
    expect(scope._NON_FORTINET_TABBED).not.toContain("genericapi");
    expect(scope._integrationRequires("genericapi", "create")).toEqual([["f-host", "host"]]);
  });

  it("has its own four tabs — General, Records & Mapping, Monitoring (monitor queries), Preview — never the shared Monitoring tab", () => {
    const { tabs } = mount(stored);
    expect(tabs.map((t: any) => t.key)).toEqual(["general", "mapping", "monitoring", "network", "preview"]);
    // The shared tab's class-stream form is not what renders here.
    expect(tabs.find((t: any) => t.key === "monitoring").html).toContain('id="f-gaMonitors"');
  });

  it("is offered by the type picker", () => {
    expect(SRC).toContain('id="pick-generic"');
    expect(SRC).toContain('openIntegrationCreateModal("genericapi")');
  });
});

describe("the four-places round trip", () => {
  it("every stored field comes back out of the reader unchanged, the masked secret blank", () => {
    const { spec } = mount(stored);
    const out = spec.formGetter();
    // Blank keep-current secrets are stripped, so the PUT keeps the stored ones.
    expect(out).not.toHaveProperty("apiToken");
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("clientSecret");
    const { apiToken, password, clientSecret, ...rest } = stored;
    void apiToken; void password; void clientSecret;
    expect(out).toEqual(rest);
  });

  it("the edit defaults never carry a secret into the DOM", () => {
    mount({ ...stored, apiToken: "real-token-value" });
    expect(scope.document.body.innerHTML).not.toContain("real-token-value");
    expect((scope.document.getElementById("f-apiToken") as any).placeholder).toMatch(/keep the current token/);
  });
});

describe("the pickers drive their fields", () => {
  it("shows only the chosen auth type's inputs and the chosen paging mode's", () => {
    mount(stored);
    const shown = (sel: string) => [...scope.document.querySelectorAll(sel)].filter((el: any) => el.style.display !== "none").length;
    expect(shown('[data-ga-auth="header"]')).toBe(1);
    expect(shown('[data-ga-auth="basic"]')).toBe(0);
    expect(shown('[data-ga-page="cursor"]')).toBe(2);
    expect(shown('[data-ga-page="page"]')).toBe(0);

    const auth = scope.document.getElementById("f-gaAuthType") as any;
    auth.value = "oauth2";
    auth.dispatchEvent(new scope.Event("change"));
    expect(shown('[data-ga-auth="oauth2"]')).toBe(1);
    expect(shown('[data-ga-auth="header"]')).toBe(0);

    const method = scope.document.getElementById("f-gaMethod") as any;
    method.value = "GET";
    method.dispatchEvent(new scope.Event("change"));
    expect((scope.document.getElementById("f-gaBodyWrap") as any).style.display).toBe("none");
  });
});

describe("Preview", () => {
  it("sends the form's config with blank secrets stripped and the id, and renders escaped rows", async () => {
    mount(stored);
    await scope._runGenericApiPreview("i1");
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0].id).toBe("i1");
    expect(previewCalls[0].config).not.toHaveProperty("apiToken");
    expect(previewCalls[0].config.fieldMap.id).toBe("uuid");
    const html = scope.document.getElementById("f-gaPreviewResult").innerHTML;
    expect(html).toContain("&lt;b&gt;cam&lt;/b&gt;");
    expect(html).not.toContain("<b>cam</b>");
    expect(html).toContain("other (Network Camera)");
    expect(html).toContain("Skipped — no usable serialNumber");
    expect(html).toContain("Stopped at the page limit");
  });

  it("shows each detail query's response, flags a row whose detail failed, and grows a column only when a row has the field", async () => {
    mount(stored);
    scope.api.integrations.genericApiPreview = async () => ({
      ok: true, message: "", warnings: [],
      sampleRecord: { uuid: "a" },
      sampleDetails: [
        { name: "Hardware", path: "/api/devices/a/hw", ok: true, response: { hw: { serial: "<i>SN</i>" } }, error: null },
        { name: "Owner", path: null, ok: false, response: null, error: "the record has no usable value at {{owner.id}}" },
      ],
      rows: [
        { index: 0, outcome: { ok: true, record: { identity: "a", hostname: "cam", tags: ["east", "lobby"], warrantyExpiry: "2027-03-01T00:00:00.000Z" } }, filteredOut: false, detailFailures: ["Owner: boom"] },
      ],
    });
    await scope._runGenericApiPreview("i1");
    const html = scope.document.getElementById("f-gaPreviewResult").innerHTML;
    expect(html).toContain("Detail query “Hardware” — /api/devices/a/hw");
    expect(html).toContain("&lt;i&gt;SN&lt;/i&gt;");
    expect(html).toContain("no usable value at {{owner.id}}");
    expect(html).toContain("(detail query failed)");
    expect(html).toContain("east, lobby");
    expect(html).toContain("2027-03-01");
    expect(html).not.toContain("<th>Department</th>");
  });
});

describe("detail queries", () => {
  const blocks = () => [...scope.document.querySelectorAll("[data-ga-detail]")] as any[];

  it("Add appends an empty block, Remove deletes one, and an untouched blank block is not saved", () => {
    mount(stored);
    expect(blocks()).toHaveLength(2);
    scope.document.getElementById("f-gaDetailAdd").click();
    expect(blocks()).toHaveLength(3);
    // The new block is blank, so the reader leaves it out.
    expect(scope.getGenericApiFormConfig().detailQueries).toHaveLength(2);
    blocks()[0].querySelector(".ga-detail-remove").click();
    expect(blocks()).toHaveLength(2);
    expect(scope.getGenericApiFormConfig().detailQueries.map((q: any) => q.path)).toEqual(["/api/owners/{{owner.id}}"]);
  });

  it("stops at five blocks", () => {
    mount(stored);
    for (let i = 0; i < 6; i++) scope.document.getElementById("f-gaDetailAdd").click();
    expect(blocks()).toHaveLength(5);
  });

  it("the method picker shows the body only for POST", () => {
    mount(stored);
    const [post, get] = blocks();
    expect(post.querySelector(".ga-detail-body-wrap").style.display).toBe("");
    expect(get.querySelector(".ga-detail-body-wrap").style.display).toBe("none");
    const sel = get.querySelector(".ga-detail-method");
    sel.value = "POST";
    sel.dispatchEvent(new scope.Event("change", { bubbles: true }));
    expect(get.querySelector(".ga-detail-body-wrap").style.display).toBe("");
  });

  it("names a map line it cannot read instead of dropping it silently", () => {
    mount(stored);
    const ta = blocks()[1].querySelector(".ga-detail-map");
    ta.value = "assignedTo = email\nhostnme = name\nid = uuid";
    ta.dispatchEvent(new scope.Event("input", { bubbles: true }));
    const hint = blocks()[1].querySelector(".ga-detail-map-hint").textContent;
    expect(hint).toContain("hostnme = name");
    // The record ID comes from the list query only.
    expect(hint).toContain("id = uuid");
    expect(scope.getGenericApiFormConfig().detailQueries[1].fieldMap).toEqual({ assignedTo: "email" });
  });
});

describe("JSON tab", () => {
  beforeEach(() => {
    scope = boot(true);
    scope.api.integrations.genericApiPreview = async () => ({ ok: true, rows: [], warnings: [] });
  });

  const json = () => JSON.parse((scope.document.getElementById("f-gaJson") as any).value);

  it("is a fourth tab only when the portability module is loaded", () => {
    expect(mount(stored).tabs.map((t: any) => t.key)).toEqual(["general", "mapping", "monitoring", "network", "preview", "json"]);
  });

  it("shows the form as a shareable file: no secret, no connection details, credential header blanked", () => {
    mount({ ...stored, username: "svc-polaris", headers: [{ name: "X-Tenant", value: "east" }, { name: "X-Api-Key", value: "k-123" }] });
    const file = json();
    expect(file.polarisGenericApi).toBe(1);
    expect(file.name).toBe("CMDB");
    expect(file.config).not.toHaveProperty("apiToken");
    expect(file.config).not.toHaveProperty("host");
    expect(file.config).not.toHaveProperty("port");
    expect(file.config).not.toHaveProperty("username");
    expect(file.config).not.toHaveProperty("verboseLogging");
    expect(file.config.headers).toEqual([{ name: "X-Tenant", value: "east" }, { name: "X-Api-Key", value: "" }]);
    expect(file.needs).toEqual(expect.arrayContaining(["token", "host", "port", "username", "header:X-Api-Key"]));
    expect(file.config.detailQueries).toHaveLength(2);
    expect(JSON.stringify(file)).not.toContain("k-123");
  });

  it("includes the connection details when asked", () => {
    mount(stored);
    const box = scope.document.getElementById("f-gaJsonConnection") as any;
    box.checked = true;
    box.dispatchEvent(new scope.Event("change"));
    expect(json().config.host).toBe("cmdb.example.com");
    expect(json().config.port).toBe(8443);
  });

  it("an exported file applied to a blank Add form reproduces the configuration", () => {
    mount(stored);
    const box = scope.document.getElementById("f-gaJsonConnection") as any;
    box.checked = true;
    box.dispatchEvent(new scope.Event("change"));
    const text = (scope.document.getElementById("f-gaJson") as any).value;

    // A fresh Add dialog.
    const generalHtml = scope._formHTMLForType("genericapi", { useHttps: true, verifySsl: true });
    const tabs = scope._integrationTabs({ type: "genericapi", mode: "create", id: null, config: {}, defaults: {}, generalHtml });
    scope.document.body.innerHTML = tabs.map((t: any) => `<div data-key="${t.key}">${t.html}</div>`).join("");
    scope._wireGenericApiForm(null);
    expect(scope._gaApplyJson(text, "x.genericapi.json")).toBe(true);

    expect((scope.document.getElementById("f-name") as any).value).toBe("CMDB");
    const out = scope.getGenericApiFormConfig();
    const { apiToken, password, clientSecret, verboseLogging, ...rest } = stored;
    void apiToken; void password; void clientSecret; void verboseLogging;
    const { verboseLogging: _v, apiToken: _t, password: _p, clientSecret: _c, ...outRest } = out;
    void _v; void _t; void _p; void _c;
    expect(outRest).toEqual(rest);
    expect(scope.document.getElementById("f-gaJsonStatus").textContent).toContain("the token / key");
  });

  it("a file carrying a secret never puts it in the form", () => {
    mount(stored);
    const text = JSON.stringify({ polarisGenericApi: 1, config: { ...stored, apiToken: "smuggled", password: "pw", clientSecret: "cs" } });
    expect(scope._gaApplyJson(text, "")).toBe(true);
    for (const id of ["f-apiToken", "f-password", "f-clientSecret"]) expect((scope.document.getElementById(id) as any).value).toBe("");
    expect(scope.document.body.innerHTML).not.toContain("smuggled");
  });

  it("a file without connection details keeps the host the form already has", () => {
    mount(stored);
    expect(scope._gaApplyJson(JSON.stringify({ polarisGenericApi: 1, config: { path: "/v3/things", recordsPath: "items" } }), "")).toBe(true);
    expect((scope.document.getElementById("f-host") as any).value).toBe("cmdb.example.com");
    expect((scope.document.getElementById("f-gaPath") as any).value).toBe("/v3/things");
    // Everything else follows the file: the detail queries it does not list are gone.
    expect(scope.getGenericApiFormConfig().detailQueries).toEqual([]);
  });

  it("bad JSON is reported on the tab and changes nothing", () => {
    mount(stored);
    expect(scope._gaApplyJson("{ nope", "")).toBe(false);
    expect(scope.document.getElementById("f-gaJsonStatus").textContent).toMatch(/valid JSON/);
    expect((scope.document.getElementById("f-gaPath") as any).value).toBe("/api/v2/devices?status=active");
  });

  it("opening the tab refreshes from the form, but never over JSON the operator is editing", () => {
    const tab = () => scope.document.querySelector('.page-tab[data-tab="json"]') as any;
    const spec = scope._intgEditFormSpec({ type: "genericapi", name: "CMDB", enabled: true, autoDiscover: true, pollInterval: 6 }, stored);
    const tabs = scope._integrationTabs({ type: "genericapi", mode: "edit", id: "i1", config: stored, defaults: spec.defaults, generalHtml: spec.body });
    scope.document.body.innerHTML = '<button class="page-tab" data-tab="json"></button>' + tabs.map((t: any) => `<div>${t.html}</div>`).join("");
    scope._wireGenericApiForm("i1");
    const ta = scope.document.getElementById("f-gaJson") as any;
    const path = scope.document.getElementById("f-gaPath") as any;
    path.value = "/changed";
    tab().click();
    expect(json().config.path).toBe("/changed");
    ta.value = '{"edited": true}';
    ta.dispatchEvent(new scope.Event("input"));
    path.value = "/changed-again";
    tab().click();
    expect(ta.value).toBe('{"edited": true}');
  });

  it("Export downloads the file under the integration's name, re-stripped", () => {
    mount(stored);
    const ta = scope.document.getElementById("f-gaJson") as any;
    const file = json();
    file.config.apiToken = "typed-in-editor";
    ta.value = JSON.stringify(file);
    ta.dispatchEvent(new scope.Event("input"));
    scope.document.getElementById("f-gaJsonExport").click();
    const downloads = scope.eval("__downloads");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("CMDB.genericapi.json");
    expect(downloads[0].obj.config).not.toHaveProperty("apiToken");
  });

  it("never exports the install's own tier-3 monitor settings", () => {
    mount({ ...stored, monitorSettings: { intervalSeconds: 30, responseTimePolling: "genericapi" } });
    expect(json().config).not.toHaveProperty("monitorSettings");
    expect(json().config.monitorQueries).toHaveLength(4);
  });
});

describe("Monitoring tab — monitor queries", () => {
  const blocks = () => [...scope.document.querySelectorAll("[data-ga-monitor]")] as any[];
  const shown = (block: any, sel: string) => block.querySelector(sel).style.display !== "none";

  it("shows each block only the fields its stream, scope and method use", () => {
    mount(stored);
    const [status, ports, disks, supplies] = blocks();
    expect(shown(status, ".ga-mon-fleet")).toBe(true);
    expect(shown(status, ".ga-mon-up-wrap")).toBe(true);
    expect(shown(status, ".ga-mon-items-wrap")).toBe(false);
    expect(shown(ports, ".ga-mon-fleet")).toBe(false);
    expect(shown(ports, ".ga-mon-asset-hint")).toBe(true);
    expect(shown(ports, ".ga-mon-items-wrap")).toBe(true);
    expect(shown(disks, ".ga-mon-body-wrap")).toBe(true);
    expect(shown(disks, ".ga-mon-unit-wrap")).toBe(true);
    expect(shown(supplies, ".ga-mon-widgets-wrap")).toBe(true);
    expect(shown(supplies, ".ga-mon-map-wrap")).toBe(false);
    expect(shown(supplies, ".ga-mon-default-wrap")).toBe(false);

    const stream = status.querySelector(".ga-mon-stream");
    stream.value = "lldp";
    stream.dispatchEvent(new scope.Event("change", { bubbles: true }));
    expect(shown(status, ".ga-mon-up-wrap")).toBe(false);
    expect(shown(status, ".ga-mon-items-wrap")).toBe(true);
    expect(status.querySelector(".ga-mon-map-hint").textContent).toContain("localIfName");
  });

  it("Add appends a blank block (not saved until filled), Remove deletes one, and the cap is ten", () => {
    mount(stored);
    scope.document.getElementById("f-gaMonitorAdd").click();
    expect(blocks()).toHaveLength(5);
    expect(scope.getGenericApiFormConfig().monitorQueries).toHaveLength(4);
    blocks()[0].querySelector(".ga-mon-remove").click();
    expect(scope.getGenericApiFormConfig().monitorQueries.map((q: any) => q.name)).toEqual(["Ports", "Disks", "Supplies"]);
    for (let i = 0; i < 12; i++) scope.document.getElementById("f-gaMonitorAdd").click();
    expect(blocks()).toHaveLength(10);
  });

  it("names a field line or a widget line it cannot read instead of dropping it silently", () => {
    mount(stored);
    const status = blocks()[0];
    const ta = status.querySelector(".ga-mon-map");
    ta.value = "up = state\ncpuPct = cpu";
    ta.dispatchEvent(new scope.Event("input", { bubbles: true }));
    expect(status.querySelector(".ga-mon-map-hint").textContent).toContain("Not read: cpuPct = cpu");
    expect(scope.getGenericApiFormConfig().monitorQueries[0].map).toEqual({ up: "state" });

    const supplies = blocks()[3];
    const wt = supplies.querySelector(".ga-mon-widgets");
    wt.value = "Toner | gauge | toner\nBroken line\nLevel | gauge | lvl | % | low";
    wt.dispatchEvent(new scope.Event("input", { bubbles: true }));
    const hint = supplies.querySelector(".ga-mon-widgets-hint").textContent;
    expect(hint).toContain("Broken line");
    expect(hint).toContain("Level | gauge | lvl | % | low");
    expect(scope.getGenericApiFormConfig().monitorQueries[3].widgets).toEqual([{ name: "Toner", type: "gauge", path: "toner" }]);
  });

  it("parses a state widget's OK values into a notEquals StateMap, and formats it back the same way", () => {
    const parsed = scope._gaParseWidgetLines("Door | state | door | closed, locked\nAlarm bit | state | alarm");
    expect(parsed.widgets).toEqual([
      { name: "Door", type: "state", path: "door", stateMap: { mode: "notEquals", values: ["closed", "locked"], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true } },
      { name: "Alarm bit", type: "state", path: "alarm", stateMap: { mode: "nonzero", values: [], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true } },
    ]);
    expect(scope._gaFormatWidgetLines(parsed.widgets)).toBe("Door | state | door | closed, locked\nAlarm bit | state | alarm");
  });
});

describe("the genericapi polling method in the pickers", () => {
  it("is offered on its own source, the directory sources and manual — for every mappable stream, never processes", () => {
    const allowed = (src: string, stream: string) => scope._streamAllowedMethods(src, stream, null);
    for (const st of ["responseTime", "telemetry", "interfaces", "storage", "temperature", "lldp"]) {
      expect(allowed("genericapi", st), st).toContain("genericapi");
    }
    expect(allowed("genericapi", "processes")).not.toContain("genericapi");
    expect(allowed("activedirectory", "interfaces")).toContain("genericapi");
    expect(allowed("manual", "storage")).toContain("genericapi");
    expect(allowed("vcenter", "interfaces")).not.toContain("genericapi");
    expect(allowed("fortigate", "responseTime")).not.toContain("genericapi");
    expect(scope._POLLING_LABELS.genericapi).toBe("Generic API");
  });
});

describe("Network tab — network queries (rule 100(j))", () => {
  const blocks = () => [...scope.document.querySelectorAll("[data-ga-network]")] as any[];

  it("Add appends a blank block (not saved until filled), Remove deletes one, the cap is ten", () => {
    mount(stored);
    expect(blocks()).toHaveLength(2);
    scope.document.getElementById("f-gaNetworkAdd").click();
    expect(scope.getGenericApiFormConfig().networkQueries).toHaveLength(2);
    blocks()[0].querySelector(".ga-net-remove").click();
    expect(scope.getGenericApiFormConfig().networkQueries.map((q: any) => q.name)).toEqual(["Leases"]);
    for (let i = 0; i < 12; i++) scope.document.getElementById("f-gaNetworkAdd").click();
    expect(blocks()).toHaveLength(10);
  });

  it("names a field line the kind cannot read, and follows the kind picker", () => {
    mount(stored);
    const b = blocks()[0];
    const ta = b.querySelector(".ga-net-map");
    ta.value = "cidr = prefix\nipAddress = ip";
    ta.dispatchEvent(new scope.Event("input", { bubbles: true }));
    expect(b.querySelector(".ga-net-map-hint").textContent).toContain("Not read: ipAddress = ip");
    expect(scope.getGenericApiFormConfig().networkQueries[0].map).toEqual({ cidr: "prefix" });
    const kind = b.querySelector(".ga-net-kind");
    kind.value = "assignments";
    kind.dispatchEvent(new scope.Event("change", { bubbles: true }));
    expect(b.querySelector(".ga-net-map-hint").textContent).toContain("Not read: cidr = prefix");
    expect(b.querySelector(".ga-net-body-wrap").style.display).toBe("none");
    expect(blocks()[1].querySelector(".ga-net-body-wrap").style.display).toBe("");
  });

  it("carries the sweep switches and the device-read switch", () => {
    mount({ ...stored, releaseMissingAddresses: false, deprecateMissingSubnets: true, readDevices: false });
    const cfg = scope.getGenericApiFormConfig();
    expect([cfg.releaseMissingAddresses, cfg.deprecateMissingSubnets, cfg.readDevices]).toEqual([false, true, false]);
    // A config saved before the switches existed reads as the defaults.
    const { releaseMissingAddresses, deprecateMissingSubnets, readDevices, ...old } = stored as any;
    void releaseMissingAddresses; void deprecateMissingSubnets; void readDevices;
    mount(old);
    const d = scope.getGenericApiFormConfig();
    expect([d.releaseMissingAddresses, d.deprecateMissingSubnets, d.readDevices]).toEqual([true, false, true]);
  });

  it("Preview shows each network query's first page as IPAM would read it", async () => {
    mount(stored);
    scope.api.integrations.genericApiPreview = async () => ({
      ok: true, message: "", warnings: [], rows: [], sampleRecord: null,
      network: [
        { name: "Prefixes", kind: "subnets", ok: true, message: "first page: 2 record(s), 1 mapped", sampleRecord: { prefix: "<b>10.0.0.0/24</b>" },
          rows: [{ index: 0, outcome: { ok: true, value: { cidr: "10.0.0.0/24", name: "Core", vlan: 10, purpose: null } } }, { index: 1, outcome: { ok: false, reason: "2001:db8::/64 is IPv6 — only IPv4 networks are read" } }] },
        { name: "Leases", kind: "leases", ok: false, message: "HTTP 500", sampleRecord: null, rows: [] },
      ],
    });
    await scope._runGenericApiPreview("i1");
    const html = scope.document.getElementById("f-gaPreviewResult").innerHTML;
    expect(html).toContain("Network query “Prefixes”");
    expect(html).toContain("10.0.0.0/24");
    expect(html).toContain("&lt;b&gt;10.0.0.0/24&lt;/b&gt;");
    expect(html).toContain("is IPv6");
    expect(html).toContain("HTTP 500");
  });
});
