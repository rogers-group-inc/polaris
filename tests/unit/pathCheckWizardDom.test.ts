/**
 * tests/unit/pathCheckWizardDom.test.ts — the Add / Edit Path Check wizard
 * (public/js/path-checks.js → openCheckModal).
 *
 * The modal was four peer tabs; it is now the automations wizard's stepper
 * idiom with ITS OWN steps (General → Expectations → Traceroute → Sources,
 * in that order — the operator's choice, 2026-09-30) and Back / Next. Pinned:
 *
 *  - `.stepper` is the DIRECT FIRST CHILD of `.modal-body` (the sticky rule
 *    and the `:has(> .stepper:first-child)` padding rule key off that);
 *  - the four steps, their order, and the connecting `.stepper-line`s, which
 *    turn `.done` as the operator moves past a step;
 *  - Back is hidden on step 1, Next on the last step, and a NEW check shows
 *    Create only on the last step, while an EDIT shows Save on every step;
 *  - Next validates the step it leaves (a nameless check cannot leave
 *    General), Back never validates;
 *  - a fresh draft can only jump to steps it has visited; an edit, to any;
 *  - "Run from this Polaris server" is a source on its own — a check with no
 *    agent hosts but the server ticked saves, posting runOnServer: true;
 *  - the server box is disabled for a caller without networkScan:write.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/path-checks.js"), "utf8");
const g = globalThis as Record<string, any>;
let doc: Window["document"];
let toasts: { msg: string; kind?: string }[];
let posted: any[];
let seeded = 0;
let filledTree: any = null; // a finder condition the mock builder "holds"
let previewCalls: any[] = [];
const EMPTY_PREVIEW = { total: 0, ids: [], pinned: 0, matchedWithoutAgent: 0, agents: [], pinnedWithoutAgent: [], minAgentVersion: "0.21.0" };
let previewRes: any = EMPTY_PREVIEW;

function load(opts: { networkScan?: "read" | "write" } = {}) {
  const win = new Window();
  doc = win.document;
  toasts = [];
  posted = [];
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
  g.closeModal = () => { doc.getElementById("modal-overlay")?.remove(); };
  g.sectionHeading = (t: string) => "<p>" + t + "</p>";
  g.formDivider = () => "<hr>";
  g.infoBox = (h: string) => "<div>" + h + "</div>";
  g.permAtLeast = (key: string, level: string) => {
    if (key === "networkScan") return (opts.networkScan ?? "write") === "write" || level === "read";
    return true;
  };
  g.openModal = (title: string, body: string, footer: string) => {
    let overlay = doc.getElementById("modal-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "modal-overlay";
      overlay.innerHTML = '<div class="modal"><div class="modal-header"><h3></h3></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
      doc.body.appendChild(overlay);
    }
    overlay.querySelector(".modal-header h3")!.textContent = title;
    overlay.querySelector(".modal-body")!.innerHTML = body;
    overlay.querySelector(".modal-footer")!.innerHTML = footer;
  };
  // A minimal condition builder: an empty tree until seeded, and then — like
  // the real one — one unfilled row that refuses validation.
  seeded = 0;
  filledTree = null;
  previewCalls = [];
  previewRes = EMPTY_PREVIEW;
  (win as any).PolarisConditionBuilder = {
    create: () => ({
      groupHtml: () => '<div class="scg-group"></div>',
      wire: () => {},
      collect: () => filledTree || ({ op: "and", children: seeded ? [{ field: "", op: "eq", value: "" }] : [] }),
      validate: (tree: any) => (tree.children.some((r: any) => !r.field) ? "Pick a field" : null),
      seedIfEmpty: () => { seeded++; },
    }),
  };
  g.api = {
    credentials: {
      list: async () => [
        { id: "cr-basic", name: "ERP login", type: "http", config: { authMode: "basic", username: "svc" } },
        { id: "cr-form", name: "Switch admin", type: "http", config: { authMode: "form", username: "admin" } },
        { id: "cr-snmp", name: "public", type: "snmp", config: {} },
      ],
    },
    pathChecks: {
      filterSchema: async () => ({ scopeCondition: { fields: [] }, options: {} }),
      previewSources: async (b: any) => { previewCalls.push(b); return previewRes; },
      create: async (body: any) => { posted.push(body); return { id: "c1" }; },
      update: async (_id: string, body: any) => { posted.push(body); return { id: "c1" }; },
      list: async () => ({ checks: [] }),
      test: async (body: any) => {
        posted.push({ test: body });
        return { source: "server", httpVersion: "1.1", sample: { ok: false, httpStatus: 204, error: "HTTP 204 (expected 200)", latencyMs: 12 },
          headers: { "content-type": "text/plain" }, body: "status: UP" };
      },
    },
  };
  (0, eval)(SRC);
  return (win as any).PolarisPathChecks;
}

const body = () => doc.querySelector("#modal-overlay .modal-body") as HTMLElement;
const activeStep = () => (doc.querySelector("#pc-stepper .stepper-step.active") as HTMLElement | null)?.getAttribute("data-step");
const shown = (id: string) => { const el = doc.getElementById(id) as HTMLElement | null; return !!el && el.style.display !== "none"; };
const click = (id: string) => (doc.getElementById(id) as HTMLElement).click();
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("path check wizard — shell", () => {
  it("renders the stepper first, with the four steps in the operator's order", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    const first = body().firstElementChild as HTMLElement;
    expect(first.classList.contains("stepper")).toBe(true);
    const labels = Array.from(doc.querySelectorAll("#pc-stepper .stepper-step")).map((el) => (el as HTMLElement).textContent!.replace(/^\d/, ""));
    expect(labels).toEqual(["General", "Expectations", "Traceroute", "Sources"]);
    expect(doc.querySelectorAll("#pc-stepper .stepper-line")).toHaveLength(3);
    expect(PC.STEPS.map((s: any) => s.key)).toEqual(["general", "expect", "trace", "sources"]);
    // Every step leads with its question.
    for (let i = 1; i <= 4; i++) expect(doc.querySelector(`#pc-step-${i} > h3`)).not.toBeNull();
  });

  it("walks forward with Next, back with Back, and marks the lines it passed", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    expect(activeStep()).toBe("1");
    expect(shown("pc-back")).toBe(false);
    expect(shown("pc-next")).toBe(true);
    expect(shown("pc-save")).toBe(false);
    // A nameless check cannot leave General.
    click("pc-next");
    expect(activeStep()).toBe("1");
    expect(toasts.pop()?.msg).toMatch(/Name is required/);
    (doc.getElementById("pc-name") as HTMLInputElement).value = "Intranet";
    (doc.getElementById("pc-target") as HTMLInputElement).value = "https://intranet.example/health";
    click("pc-next");
    expect(activeStep()).toBe("2");
    expect(doc.querySelector('#pc-stepper .stepper-line[data-line="1"]')!.classList.contains("done")).toBe(true);
    expect(doc.querySelector('#pc-stepper .stepper-line[data-line="2"]')!.classList.contains("done")).toBe(false);
    click("pc-next");
    click("pc-next");
    expect(activeStep()).toBe("4");
    expect(shown("pc-next")).toBe(false);
    expect(shown("pc-save")).toBe(true);
    // Back never validates.
    (doc.getElementById("pc-name") as HTMLInputElement).value = "";
    click("pc-back");
    expect(activeStep()).toBe("3");
  });

  it("jumps only to visited steps on a new check, and to any step on an edit", async () => {
    let PC = load();
    await PC.openCheckModal(null);
    (doc.querySelector('#pc-stepper .stepper-step[data-step="4"]') as HTMLElement).click();
    expect(activeStep()).toBe("1");
    PC = load();
    const existing = {
      id: "c9", name: "Intranet", kind: "https", target: "https://intranet.example/", intervalSec: 60, timeoutMs: 5000, enabled: true,
      http: { expectStatus: "", verifyTls: true, bodyMatch: null }, traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
      scope: { allAssets: true }, assetIds: [], runOnServer: false,
    };
    await PC.openCheckModal(existing);
    expect(shown("pc-save")).toBe(true); // edit: Save on every step
    (doc.querySelector('#pc-stepper .stepper-step[data-step="4"]') as HTMLElement).click();
    expect(activeStep()).toBe("4");
  });
});

describe("path check wizard — the Polaris server source", () => {
  it("saves a check whose only source is this server", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    (doc.getElementById("pc-name") as HTMLInputElement).value = "ERP from the server";
    (doc.getElementById("pc-target") as HTMLInputElement).value = "https://erp.example/";
    (doc.getElementById("pc-all-hosts") as HTMLInputElement).checked = false;
    (doc.getElementById("pc-server") as HTMLInputElement).checked = true;
    click("pc-next"); click("pc-next"); click("pc-next");
    click("pc-save");
    await flush();
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ runOnServer: true, assetIds: [], scope: {} });
  });

  it("refuses a check with no source at all, on the Sources step", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    (doc.getElementById("pc-name") as HTMLInputElement).value = "Nowhere";
    (doc.getElementById("pc-target") as HTMLInputElement).value = "https://x.example/";
    (doc.getElementById("pc-all-hosts") as HTMLInputElement).checked = false;
    click("pc-next"); click("pc-next"); click("pc-next");
    click("pc-save");
    await flush();
    expect(posted).toHaveLength(0);
    expect(activeStep()).toBe("4");
    expect(toasts.pop()?.msg).toMatch(/Run from this Polaris server/);
  });

  const serverOnly = {
    id: "c7", name: "ERP", kind: "https", target: "https://erp.example/", intervalSec: 60, timeoutMs: 5000, enabled: true,
    http: { expectStatus: "", verifyTls: true, bodyMatch: null }, traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
    scope: {}, assetIds: [], runOnServer: true,
  };
  const change = (id: string) => (doc.getElementById(id) as HTMLElement).dispatchEvent(new (g.window as any).Event("change"));

  it("is a toggle switch, and hides the agent filter while it is on", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    const cb = doc.getElementById("pc-server") as HTMLInputElement;
    expect(cb.closest(".toggle-switch")).not.toBeNull();
    expect(shown("pc-agent-sources")).toBe(true);
    cb.checked = true; change("pc-server");
    expect(shown("pc-agent-sources")).toBe(false);
    cb.checked = false; change("pc-server");
    expect(shown("pc-agent-sources")).toBe(true);
  });

  it("edits a server-only check without seeding a condition row, and saves it unchanged", async () => {
    const PC = load();
    await PC.openCheckModal(serverOnly);
    expect(seeded).toBe(0);
    expect(shown("pc-agent-sources")).toBe(false);
    click("pc-save");
    await flush();
    expect(toasts.filter((t) => t.kind === "error")).toEqual([]);
    expect(posted[0]).toMatchObject({ runOnServer: true, scope: {}, assetIds: [] });
  });

  it("seeds the finder when the toggle is turned off, and refuses the save until a host is ticked", async () => {
    const PC = load();
    await PC.openCheckModal(serverOnly);
    const cb = doc.getElementById("pc-server") as HTMLInputElement;
    cb.checked = false; change("pc-server");
    expect(seeded).toBe(1);
    click("pc-save");
    await flush();
    expect(posted).toHaveLength(0);
    // An unfilled finder row is not the refusal; having no source is.
    expect(toasts.pop()?.msg).toMatch(/tick at least one agent host/);
  });

  it("drops the agent hosts of a check that ran from both when saved with the toggle on, and says so first", async () => {
    const PC = load();
    await PC.openCheckModal({ ...serverOnly, scope: { allAssets: true }, assetIds: ["a1"] });
    expect(shown("pc-both-note")).toBe(true);
    click("pc-save");
    await flush();
    expect(posted[0]).toMatchObject({ runOnServer: true, scope: {}, assetIds: [] });
  });

  it("disables the server box for a caller without networkScan:write", async () => {
    const PC = load({ networkScan: "read" });
    await PC.openCheckModal(null);
    const cb = doc.getElementById("pc-server") as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(body().textContent).toMatch(/Needs Read-Write on Network Discovery/);
  });
});

describe("path check wizard — find hosts with the filter, tick the ones that run it", () => {
  const TREE = { op: "and", children: [{ field: "tag", op: "has", value: "Camera Station" }] };
  const host = (id: string) => ({ assetId: id, hostname: id.toUpperCase(), ipAddress: "10.0.0.1", os: "Windows", agentVersion: "0.23.0", online: true, supported: true, pinned: false, pinnedOnly: false });
  // Three matches, but only two rows shown (the preview's display cap).
  const THREE = { ...EMPTY_PREVIEW, total: 3, ids: ["h1", "h2", "h3"], agents: [host("h1"), host("h2")] };
  const agentCheck = {
    id: "c5", name: "Cams", kind: "https", target: "https://cams.example/", intervalSec: 60, timeoutMs: 5000, enabled: true,
    http: { expectStatus: "", verifyTls: true, bodyMatch: null }, traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 },
    runOnServer: false,
  };
  const pinBox = (id: string) => doc.querySelector(`.pc-pin[data-id="${id}"]`) as HTMLInputElement;
  const tick = (el: HTMLInputElement, on: boolean) => { el.checked = on; el.dispatchEvent(new (g.window as any).Event("change")); };

  it("lists the matches unticked, with a Select all / none box at the top", async () => {
    const PC = load();
    filledTree = TREE; previewRes = THREE;
    await PC.openCheckModal({ ...agentCheck, scope: {}, assetIds: [], sourceFilter: { condition: TREE } });
    await flush();
    expect(previewCalls[0]).toMatchObject({ scope: { condition: TREE }, assetIds: [] });
    const all = doc.getElementById("pc-select-all") as HTMLInputElement;
    expect(all).not.toBeNull();
    expect(all.checked).toBe(false);
    expect(pinBox("h1").checked).toBe(false);
    expect(doc.getElementById("pc-selection-head")!.textContent).toMatch(/0 of 3 agent hosts selected/);
  });

  it("Select all ticks every match — past the rows shown — and none clears them; ticked hosts are what saves", async () => {
    const PC = load();
    filledTree = TREE; previewRes = THREE;
    await PC.openCheckModal({ ...agentCheck, scope: {}, assetIds: [], sourceFilter: { condition: TREE } });
    await flush();
    const all = doc.getElementById("pc-select-all") as HTMLInputElement;
    tick(all, true);
    expect(pinBox("h1").checked && pinBox("h2").checked).toBe(true);
    expect(doc.getElementById("pc-selection-head")!.textContent).toMatch(/3 of 3/);
    tick(all, false);
    expect(pinBox("h1").checked || pinBox("h2").checked).toBe(false);
    expect(doc.getElementById("pc-selection-head")!.textContent).toMatch(/0 of 3/);
    tick(all, true);
    tick(pinBox("h2"), false);
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    click("pc-save");
    await flush();
    // Only the ticked hosts run it; the filter is kept for display, not membership.
    expect(posted[0]).toMatchObject({ scope: {}, runOnServer: false, sourceFilter: { condition: TREE } });
    expect([...posted[0].assetIds].sort()).toEqual(["h1", "h3"]);
  });

  it("ticks what a check that used to follow its filter was running on, and says so", async () => {
    const PC = load();
    filledTree = TREE; previewRes = THREE;
    await PC.openCheckModal({ ...agentCheck, scope: { condition: TREE }, assetIds: [] });
    await flush();
    expect(shown("pc-follow-note")).toBe(true);
    expect(pinBox("h1").checked).toBe(true);
    click("pc-save");
    await flush();
    expect(posted[0]).toMatchObject({ scope: {}, sourceFilter: { condition: TREE } });
    expect([...posted[0].assetIds].sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("keeps All agent hosts as the one dynamic choice, with no host list and no pins", async () => {
    const PC = load();
    await PC.openCheckModal({ ...agentCheck, scope: { allAssets: true }, assetIds: ["h1"] });
    await flush();
    expect(previewCalls).toHaveLength(0);
    click("pc-save");
    await flush();
    expect(posted[0]).toMatchObject({ scope: { allAssets: true }, assetIds: [], sourceFilter: null });
  });
});

describe("pure helpers", () => {
  it("maps each validation tab to its step", () => {
    const PC = load();
    expect(["general", "expect", "trace", "sources"].map(PC.stepOfTab)).toEqual([1, 2, 3, 4]);
  });
  it("reads the Select-all state over every match against the ticked set", () => {
    const PC = load();
    expect(PC.selectionState(["a", "b"], new Set(["a", "b"]))).toEqual({ selected: 2, all: true, some: true });
    expect(PC.selectionState(["a", "b"], new Set(["a"]))).toEqual({ selected: 1, all: false, some: true });
    expect(PC.selectionState(["a", "b"], new Set())).toEqual({ selected: 0, all: false, some: false });
    // A tick outside the filter counts as selected but not toward "all".
    expect(PC.selectionState(["a"], new Set(["z"]))).toEqual({ selected: 1, all: false, some: false });
    expect(PC.selectionState([], new Set())).toMatchObject({ all: false });
  });
  it("names a run OK, Fail, or Unexpected response when an HTTP answer came back wrong", () => {
    const PC = load();
    expect(PC.resultState(true, 200)).toBe("ok");
    expect(PC.resultState(false, 503)).toBe("unexpected");
    expect(PC.resultState(false, null)).toBe("fail");
    expect(PC.resultState(null, null)).toBeNull();
  });
  it("counts a check's sources per state, zeros left out", () => {
    const PC = load();
    expect(PC.checkResultCounts({ okCount: 3, failCount: 0 })).toEqual([{ state: "ok", count: 3 }]);
    // unexpectedCount is carved out of failCount, not added to it.
    expect(PC.checkResultCounts({ okCount: 3, failCount: 3, unexpectedCount: 1 })).toEqual([
      { state: "ok", count: 3 }, { state: "unexpected", count: 1 }, { state: "fail", count: 2 },
    ]);
    expect(PC.checkResultCounts({ okCount: 0, failCount: 1, unexpectedCount: 5 })).toEqual([{ state: "unexpected", count: 1 }]);
    expect(PC.checkResultCounts({ okCount: 0, failCount: 0 })).toEqual([]);
  });
  it("renders the counts in the list's Result cell", async () => {
    const PC = load();
    const tb = doc.createElement("table");
    tb.innerHTML = '<tbody id="path-tbody"></tbody>';
    doc.body.appendChild(tb);
    g.renderPageControls = () => {};
    g.TableSF = function (this: any) { this.apply = (d: any) => d; this.getPrefs = () => ({}); this.setPrefs = () => {}; };
    g.setupColumnLayout = () => ({ getPrefs: () => null, setPrefs: () => {} });
    g.api.pathChecks.list = async () => ({ checks: [
      { id: "k1", name: "Cams", kind: "https", target: "https://c.example/", intervalSec: 60, enabled: true, sourceCount: 6, okCount: 3, failCount: 3, unexpectedCount: 1, traceroute: {} },
    ] });
    await PC.loadTab();
    expect(doc.getElementById("path-tbody")!.textContent).toMatch(/3 OK · 1 Unexpected response · 2 Fail/);
  });
  it("offers the server row its charts, and an agent row its asset", () => {
    const PC = load();
    const h = { openServer: () => {}, openAsset: () => {} };
    expect(PC.resultRowMenu(true, h).map((i: any) => i.label)).toEqual(["Show charts and path"]);
    expect(PC.resultRowMenu(false, h).map((i: any) => i.label)).toEqual(["Open asset — Paths tab"]);
  });
});

describe("path check wizard — Test from this Polaris server", () => {
  it("runs the draft, shows the answer, and turns the status into the expectation", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    (doc.getElementById("pc-name") as HTMLInputElement).value = "Intranet";
    (doc.getElementById("pc-target") as HTMLInputElement).value = "https://intranet.example/health";
    click("pc-next");
    (doc.getElementById("pc-status-spec") as HTMLInputElement).value = "200";
    click("pc-test");
    await flush(); await flush();
    expect(posted[0].test).toMatchObject({ target: "https://intranet.example/health", http: { expectStatus: "200" } });
    const out = doc.getElementById("pc-test-result")!;
    expect(out.textContent).toMatch(/Fails/);
    expect(out.textContent).toMatch(/HTTP 204 \(expected 200\)/);
    expect(doc.getElementById("pc-test-body")!.textContent).toBe("status: UP");
    click("pc-test-use-status");
    expect((doc.getElementById("pc-status-spec") as HTMLInputElement).value).toBe("204");
  });
  it("is disabled for a caller without networkScan:write", async () => {
    const PC = load({ networkScan: "read" });
    await PC.openCheckModal(null);
    expect((doc.getElementById("pc-test") as HTMLButtonElement).disabled).toBe(true);
  });
  it("renders the result panel as a pure function, escaping what came back", () => {
    const PC = load();
    const html = PC.testResultHtml({ sample: { ok: true, httpStatus: 200 }, headers: { "x-a": "<b>" }, body: "<script>x</script>" });
    expect(html).toContain("Passes");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("path check wizard — request options and authentication", () => {
  async function fillGeneral() {
    (doc.getElementById("pc-name") as HTMLInputElement).value = "ERP";
    (doc.getElementById("pc-target") as HTMLInputElement).value = "https://erp.example/health";
  }
  const change = (id: string) => (doc.getElementById(id) as HTMLElement).dispatchEvent(new (g.window as any).Event("change"));

  it("offers only Bearer / Basic / Digest http credentials", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    const opts = Array.from((doc.getElementById("pc-credential") as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).toEqual(["", "cr-basic"]);
  });

  it("locks Sources to this server once a credential is chosen, and posts no agent hosts", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    await fillGeneral();
    (doc.getElementById("pc-credential") as HTMLSelectElement).value = "cr-basic";
    change("pc-credential");
    const serverCb = doc.getElementById("pc-server") as HTMLInputElement;
    expect(serverCb.checked).toBe(true);
    expect(serverCb.disabled).toBe(true);
    expect((doc.getElementById("pc-agent-sources") as HTMLElement).style.display).toBe("none");
    expect((doc.getElementById("pc-server-only-note") as HTMLElement).style.display).toBe("");
    // Back to None and on again: the agent half comes back, then goes away.
    (doc.getElementById("pc-credential") as HTMLSelectElement).value = "";
    change("pc-credential");
    expect((doc.getElementById("pc-agent-sources") as HTMLElement).style.display).toBe("");
    (doc.getElementById("pc-credential") as HTMLSelectElement).value = "cr-basic";
    change("pc-credential");
    click("pc-next"); click("pc-next"); click("pc-next");
    click("pc-save");
    await flush();
    expect(posted[0]).toMatchObject({ credentialId: "cr-basic", runOnServer: true, scope: {}, assetIds: [] });
  });

  it("collects HEAD, the Host header, redirects and a NOT body match, and notes the agent version they need", async () => {
    const PC = load();
    await PC.openCheckModal(null);
    await fillGeneral();
    (doc.getElementById("pc-host-header") as HTMLInputElement).value = "erp-02.example";
    (doc.getElementById("pc-follow-redirects") as HTMLInputElement).checked = true;
    change("pc-follow-redirects");
    expect((doc.getElementById("pc-agent-version-note") as HTMLElement).style.display).toBe("");
    (doc.getElementById("pc-body-mode") as HTMLSelectElement).value = "!contains";
    (doc.getElementById("pc-body-pattern") as HTMLInputElement).value = "maintenance";
    const p = PC.collectCheck(doc.querySelector("#modal-overlay .modal-body"), {}, []);
    expect(p.http).toMatchObject({ method: "GET", hostHeader: "erp-02.example", followRedirects: true, bodyMatch: { mode: "contains", pattern: "maintenance", negate: true } });
    (doc.getElementById("pc-method") as HTMLSelectElement).value = "HEAD";
    const head = PC.collectCheck(doc.querySelector("#modal-overlay .modal-body"), {}, []);
    expect(PC.validateCheck(head)).toMatchObject({ tab: "expect", message: expect.stringMatching(/HEAD request has no body/) });
  });

  it("opens a stored check with its negated match and method pinned from the model", async () => {
    const PC = load();
    await PC.openCheckModal({
      id: "c9", name: "ERP", kind: "https", target: "https://erp.example/", intervalSec: 60, timeoutMs: 5000, enabled: true,
      http: { expectStatus: "", verifyTls: true, method: "GET", hostHeader: "x.example", followRedirects: true, bodyMatch: { mode: "regex", pattern: "err", caseSensitive: false, negate: true } },
      traceroute: { enabled: true, everyNRuns: 5, maxHops: 30, probesPerHop: 3 }, scope: {}, assetIds: [], runOnServer: true, credentialId: "cr-basic",
    });
    expect((doc.getElementById("pc-body-mode") as HTMLSelectElement).value).toBe("!regex");
    expect((doc.getElementById("pc-credential") as HTMLSelectElement).value).toBe("cr-basic");
    expect((doc.getElementById("pc-follow-redirects") as HTMLInputElement).checked).toBe(true);
  });

  it("filters usable credentials as a pure function", () => {
    const PC = load();
    expect(PC.usableHttpCredentials([
      { id: "a", name: "a", type: "http", config: { authMode: "digest" } },
      { id: "b", name: "b", type: "http", config: { apiToken: "***" } },
      { id: "c", name: "c", type: "http", config: { authMode: "form" } },
      { id: "d", name: "d", type: "ssh", config: {} },
    ]).map((c: any) => c.id + ":" + c.authMode)).toEqual(["a:digest", "b:bearer"]);
  });
});
