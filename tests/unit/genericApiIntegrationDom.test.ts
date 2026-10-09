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

let scope: Record<string, any>;
let previewCalls: any[] = [];

function boot(): Record<string, any> {
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
  `;
  (win as any).eval(APP_SHELL_STUBS + "\n" + stubs + "\n" + DOWN_AFTER_SRC + "\n" + SRC + "\n;window.__scope = this;");
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
  fieldMap: { id: "uuid", hostname: "name", ipAddress: "ips", macAddress: "nics[*].mac", serialNumber: "serial", model: "model", assetType: "kind", location: "site.name" },
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

  it("has three tabs — General, Records & Mapping, Preview — and no Monitoring", () => {
    const { tabs } = mount(stored);
    expect(tabs.map((t: any) => t.key)).toEqual(["general", "mapping", "preview"]);
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
});
