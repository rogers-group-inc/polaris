/**
 * tests/unit/assetAgentPanelOfferDom.test.ts — who the asset-details System
 * tab offers a Polaris Agent deploy to (`_assetHasAgentIntent` +
 * `assetAgentSubpanelHTML` in public/js/assets.js).
 *
 * The panel used to render only once the operator had expressed agent-intent
 * through a polling dropdown, so a plain server or workstation showed nothing
 * to click and the only deploy paths were the bulk action and the edit modal.
 * Servers and workstations now get the offer where they are standing, and the
 * three ways that goes wrong are all silent:
 *
 *  - offering it on a device that cannot take it. The install route 400s on a
 *    hypervisor and the compatibility matrix has no "agent" for the two
 *    Fortinet sources — a button that can only fail is worse than no button;
 *  - dropping the vCenter guest. A vCenter-discovered VM is an ordinary guest
 *    OS, and the bulk-deploy path has always accepted one;
 *  - showing a deploy button to a reader. Deploying is `assets=fullwrite`
 *    (rule 43a), a notch above the rest of this page.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetVipRowsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

/** Slice a top-level `var NAME = …;` declaration (single- or multi-line). */
function varSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`var ${name} = `));
  if (start < 0) throw new Error(`assets.js: var ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i >= start && /;\s*$/.test(l));
  if (end < 0) throw new Error(`assets.js: no end of var ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

/** One asset as GET /assets/:id ships it, plus the fields the panel reads. */
function asset(over: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    hostname: "APP-PRD-03",
    ipAddress: "10.20.4.11",
    assetType: "server",
    os: "Windows Server 2022",
    monitored: true,
    discoveredByIntegration: { type: "activedirectory" },
    responseTimePolling: null,
    cpuMemoryPolling: null,
    interfacesPolling: null,
    lldpPolling: null,
    storagePolling: null,
    ...over,
  };
}

function render(a: Record<string, unknown>, agent: unknown = null): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g.assetAgentSubpanelHTML(a, agent);
  return host;
}

function installButton(a: Record<string, unknown>, agent: unknown = null): Element | null {
  return render(a, agent).querySelector("#btn-agent-install");
}

beforeEach(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "1s ago";
  g.canDeployAgent = () => true;
  // The source-compat mirror lives in integrations.js, which assets.js reads
  // as a global; the helper normalizes an unknown key through it.
  g._POLLING_COMPAT = {
    fortimanager: [], fortigate: [], activedirectory: [], entraid: [],
    windowsserver: [], azurearc: [], vcenter: [], manual: [],
  };
  (0, eval)(varSrc("_AGENT_INSTALLABLE_SOURCES"));
  (0, eval)(varSrc("_AGENT_OFFERED_ASSET_TYPES"));
  (0, eval)(fnSrc("_assetSupportsAgentInstall"));
  (0, eval)(fnSrc("_assetHasAgentIntent"));
  (0, eval)(fnSrc("_agentStatusLabel"));
  (0, eval)(fnSrc("_agentStatusColor"));
  (0, eval)(fnSrc("assetAgentSubpanelHTML"));
  expect(typeof g.assetAgentSubpanelHTML, "assets.js no longer declares assetAgentSubpanelHTML").toBe("function");
});

describe("agent deploy offer on the System tab", () => {
  it("offers the install on a server and on a workstation", () => {
    for (const assetType of ["server", "workstation"]) {
      const host = render(asset({ assetType }));
      expect(host.querySelector("#asset-agent-panel"), assetType).not.toBeNull();
      expect(host.querySelector("#btn-agent-install"), assetType).not.toBeNull();
    }
  });

  it("offers it on a vCenter-discovered guest — the bulk path installs on those too", () => {
    expect(installButton(asset({ discoveredByIntegration: { type: "vcenter" } }))).not.toBeNull();
  });

  it("offers it on a manual asset with no integration at all", () => {
    expect(installButton(asset({ discoveredByIntegration: null }))).not.toBeNull();
  });

  it("stays away from device types that are not agent hosts", () => {
    for (const assetType of ["firewall", "switch", "access_point", "printer", "other"]) {
      expect(render(asset({ assetType })).innerHTML, assetType).toBe("");
    }
  });

  it("stays away from an ESXi host — the install route refuses a hypervisor", () => {
    expect(render(asset({ assetType: "hypervisor", discoveredByIntegration: { type: "vcenter" } })).innerHTML).toBe("");
  });

  it("stays away from a Fortinet-sourced asset — FortiOS takes no agent", () => {
    for (const type of ["fortimanager", "fortigate"]) {
      expect(render(asset({ discoveredByIntegration: { type } })).innerHTML, type).toBe("");
    }
  });

  it("stays away on the create flow, where there is no row to install onto", () => {
    expect(render(asset({ id: undefined })).innerHTML).toBe("");
  });

  it("withholds the button from a reader but keeps the panel's explanation", () => {
    g.canDeployAgent = () => false;
    const host = render(asset());
    expect(host.querySelector("#asset-agent-panel")).not.toBeNull();
    expect(host.querySelector("#btn-agent-install")).toBeNull();
    expect(host.textContent).toContain("Full Read-Write on Assets");
  });

  it("describes the offer as an offer, not as a half-finished choice", () => {
    const text = render(asset()).textContent || "";
    expect(text).toContain("No agent is installed on this host");
    expect(text).not.toContain("You picked");
  });

  it("keeps the polling-dropdown wording for an operator who did pick the method", () => {
    const text = render(asset({ cpuMemoryPolling: "agent" })).textContent || "";
    expect(text).toContain("You picked");
  });

  it("still renders for a picked-method asset of any type — that intent is unchanged", () => {
    const host = render(asset({ assetType: "switch", responseTimePolling: "agent" }));
    expect(host.querySelector("#asset-agent-panel")).not.toBeNull();
  });

  it("shows the installed agent's diagnostics instead of the offer once it is active", () => {
    const host = render(asset(), {
      id: "ma-1", installStatus: "active", agentVersion: "0.17.3",
      osPlatform: "windows", arch: "amd64", lastSeenAt: new Date().toISOString(),
      wsConnectedAt: new Date().toISOString(), wsDisconnectedAt: null,
    });
    expect(host.querySelector("#btn-agent-install")).toBeNull();
    expect(host.querySelector("#btn-agent-upgrade")).not.toBeNull();
    expect(host.textContent).toContain("0.17.3");
  });
});
