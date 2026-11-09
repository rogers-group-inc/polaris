/**
 * tests/unit/nginxApplyService.test.ts
 *
 * The nginx GUI orchestrator: the order of operations around the privileged
 * wrapper, and the refusals that keep a bad change from ever reaching it.
 *
 *   • apply refuses without the wrapper (503) and outside managed mode (409),
 *     and records lastAppliedHash ONLY after the wrapper succeeds;
 *   • cert rotation refuses an unparseable cert, an expired cert, an
 *     unparseable key and a key that does not match the cert BEFORE staging
 *     anything; the certInfo cache is invalidated whatever the outcome;
 *   • bootstrap seeds proxyConfig once, in proxy mode only, always with
 *     managedMode=false;
 *   • drift status parses the live file only when its hash differs from the
 *     last applied one.
 *
 * The wrapper, renderer, parser and persistence are faked; the X.509 work is
 * real against the committed test certificates in tests/fixtures/.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const m = vi.hoisted(() => ({
  isWrapperAvailable: vi.fn(),
  runNginxApply: vi.fn(),
  stageNginxConfig: vi.fn(),
  stageCertAndKey: vi.fn(),
  getProxyConfig: vi.fn(),
  saveProxyConfig: vi.fn(),
  proxyConfigRowExists: vi.fn(),
  renderNginxConfig: vi.fn(),
  parseNginxConfig: vi.fn(),
  invalidateCertInfoCache: vi.fn(),
  getServerCertFingerprint: vi.fn(),
  isProxyMode: vi.fn(),
  readFile: vi.fn(),
  calls: [] as string[],
}));

vi.mock("../../src/services/privilegedSysadmin.js", () => ({
  isWrapperAvailable: m.isWrapperAvailable,
  runNginxApply: m.runNginxApply,
  stageNginxConfig: m.stageNginxConfig,
  stageCertAndKey: m.stageCertAndKey,
}));
vi.mock("../../src/services/proxyConfigService.js", () => ({
  getProxyConfig: m.getProxyConfig,
  saveProxyConfig: m.saveProxyConfig,
  proxyConfigRowExists: m.proxyConfigRowExists,
}));
vi.mock("../../src/services/nginxRenderer.js", () => ({ renderNginxConfig: m.renderNginxConfig }));
vi.mock("../../src/services/nginxConfigParser.js", () => ({ parseNginxConfig: m.parseNginxConfig }));
vi.mock("../../src/services/apiDocsAccessService.js", () => ({
  getApiDocsSettings: vi.fn(async () => ({})),
  deriveApiDocsNginxAllow: vi.fn(() => ["10.0.0.0/8"]),
}));
vi.mock("../../src/services/certInfo.js", () => ({
  invalidateCache: m.invalidateCertInfoCache,
  getServerCertFingerprint: m.getServerCertFingerprint,
}));
vi.mock("../../src/utils/proxyMode.js", () => ({ isProxyMode: m.isProxyMode }));
vi.mock("../../src/utils/publicUrl.js", () => ({
  deriveNginxServerName: () => "polaris.example.com",
  derivePolarisPort: () => 3000,
}));
vi.mock("../../src/utils/dashConfig.js", () => ({ resolveDashPort: () => 3001 }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("node:fs/promises", () => ({ readFile: m.readFile }));

const svc = await import("../../src/services/nginxApplyService.js");

const FIX = join(__dirname, "..", "fixtures");
const certA = readFileSync(join(FIX, "tls-pin-a.pem"), "utf8");
const keyA = readFileSync(join(FIX, "tls-pin-a.key"), "utf8");
const keyB = readFileSync(join(FIX, "tls-pin-b.key"), "utf8");

const managed = { managedMode: true, httpsPort: 443, lastAppliedHash: "old" };

beforeEach(() => {
  for (const fn of Object.values(m)) if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
  m.calls = [];
  m.isWrapperAvailable.mockReturnValue(true);
  m.getProxyConfig.mockResolvedValue(managed);
  m.saveProxyConfig.mockImplementation(async (c: unknown) => { m.calls.push("save"); return { ...managed, ...(c as object) }; });
  m.renderNginxConfig.mockReturnValue({ contents: "server {}", sha256: "NEWHASH" });
  m.stageNginxConfig.mockImplementation(() => m.calls.push("stage"));
  m.stageCertAndKey.mockImplementation(() => m.calls.push("stageCert"));
  m.runNginxApply.mockImplementation(async (a: { kind: string }) => { m.calls.push(a.kind); return { exitCode: 0, output: `${a.kind} ok` }; });
  m.invalidateCertInfoCache.mockImplementation(() => m.calls.push("invalidate"));
});
afterEach(() => vi.useRealTimers());

// ─── apply ───────────────────────────────────────────────────────────────────

describe("applyProxyConfig", () => {
  it("503s when the privileged wrapper is not installed, before persisting anything", async () => {
    m.isWrapperAvailable.mockReturnValue(false);
    await expect(svc.applyProxyConfig({ httpsPort: 8443 } as never)).rejects.toMatchObject({ httpStatus: 503 });
    expect(m.saveProxyConfig).not.toHaveBeenCalled();
  });

  it("409s in adopt-required mode and stages nothing", async () => {
    m.getProxyConfig.mockResolvedValue({ ...managed, managedMode: false });
    await expect(svc.applyProxyConfig()).rejects.toMatchObject({ httpStatus: 409 });
    expect(m.stageNginxConfig).not.toHaveBeenCalled();
  });

  it("saves the changes, renders, stages, applies, THEN records the hash, then verifies the listener", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const r = await svc.applyProxyConfig({ httpsPort: 8443 } as never);
    expect(m.calls).toEqual(["save", "stage", "apply-config", "save", "verify-listening"]);
    expect(m.renderNginxConfig.mock.calls[0][0]).toMatchObject({
      serverName: "polaris.example.com", polarisPort: 3000, dashPort: 3001, apiDocsAllow: ["10.0.0.0/8"],
    });
    expect(m.saveProxyConfig.mock.calls[1][0]).toEqual({ lastAppliedAt: "2026-11-09T10:00:00.000Z", lastAppliedHash: "NEWHASH" });
    expect(m.runNginxApply.mock.calls[1][0]).toEqual({ kind: "verify-listening", port: 8443 });
    expect(r).toEqual({ ok: true, hash: "NEWHASH", wrapperOutput: "apply-config ok", listening: "verify-listening ok" });
  });

  it("returns the wrapper output and does NOT record the hash when the wrapper fails", async () => {
    m.runNginxApply.mockResolvedValue({ exitCode: 1, output: "nginx: [emerg] bad" });
    const r = await svc.applyProxyConfig();
    expect(r).toEqual({ ok: false, hash: "NEWHASH", wrapperOutput: "nginx: [emerg] bad" });
    expect(m.saveProxyConfig).not.toHaveBeenCalled();
  });

  it("still reports success when only verify-listening fails, naming the failure", async () => {
    m.runNginxApply.mockImplementation(async (a: { kind: string }) =>
      a.kind === "verify-listening" ? { exitCode: 2, output: "nothing on 443" } : { exitCode: 0, output: "ok" });
    const r = await svc.applyProxyConfig();
    expect(r.ok).toBe(true);
    expect(r.listening).toBe("(verify-listening failed: nothing on 443)");
  });
});

// ─── cert rotation ───────────────────────────────────────────────────────────

describe("rotateCertAndKey / preflightCertRotation", () => {
  it("refuses a cert that does not parse", async () => {
    await expect(svc.rotateCertAndKey("not a cert", keyA)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("X.509") });
    expect(m.stageCertAndKey).not.toHaveBeenCalled();
  });

  it("refuses a key that does not parse", async () => {
    await expect(svc.rotateCertAndKey(certA, "not a key")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("private key") });
    expect(m.stageCertAndKey).not.toHaveBeenCalled();
  });

  it("refuses a key that belongs to a different certificate", async () => {
    await expect(svc.rotateCertAndKey(certA, keyB)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("does not match") });
    expect(m.stageCertAndKey).not.toHaveBeenCalled();
    expect(m.runNginxApply).not.toHaveBeenCalled();
  });

  it("refuses an already-expired certificate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2130-01-01T00:00:00Z")); // the fixture expires in 2126
    await expect(svc.rotateCertAndKey(certA, keyA)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("expired") });
  });

  it("stages, rotates, invalidates the certInfo cache and returns the new sha256 fingerprint", async () => {
    const r = await svc.rotateCertAndKey(certA, keyA);
    expect(m.calls).toEqual(["stageCert", "rotate-cert", "invalidate"]);
    expect(m.stageCertAndKey).toHaveBeenCalledWith(certA, keyA);
    const { X509Certificate } = await import("node:crypto");
    const expected = `sha256:${createHash("sha256").update(new X509Certificate(certA).raw).digest("hex")}`;
    expect(r).toEqual({ ok: true, fingerprint: expected, wrapperOutput: "rotate-cert ok" });
  });

  it("invalidates the cache even when the wrapper fails, and returns no fingerprint", async () => {
    m.runNginxApply.mockResolvedValue({ exitCode: 1, output: "reload failed" });
    const r = await svc.rotateCertAndKey(certA, keyA);
    expect(r).toEqual({ ok: false, wrapperOutput: "reload failed" });
    expect(m.invalidateCertInfoCache).toHaveBeenCalled();
  });

  it("preflight touches nothing on disk and reports the new cert beside the current pin", () => {
    m.getServerCertFingerprint.mockReturnValue("sha256:current");
    const p = svc.preflightCertRotation(certA, keyA);
    expect(p.newCn).toBe("polaris-tls-pin-test-a");
    expect(p.newDnsSans).toEqual([]);
    expect(p.newExpiresAt).toMatch(/^2126-09-19T/);
    expect(p.newFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.currentFingerprint).toBe("sha256:current");
    expect(m.stageCertAndKey).not.toHaveBeenCalled();
    expect(m.runNginxApply).not.toHaveBeenCalled();
  });
});

// ─── bootstrap ───────────────────────────────────────────────────────────────

describe("bootstrapProxyConfig", () => {
  it("does nothing outside proxy mode, or when a proxyConfig row already exists", async () => {
    m.isProxyMode.mockReturnValue(false);
    await svc.bootstrapProxyConfig();
    m.isProxyMode.mockReturnValue(true);
    m.proxyConfigRowExists.mockResolvedValue(true);
    await svc.bootstrapProxyConfig();
    expect(m.saveProxyConfig).not.toHaveBeenCalled();
  });

  it("seeds from the live config but always unmanaged, with no applied hash", async () => {
    m.isProxyMode.mockReturnValue(true);
    m.proxyConfigRowExists.mockResolvedValue(false);
    m.readFile.mockResolvedValue("server { listen 443 ssl; }");
    m.parseNginxConfig.mockReturnValue({ config: { httpsPort: 443, managedMode: true }, drift: [] });
    await svc.bootstrapProxyConfig();
    expect(m.saveProxyConfig).toHaveBeenCalledWith({ httpsPort: 443, managedMode: false, lastAppliedAt: null, lastAppliedHash: null });
  });

  it("seeds defaults (unmanaged) when the live config is unreadable", async () => {
    m.isProxyMode.mockReturnValue(true);
    m.proxyConfigRowExists.mockResolvedValue(false);
    m.readFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await svc.bootstrapProxyConfig();
    expect(m.parseNginxConfig).not.toHaveBeenCalled();
    expect(m.saveProxyConfig).toHaveBeenCalledWith({ managedMode: false, lastAppliedAt: null, lastAppliedHash: null });
  });
});

// ─── drift ───────────────────────────────────────────────────────────────────

describe("getDriftStatus", () => {
  const text = "server { listen 443 ssl; }";
  const hash = createHash("sha256").update(text).digest("hex");

  it("reports no drift markers (and skips the parse) when the live file matches the last applied hash", async () => {
    m.getProxyConfig.mockResolvedValue({ ...managed, lastAppliedHash: hash });
    m.readFile.mockResolvedValue(text);
    await expect(svc.getDriftStatus()).resolves.toEqual({ managedMode: true, liveHash: hash, expectedHash: hash, driftMarkers: [] });
    expect(m.parseNginxConfig).not.toHaveBeenCalled();
  });

  it("parses for markers when the file was edited by hand, or was never applied", async () => {
    m.parseNginxConfig.mockReturnValue({ config: {}, drift: ["custom location /foo"] });
    m.readFile.mockResolvedValue(text);
    m.getProxyConfig.mockResolvedValue({ ...managed, lastAppliedHash: "different" });
    await expect(svc.getDriftStatus()).resolves.toMatchObject({ liveHash: hash, driftMarkers: ["custom location /foo"] });
    m.getProxyConfig.mockResolvedValue({ ...managed, lastAppliedHash: null });
    await expect(svc.getDriftStatus()).resolves.toMatchObject({ driftMarkers: ["custom location /foo"] });
  });

  it("names an unreadable live file rather than throwing", async () => {
    m.readFile.mockRejectedValue(new Error("ENOENT"));
    await expect(svc.getDriftStatus()).resolves.toMatchObject({ liveHash: null, driftMarkers: ["live nginx config not readable"] });
  });
});
