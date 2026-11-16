/**
 * tests/unit/rebootSettingsService.test.ts — business rule 115(d): whether a
 * reboot must say why. Only a literal `true` turns the requirement on; a
 * settings outage reads as "not required"; the note is flattened to one line,
 * capped at REBOOT_NOTE_MAX, and refused blank only while required; a change
 * of the switch is audited, a re-save of the same value is not.
 *
 * The booking / email half is in tests/unit/rebootNote.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import {
  REBOOT_SETTING_KEY,
  REBOOT_NOTE_MAX,
  parseRebootSettings,
  getRebootSettings,
  saveRebootSettings,
  invalidateRebootSettingsCache,
  normalizeRebootNote,
  resolveRebootNote,
} from "../../src/services/rebootSettingsService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const findUnique = () => stubbed(prisma.setting.findUnique);
const upsert = () => stubbed(prisma.setting.upsert);
const stored = (value: unknown) => findUnique().mockResolvedValue(value === undefined ? null : { key: REBOOT_SETTING_KEY, value });

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  invalidateRebootSettingsCache();
  stored(undefined);
  upsert().mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe("parseRebootSettings", () => {
  it("is on only for a literal true", () => {
    expect(parseRebootSettings({ requireNote: true })).toEqual({ requireNote: true });
    for (const raw of [{ requireNote: "true" }, { requireNote: 1 }, {}, null, undefined, "x", 5, []]) {
      expect(parseRebootSettings(raw)).toEqual({ requireNote: false });
    }
  });

  it("drops unknown fields", () => {
    expect(parseRebootSettings({ requireNote: true, extra: 1 })).toEqual({ requireNote: true });
  });
});

describe("getRebootSettings", () => {
  it("reads the rebootConfig row, off when absent", async () => {
    expect(await getRebootSettings()).toEqual({ requireNote: false });
    expect(findUnique().mock.calls[0][0]).toEqual({ where: { key: "rebootConfig" } });
  });

  it("caches the read, and re-reads after invalidation", async () => {
    stored({ requireNote: true });
    await getRebootSettings();
    await getRebootSettings();
    expect(findUnique()).toHaveBeenCalledOnce();
    stored({ requireNote: false });
    invalidateRebootSettingsCache();
    expect(await getRebootSettings()).toEqual({ requireNote: false });
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it("re-reads once the 10 s TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    await getRebootSettings();
    vi.setSystemTime(new Date("2026-11-16T12:00:10.001Z"));
    await getRebootSettings();
    expect(findUnique()).toHaveBeenCalledTimes(2);
  });

  it("reads 'not required' when the settings row cannot be read", async () => {
    findUnique().mockRejectedValue(new Error("db down"));
    expect(await getRebootSettings()).toEqual({ requireNote: false });
  });
});

describe("saveRebootSettings", () => {
  it("stores the parsed value and audits a switch on with before/after", async () => {
    const out = await saveRebootSettings({ requireNote: true }, "alice");
    expect(out).toEqual({ requireNote: true });
    expect(upsert().mock.calls[0][0]).toMatchObject({ where: { key: "rebootConfig" }, create: { key: "rebootConfig", value: { requireNote: true } } });
    expect(eventLog.logEvent).toHaveBeenCalledOnce();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "setting.reboot_updated", resourceType: "setting", resourceName: "rebootConfig", actor: "alice", level: "info",
      message: "A reboot note is now required for every reboot",
      details: { before: { requireNote: false }, after: { requireNote: true } },
    });
  });

  it("audits a switch off with its own message", async () => {
    stored({ requireNote: true });
    await saveRebootSettings({ requireNote: false }, "bob");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ message: "A reboot note is now optional", actor: "bob" });
  });

  it("writes no Event when the value did not change", async () => {
    await saveRebootSettings({ requireNote: false }, "alice");
    expect(upsert()).toHaveBeenCalledOnce();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("normalizes a non-boolean on the way in", async () => {
    const out = await saveRebootSettings({ requireNote: "yes" as unknown as boolean }, "alice");
    expect(out).toEqual({ requireNote: false });
  });

  it("primes the cache with what it saved", async () => {
    await saveRebootSettings({ requireNote: true }, "alice");
    findUnique().mockClear();
    expect(await getRebootSettings()).toEqual({ requireNote: true });
    expect(findUnique()).not.toHaveBeenCalled();
  });
});

describe("normalizeRebootNote", () => {
  it("reads undefined, null and blank as no note", () => {
    expect(normalizeRebootNote(undefined)).toBeNull();
    expect(normalizeRebootNote(null)).toBeNull();
    expect(normalizeRebootNote(" \n\t ")).toBeNull();
  });

  it("flattens control characters (DEL included) to single spaces and trims", () => {
    expect(normalizeRebootNote("  patch\r\nTuesday\u0000\u007f window  ")).toBe("patch Tuesday window");
    expect(normalizeRebootNote("a    b")).toBe("a b");
  });

  it("accepts exactly REBOOT_NOTE_MAX characters and refuses one more with 400", () => {
    expect(normalizeRebootNote("n".repeat(REBOOT_NOTE_MAX))).toHaveLength(REBOOT_NOTE_MAX);
    expect(() => normalizeRebootNote("n".repeat(REBOOT_NOTE_MAX + 1))).toThrow(expect.objectContaining({ httpStatus: 400 }));
  });

  it("measures the cap after flattening", () => {
    expect(normalizeRebootNote(`  ${"n".repeat(REBOOT_NOTE_MAX)}  `)).toHaveLength(REBOOT_NOTE_MAX);
  });

  it("refuses anything that is not text with 400", () => {
    for (const bad of [42, true, { note: "x" }, ["x"]]) {
      expect(() => normalizeRebootNote(bad)).toThrow(expect.objectContaining({ httpStatus: 400, message: "note must be text" }));
    }
  });
});

describe("resolveRebootNote", () => {
  it("returns the flattened note whatever the setting", async () => {
    stored({ requireNote: true });
    expect(await resolveRebootNote(" kernel\nupdate ")).toBe("kernel update");
  });

  it("allows no note while not required, without failing", async () => {
    expect(await resolveRebootNote(undefined)).toBeNull();
  });

  it("refuses a blank note with 400 while required", async () => {
    stored({ requireNote: true });
    await expect(resolveRebootNote("   ")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("does not read the setting when a note was given", async () => {
    await resolveRebootNote("why");
    expect(findUnique()).not.toHaveBeenCalled();
  });

  it("lets the reboot through with no note when the setting cannot be read", async () => {
    findUnique().mockRejectedValue(new Error("db down"));
    expect(await resolveRebootNote("")).toBeNull();
  });
});
