/**
 * tests/unit/mobileReservationScope.test.ts — the phone's Edit / Free gate on
 * a reservation (public/js/mobile/reservation-actions.js → canModify) reads
 * the server's per-row verdict first, as the desktop's canEditReservation in
 * app.js does (business rule 141 (e)): at Read-Write a reservation is the
 * caller's own OR sits on a network carrying one of their tags, and only the
 * server knows the second half. The creator comparison is the fallback for a
 * row that lacks the flag (an older payload).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "reservation-actions.js"), "utf-8");
const g = globalThis as any;

let canModify: (user: any, row: any) => boolean;
beforeAll(() => {
  // Page globals the script reads at load (mobile.html's other scripts).
  g.mobileFormatDate = (d: any) => String(d ?? "");
  g.escapeHtml = (s: any) => String(s ?? "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  canModify = g.PolarisReservationActions.canModify;
});

const user = (level: string) => ({ username: "alice", permissions: { reservations: level } });

describe("mobile reservation Edit / Free gate (rule 141 (e))", () => {
  it("follows the server's verdict at Read-Write — a tagged network's row someone else made", () => {
    expect(canModify(user("write"), { createdBy: "bob", canEdit: true })).toBe(true);
  });

  it("refuses the caller's own row when the server says no (it never does today, but the verdict wins)", () => {
    expect(canModify(user("write"), { createdBy: "alice", canEdit: false })).toBe(false);
  });

  it("falls back to the creator comparison when the row carries no verdict", () => {
    expect(canModify(user("write"), { createdBy: "alice" })).toBe(true);
    expect(canModify(user("write"), { createdBy: "bob" })).toBe(false);
  });

  it("Full Read-Write reaches every row; Read-Only none", () => {
    expect(canModify(user("fullwrite"), { createdBy: "bob", canEdit: false })).toBe(true);
    expect(canModify(user("read"), { createdBy: "alice", canEdit: true })).toBe(false);
  });
});
