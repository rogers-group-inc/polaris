/**
 * tests/unit/logPathGlob.test.ts
 *
 * An asset's log path glob is read by a Polaris Agent running as a privileged
 * user, so what it may name is narrowed to absolute local paths (scan finding
 * F194; business rule 105).
 */

import { describe, it, expect } from "vitest";
import { isSafeLogPathGlob, logPathGlobProblem, LOG_PATH_GLOB_MAX } from "../../src/utils/logPathGlob.js";

describe("logPathGlobProblem", () => {
  it.each([
    "/var/log/nginx/*.log",
    "/opt/app/logs/app-*.log",
    "/var/log/syslog",
    "C:\\ProgramData\\App\\logs\\*.log",
    "D:/logs/app/*.txt",
    "/srv/app/some.dir/with..dots/x.log",
  ])("accepts %s", (glob) => {
    expect(logPathGlobProblem(glob)).toBeNull();
  });

  it("treats empty and null as no glob, not as an error", () => {
    expect(logPathGlobProblem("")).toBeNull();
    expect(logPathGlobProblem(null)).toBeNull();
    expect(logPathGlobProblem(undefined)).toBeNull();
  });

  it.each([
    ["\\\\attacker\\share\\x.log", /network share/],
    ["//attacker/share/x.log", /network share/],
    ["\\\\.\\PhysicalDrive0", /network share|device/],
    ["\\\\?\\C:\\Windows\\win.ini", /network share|device/],
  ])("refuses a network or device path: %s", (glob, message) => {
    expect(logPathGlobProblem(glob)).toMatch(message);
  });

  it.each(["var/log/x.log", "logs/*.log", "./x.log", "~/x.log", "%ProgramData%\\x.log", "C:relative.log"])(
    "refuses a path that is not absolute: %s",
    (glob) => {
      expect(logPathGlobProblem(glob)).toMatch(/absolute/);
    },
  );

  it.each(["/var/log/../../etc/shadow", "/var/log/..", "C:\\logs\\..\\Windows\\win.ini", "/a/../b"])(
    "refuses a .. segment: %s",
    (glob) => {
      expect(logPathGlobProblem(glob)).toMatch(/\.\./);
    },
  );

  it("refuses control characters", () => {
    expect(logPathGlobProblem("/var/log/x\n.log")).toMatch(/control/);
    expect(logPathGlobProblem("/var/log/x\u0000.log")).toMatch(/control/);
  });

  it("refuses an over-long path", () => {
    expect(logPathGlobProblem("/" + "a".repeat(LOG_PATH_GLOB_MAX))).toMatch(/longer/);
  });
});

describe("isSafeLogPathGlob", () => {
  it("is the boolean form of the same check", () => {
    expect(isSafeLogPathGlob("/var/log/x.log")).toBe(true);
    expect(isSafeLogPathGlob("\\\\h\\s\\x")).toBe(false);
    expect(isSafeLogPathGlob(null)).toBe(true);
  });
});
