/**
 * tests/unit/assetsDiscoveryDom.test.ts — the network Discovery wizard
 * (public/js/assets-discovery.js).
 *
 * A wizard that doesn't open renders nothing and raises no toast, which is the
 * class of bug tests/unit/automationsWizardDom.test.ts exists for. On top of
 * that shell coverage, what's pinned here is the behaviour that is a decision
 * rather than an implementation detail:
 *
 *  - `.stepper` is the DIRECT FIRST CHILD of `.modal-body` — both the sticky
 *    rule and the `:has(> .stepper:first-child)` padding rule key off that, so
 *    a stray wrapper silently unpins the header mid-scroll;
 *  - **Save is absent, not disabled, for a read-level caller.** Authoring is
 *    `networkScan:write`; a button whose click can only 403 must not render;
 *  - **step validation blocks Next** — a Discovery with no name or no target is
 *    not saveable, and the wizard says so on the step rather than at the POST;
 *  - free navigation reaches visited steps only, so a fresh draft can't jump to
 *    the Run step before it has targets;
 *  - the target rows are add/removable and never collapse to zero;
 *  - a method toggle keeps the stored order = the METHOD priority order, since
 *    the runner treats array order as "try this first";
 *  - `groupKeyForHit` mirrors the server's `methodKeyForHit`, because step 6's
 *    per-group selections are keyed by it and a mismatch would silently pin
 *    nothing;
 *  - the saved-Discovery list's row verbs are gated per key, and a read-level
 *    caller gets Export only;
 *  - **a SHARED Discovery someone else owns is runnable but not editable** —
 *    the visibility cutover's whole point. The Save button and the visibility
 *    control are both absent on such a row (the route would 403), Delete drops
 *    off its row menu, and Run stays, because publishing a Discovery exists so
 *    that somebody else can run it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/assets-discovery.js"), "utf8");

const g = globalThis as Record<string, any>;
let doc: Window["document"];
let toasts: { msg: string; kind?: string }[];

interface Api {
  open: (existing?: unknown, opts?: unknown) => Promise<void>;
  openList: () => Promise<void>;
  STEPS: string[];
  emptyDraft: () => Record<string, unknown>;
  groupKeyForHit: (hit: unknown) => string;
  listRowItems: (scan: unknown) => { label?: string; separator?: boolean; onSelect?: () => void }[];
  ownerCellHtml: (scan: unknown) => string;
  canEditDraft: (draft: unknown) => boolean;
  METHOD_ORDER: string[];
}

/** Load the module into a fresh happy-dom with the app-shell globals stubbed. */
function load(opts: {
  scan?: "none" | "read" | "write"; assets?: boolean; scans?: unknown[];
  subnetsRead?: boolean; networks?: unknown[];
} = {}): Api {
  const scan = opts.scan ?? "write";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  const win = new Window();
  doc = win.document;
  toasts = [];
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => true;
  g.closeModal = () => { doc.getElementById("modal-overlay")?.remove(); };
  g.showRowMenu = () => {};
  g.permAtLeast = (key: string, level: string) => {
    if (key === "networkScan") return RANK[scan] >= RANK[level];
    if (key === "assets") return opts.assets !== false;
    if (key === "subnets") return opts.subnetsRead !== false;
    return true;
  };
  // Mirror production: ONE #modal-overlay, reused, with body/footer replaced.
  g.openModal = (title: string, body: string, footer: string) => {
    let overlay = doc.getElementById("modal-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal"><div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body"></div><div class="modal-footer"></div></div>';
      doc.body.appendChild(overlay);
    }
    overlay.querySelector(".modal-header h3")!.textContent = title;
    overlay.querySelector(".modal-body")!.innerHTML = body;
    overlay.querySelector(".modal-footer")!.innerHTML = footer;
  };
  g.api = {
    credentials: { list: async () => ({ credentials: [{ id: "c1", name: "public", type: "snmp" }] }) },
    subnets: {
      list: vi.fn(async () => ({ subnets: opts.networks ?? [], total: (opts.networks ?? []).length })),
    },
    networkScans: {
      list: async () => ({ scans: opts.scans ?? [] }),
      previewTargets: async () => ({ total: 6, dropped: 0, droppedBy: { invalid: 0, excluded: 0, cap: 0 }, perTarget: [{ count: 6 }], alreadyKnown: 0, cap: 65536 }),
      getRun: async () => ({ run: { id: "r1", status: "completed", totalTargets: 6, scannedCount: 6, hitCount: 0, hits: [] } }),
      run: async () => ({ run: { id: "r1", status: "queued", totalTargets: 0, scannedCount: 0, hitCount: 0 } }),
      create: async () => ({ scan: { id: "s1" } }),
      update: async () => ({ scan: { id: "s1" } }),
      delete: async () => ({}),
      cancelRun: async () => ({}),
      adopt: async () => ({ created: 1, skipped: [], assetIds: ["a1"] }),
    },
  };
  (0, eval)(SRC);
  return win.PolarisAssetDiscovery as Api;
}

