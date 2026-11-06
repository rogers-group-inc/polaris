/**
 * tests/unit/accountSelfService.test.ts — a signed-in user managing their own
 * password, TOTP and passkey step-up (services/accountSelfService.ts, lifted
 * out of routes/auth.ts by CQ-B044). The routes' session handling is pinned by
 * the integration suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn(), update: vi.fn() } }));
const pw = vi.hoisted(() => ({ verifyPassword: vi.fn(), hashPassword: vi.fn(async (p: string) => `hash(${p})`) }));
const lock = vi.hoisted(() => ({ isLocked: vi.fn(() => ({ locked: false })), recordFailure: vi.fn() }));
const totp = vi.hoisted(() => ({
  verifyCodeStep: vi.fn(),
  consumeBackupCode: vi.fn(),
  generateSecret: vi.fn(() => "SECRET"),
  generateBackupCodes: vi.fn(async () => ({ plaintext: ["a", "b"], hashes: ["ha", "hb"] })),
  buildEnrollment: vi.fn(async () => ({ otpauthUri: "otpauth://x", qrSvg: "<svg/>" })),
}));
const claimTotpStep = vi.hoisted(() => vi.fn());
const assertPasswordMeetsPolicy = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());

vi.mock("../../src/db.js", () => ({ prisma: db }));
vi.mock("../../src/utils/password.js", () => pw);
vi.mock("../../src/utils/loginLockout.js", () => lock);
vi.mock("../../src/utils/secretBox.js", () => ({ sealValue: (v: string) => `sealed(${v})`, openValue: (v: string) => v.replace(/^sealed\((.*)\)$/, "$1") }));
vi.mock("../../src/services/totpService.js", () => totp);
vi.mock("../../src/services/totpStepService.js", () => ({ claimTotpStep }));
vi.mock("../../src/services/passwordPolicyService.js", () => ({ assertPasswordMeetsPolicy }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent }));

const svc = await import("../../src/services/accountSelfService.js");

const local = (over: Record<string, unknown> = {}) => ({
  id: "u1", username: "alice", displayName: null, authProvider: "local", passwordHash: "H",
  totpSecret: null, totpEnabledAt: null, totpBackupCodes: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  lock.isLocked.mockReturnValue({ locked: false });
});

describe("changeOwnPassword", () => {
  it("writes the new hash after proving the current password", async () => {
    db.user.findUnique.mockResolvedValue(local());
    pw.verifyPassword.mockResolvedValue({ valid: true });
    expect(await svc.changeOwnPassword("u1", "old", "new")).toEqual({ id: "u1", username: "alice" });
    expect(assertPasswordMeetsPolicy).toHaveBeenCalledWith("new");
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { passwordHash: "hash(new)" } });
  });

  it("refuses an SSO account, a wrong current password and an unchanged password", async () => {
    db.user.findUnique.mockResolvedValue(local({ authProvider: "saml" }));
    await expect(svc.changeOwnPassword("u1", "a", "b")).rejects.toMatchObject({ httpStatus: 400 });
    db.user.findUnique.mockResolvedValue(local());
    pw.verifyPassword.mockResolvedValue({ valid: false });
    await expect(svc.changeOwnPassword("u1", "a", "b")).rejects.toMatchObject({ httpStatus: 401 });
    pw.verifyPassword.mockResolvedValue({ valid: true });
    await expect(svc.changeOwnPassword("u1", "same", "same")).rejects.toMatchObject({ httpStatus: 400 });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("TOTP enrolment", () => {
  it("start seals the new secret and returns the QR; an enabled setup is never replaced", async () => {
    db.user.findUnique.mockResolvedValue(local());
    expect(await svc.startTotpEnrollment("u1")).toEqual({ secret: "SECRET", otpauthUri: "otpauth://x", qrSvg: "<svg/>" });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { totpSecret: "sealed(SECRET)", totpLastStep: null } });
    db.user.findUnique.mockResolvedValue(local({ totpEnabledAt: new Date() }));
    await expect(svc.startTotpEnrollment("u1")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("confirm enables, stores hashed backup codes and records the confirming step", async () => {
    db.user.findUnique.mockResolvedValue(local({ totpSecret: "sealed(SECRET)" }));
    totp.verifyCodeStep.mockReturnValue(4242);
    const out = await svc.confirmTotpEnrollment("u1", "123456");
    expect(totp.verifyCodeStep).toHaveBeenCalledWith("SECRET", "123456");
    expect(out.backupCodes).toEqual(["a", "b"]);
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ totpBackupCodes: ["ha", "hb"], totpLastStep: 4242 });
  });

  it("confirm refuses with no enrolment (400) and a wrong code (401)", async () => {
    db.user.findUnique.mockResolvedValue(local());
    await expect(svc.confirmTotpEnrollment("u1", "1")).rejects.toMatchObject({ httpStatus: 400 });
    db.user.findUnique.mockResolvedValue(local({ totpSecret: "sealed(S)" }));
    totp.verifyCodeStep.mockReturnValue(null);
    await expect(svc.confirmTotpEnrollment("u1", "1")).rejects.toMatchObject({ httpStatus: 401 });
  });
});

describe("disableOwnTotp", () => {
  const enabled = () => local({ totpSecret: "sealed(S)", totpEnabledAt: new Date(), totpBackupCodes: ["h"] });

  it("a TOTP code must claim its step (single use) before TOTP is cleared", async () => {
    db.user.findUnique.mockResolvedValue(enabled());
    totp.verifyCodeStep.mockReturnValue(7);
    claimTotpStep.mockResolvedValue(false); // replayed step
    await expect(svc.disableOwnTotp("u1", "123456", false)).rejects.toMatchObject({ httpStatus: 401 });
    claimTotpStep.mockResolvedValue(true);
    await svc.disableOwnTotp("u1", "123456", false);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [], totpLastStep: null },
    });
  });

  it("accepts a valid backup code and refuses when TOTP is not enabled", async () => {
    db.user.findUnique.mockResolvedValue(enabled());
    totp.consumeBackupCode.mockResolvedValue([]);
    await svc.disableOwnTotp("u1", "bkp", true);
    expect(claimTotpStep).not.toHaveBeenCalled();
    db.user.findUnique.mockResolvedValue(local());
    await expect(svc.disableOwnTotp("u1", "bkp", true)).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("getTotpStatus / getOwnAuthProvider", () => {
  it("reports state without the secret", async () => {
    db.user.findUnique.mockResolvedValue({ authProvider: "local", totpSecret: "s", totpEnabledAt: null, totpBackupCodes: [] });
    expect(await svc.getTotpStatus("u1")).toEqual({ authProvider: "local", enabled: false, enrolling: true, backupCodesRemaining: 0 });
  });

  it("falls back to local when the row is gone", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expect(await svc.getOwnAuthProvider("u1")).toBe("local");
  });
});

describe("passkey step-up (rule 108)", () => {
  it("returns the registrant without the password hash", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", username: "alice", displayName: null, authProvider: "local", passwordHash: "H" });
    pw.verifyPassword.mockResolvedValue({ valid: true });
    const r = await svc.verifyPasskeyStepUp("u1", "pw", "10.0.0.1");
    expect(r).toEqual({ id: "u1", username: "alice", displayName: null, authProvider: "local" });
    expect(r).not.toHaveProperty("passwordHash");
  });

  it("a wrong password counts a lockout failure and is audited; a locked account is 423", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", username: "alice", displayName: null, authProvider: "local", passwordHash: "H" });
    pw.verifyPassword.mockResolvedValue({ valid: false });
    await expect(svc.verifyPasskeyStepUp("u1", "bad", "10.0.0.1")).rejects.toMatchObject({ httpStatus: 401 });
    expect(lock.recordFailure).toHaveBeenCalledWith("alice");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.passkey.step_up_failed", details: { ip: "10.0.0.1" } }));
    lock.isLocked.mockReturnValue({ locked: true });
    await expect(svc.verifyPasskeyStepUp("u1", "pw", "10.0.0.1")).rejects.toMatchObject({ httpStatus: 423 });
  });

  it("findPasskeyRegistrant 404s a missing user", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(svc.findPasskeyRegistrant("u1")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
