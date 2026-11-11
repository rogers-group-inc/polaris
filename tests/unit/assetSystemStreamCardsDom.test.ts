/**
 * tests/unit/assetSystemStreamCardsDom.test.ts — the System tab's LLDP card and
 * the Storage / LLDP chips (public/js/assets-system.js, assets-monitoring.js).
 *
 * Seen on an APC rack PDU (2026-11-11): Interfaces on SNMP with a per-asset
 * override, Storage and LLDP left on Inherit, which resolves to "not
 * delivered". The tab still drew both cards — LLDP with "no neighbors … try
 * flipping the integration's LLDP transport to SNMP" — and Storage's chip read
 * "SNMP (Datacenter Power) · every 10m · Asset override", the INTERFACES
 * stream's settings. Storage and LLDP are streams of their own (own method,
 * own queue, own cadence); Storage borrows only the Interfaces credential.
 *
 * Sliced and eval'd like tests/unit/assetStorageSectionDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadSharedModules } from "./_sharedModules.js";
import { assetsSource } from "./_assetsSource.js";

loadSharedModules();

const g = globalThis as Record<string, any>;
const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_streamSwitchedOff", "_showSystemSection", "_renderLldpNeighborsCard",
  "_streamIntervalAssetField", "_streamIntervalEffectiveField", "_streamCredential", "_streamFieldPrefix",
];
const SRC = FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

function withStreams(streams: Record<string, string | null>) {
  g._resolvedStreamPolling = (_a: any, stream: string) => streams[stream] ?? null;
}

function renderLldp(neighbors: any[], asset: any = { id: "P1", assetType: "power" }) {
  document.body.innerHTML = '<div data-shot-section="lldp" id="sec"><div id="lldp"></div></div>';
  const el = document.getElementById("lldp")!;
  g._renderLldpNeighborsCard(el, { lldpNeighbors: neighbors }, asset);
  return el;
}
const shown = () => document.getElementById("sec")!.style.display !== "none";

beforeEach(() => {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g._isRestApiManagedNetworkDevice = () => false;
  g._assetMonitorStreamSource = () => ({ polling: "REST API" });
  g._notAvailableViaPollingHTML = (label: string, method: string) => `<div data-na="1" data-method="${method}">${label}</div>`;
  g._assetTableTypeKey = () => "asset-lldp";
  g._staleBannerHTML = () => "";
  g._streamFailureError = () => null;
  g._screenshotTableEl = () => null;
  g.applyTableLayout = undefined;
  g.openViewModal = () => {};
  g._credentialCache = { loaded: true, list: [{ id: "c-if", name: "Datacenter Power" }, { id: "c-lldp", name: "LLDP cred" }] };
  eval(SRC);
});

describe("the LLDP card", () => {
  it("is hidden when the LLDP stream is switched off and nothing was collected", () => {
    withStreams({ lldp: "disabled", interfaces: "snmp" });
    const el = renderLldp([]);
    expect(shown()).toBe(false);
    expect(el.innerHTML).toBe("");
  });

  it("is hidden when no method resolves for LLDP (Inherit → not delivered)", () => {
    withStreams({ lldp: null });
    renderLldp([]);
    expect(shown()).toBe(false);
  });

  it("comes back on a re-render once a method resolves (the effective-settings post-pass)", () => {
    withStreams({ lldp: null });
    const el = renderLldp([]);
    withStreams({ lldp: "snmp" });
    g._renderLldpNeighborsCard(el, { lldpNeighbors: [] }, { id: "P1", assetType: "power" });
    expect(shown()).toBe(true);
    expect(el.textContent).toContain("No LLDP neighbors collected");
  });

  it("keeps the 'not available via REST API' state for a managed switch on REST", () => {
    withStreams({ lldp: "rest_api" });
    g._isRestApiManagedNetworkDevice = () => true;
    const el = renderLldp([], { id: "S1", assetType: "switch" });
    expect(shown()).toBe(true);
    expect(el.querySelector("[data-na]")).not.toBeNull();
  });

  it("shows neighbors that were collected even if the stream has since been switched off", () => {
    withStreams({ lldp: "disabled" });
    const el = renderLldp([{ localPort: "port1", chassisId: "aa:bb", systemName: "sw-core" }]);
    expect(shown()).toBe(true);
    expect(el.textContent).toContain("sw-core");
  });
});

describe("Storage and LLDP chips read their own stream", () => {
  it("each has its own cadence column, not the system-info one", () => {
    expect(g._streamIntervalAssetField("storage")).toBe("storageIntervalSec");
    expect(g._streamIntervalEffectiveField("storage")).toBe("storageIntervalSeconds");
    expect(g._streamIntervalAssetField("lldp")).toBe("lldpIntervalSec");
    expect(g._streamIntervalEffectiveField("lldp")).toBe("lldpIntervalSeconds");
    expect(g._streamIntervalEffectiveField("interfaces")).toBe("systemInfoIntervalSeconds");
  });

  it("Storage names the Interfaces credential it borrows; LLDP its own", () => {
    const asset = { id: "P1" };
    const eff = { interfacesCredentialId: "c-if", lldpCredentialId: "c-lldp" };
    expect(g._streamCredential(asset, "storage", "snmp", eff)?.name).toBe("Datacenter Power");
    expect(g._streamCredential(asset, "lldp", "snmp", eff)?.name).toBe("LLDP cred");
  });

  it("names no credential for a switched-off stream", () => {
    expect(g._streamCredential({ id: "P1", interfacesCredential: { name: "Datacenter Power" } }, "storage", "disabled", null)).toBeNull();
  });
});
