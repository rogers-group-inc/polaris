/**
 * tests/unit/arcIntegrationDom.test.ts — DOM smoke for the Azure Arc branches
 * in public/js/integrations.js.
 *
 * Same eval-into-happy-dom idiom as assetsTabsDom.test.ts. This is the net for
 * the wiring no server test can see, and it targets the three failure modes
 * that are SILENT in the browser:
 *
 *   1. The dispatcher trio (_formHTMLForType / _formConfigForType /
 *      _titleForType). Miss one and Arc quietly renders the FortiManager form
 *      with no error anywhere.
 *   2. The rich-card predicate. If Arc isn't in _isWsSrvRichType, the
 *      Monitoring tab renders the bare windowsserver-style card set — the
 *      agent-deploy and storage cards just aren't there, and nothing says so.
 *   3. The form → reader round trip, including the blank-secret path that
 *      "leave blank to keep the current secret" depends on.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = readFileSync(resolve(__dirname, "../../public/js/integrations.js"), "utf8");
// The "Declare Down after" arithmetic moved to its own module (shared with the
// automations wizard now that the missed-poll count belongs to the down-detection
// automation), and integrations.js calls it at RENDER time — so the harness has
// to load it the way the page does.
const DOWN_AFTER_SRC = readFileSync(resolve(__dirname, "../../public/js/monitor-down-after.js"), "utf8");

let win: InstanceType<typeof Window>;
let scope: Record<string, any>;

/**
 * Eval integrations.js into a fresh happy-dom window and hand back the
 * globals it defines. The file is a plain script (no modules), so the
 * function declarations land on the window object.
 */