const activeStep = () =>
  (doc.querySelector("#nd-stepper .stepper-step.active") as HTMLElement | null)?.getAttribute("data-step");
const visiblePanels = () =>
  Array.from(doc.querySelectorAll(".step-panel.visible")).map((el) => (el as HTMLElement).id);
const shown = (id: string) => {
  const el = doc.getElementById(id) as HTMLElement | null;
  return !!el && el.style.display !== "none";
};
const click = (id: string) => (doc.getElementById(id) as HTMLElement).click();

/** Fill step 1 + 2 so Next is allowed through. */
function fillBasics() {
  (doc.getElementById("nd-name") as HTMLInputElement).value = "Ashfield mgmt";
  (doc.querySelector("#nd-targets .nd-t-value") as HTMLInputElement).value = "10.4.0.0/29";
}

beforeEach(() => { /* each test loads its own window */ });

describe("PolarisAssetDiscovery — namespace", () => {
  it("exposes what assets.js reads plus the pure helpers", async () => {
    const D = load();
    expect(typeof D.open).toBe("function");
    expect(typeof D.openList).toBe("function");
    // "Monitor", not "Monitoring": seven steps wrap onto a second row in a
    // .modal-wide stepper, and the shorter label keeps that row readable.
    expect(D.STEPS).toEqual(["Name", "Targets", "Methods", "Run", "Results", "Monitor", "Summary"]);
    expect(D.METHOD_ORDER).toEqual(["icmp", "snmp", "restapi", "ssh", "winrm"]);
  });

  it("emptyDraft separates configuration from run state", async () => {
    const d = load().emptyDraft();
    expect(d).toMatchObject({ name: "", autoMonitor: {} });
    // Run state must never be saved with the configuration.
    expect(d).toMatchObject({ runId: null, hits: [], selected: [] });
    // A usable starting shape rather than empty arrays the operator must seed.
    expect(d.targets).toHaveLength(1);
    expect(d.methods).toEqual([{ type: "icmp", credentialIds: [] }]);
  });
});

