/**
 * tests/unit/automationScriptPortability.test.ts — one automation script to and
 * from a file (public/js/automation-script-portability.js): an export carries
 * no id, hash or enabled flag and round-trips through import; a plain script
 * file imports with its interpreter read from the extension or #! line; bad
 * files are refused with a message an operator can act on.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const win: Record<string, unknown> = {};
new Function("window", readFileSync(resolve(__dirname, "../../public/js/automation-script-portability.js"), "utf8"))(win);
const P = win.PolarisScriptPortability as {
  exportText: (sc: Record<string, unknown>, now?: Date) => string;
  filenameForExport: (sc: Record<string, unknown>) => string;
  parseImportFile: (text: string, filename: string) => Record<string, any>;
  MAX_IMPORT_BYTES: number;
};

const row = {
  id: "11111111-2222-4333-8444-555555555555", name: "cert-mail", description: "Mail a renewed cert",
  interpreter: "python3", runTarget: "server", timeoutSec: 30, enabled: true,
  sha256: "abc", createdBy: "dmoore", body: "#!/usr/bin/env python3\nprint('hi')\n",
};

describe("export", () => {
  it("writes the fields that make the script, and nothing install-specific", () => {
    const doc = JSON.parse(P.exportText(row, new Date("2026-11-16T12:00:00Z")));
    expect(doc).toEqual({
      polarisScript: 1, exportedAt: "2026-11-16T12:00:00.000Z", name: "cert-mail", description: "Mail a renewed cert",
      interpreter: "python3", runTarget: "server", timeoutSec: 30, body: row.body,
    });
    expect(P.filenameForExport({ name: 'a/b:c*"d' })).toBe("a_b_c_d.script.json");
  });

  it("round-trips through import", () => {
    const back = P.parseImportFile(P.exportText(row), "cert-mail.script.json");
    expect(back).toMatchObject({ name: "cert-mail", description: "Mail a renewed cert", interpreter: "python3", runTarget: "server", timeoutSec: 30, body: row.body, problems: [] });
  });
});

describe("import", () => {
  it("reads a plain script file: body, name from the file, interpreter from the extension", () => {
    expect(P.parseImportFile("Write-Host hi", "Restart Spooler.ps1")).toMatchObject({ name: "Restart Spooler", interpreter: "powershell", runTarget: "server", body: "Write-Host hi", problems: [] });
    expect(P.parseImportFile("echo hi", "x.bat").interpreter).toBe("cmd");
    expect(P.parseImportFile("echo hi", "x.sh").interpreter).toBe("bash");
  });

  it("falls back to the #! line, then to bash with a note", () => {
    expect(P.parseImportFile("#!/usr/bin/python3\nprint(1)", "tool").interpreter).toBe("python3");
    const guessed = P.parseImportFile("echo hi", "notes.txt");
    expect(guessed.interpreter).toBe("bash");
    expect(guessed.problems[0]).toMatch(/check it/);
  });

  it("keeps a bad field out rather than trusting it", () => {
    const doc = JSON.stringify({ polarisScript: 1, name: "x", interpreter: "perl", runTarget: "everywhere", timeoutSec: 9999, body: "echo" });
    const r = P.parseImportFile(doc, "x.script.json");
    expect(r).toMatchObject({ interpreter: "bash", runTarget: "server", timeoutSec: 60 });
    expect(r.problems.join(" ")).toMatch(/interpreter/);
  });

  it("refuses empty, oversized, non-export JSON and over-64KB bodies", () => {
    expect(() => P.parseImportFile("  ", "a.sh")).toThrow(/empty/);
    expect(() => P.parseImportFile("x".repeat(P.MAX_IMPORT_BYTES + 1), "a.sh")).toThrow(/too large/);
    expect(() => P.parseImportFile("{\"rule\":{}}", "a.script.json")).toThrow(/not a Polaris script export/);
    expect(() => P.parseImportFile("{oops", "a.script.json")).toThrow(/Invalid JSON/);
    expect(() => P.parseImportFile("y".repeat(65 * 1024), "a.sh")).toThrow(/64 KB/);
  });

  it("notes a newer format version", () => {
    const r = P.parseImportFile(JSON.stringify({ polarisScript: 2, name: "x", interpreter: "sh", body: "true" }), "x.script.json");
    expect(r.problems[0]).toMatch(/version 2/);
  });
});

describe("what an import into an existing script may take", () => {
  it("flags an export, a plain file, and an interpreter that is only a guess", () => {
    expect(P.parseImportFile(JSON.stringify({ name: "x", interpreter: "sh", body: "true" }), "x.script.json")).toMatchObject({ fromExport: true, interpreterGuessed: false });
    expect(P.parseImportFile(JSON.stringify({ name: "x", body: "true" }), "x.json")).toMatchObject({ fromExport: true, interpreterGuessed: true });
    expect(P.parseImportFile("echo hi", "x.sh")).toMatchObject({ fromExport: false, interpreterGuessed: false });
    expect(P.parseImportFile("#!/bin/bash\necho hi", "tool")).toMatchObject({ fromExport: false, interpreterGuessed: false });
    expect(P.parseImportFile("echo hi", "notes.txt")).toMatchObject({ fromExport: false, interpreterGuessed: true });
  });
});
