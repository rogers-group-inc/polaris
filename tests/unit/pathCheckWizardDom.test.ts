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
  // A minimal condition builder: an empty tree, and a "rule" when seeded.
  (win as any).PolarisConditionBuilder = {
    create: () => ({
      groupHtml: () => '<div class="scg-group"></div>',
      wire: () => {},
      collect: () => ({ op: "and", children: [] }),
      validate: () => null,
      seedIfEmpty: () => {},
    }),
  };
  g.api = {
    pathChecks: {
      filterSchema: async () => ({ scopeCondition: { fields: [] }, options: {} }),
      previewSources: async () => ({ total: 0, pinned: 0, matchedWithoutAgent: 0, agents: [], pinnedWithoutAgent: [], minAgentVersion: "0.21.0" }),
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

  it("disables the server box for a caller without networkScan:write", async () => {
    const PC = load({ networkScan: "read" });
    await PC.openCheckModal(null);
    const cb = doc.getElementById("pc-server") as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(body().textContent).toMatch(/Needs Read-Write on Network Discovery/);
  });
});

describe("pure helpers", () => {
  it("maps each validation tab to its step", () => {
    const PC = load();
    expect(["general", "expect", "trace", "sources"].map(PC.stepOfTab)).toEqual([1, 2, 3, 4]);
  });
  it("lets an empty condition tree stand when something else runs the check", () => {
    const PC = load();
    const empty = { error: "x", empty: true };
    expect(PC.scopeProblem(empty, { runOnServer: true, assetIds: [], scope: {} })).toBeNull();
    expect(PC.scopeProblem(empty, { runOnServer: false, assetIds: ["a1"], scope: {} })).toBeNull();
    expect(PC.scopeProblem(empty, { runOnServer: false, assetIds: [], scope: {} })).toMatchObject({ tab: "sources" });
    // A tree with a bad row is refused even when the server runs the check.
    expect(PC.scopeProblem({ error: "Pick a value" }, { runOnServer: true, assetIds: [], scope: {} })).toMatchObject({ tab: "sources", message: "Pick a value" });
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
