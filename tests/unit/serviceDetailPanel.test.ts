/**
 * tests/unit/serviceDetailPanel.test.ts — the Services tab's per-service
 * slide-in (openServiceDetailPanel) and the helpers the table shares with it.
 * A Windows service shows its startup type in the Services console's words,
 * its description, and its CPU; figures from a process several services share
 * say so; and the log section names the Event Log instead of claiming Windows
 * logs are "collected elsewhere". Evaluates the REAL functions out of
 * public/js/assets.js.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, unknown>;

// CRLF-normalized, so the "\n}\n" slice finds a function's end in a Windows checkout.
const SRC = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").replace(/\r\n/g, "\n");

function extractFunction(name: string): string {
  const m = new RegExp("\\n(async )?function " + name + "\\(").exec(SRC);
  if (!m) throw new Error("function not found: " + name);
  const start = m.index + 1;
  return SRC.slice(start, SRC.indexOf("\n}\n", start) + 2);
}

function extractVar(name: string): string {
  const start = SRC.indexOf("\nvar " + name + " ");
  if (start < 0) throw new Error("var not found: " + name);
  return SRC.slice(start + 1, SRC.indexOf(";\n", start) + 2);
}

type Svc = Record<string, unknown>;
let openServiceDetailPanel: (asset: unknown, svc: Svc, shared?: string[]) => void;
let svcStartupLabel: (svc: Svc) => string;
let sharedIndex: (rows: Svc[]) => Record<string, string[]>;
let sharedTag: (svc: Svc, byPid: Record<string, string[]>) => string;
let logCalls: unknown[][] = [];
let win: Window;

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g._fmtBytes = (n: number) => Math.round(n / 1e6) + " MB";
  g._ensureProcPanelDOM = () => {
    if (win.document.getElementById("proc-panel-body")) return;
    win.document.body.innerHTML =
      '<div id="proc-panel-overlay"><h3 id="proc-panel-title"></h3><div id="proc-panel-meta"></div>' +
      '<div id="proc-panel-body"></div><div id="proc-panel-footer"></div></div>';
  };
  g._setProcPanelFooter = () => {};
  g.raiseSlideover = () => {};
  g.revealOverlay = () => {};
  g._loadServiceConnectionsFor = () => {};
  g._loadServiceLogsFor = (...a: unknown[]) => { logCalls.push(a); };
  g._exportPanelLogsCsv = () => {};
  const code = [
    extractVar("_WIN_START_MODE_LABELS"),
    extractFunction("_svcStatePill"),
    extractFunction("_svcStartupLabel"),
    extractFunction("_svcSharedProcessIndex"),
    extractFunction("_svcSharedTagHTML"),
    extractFunction("openServiceDetailPanel"),
  ].join("\n");
  const fns = new Function(code + "\nreturn { openServiceDetailPanel, _svcStartupLabel, _svcSharedProcessIndex, _svcSharedTagHTML };")();
  openServiceDetailPanel = fns.openServiceDetailPanel;
  svcStartupLabel = fns._svcStartupLabel;
  sharedIndex = fns._svcSharedProcessIndex;
  sharedTag = fns._svcSharedTagHTML;
});

const ASSET = { id: "a1", hostname: "ws-01" };
const body = () => win.document.getElementById("proc-panel-body")!.textContent ?? "";

describe("_svcStartupLabel", () => {
  it("speaks the Services console's words for a Windows start mode", () => {
    expect(svcStartupLabel({ platform: "windows", enabledState: "auto-delayed" })).toBe("Automatic (Delayed Start)");
    expect(svcStartupLabel({ platform: "windows", enabledState: "auto" })).toBe("Automatic");
    expect(svcStartupLabel({ platform: "windows", enabledState: "manual" })).toBe("Manual");
  });
  it("leaves a systemd enablement state as reported", () => {
    expect(svcStartupLabel({ platform: "systemd", enabledState: "enabled" })).toBe("enabled");
    expect(svcStartupLabel({ platform: "systemd", enabledState: null })).toBe("—");
  });
});

describe("shared-process marking", () => {
  const rows = [
    { unit: "Dnscache", mainPid: 900, mainProcess: "svchost.exe" },
    { unit: "NlaSvc", mainPid: 900, mainProcess: "svchost.exe" },
    { unit: "Spooler", mainPid: 6616, mainProcess: "spoolsv.exe" },
    { unit: "wuauserv", mainPid: null },
  ];
  it("groups units by process and tags only a process with two or more", () => {
    const idx = sharedIndex(rows);
    expect(idx[900]).toEqual(["Dnscache", "NlaSvc"]);
    expect(sharedTag(rows[0]!, idx)).toContain("shared");
    expect(sharedTag(rows[0]!, idx)).toContain("2 services run in svchost.exe (PID 900)");
    expect(sharedTag(rows[2]!, idx)).toBe("");
    expect(sharedTag(rows[3]!, idx)).toBe("");
  });
});

describe("openServiceDetailPanel", () => {
  it("shows a Windows service's startup type, description, CPU and Event Log section", () => {
    logCalls = [];
    openServiceDetailPanel(ASSET, {
      unit: "BITS", platform: "windows", displayName: "Background Intelligent Transfer Service",
      description: "Transfers files in the background.", activeState: "running",
      enabledState: "auto-delayed", mainPid: 11020, mainProcess: "svchost.exe",
      memBytes: "24000000", cpuPct: 1.234,
    }, ["BITS"]);
    const t = body();
    expect(t).toContain("Startup type");
    expect(t).toContain("Automatic (Delayed Start)");
    expect(t).toContain("Transfers files in the background.");
    expect(t).toContain("1.2%");
    expect(t).toContain("24 MB");
    expect(t).toContain("Event Log");
    expect(t).not.toContain("collected via the Event Log stream");
    expect(t).not.toContain("Shares its process with");
    expect(t).not.toContain("(whole process)");
    // The platform reaches the log loader so its empty-state text can be Windows-specific.
    expect(logCalls.at(-1)).toEqual(["a1", "BITS", "windows"]);
  });

  it("names the services a shared process holds and marks its figures", () => {
    openServiceDetailPanel(ASSET, {
      unit: "Dnscache", platform: "windows", activeState: "running", enabledState: "auto",
      mainPid: 900, mainProcess: "svchost.exe", memBytes: "50000000", cpuPct: 0.5,
    }, ["Dnscache", "NlaSvc", "LanmanWorkstation"]);
    const t = body();
    expect(t).toContain("Shares its process with");
    expect(t).toContain("NlaSvc, LanmanWorkstation");
    expect(t).toContain("(whole process)");
  });

  it("keeps the systemd wording and dashes a CPU the agent has not measured yet", () => {
    openServiceDetailPanel(ASSET, {
      unit: "sshd.service", platform: "systemd", displayName: "OpenSSH server daemon",
      activeState: "active", subState: "running", enabledState: "enabled",
      mainPid: 812, mainProcess: "sshd", memBytes: null, cpuPct: null,
    }, ["sshd.service"]);
    const t = body();
    expect(t).toContain("Enabled");
    expect(t).not.toContain("Startup type");
    expect(t).toContain("journalctl");
    expect(t).not.toContain("Description");
    expect(t).toMatch(/CPU\s*—/);
  });
});
