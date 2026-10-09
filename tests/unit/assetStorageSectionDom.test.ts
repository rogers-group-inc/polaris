/**
 * tests/unit/assetStorageSectionDom.test.ts — the asset-details System tab's
 * Storage section gate (public/js/assets.js).
 *
 * A FortiSwitch collecting flash usage over SNMP had no Storage section at all.
 * Three things stacked up, and this file pins the two that were decided in the
 * browser:
 *
 *  - **The section is always in the DOM.** It used to be omitted whenever the
 *    interfaces stream *looked like* REST API, judged from the per-asset
 *    `interfacesPolling` column — null on almost every asset, in which case the
 *    old code guessed `rest_api` for anything an FMG or FortiGate discovered.
 *    So an integration- or class-tier SNMP override (the documented way to
 *    enable direct switch polling) still hid it, and there was no element for
 *    the effective-settings post-pass to correct once the real value landed.
 *  - **`storagePolling` is the sole authority, and the copy has to say so.**
 *    Every server path drops the rows the interfaces walk produced unless the
 *    STORAGE stream asked for that transport, so "switch Interfaces to SNMP" —
 *    the setting that reveals every other section of this tab — collects
 *    nothing. An empty state that sent an operator to the wrong control would
 *    be worse than the silent omission it replaced.
 *  - **"Nothing yet" and "nothing ever" are different states.** The first is a
 *    device that will report on its next scrape; the second is a stream that is
 *    switched off. Rendering both as "No storage data yet" reads as a device
 *    with no disks.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/hwSensorTableScroll.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

/** The delivering-method list comes from the file so the test can't drift. */
function varSrc(name: string): string {
  const line = assetsLines.find((l) => l.startsWith(`var ${name} =`));
  if (!line) throw new Error(`assets.js: ${name} not found`);
  return line;
}

const FN_NAMES = [
  "_storageStreamDelivers", "_renderStorageTable", "_storageDetailsFor", "_storageHealthCell", "_setStorageDetailsFromVirtualization",
  "_poolLayoutsHTML", "_poolMemberUnhealthy", "_poolScanText",
];
const SRC = varSrc("_STORAGE_DELIVERING_METHODS") + "\n" +
  varSrc("_assetStorageDetails") + "\n" +
  FN_NAMES.map(fnSrc).join("\n") + "\n" +
  "globalThis._STORAGE_DELIVERING_METHODS = _STORAGE_DELIVERING_METHODS;\n" +
  FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

/** Resolved per-stream methods, as /effective-monitor-settings would report. */
function withStreams(streams: Record<string, string | null>) {
  g._resolvedStreamPolling = (_asset: any, stream: string) => streams[stream] ?? null;
}

function render(storage: any[] | undefined, asset?: any) {
  document.body.innerHTML = '<div id="storage"></div>';
  const el = document.getElementById("storage")!;
  g._renderStorageTable(el, { storage, monitoredStorage: [] }, asset || { id: "A1", assetType: "switch" });
  return el;
}

beforeEach(() => {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.canManageAssets = () => true;
  g._fmtBytes = (n: number) => String(n);
  g._storagePctCell = (p: number | null) => `<span>${p == null ? "—" : Math.round(p)}</span>`;
  g._assetTableTypeKey = () => "asset-storage";
  g.timeAgo = () => "2 days ago";
  g.applyTableLayout = undefined;
  g._POLLING_LABELS = { snmp: "SNMP", rest_api: "REST API", disabled: "Disabled", agent: "Polaris Agent", vcenter: "vCenter" };
  g._notAvailableViaPollingHTML = (label: string, method: string, desc: string) =>
    `<div data-na="1" data-label="${label}" data-method="${method}">${desc}</div>`;
  // eslint-disable-next-line no-eval
  eval(SRC);
});

