/**
 * tests/unit/notificationPreferenceService.test.ts — the STORED half of the
 * per-user notification preference (CQ-T010): read, write, the recipient-index
 * bump and the audit Event. The pure routing half (normalize /
 * preferenceAllowsTransport) is covered in depth by
 * notificationPreference.test.ts; the labels table is checked here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { bumpRecipientIndex } = vi.hoisted(() => ({ bumpRecipientIndex: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/notificationRecipientService.js", () => ({ bumpRecipientIndex }));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_LABELS,
  getNotificationPreference,
  setNotificationPreference,
  preferenceAllowsTransport,
} from "../../src/services/notificationPreferenceService.js";
import { AppError } from "../../src/utils/errors.js";

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  bumpRecipientIndex.mockReset();
});

describe("NOTIFICATION_PREFERENCE_LABELS", () => {
  it("labels every preference and nothing else", () => {
    expect(Object.keys(NOTIFICATION_PREFERENCE_LABELS).sort()).toEqual([...NOTIFICATION_PREFERENCES].sort());
    expect(NOTIFICATION_PREFERENCE_LABELS).toEqual({ email: "Email", push: "Push", any: "Email and push" });
  });
});

describe("preferenceAllowsTransport — the full matrix", () => {
  it.each([
    ["email", "email", true],
    ["email", "web_push", false],
    ["push", "email", false],
    ["push", "web_push", true],
    ["any", "email", true],
    ["any", "web_push", true],
    [null, "email", true],
    [null, "web_push", false],
    ["sms", "web_push", false],
  ] as const)("pref %j on %s → %s", (pref, transport, allowed) => {
    expect(preferenceAllowsTransport(pref, transport)).toBe(allowed);
  });

  it.each(["slack", "teams", "pushbullet", "api_call", "webhook", ""])("a non-recipient transport %j is always allowed, whatever the preference", (t) => {
    for (const p of ["email", "push", "any", "junk", undefined]) expect(preferenceAllowsTransport(p, t)).toBe(true);
  });
});

describe("getNotificationPreference", () => {
  it("reads only the preference column for the user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "push" } as never);
    expect(await getNotificationPreference("u1")).toBe("push");
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { notificationPreference: true } });
  });

  it("normalizes an unknown stored value to email", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "carrier-pigeon" } as never);
    expect(await getNotificationPreference("u1")).toBe("email");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: null } as never);
    expect(await getNotificationPreference("u1")).toBe("email");
  });

  it("a missing user is a 404", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const err = await getNotificationPreference("ghost").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(404);
  });
});

describe("setNotificationPreference", () => {
  it("a missing user is a 404 and nothing is written", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const err = await setNotificationPreference("ghost", "ghost", "push").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(bumpRecipientIndex).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("an unchanged choice is a no-op: no write, no bump, no Event", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "any" } as never);
    expect(await setNotificationPreference("u1", "alice", "any")).toBe("any");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(bumpRecipientIndex).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a change writes the column, bumps the recipient index and audits from/to", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "email" } as never);
    expect(await setNotificationPreference("u1", "alice", "push")).toBe("push");
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { notificationPreference: "push" } });
    expect(bumpRecipientIndex).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "user.notification_preference.changed",
      resourceType: "user",
      resourceId: "u1",
      resourceName: "alice",
      actor: "alice",
      level: "info",
      message: "Notification preference changed from Email to Push",
      details: { from: "email", to: "push" },
    });
  });

  it("the bump happens after the write (the index must not re-cache the old value)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "push" } as never);
    const order: string[] = [];
    vi.mocked(prisma.user.update).mockImplementation((async () => { order.push("update"); }) as never);
    bumpRecipientIndex.mockImplementation(() => { order.push("bump"); });
    await setNotificationPreference("u1", "alice", "any");
    expect(order).toEqual(["update", "bump"]);
  });

  it("an unknown stored value counts as email: switching to push is a change from Email", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "pager" } as never);
    await setNotificationPreference("u1", "alice", "push");
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ details: { from: "email", to: "push" } });
  });

  it("an unknown stored value with `email` requested is treated as unchanged and left in the column", async () => {
    // Effective behaviour is identical (the reader normalizes to email), so
    // the junk value is harmless — asserted here so a change is deliberate.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "pager" } as never);
    expect(await setNotificationPreference("u1", "alice", "email")).toBe("email");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("a failing audit write does not fail the change", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "email" } as never);
    eventLog.logEvent.mockRejectedValue(new Error("db down"));
    await expect(setNotificationPreference("u1", "alice", "any")).resolves.toBe("any");
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("a failing update propagates and neither bumps nor audits", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ notificationPreference: "email" } as never);
    vi.mocked(prisma.user.update).mockRejectedValue(new Error("write failed") as never);
    await expect(setNotificationPreference("u1", "alice", "push")).rejects.toThrow("write failed");
    expect(bumpRecipientIndex).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});