function boot(): Record<string, any> {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;

  // Collaborators integrations.js expects from the rest of the page. The
  // app.js form-part helpers (sectionHeading / formDivider / calloutHTML / …)
  // arrive verbatim via APP_SHELL_STUBS above, since several assertions here
  // read the copy that flows through them.
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

beforeEach(() => {
  scope = boot();
});

// ─── Shared registries ──────────────────────────────────────────────────────

describe("Azure Arc registries", () => {
  it("labels the arc source kind so Inherit options read 'Azure Arc'", () => {
    // A stray "Manual" here means _polarisSourceLabel was missed, and every
    // Inherit option across the Monitoring tab silently mislabels itself.
    expect(scope._polarisSourceLabel("azurearc")).toBe("Azure Arc");
  });

  it("offers the same polling methods as the directory sources", () => {
    expect(scope._POLLING_COMPAT.azurearc).toEqual(scope._POLLING_COMPAT.entraid);
  });

  it("never offers REST API or SNMP on an Arc host", () => {
    expect(scope._POLLING_COMPAT.azurearc).not.toContain("rest_api");
    expect(scope._POLLING_COMPAT.azurearc).not.toContain("snmp");
    expect(scope._POLLING_COMPAT.azurearc).toContain("winrm");
    expect(scope._POLLING_COMPAT.azurearc).toContain("ssh");
    expect(scope._POLLING_COMPAT.azurearc).toContain("icmp");
    // "agent" is deliberately absent from every array in this map — the
    // Polaris Agent is installed from its own button and stamped server-side
    // at enrollment, never picked from the polling dropdown. The backend
    // matrix DOES allow it; these arrays are the UI's offer list, not the
    // compatibility rule.
    expect(scope._POLLING_COMPAT.azurearc).not.toContain("agent");
  });

  it("declares Workstations + Servers + Kubernetes class subtabs", () => {
    const spec = scope._CLASS_SUBTAB_SPECS.azurearc;
    expect(spec.primary).toBe("workstations");
    expect(spec.classes.map((c: any) => c.key)).toEqual(["workstations", "servers", "clusters"]);
  });

  it("counts Arc as a rich workstation/server type", () => {
    expect(scope._isWsSrvRichType("azurearc")).toBe(true);
    expect(scope._isWsSrvRichType("activedirectory")).toBe(true);
    expect(scope._isWsSrvRichType("entraid")).toBe(true);
    // windowsserver deliberately gets the bare addAsMonitored card only.
    expect(scope._isWsSrvRichType("windowsserver")).toBe(false);
    expect(scope._isWsSrvRichType("vcenter")).toBe(false);
  });
});

// ─── Monitoring tab ─────────────────────────────────────────────────────────

describe("Azure Arc Monitoring tab", () => {
  const render = () =>
    scope.monitorSettingsFormHTML({}, { integrationId: null, integrationType: "azurearc", integrationName: "" });

  it("renders both class subtabs", () => {
    const html = render();
    expect(html).toContain("Workstations");
    expect(html).toContain("Servers");
  });

  it("renders the FULL card set, not the windowsserver-style bare card", () => {
    // This is the single edit most likely to be forgotten — without arc in
    // the rich-type predicate the operator gets addAsMonitored and nothing
    // else, with no error to explain the missing cards.
    const html = render();
    expect(html).toContain('id="f-mon-workstation-addAsMonitored"');
    expect(html).toMatch(/id="f-mon-workstation-deploy-/);
    expect(html).toMatch(/id="f-mon-server-stor-/);
  });

  it("offers the verify-presence toggle", () => {
    expect(render()).toContain('id="f-verifyPresence"');
  });

  it("gives Kubernetes clusters the REDUCED card — addAsMonitored only", () => {
    // A cluster runs no agent and reports no interfaces or mounts, so it must
    // NOT get the workstation/server auto-monitor + agent-deploy cards.
    const html = render();
    expect(html).toContain('id="f-mon-clusters-addAsMonitored"');
    expect(html).not.toContain('id="f-mon-clusters-deploy-');
    expect(html).not.toContain('id="f-mon-clusters-stor-');
    expect(html).not.toContain('id="f-mon-clusters-amon-');
  });
});

// ─── General tab: the Azure setup instructions ──────────────────────────────

describe("azureArcFormHTML setup instructions", () => {
  const html = () => boot().azureArcFormHTML({});

  it("walks the operator through the Azure-side prerequisites", () => {
    const h = html();
    expect(h).toContain("App registrations");
    expect(h).toContain("Certificates &amp; secrets");
    expect(h).toContain("Reader");
    expect(h).toContain("Microsoft.HybridCompute");
    expect(h).toContain("Test Connection");
  });

  it("states that no Microsoft Graph permission is needed", () => {
    // The mistake operators carry over from setting up the Entra integration.
    expect(html()).toContain("No Microsoft Graph permissions are needed");
  });

  it("warns that a partial Reader assignment yields a partial roster", () => {
    // The failure this integration cannot surface any other way: Azure
    // returns fewer machines rather than an access error.
    const h = html();
    expect(h).toContain("Partial Reader means a partial roster");
  });

  // The read-only claim has to track the run-command toggle. It used to be an
  // unconditional "Polaris never writes to Azure / don't grant anything
  // broader", which the Script Publishing tab of the SAME modal contradicts as
  // soon as publishing is on — leaving the operator to pick which tab lied.
  it("says read-only, with the script-publishing exception, when publishing is off", () => {
    const h = boot().azureArcFormHTML({});
    expect(h).toContain("Read-only unless you enable script publishing");
    expect(h).toContain("Script Publishing");
    expect(h).not.toContain("This integration can write to Azure");
  });

  it("drops the read-only claim once run-command publishing is on", () => {
    const h = boot().azureArcFormHTML({ allowRunCommand: true });
    expect(h).toContain("This integration can write to Azure");
    expect(h).not.toContain("Read-only unless you enable script publishing");
    // Discovery's own requirement is unchanged, and saying so is what stops
    // an operator "fixing" the contradiction by over-granting.
    expect(h).toContain("Reader");
  });

  it("uses only synthetic all-zero GUIDs in placeholders", () => {
    const h = html();
    expect(h).toContain("00000000-0000-0000-0000-000000000000");
    // Nothing that looks like a populated GUID should ship in the markup.
    const realish = h.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || [];
    for (const guid of realish) expect(guid.replace(/[-0]/g, "")).toBe("");
  });
});

describe("arcScriptPublishingFormHTML RBAC guidance", () => {
  const html = () => boot().arcScriptPublishingFormHTML(true);

  it("names every action the run-command path actually calls", () => {
    // read → the picker's roster, runCommands/write → dispatch,
    // runCommands/read → the instanceView GET that returns exit code + output.
    const h = html();
    expect(h).toContain("Microsoft.HybridCompute/machines/read");
    expect(h).toContain("Microsoft.HybridCompute/machines/runCommands/write");
    expect(h).toContain("Microsoft.HybridCompute/machines/runCommands/read");
  });

  it("offers the least-privilege custom role and flags the built-in's breadth", () => {
    const h = html();
    expect(h).toContain("custom role");
    expect(h).toContain("Azure Connected Machine Resource Administrator");
    expect(h).toMatch(/modify and delete/i);
  });

  it("says to keep Reader, since roles are additive", () => {
    expect(html()).toMatch(/Keep the existing Reader assignment/i);
  });

  it("still distinguishes Azure RBAC from a Graph permission", () => {
    // The confusion carried over from the Intune side of the same feature.
    expect(html()).toContain("Azure RBAC role assignment");
  });

  it("keeps the no-inert-state warning — the review gate for this vehicle", () => {
    expect(html()).toContain("A run command executes immediately.");
  });
});

// ─── General tab: field ids + round trip ────────────────────────────────────

describe("azureArcFormHTML / getArcFormConfig round trip", () => {
  it("carries every field id the reader looks for, and ends with the Debug block", () => {
    const h = boot().azureArcFormHTML({});
    for (const id of [
      "f-name", "f-tenantId", "f-clientId", "f-clientSecret", "f-subscriptionIds",
      "f-useResourceGraph", "f-includeDisconnected", "f-fetchNetworkProfile",
      "f-enabled", "f-autoDiscover", "f-pollInterval",
      "f-rgMode", "f-rgNames", "f-deviceMode", "f-deviceNames", "f-tagMode", "f-tagFilters",
      "f-verboseLogging",
    ]) {
      expect(h).toContain(`id="${id}"`);
    }
  });

  it("gives the resource-group and tag axes their own ids", () => {
    // Arc is the first type with two filter axes. Reusing the shared
    // f-deviceMode/f-deviceNames pair for both would make them clobber each
    // other on read.
    const h = boot().azureArcFormHTML({});
    expect(h).toContain('id="f-rgNames"');
    expect(h).toContain('id="f-tagFilters"');
    expect(h).toContain('id="f-deviceNames"');
  });

  it("round-trips a populated config through the form and back", () => {
    const s = boot();
    s.document.body.innerHTML = s.azureArcFormHTML({
      name: "Prod Arc",
      tenantId: "11111111-1111-1111-1111-111111111111",
      clientId: "22222222-2222-2222-2222-222222222222",
      subscriptionInclude: ["33333333-3333-3333-3333-333333333333"],
      useResourceGraph: true,
      includeDisconnected: false,
      fetchNetworkProfile: true,
      resourceGroupInclude: ["rg-prod-*"],
      tagExclude: ["env=dev"],
      deviceExclude: ["*-lab"],
    });

    const cfg = s.getArcFormConfig();
    expect(cfg.tenantId).toBe("11111111-1111-1111-1111-111111111111");
    expect(cfg.clientId).toBe("22222222-2222-2222-2222-222222222222");
    expect(cfg.subscriptionInclude).toEqual(["33333333-3333-3333-3333-333333333333"]);
    expect(cfg.useResourceGraph).toBe(true);
    expect(cfg.includeDisconnected).toBe(false);
    expect(cfg.fetchNetworkProfile).toBe(true);
    expect(cfg.resourceGroupInclude).toEqual(["rg-prod-*"]);
    expect(cfg.resourceGroupExclude).toEqual([]);
    expect(cfg.tagExclude).toEqual(["env=dev"]);
    expect(cfg.tagInclude).toEqual([]);
    expect(cfg.deviceExclude).toEqual(["*-lab"]);
  });

  it("reads a blank secret as empty so the edit path can drop it", () => {
    // _intgEditFormSpec's `if (!fc.clientSecret) delete fc.clientSecret` is
    // what makes "leave blank to keep current secret" work — it depends on
    // the reader returning a falsy value rather than the placeholder text.
    const s = boot();
    s.document.body.innerHTML = s.azureArcFormHTML({
      clientSecretPlaceholder: "Leave blank to keep current secret",
    });
    expect(s.getArcFormConfig().clientSecret).toBe("");
  });
});

// ─── Dispatchers ────────────────────────────────────────────────────────────

describe("Azure Arc form dispatchers", () => {
  it("routes azurearc to the Arc form, not the FortiManager fallback", () => {
    const h = scope._formHTMLForType("azurearc", {});
    expect(h).toContain('id="f-tenantId"');
    expect(h).toContain("Microsoft.HybridCompute");
    expect(h).not.toContain('id="f-apiToken"');
  });

  it("routes azurearc to the Arc config reader", () => {
    const s = boot();
    s.document.body.innerHTML = s.azureArcFormHTML({ tenantId: "44444444-4444-4444-4444-444444444444" });
    expect(s._formConfigForType("azurearc").tenantId).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("titles the modal Azure Arc", () => {
    expect(scope._titleForType("azurearc", "Add")).toBe("Add Azure Arc Integration");
  });
});

describe("Azure Arc extra-resource toggles", () => {
  it("offers all three opt-in resource toggles", () => {
    const h = boot().azureArcFormHTML({});
    expect(h).toContain('id="f-enableVmInstances"');
    expect(h).toContain('id="f-enableSqlServer"');
    expect(h).toContain('id="f-enableKubernetes"');
  });

  it("warns that only the Kubernetes toggle adds devices", () => {
    // The other two fold into existing machines; this one changes the fleet.
    expect(boot().azureArcFormHTML({})).toContain("adds devices");
  });

  it("round-trips the three toggles through the reader", () => {
    const s = boot();
    s.document.body.innerHTML = s.azureArcFormHTML({
      enableVmInstances: true, enableSqlServer: false, enableKubernetes: true,
    });
    const cfg = s.getArcFormConfig();
    expect(cfg.enableVmInstances).toBe(true);
    expect(cfg.enableSqlServer).toBe(false);
    expect(cfg.enableKubernetes).toBe(true);
  });
});