describe("PolarisAssetDiscovery — shell", () => {
  it("opens with the stepper as the direct first child of .modal-body", async () => {
    const D = load();
    await D.open();
    const body = doc.querySelector(".modal-body")!;
    expect(body.firstElementChild?.classList.contains("stepper")).toBe(true);
  });

  it("renders one panel per step with exactly one visible", async () => {
    const D = load();
    await D.open();
    expect(doc.querySelectorAll(".step-panel").length).toBe(D.STEPS.length);
    expect(visiblePanels()).toEqual(["nd-step-1"]);
  });

  it("hides Back on the first step", async () => {
    await load().open();
    expect(shown("nd-back")).toBe(false);
    expect(shown("nd-next")).toBe(true);
  });

  it("titles the modal by mode", async () => {
    const title = () => doc.querySelector(".modal-header h3")!.textContent;
    await load().open();
    expect(title()).toBe("New discovery");
    await load().open({ id: "s1", name: "x", targets: [], methods: [] });
    expect(title()).toBe("Edit discovery");
    await load().open({ name: "x", targets: [], methods: [] }, { import: true });
    expect(title()).toBe("Imported discovery");
  });

  it("does not mutate the row it was opened with", async () => {
    const row = { id: "s1", name: "Ashfield", targets: [{ kind: "cidr", value: "10.0.0.0/24" }], methods: [] };
    const before = JSON.stringify(row);
    await load().open(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  it("unlocks every step when editing a saved Discovery", async () => {
    const D = load();
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    (doc.querySelector('#nd-stepper .stepper-step[data-step="7"]') as HTMLElement).click();
    expect(activeStep()).toBe("7");
  });
});

describe("PolarisAssetDiscovery — layout parity with the automations wizard", () => {
  it("leads every step with an h3 question, then the controls", async () => {
    // The automations wizard puts the question and its one-line explanation at
    // the TOP of each step; this wizard shipped with the explanation trailing
    // the form, which read as a different product. Pinned per step because it
    // is the kind of thing a later edit re-orders without noticing.
    const D = load();
    await D.open({
      id: "s1", name: "x",
      targets: [{ kind: "cidr", value: "10.4.0.0/29" }],
      methods: [{ type: "icmp" }],
    });
    for (const n of [1, 2, 3, 5, 6, 7]) {
      (doc.querySelector(`#nd-stepper .stepper-step[data-step="${n}"]`) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 0));
      const panel = doc.getElementById(`nd-step-${n}`)!;
      const first = panel.firstElementChild as HTMLElement | null;
      expect(first?.tagName, `step ${n} does not open with a heading`).toBe("H3");
      // …and the heading is followed by the explanation, not by a control.
      expect((first!.nextElementSibling as HTMLElement | null)?.tagName, `step ${n} heading has no explanation`).toBe("P");
    }
  });

  it("keeps the label short enough for a wrapped stepper row", () => {
    // Seven steps overflow a .modal-wide row at any label length, so the
    // stepper wraps (styles.css) — which only reads well if the labels are
    // short. "Monitoring" was the one that pushed it.
    for (const label of load().STEPS) expect(label.length).toBeLessThanOrEqual(8);
  });
});

describe("PolarisAssetDiscovery — step validation", () => {
  it("refuses Next with no name", async () => {
    await load().open();
    click("nd-next");
    expect(activeStep()).toBe("1");
    expect(toasts.some((t) => /name/i.test(t.msg))).toBe(true);
  });

  it("refuses Next with no target", async () => {
    await load().open();
    (doc.getElementById("nd-name") as HTMLInputElement).value = "Ashfield mgmt";
    click("nd-next");
    expect(activeStep()).toBe("2");
    click("nd-next");
    expect(activeStep()).toBe("2");
    expect(toasts.some((t) => /address, range or subnet/i.test(t.msg))).toBe(true);
  });

  it("walks to the methods step once name and target are filled", async () => {
    await load().open();
    fillBasics();
    click("nd-next");
    click("nd-next");
    expect(activeStep()).toBe("3");
    expect(visiblePanels()).toEqual(["nd-step-3"]);
  });

  it("refuses to leave the Run step before a run exists", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next"); click("nd-next");
    expect(activeStep()).toBe("4");
    click("nd-next");
    expect(activeStep()).toBe("4");
    expect(toasts.some((t) => /Run the scan/i.test(t.msg))).toBe(true);
  });

  it("jumps to a visited step but not an unvisited one", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    expect(activeStep()).toBe("3");
    (doc.querySelector('#nd-stepper .stepper-step[data-step="1"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
    (doc.querySelector('#nd-stepper .stepper-step[data-step="6"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
  });
});

describe("PolarisAssetDiscovery — targets step", () => {
  it("adds and removes target rows, never collapsing to zero", async () => {
    await load().open();
    (doc.getElementById("nd-name") as HTMLInputElement).value = "x";
    click("nd-next");
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(1);
    click("nd-add-target");
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(2);
    // Removing the last remaining row leaves an empty one to type into.
    (doc.querySelectorAll("#nd-targets .nd-t-remove")[1] as HTMLElement).click();
    (doc.querySelectorAll("#nd-targets .nd-t-remove")[0] as HTMLElement).click();
    expect(doc.querySelectorAll("#nd-targets .nd-target-row").length).toBe(1);
  });

  it("renders every preview state through one shell, in the COMPACT box", async () => {
    await load().open();
    const box = doc.getElementById("nd-target-preview")!;
    expect(box.classList.contains("aw-preview-box")).toBe(true);
    // Compact: this preview's whole answer is a count plus any mistyped-row
    // errors, so the shared 232px height (sized for the automations Devices
    // step's 100-device list) would be dead space.
    expect(box.classList.contains("aw-preview-compact")).toBe(true);
    expect(box.querySelector(".aw-preview-head")).toBeTruthy();
    expect(box.querySelector(".aw-preview-body")).toBeTruthy();
  });
});

describe("PolarisAssetDiscovery — IPAM network picker", () => {
  const NETS = [
    { cidr: "10.4.0.0/24", name: "Ashfield Mgmt", vlan: 20, fortigateDevice: "FGT-ASH", status: "available", block: { name: "Ashfield" } },
    { cidr: "10.5.0.0/24", name: "Brookline Users", vlan: 30, fortigateDevice: "FGT-BRK", status: "available", block: { name: "Brookline" } },
    { cidr: "192.168.10.0/24", name: "Lab 10.4 overflow", vlan: null, status: "reserved" },
    { cidr: "10.9.0.0/24", name: "Old Ashfield", status: "deprecated" },
    { cidr: "2001:db8::/64", name: "Ashfield v6", status: "available" },
  ];
  const Ev = (type: string, init: Record<string, unknown> = {}) =>
    new (doc.defaultView as any).Event(type, { bubbles: true, ...init });
  const Key = (key: string) => new (doc.defaultView as any).KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const valueBox = () => doc.querySelector("#nd-targets .nd-t-value") as HTMLInputElement;
  const items = () => Array.from(doc.querySelectorAll("#nd-targets .nd-t-suggest .aw-suggest-item")) as HTMLElement[];
  const shownCidrs = () => items().map((i) => i.getAttribute("data-val"));

  async function toTargets(o: Parameters<typeof load>[0] = {}) {
    const D = load({ networks: NETS, ...o });
    await D.open();
    (doc.getElementById("nd-name") as HTMLInputElement).value = "x";
    click("nd-next");
    return D;
  }
  async function focusBox() {
    valueBox().focus();
    valueBox().dispatchEvent(Ev("focusin"));
    await flush(); await flush();
  }
  async function type(text: string) {
    valueBox().value = text;
    valueBox().dispatchEvent(Ev("input"));
    await flush();
  }

  it("lists IPAM's usable IPv4 networks on focus, skipping deprecated and IPv6", async () => {
    await toTargets();
    await focusBox();
    expect(doc.querySelector(".nd-t-suggest")!.classList.contains("open")).toBe(true);
    expect(shownCidrs()).toEqual(["10.4.0.0/24", "10.5.0.0/24", "192.168.10.0/24"]);
    // Fetched once with the Networks page's own read, not per keystroke.
    await type("10");
    await type("10.");
    expect(g.api.subnets.list).toHaveBeenCalledTimes(1);
    expect(g.api.subnets.list).toHaveBeenCalledWith({ limit: 10000 });
  });

  it("filters as you type, across CIDR, name, VLAN and gate, every word required", async () => {
    await toTargets();
    await focusBox();
    await type("brook");
    expect(shownCidrs()).toEqual(["10.5.0.0/24"]);
    await type("ash vlan 20");
    expect(shownCidrs()).toEqual(["10.4.0.0/24"]);
    await type("fgt-");
    expect(shownCidrs()).toEqual(["10.4.0.0/24", "10.5.0.0/24"]);
    await type("nothing-like-this");
    expect(items()).toHaveLength(0);
    expect(doc.querySelector(".nd-t-suggest")!.textContent).toMatch(/scanned as typed/);
  });

  it("ranks a CIDR-prefix match ahead of a name that merely mentions it", async () => {
    await toTargets();
    await focusBox();
    await type("10.4");
    // "Lab 10.4 overflow" matches by name, but 10.4.0.0/24 is what was meant.
    expect(shownCidrs()).toEqual(["10.4.0.0/24", "192.168.10.0/24"]);
  });

  it("a click fills the CIDR and closes the list", async () => {
    await toTargets();
    await focusBox();
    await type("brook");
    items()[0].dispatchEvent(new (doc.defaultView as any).MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(valueBox().value).toBe("10.5.0.0/24");
    expect(doc.querySelector(".nd-t-suggest")!.classList.contains("open")).toBe(false);
  });

  it("arrow + Enter picks, and claims Enter so the wizard doesn't also advance", async () => {
    await toTargets();
    await focusBox();
    await type("10.");
    valueBox().dispatchEvent(Key("ArrowDown"));
    valueBox().dispatchEvent(Key("ArrowDown"));
    const enter = Key("Enter");
    valueBox().dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(valueBox().value).toBe("10.5.0.0/24");
    expect(activeStep()).toBe("2");
  });

  it("still takes free text — a subnet IPAM doesn't know is the common case", async () => {
    await toTargets();
    await focusBox();
    await type("172.16.0.0/24");
    valueBox().dispatchEvent(Ev("focusout"));
    click("nd-next");
    expect(activeStep()).toBe("3");
  });

  it("offers no picker on range and single rows", async () => {
    await toTargets();
    const kind = doc.querySelector("#nd-targets .nd-t-kind") as HTMLSelectElement;
    kind.value = "range";
    kind.dispatchEvent(Ev("change"));
    expect(doc.querySelector("#nd-targets .nd-t-combo")).toBeNull();
    expect(valueBox()).toBeTruthy();
  });

  it("a caller without subnets:read gets the plain box and no fetch", async () => {
    await toTargets({ subnetsRead: false });
    expect(doc.querySelector("#nd-targets .nd-t-combo")).toBeNull();
    await focusBox();
    expect(g.api.subnets.list).not.toHaveBeenCalled();
  });

  it("degrades to a note, not a broken step, when the network list fails", async () => {
    await toTargets();
    g.api.subnets.list = vi.fn(async () => { throw new Error("boom"); });
    await focusBox();
    expect(doc.querySelector(".nd-t-suggest")!.textContent).toMatch(/typing a subnet still works/);
  });
});

describe("PolarisAssetDiscovery — methods step", () => {
  it("offers all five methods with ICMP on by default", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const boxes = Array.from(doc.querySelectorAll(".nd-m-enable")) as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute("data-type"))).toEqual(["icmp", "snmp", "restapi", "ssh", "winrm"]);
    expect(boxes[0].checked).toBe(true);
  });

  it("refuses Next for a credentialed method with no credential", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const snmp = doc.querySelector('.nd-m-enable[data-type="snmp"]') as HTMLInputElement;
    snmp.checked = true;
    snmp.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));
    click("nd-next");
    expect(activeStep()).toBe("3");
    expect(toasts.some((t) => /credential for SNMP/i.test(t.msg))).toBe(true);
  });

  it("says so when a method has no credential rather than looking configured", async () => {
    await load().open();
    fillBasics();
    click("nd-next"); click("nd-next");
    const snmp = doc.querySelector('.nd-m-enable[data-type="snmp"]') as HTMLInputElement;
    snmp.checked = true;
    snmp.dispatchEvent(new (doc.defaultView as any).Event("change", { bubbles: true }));
    expect(doc.getElementById("nd-step-3")!.innerHTML).toMatch(/can't be attempted/i);
  });
});