describe("_storageStreamDelivers", () => {
  it("reads the STORAGE stream, not the interfaces stream", () => {
    // The trap: interfaces on SNMP is what reveals every other section of the
    // tab, and it collects storage rows the server then drops.
    withStreams({ storage: "disabled", interfaces: "snmp" });
    expect(g._storageStreamDelivers({ id: "A1" })).toBe(false);
    withStreams({ storage: "snmp", interfaces: "rest_api" });
    expect(g._storageStreamDelivers({ id: "A1" })).toBe(true);
  });

  it("accepts every transport that can carry storage", () => {
    for (const m of ["snmp", "ssh", "winrm", "agent", "vcenter"]) {
      withStreams({ storage: m });
      expect(g._storageStreamDelivers({ id: "A1" }), m).toBe(true);
    }
  });

  it("rejects the methods that carry no storage, and an unresolved stream", () => {
    for (const m of ["disabled", "icmp", "rest_api", "fortimanager"]) {
      withStreams({ storage: m });
      expect(g._storageStreamDelivers({ id: "A1" }), m).toBe(false);
    }
    withStreams({ storage: null });
    expect(g._storageStreamDelivers({ id: "A1" })).toBe(false);
  });
});

describe("_renderStorageTable empty states", () => {
  it("a FortiSwitch with Storage off gets the actionable state, naming the Storage stream", () => {
    withStreams({ storage: "disabled", interfaces: "rest_api" });
    const el = render([]);
    const box = el.querySelector("[data-na]");
    expect(box).not.toBeNull();
    expect(box!.getAttribute("data-label")).toBe("Storage");
    // The description must point at Storage and must NOT tell the operator that
    // setting Interfaces to SNMP is enough — that is the bug this replaced.
    expect(box!.innerHTML).toContain("<strong>Storage</strong>");
    expect(box!.innerHTML).toContain("<strong>SNMP</strong>");
    expect(box!.innerHTML).toContain("switched off");
  });

  it("says 'the current polling method' rather than 'via Disabled' when the stream is off", () => {
    withStreams({ storage: "disabled" });
    expect(render([]).querySelector("[data-na]")!.getAttribute("data-method"))
      .toBe("the current polling method");
  });

  it("names a real-but-non-delivering method when one is set", () => {
    withStreams({ storage: "rest_api" });
    expect(render([]).querySelector("[data-na]")!.getAttribute("data-method")).toBe("REST API");
  });

  it("a delivering stream with no rows yet is pending, not unavailable", () => {
    withStreams({ storage: "snmp" });
    const el = render([]);
    expect(el.querySelector("[data-na]")).toBeNull();
    expect(el.textContent).toContain("No storage data yet");
  });

  it("renders the table once rows arrive, whatever the resolved method says", () => {
    withStreams({ storage: "disabled", interfaces: "rest_api" });
    const el = render([{ mountPath: "flash", usedBytes: 400, totalBytes: 1000 }]);
    expect(el.querySelector("[data-na]")).toBeNull();
    expect(el.querySelector("table")).not.toBeNull();
    expect(el.textContent).toContain("flash");
  });
});

