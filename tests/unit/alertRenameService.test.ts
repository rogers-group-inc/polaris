/**
 * tests/unit/alertRenameService.test.ts
 *
 * Business rule 134: an open alert follows its device's rename. The pure half —
 * which occurrences of the old name in a rendered message are the device.
 */

import { describe, expect, it } from "vitest";
import { renameInTemplateCtx, replaceDeviceName } from "../../src/services/alertRenameService.js";

describe("replaceDeviceName", () => {
  it("renames the device in a rendered message", () => {
    expect(replaceDeviceName("SIEBOLDT-61F-1 is down", "SIEBOLDT-61F-1", "HARBOR-61F-1")).toBe("HARBOR-61F-1 is down");
  });

  it("renames every occurrence", () => {
    expect(replaceDeviceName("GW-1: GW-1 lost wan1", "GW-1", "GW-2")).toBe("GW-2: GW-2 lost wan1");
  });

  it("leaves a longer name that merely contains the old one", () => {
    expect(replaceDeviceName("GATE-10 is down", "GATE-1", "X")).toBe("GATE-10 is down");
    expect(replaceDeviceName("SITE-GATE-1 is down", "GATE-1", "X")).toBe("SITE-GATE-1 is down");
    expect(replaceDeviceName("GATE-1.corp is down", "GATE-1", "X")).toBe("GATE-1.corp is down");
  });

  it("treats a sentence-ending period as punctuation", () => {
    expect(replaceDeviceName("Lost GATE-1.", "GATE-1", "GATE-9")).toBe("Lost GATE-9.");
  });

  it("matches regex metacharacters in the name literally", () => {
    expect(replaceDeviceName("a.b is down; axb is up", "a.b", "c")).toBe("c is down; axb is up");
  });

  it("returns the text unchanged when the name is absent or unchanged", () => {
    expect(replaceDeviceName("all quiet", "GW-1", "GW-2")).toBe("all quiet");
    expect(replaceDeviceName("GW-1 is down", "GW-1", "GW-1")).toBe("GW-1 is down");
    expect(replaceDeviceName("GW-1 is down", "", "GW-2")).toBe("GW-1 is down");
  });
});

describe("renameInTemplateCtx", () => {
  it("renames string values and keeps everything else", () => {
    const out = renameInTemplateCtx({ asset: "GW-1", message: "GW-1 is down", "dependency.upstream": "CORE-1", n: 3 }, "GW-1", "GW-2");
    expect(out).toEqual({ asset: "GW-2", message: "GW-2 is down", "dependency.upstream": "CORE-1", n: 3 });
  });

  it("is null when nothing changed or there is no snapshot", () => {
    expect(renameInTemplateCtx({ asset: "CORE-1" }, "GW-1", "GW-2")).toBeNull();
    expect(renameInTemplateCtx(null, "GW-1", "GW-2")).toBeNull();
    expect(renameInTemplateCtx(["GW-1"], "GW-1", "GW-2")).toBeNull();
  });
});
