/**
 * tests/unit/fortigatePushTabCopy.test.ts — a standalone FortiGate integration
 * has no FortiManager, so none of its tabs may name one.
 *
 * Three tabs are shared by the FortiManager and standalone FortiGate modals —
 * DHCP Push, Quarantine Push, Description Sync (`_integrationTabs` gates them
 * on `isFmg || isFgt`) — and each states HOW the write reaches the device and
 * WHICH device's permissions authorize it. There are THREE transports, not the
 * two the copy was written for: FMG proxy, FMG "bypass the proxy" direct mode,
 * and a standalone FortiGate, which has no FortiManager in front of it at all
 * (`buildTransportForIntegration` always returns a direct-fortigate transport
 * for the type).
 *
 * The tab set passed `pushUseProxy = true` for the standalone case to suppress
 * FMG's direct-mode warning, which selected the PROXY copy instead: an install
 * with no FortiManager was told its quarantine entries were "written through
 * FortiManager's /sys/proxy/json" and that it needed Device Manager Read-Write
 * on "the FortiManager admin profile Polaris uses" — sending the operator to
 * grant permissions on a device that does not exist, while the FortiOS access
 * profile that actually authorizes the write went unmentioned. The permission
 * section was worse than the label: it had no transport branch at all.
 *
 * Rendering is exercised for real rather than grepped, because the bug was in
 * which BRANCH ran, not in the strings themselves — a static assertion that the
 * file contains direct-mode copy would have passed throughout. The three form
 * builders are pure string functions with two collaborators, so they are
 * extracted from the shipped source and evaluated against stubs instead of
 * standing up the integrations page.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INTG_JS = resolve(__dirname, "../../public/js/integrations.js");
const INTG_TS = resolve(__dirname, "../../src/api/routes/integrations.ts");
const js = readFileSync(INTG_JS, "utf8").replace(/\r\n/g, "\n");
const ts = readFileSync(INTG_TS, "utf8").replace(/\r\n/g, "\n");

type Forms = {
  reservationPushFormHTML: (a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, type: string) => string;
  quarantinePushFormHTML: (on: boolean, useProxy: boolean, type: string) => string;
  descriptionSyncFormHTML: (flags: DescFlags, useProxy: boolean, type: string) => string;
  _descriptionSyncFlags: (config: Record<string, unknown>) => DescFlags;
};

type DescFlags = { fortigate?: boolean; fortiswitch?: boolean; fortiap?: boolean };
const ALL_ON: DescFlags = { fortigate: true, fortiswitch: true, fortiap: true };

function loadForms(): Forms {
  const grab = (name: string) => {
    const i = js.indexOf("\nfunction " + name + "(");
    if (i < 0) throw new Error(name + " not found in integrations.js");
    const j = js.indexOf("\n}\n", i);
    return js.slice(i, j + 3);
  };
  const grabVar = (name: string) => {
    const i = js.indexOf("\nvar " + name + " = {");
    if (i < 0) throw new Error(name + " not found in integrations.js");
    const j = js.indexOf("\n};\n", i);
    return js.slice(i, j + 4);
  };
  const stubs =
    'function calloutHTML(kind, title, body) { return "[callout " + kind + ": " + title + " | " + body + "]"; }\n' +
    "function escapeHtml(s) { return String(s); }\n" +
    'function sectionHeading(t) { return "<p data-section>" + t + "</p>"; }\n' +
    'function formDivider() { return "<hr>"; }\n';
  const names = [
    "_fortigateAccessProfileHTML",
    "reservationPushFormHTML",
    "quarantinePushFormHTML",
    "_descriptionSyncFlags",
    "_descriptionSyncToggleRow",
    "descriptionSyncFormHTML",
  ];
  const body =
    stubs +
    grabVar("DESCRIPTION_SYNC_KEYS") +
    names.map(grab).join("\n") +
    "\nreturn { reservationPushFormHTML, quarantinePushFormHTML, descriptionSyncFormHTML, _descriptionSyncFlags };";
  return new Function(body)() as Forms;
}

const forms = loadForms();

/** Every way the three tabs can name a FortiManager. */
const FMG_MENTION = /FortiManager|FMG|ADOM|sys\/proxy/;

