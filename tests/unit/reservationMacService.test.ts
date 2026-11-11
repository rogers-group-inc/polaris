/**
 * tests/unit/reservationMacService.test.ts — the install-wide placeholder-MAC
 * prefix (CQ-T010): a stored value that no longer normalizes reads as the
 * default (so adoption never quietly switches off), a save REJECTS an unusable
 * prefix with a 400 instead of defaulting it, an unchanged prefix writes
 * nothing, and a change writes the reservation.mac_placeholder.updated Event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ opts: null as null | { key: string; parse: (raw: unknown) => { prefix: string } }, get: vi.fn(), save: vi.fn() }));
vi.mock("../../src/services/settingsStore.js", () => ({
  createSettingStore: (opts: typeof h.opts) => { h.opts = opts; return { get: h.get, save: h.save }; },
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { DEFAULT_PLACEHOLDER_MAC_PREFIX } from "../../src/utils/mac.js";
import { getPlaceholderPrefix, saveReservationMacSettings } from "../../src/services/reservationMacService.js";

beforeEach(() => {
  resetEventLogStub(); h.get.mockReset(); h.save.mockReset();
  h.get.mockResolvedValue({ prefix: "02" });
  h.save.mockImplementation(async (v: { prefix: string }) => v);
});

describe("the stored setting", () => {
  it("is the reservationMacPlaceholder row", () => {
    expect(h.opts?.key).toBe("reservationMacPlaceholder");
  });
  it("an unusable stored prefix reads as the default, never as itself", () => {
    expect(h.opts!.parse({ prefix: "00:11:22" }).prefix).toBe(DEFAULT_PLACEHOLDER_MAC_PREFIX);
    expect(h.opts!.parse(null).prefix).toBe(DEFAULT_PLACEHOLDER_MAC_PREFIX);
  });
  it("getPlaceholderPrefix returns just the string", async () => {
    expect(await getPlaceholderPrefix()).toBe("02");
  });
});

describe("saveReservationMacSettings", () => {
  it("no prefix in the body is a no-op returning the current value", async () => {
    expect(await saveReservationMacSettings({}, "op")).toEqual({ prefix: "02" });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("rejects a globally administered (vendor) prefix with a 400", async () => {
    await expect(saveReservationMacSettings({ prefix: "00:11:22" }, "op")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("an unchanged prefix writes nothing and logs nothing", async () => {
    expect(await saveReservationMacSettings({ prefix: "02" }, "op")).toEqual({ prefix: "02" });
    expect(h.save).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
  it("a new locally administered prefix is saved and logged", async () => {
    const r = await saveReservationMacSettings({ prefix: "0a" }, "op");
    expect(r.prefix).toBe(h.save.mock.calls[0][0].prefix);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "reservation.mac_placeholder.updated", actor: "op", details: { previousPrefix: "02" } });
  });
});
