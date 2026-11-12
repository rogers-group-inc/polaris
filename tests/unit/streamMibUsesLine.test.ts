/**
 * tests/unit/streamMibUsesLine.test.ts — the read-only "MIB" line that replaced
 * the per-stream MIB picker (business rule 173; `_streamMibUsesText`,
 * `_streamMibUsesRowHTML`, `_paintStreamMibUses` in public/js/polling-methods.js).
 *
 * The picker offered every MIB on every SNMP stream, but on Response Time,
 * Interfaces and LLDP it changed nothing, and on CPU/Memory and Hardware
 * Sensors an uploaded MIB silently switched the asset into that MIB's
 * manufacturer profile (2026-11-12). The line says what is read instead: the
 * standard module for the fixed streams, the covering manufacturer profile for
 * the two profile streams.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/polling-methods.js"), "utf8").split(/\r?\n/);

function block(startsWith: string): string {
  const start = lines.findIndex((l) => l.startsWith(startsWith));
  if (start < 0) throw new Error(`${startsWith} not found`);
  const end = lines.findIndex((l, i) => i > start && (l === "}" || l === "};"));
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const src = [
    block("var _STREAM_STANDARD_MIB = {"),
    'var _PROFILE_STREAMS = ["telemetry", "temperature"];',
    block("function _streamMibUsesText("),
    block("function _streamMibUsesRowHTML("),
    block("function _paintStreamMibUses("),
  ].join("\n");
  new Function("g", src + "\ng._streamMibUsesText = _streamMibUsesText; g._streamMibUsesRowHTML = _streamMibUsesRowHTML; g._paintStreamMibUses = _paintStreamMibUses;")(g);
});

const APC = { manufacturer: "APC", mibs: ["PowerNet-MIB"] };

describe("_streamMibUsesText", () => {
  it.each([
    ["responseTime", "SNMPv2-MIB"],
    ["interfaces", "IF-MIB"],
    ["lldp", "LLDP-MIB"],
  ])("%s always reads its standard module, whatever profile covers the asset", (stream, mib) => {
    expect(g._streamMibUsesText(stream, APC, true)).toBe(mib);
    expect(g._streamMibUsesText(stream, null, false)).toBe(mib);
  });

  it("CPU/Memory names the covering profile and its MIBs, then the standard fallback", () => {
    expect(g._streamMibUsesText("telemetry", APC, true)).toBe("APC manufacturer profile (PowerNet-MIB), else HOST-RESOURCES-MIB");
    expect(g._streamMibUsesText("temperature", { manufacturer: "Cisco", mibs: [] }, true)).toBe("Cisco manufacturer profile, else ENTITY-SENSOR-MIB");
  });

  it("says when no profile covers the asset", () => {
    expect(g._streamMibUsesText("telemetry", null, true)).toBe("HOST-RESOURCES-MIB (no manufacturer profile covers this asset)");
  });

  it("shows a placeholder until the effective-settings read lands", () => {
    expect(g._streamMibUsesText("telemetry", undefined, true)).toBe("…");
  });

  it("a tier form covering many assets names no single profile", () => {
    expect(g._streamMibUsesText("telemetry", APC, false)).toBe("Each asset's manufacturer profile, else HOST-RESOURCES-MIB");
  });
});

describe("the row", () => {
  it("is read-only text, never a select, and is filled in when the profile lands", () => {
    document.body.innerHTML =
      g._streamMibUsesRowHTML("t-wrap", "t", "telemetry", undefined, true, true) +
      g._streamMibUsesRowHTML("r-wrap", "r", "responseTime", undefined, true, true) +
      g._streamMibUsesRowHTML("x-wrap", "x", "telemetry", undefined, false, false);
    expect(document.querySelector("select")).toBeNull();
    expect(document.getElementById("t")!.textContent).toBe("…");
    expect((document.getElementById("x-wrap") as HTMLElement).style.display).toBe("none");

    g._paintStreamMibUses(document, APC);
    expect(document.getElementById("t")!.textContent).toBe("APC manufacturer profile (PowerNet-MIB), else HOST-RESOURCES-MIB");
    expect(document.getElementById("r")!.textContent).toBe("SNMPv2-MIB");
    // A tier-form line is not repainted with one asset's profile.
    expect(document.getElementById("x")!.textContent).toBe("Each asset's manufacturer profile, else HOST-RESOURCES-MIB");
  });
});