const STANDALONE_TABS: Array<[string, () => string]> = [
  ["DHCP Push", () => forms.reservationPushFormHTML(true, false, true, true, true, "fortigate")],
  ["Quarantine Push", () => forms.quarantinePushFormHTML(true, false, "fortigate")],
  ["Description Sync", () => forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate")],
];

describe("standalone FortiGate push tabs never mention FortiManager", () => {
  for (const [label, render] of STANDALONE_TABS) {
    it(label + " renders no FortiManager copy", () => {
      expect(render()).not.toMatch(FMG_MENTION);
    });

    it(label + " states the direct transport", () => {
      expect(render()).toContain("Direct to the FortiGate");
    });

    it(label + " asks for a FortiGate access profile, not an FMG admin profile", () => {
      const html = render();
      expect(html).toContain("Required FortiGate Access Profile");
      expect(html).not.toContain("Admin Profile");
    });
  }

  it("the toggle itself still renders and reflects the stored value", () => {
    expect(forms.quarantinePushFormHTML(true, false, "fortigate")).toContain('id="f-pushQuarantine" checked');
    expect(forms.quarantinePushFormHTML(false, false, "fortigate")).not.toContain("checked");
  });

  it("names the CMDB tree each feature writes, so the grant is verifiable", () => {
    expect(forms.quarantinePushFormHTML(true, false, "fortigate")).toContain("/api/v2/cmdb/user/quarantine/targets");
    expect(forms.reservationPushFormHTML(true, false, false, false, false, "fortigate")).toContain(
      "/api/v2/cmdb/system/dhcp/server",
    );
    expect(forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate")).toContain("/api/v2/cmdb/system/global");
  });

  it("keeps the Polaris-is-primary warning, which is not FMG copy", () => {
    // It applies on every transport; only the devices it names change.
    const html = forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate");
    expect(html).toContain("Polaris overwrites device-side edits");
    expect(html).toContain("edited directly on the FortiGate");
  });
});

describe("the FortiManager copy is untouched", () => {
  // The standalone branch was added beside the FMG copy, not instead of it: a
  // FortiManager install must still get its admin-profile guidance and its
  // blast-radius warning, in BOTH of its transport modes.
  const cases: Array<[string, () => string]> = [
    ["DHCP Push proxy", () => forms.reservationPushFormHTML(true, true, true, true, true, "fortimanager")],
    ["DHCP Push direct", () => forms.reservationPushFormHTML(true, false, true, true, true, "fortimanager")],
    ["Quarantine Push proxy", () => forms.quarantinePushFormHTML(true, true, "fortimanager")],
    ["Quarantine Push direct", () => forms.quarantinePushFormHTML(true, false, "fortimanager")],
    ["Description Sync proxy", () => forms.descriptionSyncFormHTML(ALL_ON, true, "fortimanager")],
    ["Description Sync direct", () => forms.descriptionSyncFormHTML(ALL_ON, false, "fortimanager")],
  ];
  for (const [label, render] of cases) {
    it(label + " still carries the FMG admin-profile section", () => {
      const html = render();
      expect(html).toContain("Required FortiManager Admin Profile");
      expect(html).toContain("Manage Device Configurations");
      expect(html).toContain("Blast radius");
    });
  }

  it("proxy mode says proxy and direct mode says direct", () => {
    expect(forms.quarantinePushFormHTML(true, true, "fortimanager")).toContain(
      "Proxy through FortiManager to each FortiGate",
    );
    expect(forms.quarantinePushFormHTML(true, false, "fortimanager")).toContain("Direct to each FortiGate");
  });

  it("keeps the FMG central-management bullet only where an FMG database exists", () => {
    expect(forms.descriptionSyncFormHTML(ALL_ON, true, "fortimanager")).toContain("FMG central management");
    expect(forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate")).not.toContain("central management");
  });
});

describe("description sync asks for System Read-Write on every direct transport", () => {
  // The FortiGate alias is PUT to system/global, which FortiOS files under the
  // System access-profile group, not Network. The tab used to ask only for
  // Network → Configuration, so the alias write was refused while interface
  // descriptions synced — and FMG's bypass-direct mode, whose device writes
  // use each gate's own REST token, showed only the FMG admin profile.
  const direct: Array<[string, () => string]> = [
    ["standalone FortiGate", () => forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate")],
    ["FMG bypass-direct", () => forms.descriptionSyncFormHTML(ALL_ON, false, "fortimanager")],
  ];
  for (const [label, render] of direct) {
    it(label + " names System → Read-Write and the tree it covers", () => {
      const html = render();
      expect(html).toContain("Required FortiGate Access Profile");
      expect(html).toMatch(/<strong>System<\/strong> &rarr; Read-Write/);
      expect(html).toContain("system/global");
      expect(html).toContain("System Read-Write is broad");
    });
  }

  it("FMG bypass-direct points at the per-device token, not the General tab", () => {
    const html = forms.descriptionSyncFormHTML(ALL_ON, false, "fortimanager");
    expect(html).toContain("per-device API token on the Monitoring tab (FortiGate subtab)");
    expect(html).toContain("central-management mirror only");
  });

  it("FMG proxy mode is authorized by FortiManager alone", () => {
    const html = forms.descriptionSyncFormHTML(ALL_ON, true, "fortimanager");
    expect(html).not.toContain("Required FortiGate Access Profile");
    expect(html).not.toContain("central-management mirror only");
  });
});

describe("description sync has one toggle per device class", () => {
  const ids = ["f-syncFortigateDescriptions", "f-syncSwitchDescriptions", "f-syncApDescriptions"];

  it("renders a FortiGate, a FortiSwitch and a FortiAP toggle on both integration types", () => {
    for (const type of ["fortigate", "fortimanager"]) {
      const html = forms.descriptionSyncFormHTML({}, true, type);
      for (const id of ids) expect(html).toContain('id="' + id + '"');
      expect(html).not.toContain('id="f-syncDescriptions"');
    }
  });

  it("checks each toggle from its own flag", () => {
    const html = forms.descriptionSyncFormHTML({ fortigate: false, fortiswitch: true, fortiap: false }, true, "fortimanager");
    expect(html).toContain('id="f-syncSwitchDescriptions" checked');
    expect(html).not.toContain('id="f-syncFortigateDescriptions" checked');
    expect(html).not.toContain('id="f-syncApDescriptions" checked');
  });

  it("warns about FortiAP descriptions through FortiManager in both FMG transport modes only", () => {
    for (const useProxy of [true, false]) {
      expect(forms.descriptionSyncFormHTML({}, useProxy, "fortimanager")).toContain(
        "FortiAP descriptions through FortiManager: use with caution",
      );
    }
    expect(forms.descriptionSyncFormHTML(ALL_ON, false, "fortigate")).not.toContain("use with caution");
  });

  it("resolves an unset class from the legacy master toggle, an explicit key wins", () => {
    expect(forms._descriptionSyncFlags({ syncDescriptions: true })).toEqual(ALL_ON);
    expect(forms._descriptionSyncFlags({})).toEqual({ fortigate: false, fortiswitch: false, fortiap: false });
    expect(forms._descriptionSyncFlags({ syncDescriptions: true, syncApDescriptions: false })).toEqual({
      fortigate: true, fortiswitch: true, fortiap: false,
    });
  });
});

describe("the tab set hands the three shared tabs the integration type", () => {
  // Without `type` the form builders cannot tell a standalone FortiGate from
  // FMG's direct mode, and `pushUseProxy` alone has only two states.
  const tabSet = js.split("function _integrationTabs(ctx) {")[1]!.slice(0, 6000);

  it("does not hardcode proxy mode for a standalone FortiGate", () => {
    expect(tabSet).toContain("var pushUseProxy = isFmg ? (config.useProxy !== false) : false;");
  });

  it("passes type to all three push tabs", () => {
    expect(tabSet).toContain("config.adoptDiscoveredMac === true, type,");
    expect(tabSet).toContain("quarantinePushFormHTML(config.pushQuarantine === true, pushUseProxy, type)");
    expect(tabSet).toContain("descriptionSyncFormHTML(_descriptionSyncFlags(config), pushUseProxy, type)");
  });
});

describe("anything the shared modal offers exists in the type's create schema", () => {
  /**
   * `z.object` STRIPS unknown keys, so a config field the UI collects but the
   * per-type create schema omits is dropped in silence: the integration saves
   * clean and the tab comes back off. That is what happened to the two push
   * toggles — the tabs render for `isFmg || isFgt`, the schema only had them on
   * FMG, and only the Edit flow persisted them (its PUT validates config as
   * `z.record(z.unknown())` and merges). A ticked Quarantine Push box on a
   * freshly created standalone FortiGate therefore surfaced downstream as
   * "0/N FortiGate(s) accepted the push" — `quarantineAsset` skips every
   * sighting whose integration lacks the flag.
   */
  const schemaKeys = (name: string) => {
    const start = ts.indexOf("const " + name + " = z.object({");
    expect(start, name + " not found").toBeGreaterThan(-1);
    const block = ts.slice(start, ts.indexOf("\n})", start));
    return [...block.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]!);
  };
  const fmg = schemaKeys("FortiManagerConfigSchema");
  const fgt = schemaKeys("FortiGateConfigSchema");

  /** Structurally FMG-only: multi-device scoping, ADOM, and the proxy transport. */
  const FMG_ONLY = new Set([
    "adom",
    "interfaceInclude",
    "interfaceExclude",
    "deviceInclude",
    "deviceExclude",
    "discoveryParallelism",
    "useProxy",
    "fortigateApiUser",
    "fortigateApiToken",
    "fortigateVerifySsl",
  ]);

  it("carries both push toggles on the standalone FortiGate schema", () => {
    expect(fgt).toContain("pushQuarantine");
    expect(fgt).toContain("pushReservations");
  });

  it("has no other FMG feature key missing from the FortiGate schema", () => {
    const missing = fmg.filter((k) => !fgt.includes(k) && !FMG_ONLY.has(k));
    expect(missing).toEqual([]);
  });
});