describe("a hypervisor's volumes", () => {
  const headers = (el: HTMLElement) => Array.from(el.querySelectorAll("th")).map((t) => t.textContent);

  it("adds a vCenter datastore's type, backing and provisioned size, and flags one inaccessible", () => {
    withStreams({ storage: "vcenter" });
    g._setStorageDetailsFromVirtualization("H1", {
      virtualization: { role: "host" },
      datastores: [{ name: "ds-1", dsType: "VMFS", backingLabel: "array-A", provisionedBytes: "900", accessible: false }],
    });
    const el = render([{ mountPath: "ds-1", usedBytes: 400, totalBytes: 1000 }], { id: "H1", assetType: "hypervisor" });
    expect(headers(el)).toEqual(["", "Mount", "Type", "Backing", "Provisioned", "Used", "Total", "Used %"]);
    expect(el.textContent).toContain("VMFS");
    expect(el.textContent).toContain("array-A");
    expect(el.textContent).toContain("(inaccessible)");
  });

  it("adds an Unraid / TrueNAS pool's kind and health, and no column nobody filled", () => {
    withStreams({ storage: "truenas" });
    g._setStorageDetailsFromVirtualization("H2", {
      virtualization: { role: "host", platform: "truenas", pools: [{ name: "tank", kind: "zfs", health: "DEGRADED" }] },
    });
    const el = render([{ mountPath: "tank", usedBytes: 1, totalBytes: 2 }], { id: "H2", assetType: "hypervisor" });
    expect(headers(el)).toEqual(["", "Mount", "Type", "Health", "Used", "Total", "Used %"]);
    expect(el.textContent).toContain("DEGRADED");
  });

  const disk = (name: string, over: Record<string, unknown> = {}) => ({
    name, device: null, serial: null, model: null, health: "ONLINE", sizeBytes: 100,
    readErrors: 0, writeErrors: 0, checksumErrors: 0, errors: null, temperatureC: 35, filesystem: null, mediaType: "HDD", smart: null, ...over,
  });

  it("lays a ZFS pool out by vdev, and opens it when a disk is erroring", () => {
    withStreams({ storage: "truenas" });
    g._setStorageDetailsFromVirtualization("H3", {
      virtualization: { role: "host", platform: "truenas", pools: [{
        name: "tank", kind: "zfs", health: "DEGRADED", filesystem: "zfs", healthDetail: "One or more devices has experienced an error",
        scan: { kind: "scrub", state: "finished", at: "2026-10-01T00:00:00Z", percent: null, errors: 0 },
        groups: [{ role: "data", layout: "raidz1", name: "raidz1-0", health: "DEGRADED", members: [disk("sda"), disk("sdb", { checksumErrors: 4, health: "DEGRADED" })] }],
      }] },
    });
    const el = render([{ mountPath: "tank", usedBytes: 1, totalBytes: 2 }], { id: "H3", assetType: "hypervisor" });
    const block = el.querySelector("details")!;
    expect(block.hasAttribute("open")).toBe(true);
    expect(block.textContent).toContain("Data · raidz1");
    expect(block.textContent).toContain("Scrub: finished 2 days ago, 0 errors");
    expect(block.textContent).toContain("0 / 0 / 4");
    expect(block.textContent).toContain("One or more devices");
  });

  it("lays Unraid's array out as parity + data with each disk's filesystem, closed when healthy", () => {
    withStreams({ storage: "unraid" });
    g._setStorageDetailsFromVirtualization("H4", {
      virtualization: { role: "host", platform: "unraid", pools: [{
        name: "array", kind: "array", health: "STARTED", filesystem: "unraid-array (xfs)",
        scan: { kind: "parity-check", state: "ok", at: "2026-10-01T00:00:00Z", percent: null, errors: 0 },
        groups: [
          { role: "parity", layout: null, name: null, health: null, members: [disk("parity", { health: "DISK_OK", readErrors: null, writeErrors: null, checksumErrors: null, errors: 0, smart: "OK" })] },
          { role: "data", layout: null, name: null, health: null, members: [disk("disk1", { health: "DISK_OK", readErrors: null, writeErrors: null, checksumErrors: null, errors: 0, filesystem: "xfs", smart: "OK" })] },
        ],
      }] },
    });
    const el = render([{ mountPath: "array", usedBytes: 1, totalBytes: 2 }], { id: "H4", assetType: "hypervisor" });
    const block = el.querySelector("details")!;
    expect(block.hasAttribute("open")).toBe(false);
    expect(Array.from(block.querySelectorAll("th")).map((t) => t.textContent)).toEqual(
      ["Group", "Device", "Health", "Errors", "SMART", "Filesystem", "Size", "Temp", "Model / Serial"],
    );
    expect(block.textContent).toContain("Unraid array (xfs)");
    expect(block.textContent).toContain("Parity check: ok");
  });

  it("never applies one host's details to another asset", () => {
    withStreams({ storage: "vcenter" });
    g._setStorageDetailsFromVirtualization("H1", { virtualization: { role: "host" }, datastores: [{ name: "ds-1", dsType: "VMFS" }] });
    const el = render([{ mountPath: "ds-1", usedBytes: 1, totalBytes: 2 }], { id: "OTHER", assetType: "hypervisor" });
    expect(headers(el)).toEqual(["", "Mount", "Used", "Total", "Used %"]);
  });
});
