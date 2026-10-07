/**
 * tests/unit/workloadIntegrationDom.test.ts — DOM smoke for the Unraid /
 * TrueNAS SCALE branches in public/js/integrations.js (the arcIntegrationDom
 * harness). Targets the failures that are silent in the browser: a missed
 * dispatcher (the FortiManager form renders instead), the reduced class cards
 * growing vCenter's agent-deploy set, and the four-places field round trip
 * (schema / service / form + reader / edit defaults).
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

beforeEach(() => { scope = boot(); });

describe("registries", () => {
  it("names both products and routes both to the workload form + reader", () => {
    expect(scope._productForType("unraid")).toBe("Unraid");
    expect(scope._productForType("truenas")).toBe("TrueNAS SCALE");
    expect(scope._formHTMLForType("unraid", {})).toContain('id="f-ctrNames"');
    expect(scope._formHTMLForType("truenas", {})).toContain("TrueNAS revokes an API key");
    expect(scope._NON_FORTINET_TABBED).toEqual(expect.arrayContaining(["unraid", "truenas"]));
  });

  it("requires host + key, and drops the key on the edit flow", () => {
    expect(scope._integrationRequires("unraid", "create")).toEqual([["f-host", "host"], ["f-apiToken", "API key"]]);
    expect(scope._integrationRequires("truenas", "edit")).toEqual([["f-host", "host"]]);
  });

  it("mirrors the polling matrix and labels the sources", () => {
    expect(scope._POLLING_COMPAT.unraid).toContain("unraid");
    expect(scope._POLLING_COMPAT.unraid).not.toContain("truenas");
    expect(scope._POLLING_COMPAT.truenas).toContain("truenas");
    expect(scope._polarisSourceLabel("truenas")).toBe("TrueNAS SCALE");
    expect(scope._polarisSourceDefaultPolling("unraid", "temperature")).toBe("unraid");
    expect(scope._polarisSourceDefaultPolling("unraid", "lldp")).toBeNull();
    expect(scope._streamAllowedMethods("unraid", "lldp")).not.toContain("unraid");
    expect(scope._streamAllowedMethods("truenas", "storage")).toContain("truenas");
  });
});

describe("Monitoring tab", () => {
  const render = (type: string) => scope.monitorSettingsFormHTML({}, { integrationId: null, integrationType: type, integrationName: "" });

  it("renders Host / VMs / Containers (Apps on TrueNAS) with the REDUCED card each", () => {
    const u = render("unraid");
    expect(u).toContain("Containers");
    expect(render("truenas")).toContain("Apps");
    for (const p of ["f-mon-wlhost-", "f-mon-wlvm-", "f-mon-ctr-"]) {
      expect(u).toContain(`id="${p}addAsMonitored"`);
      expect(u).not.toContain(`id="${p}deploy-`);
      expect(u).not.toContain(`id="${p}amon-`);
    }
  });

  it("checks the host's auto-monitor by default, containers' not", () => {
    const u = render("unraid");
    expect(u).toMatch(/id="f-mon-wlhost-addAsMonitored" checked/);
    expect(u).not.toMatch(/id="f-mon-ctr-addAsMonitored" checked/);
  });
});

describe("General tab round trip", () => {
  it("carries every field through the form and back", () => {
    const s = scope;
    s.document.body.innerHTML = s.workloadFormHTML("unraid", {
      name: "Tower", host: "tower.lan", port: 8443, useTls: true, verifyTls: false,
      vmInclude: ["win-*"], containerExclude: ["*-test", "tmp"],
      enabled: true, autoDiscover: true, pollInterval: 2,
    });
    (s.document.getElementById("f-apiToken") as any).value = "k123";
    expect(s.getWorkloadFormConfig()).toEqual({
      host: "tower.lan", port: 8443, useTls: true, verifyTls: false, apiToken: "k123",
      vmInclude: ["win-*"], vmExclude: [], containerInclude: [], containerExclude: ["*-test", "tmp"],
      verboseLogging: false,
    });
  });

  it("never renders a stored key, and the edit getter drops a blank one", () => {
    const s = scope;
    const spec = s._intgEditFormSpec(
      { type: "truenas", name: "NAS", enabled: true, autoDiscover: true, pollInterval: 1 },
      { host: "nas.lan", useTls: true, apiToken: "SECRET-SHOULD-NOT-RENDER", containerInclude: ["plex"] },
    );
    expect(spec.body).not.toContain("SECRET-SHOULD-NOT-RENDER");
    s.document.body.innerHTML = spec.body;
    const cfg = spec.formGetter();
    expect(cfg.apiToken).toBeUndefined();
    expect(cfg.containerInclude).toEqual(["plex"]);
    expect(cfg.port).toBeUndefined();
  });
});