describe("PolarisAssetDiscovery — groupKeyForHit", () => {
  it("mirrors the server's methodKeyForHit", () => {
    const D = load();
    // Step 6 keys its per-group selections by this; a mismatch with the
    // server's methodKeyForHit would silently pin nothing.
    expect(D.groupKeyForHit({ respondedTo: ["icmp", "snmp"], identifiedBy: "snmp" })).toBe("snmp");
    expect(D.groupKeyForHit({ respondedTo: ["icmp"] })).toBe("icmp");
    expect(D.groupKeyForHit({ respondedTo: [] })).toBe("unknown");
    expect(D.groupKeyForHit(null)).toBe("unknown");
  });
});

describe("PolarisAssetDiscovery — permission gating", () => {
  it("omits Save entirely for a read-level caller", async () => {
    const D = load({ scan: "read" });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    expect(doc.getElementById("nd-save")).toBeNull();
    // …and the walkthrough still works, so the config can be read.
    (doc.querySelector('#nd-stepper .stepper-step[data-step="2"]') as HTMLElement).click();
    expect(activeStep()).toBe("2");
  });

  it("renders Save for a write-level caller", async () => {
    const D = load({ scan: "write" });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    expect(doc.getElementById("nd-save")).toBeTruthy();
  });

  it("offers no Run button to a read-level caller", async () => {
    const D = load({ scan: "read", scans: [] });
    await D.open({ id: "s1", name: "x", targets: [{ kind: "cidr", value: "10.4.0.0/29" }], methods: [{ type: "icmp" }] });
    (doc.querySelector('#nd-stepper .stepper-step[data-step="4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(doc.getElementById("nd-run-btn")).toBeNull();
    expect(doc.getElementById("nd-step-4")!.innerHTML).toMatch(/permission/i);
  });
});

describe("PolarisAssetDiscovery — saved list row verbs", () => {
  const scan = { id: "s1", name: "Ashfield", targets: [], methods: [], latestRun: null, isOwner: true };
  const labels = (items: { label?: string; separator?: boolean }[]) =>
    items.filter((i) => !i.separator).map((i) => i.label);

  it("gives a write-level caller the full set", () => {
    const D = load({ scan: "write" });
    (g.window as any).PolarisDiscoveryPortability = { buildExportFile: () => ({}), filenameForExport: () => "x.json" };
    expect(labels(D.listRowItems(scan))).toEqual(["Open…", "Run now", "Export config", "Delete"]);
  });

  it("gives a read-level caller Export only", () => {
    const D = load({ scan: "read" });
    (g.window as any).PolarisDiscoveryPortability = { buildExportFile: () => ({}), filenameForExport: () => "x.json" };
    // No trigger for verbs the routes would refuse — and no leading separator
    // stranded before an empty group.
    const items = D.listRowItems(scan);
    expect(labels(items)).toEqual(["Export config"]);
    expect(items.some((i) => i.separator)).toBe(false);
  });

  it("omits Export when the portability module is not loaded", () => {
    const D = load({ scan: "write" });
    delete (g.window as any).PolarisDiscoveryPortability;
    expect(labels(D.listRowItems(scan))).toEqual(["Open…", "Run now", "Delete"]);
  });
});

describe("PolarisAssetDiscovery — visibility", () => {
  const theirs = {
    id: "s9",
    name: "Ashfield management",
    visibility: "public",
    isOwner: false,
    createdBy: "priya",
    targets: [{ kind: "cidr", value: "10.4.0.0/29" }],
    methods: [{ type: "icmp" }],
  };

  it("offers the visibility control on a new Discovery, defaulting to private", async () => {
    const D = load({ scan: "write" });
    await D.open();
    const sel = doc.getElementById("nd-visibility") as HTMLSelectElement | null;
    expect(sel).toBeTruthy();
    // happy-dom mis-parses `<option selected>`, so the marker is read off the
    // rendered markup rather than off `select.value` (the trap that made an
    // earlier wizard suite collect the wrong metric).
    expect(doc.getElementById("nd-step-1")!.innerHTML).toMatch(/value="private" selected/);
    expect(D.emptyDraft().visibility).toBe("private");
  });

  it("renders someone else's SHARED Discovery read-only, naming its owner", async () => {
    const D = load({ scan: "write" });
    await D.open(theirs);
    // No control that would be refused, and no Save button behind it.
    expect(doc.getElementById("nd-visibility")).toBeNull();
    expect(doc.getElementById("nd-save")).toBeNull();
    const html = doc.getElementById("nd-step-1")!.innerHTML;
    expect(html).toMatch(/Shared/);
    expect(html).toMatch(/priya/);
  });

  it("still lets that caller RUN it — without saving first", async () => {
    const D = load({ scan: "write" });
    await D.open(theirs);
    (doc.querySelector('#nd-stepper .stepper-step[data-step="4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const btn = doc.getElementById("nd-run-btn");
    expect(btn).toBeTruthy();
    // The copy has to stop claiming it saves: there is nothing of theirs to save.
    expect(btn!.textContent).toBe("Start scan");
    expect(doc.getElementById("nd-step-4")!.innerHTML).toMatch(/belongs to someone else/i);
  });

  it("hands fullwrite the editing affordances on someone else's row", async () => {
    const D = load({ scan: "fullwrite" as never });
    await D.open(theirs);
    expect(doc.getElementById("nd-save")).toBeTruthy();
    expect(doc.getElementById("nd-visibility")).toBeTruthy();
  });

  it("treats an ABSENT isOwner as yours rather than hiding Save", () => {
    // The server always sends it; a payload without one is not a reason to
    // silently remove a capability the route would have allowed.
    const D = load({ scan: "write" });
    expect(D.canEditDraft({ id: "s1" })).toBe(true);
    expect(D.canEditDraft({ id: "s1", isOwner: false })).toBe(false);
    expect(D.canEditDraft({ isOwner: false })).toBe(true); // unsaved: yours by construction
  });

  it("drops Delete from a shared row's menu but keeps Run", () => {
    const D = load({ scan: "write" });
    delete (g.window as any).PolarisDiscoveryPortability;
    const labels = D.listRowItems({ ...theirs, latestRun: null }).filter((i) => !i.separator).map((i) => i.label);
    expect(labels).toEqual(["Open…", "Run now"]);
  });

  it("names the owner in the list's Owner cell", () => {
    const D = load({ scan: "write" });
    expect(D.ownerCellHtml({ isOwner: true, visibility: "private", createdBy: "me" })).toBe("You");
    expect(D.ownerCellHtml({ isOwner: false, visibility: "public", createdBy: "priya" })).toMatch(/^priya .*Shared/);
    expect(D.ownerCellHtml({ isOwner: true, visibility: "public", createdBy: "me" })).toMatch(/^You .*Shared/);
  });
});
