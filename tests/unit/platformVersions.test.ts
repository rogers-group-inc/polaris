import { describe, it, expect, vi } from "vitest";
import {
  deriveTrack,
  compareTracks,
  parseGoVersion,
  runningNodeTrack,
  checkNodeVersionAtBoot,
  NODE_MINIMUM_MAJOR,
  parsePostgresVersion,
  parseNginxVersion,
  parseJavaVersion,
  parseOsRelease,
} from "../../src/utils/platformVersions.js";

describe("deriveTrack", () => {
  it("cuts to a major", () => {
    expect(deriveTrack("20.19.0", "major")).toBe("20");
    expect(deriveTrack("15.13", "major")).toBe("15");
    expect(deriveTrack("9", "major")).toBe("9");
  });

  it("cuts to a major.minor", () => {
    expect(deriveTrack("1.22.7", "major.minor")).toBe("1.22");
    expect(deriveTrack("1.30.0", "major.minor")).toBe("1.30");
    expect(deriveTrack("22.04", "major.minor")).toBe("22.04");
  });

  it("returns the major alone when there is no minor to cut", () => {
    expect(deriveTrack("20", "major.minor")).toBe("20");
  });

  it("tolerates surrounding noise and trailing qualifiers", () => {
    expect(deriveTrack("  15.13-1.pgdg120+1  ", "major")).toBe("15");
    expect(deriveTrack("1.22rc1", "major.minor")).toBe("1.22");
  });

  it("returns null for input with no leading number", () => {
    expect(deriveTrack("unknown", "major")).toBeNull();
    expect(deriveTrack("", "major.minor")).toBeNull();
  });
});

describe("compareTracks", () => {
  it("orders numerically, not lexically", () => {
    // The bug this exists to prevent: "1.9" > "1.10" as strings, which would
    // report a host on nginx 1.10 as below a 1.9 floor.
    expect(compareTracks("1.9", "1.10")).toBeLessThan(0);
    expect(compareTracks("1.10", "1.9")).toBeGreaterThan(0);
  });

  it("compares majors", () => {
    expect(compareTracks("20", "22")).toBeLessThan(0);
    expect(compareTracks("22", "20")).toBeGreaterThan(0);
    expect(compareTracks("20", "20")).toBe(0);
  });

  it("treats a missing component as zero", () => {
    expect(compareTracks("1.22", "1.22.0")).toBe(0);
    expect(compareTracks("20", "20.0")).toBe(0);
    expect(compareTracks("1.22", "1.22.1")).toBeLessThan(0);
  });

  it("orders Ubuntu-style tracks", () => {
    expect(compareTracks("22.04", "24.04")).toBeLessThan(0);
    expect(compareTracks("24.04", "22.04")).toBeGreaterThan(0);
  });
});

describe("parseGoVersion", () => {
  it("parses standard `go version` output", () => {
    expect(parseGoVersion("go version go1.22.7 linux/amd64")).toBe("1.22.7");
    expect(parseGoVersion("go version go1.26.0 windows/amd64")).toBe("1.26.0");
  });

  it("parses a bare minor with no patch", () => {
    expect(parseGoVersion("go version go1.22 linux/amd64")).toBe("1.22");
    expect(parseGoVersion("go1.22")).toBe("1.22");
  });

  it("drops release-candidate and devel qualifiers to the minor line", () => {
    // The lifecycle question is which minor line you are on, and go1.24rc1
    // is on 1.24.
    expect(parseGoVersion("go version go1.24rc1 darwin/arm64")).toBe("1.24");
    expect(parseGoVersion("go version devel go1.25-abc123 linux/amd64")).toBe("1.25");
  });

  it("returns null for unrecognized input", () => {
    expect(parseGoVersion("command not found")).toBeNull();
    expect(parseGoVersion("")).toBeNull();
    expect(parseGoVersion("go version unknown")).toBeNull();
  });
});

describe("parsePostgresVersion", () => {
  it("parses the SELECT version() banner", () => {
    expect(parsePostgresVersion("PostgreSQL 15.13 on x86_64-pc-linux-gnu, compiled by gcc")).toBe("15.13");
    expect(parsePostgresVersion("PostgreSQL 17.2 (Debian 17.2-1.pgdg120+1) on x86_64")).toBe("17.2");
  });

  it("parses bare SHOW server_version output", () => {
    expect(parsePostgresVersion("15.13")).toBe("15.13");
    expect(parsePostgresVersion("18.0")).toBe("18.0");
  });

  it("parses SHOW server_version with a distro suffix", () => {
    expect(parsePostgresVersion("15.13 (Debian 15.13-1.pgdg120+1)")).toBe("15.13");
  });

  it("returns null when there is no version at all", () => {
    expect(parsePostgresVersion("unknown")).toBeNull();
    expect(parsePostgresVersion("")).toBeNull();
  });
});

describe("parseNginxVersion", () => {
  it("parses nginx -v output", () => {
    expect(parseNginxVersion("nginx version: nginx/1.28.0")).toBe("1.28.0");
    expect(parseNginxVersion("nginx version: nginx/1.31.1\n")).toBe("1.31.1");
  });

  it("parses an openresty build", () => {
    expect(parseNginxVersion("nginx version: openresty/1.25.3.1")).toBe("1.25.3.1");
  });

  it("returns null for unrelated output", () => {
    expect(parseNginxVersion("command not found")).toBeNull();
    expect(parseNginxVersion("")).toBeNull();
  });
});

describe("parseJavaVersion", () => {
  it("parses a modern JDK", () => {
    expect(parseJavaVersion('openjdk version "17.0.11" 2024-04-16')).toBe("17.0.11");
    expect(parseJavaVersion('openjdk version "21.0.5" 2024-10-15')).toBe("21.0.5");
  });

  it("maps the pre-9 1.x scheme to its feature version", () => {
    // "1.8" would sort below every modern release, so 8 is the useful answer.
    expect(parseJavaVersion('java version "1.8.0_402"')).toBe("8");
  });

  it("returns null when no quoted version is present", () => {
    expect(parseJavaVersion("java: not found")).toBeNull();
    expect(parseJavaVersion("")).toBeNull();
  });
});

describe("parseOsRelease", () => {
  it("parses RHEL 9", () => {
    const out = parseOsRelease('NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="9.4"\n');
    expect(out).toEqual({ id: "rhel", versionId: "9.4" });
  });

  it("parses Ubuntu 24.04 with bare values", () => {
    expect(parseOsRelease("ID=ubuntu\nVERSION_ID=24.04\n")).toEqual({ id: "ubuntu", versionId: "24.04" });
  });

  it("parses Debian bookworm", () => {
    expect(parseOsRelease('ID=debian\nVERSION_ID="12"\n')).toEqual({ id: "debian", versionId: "12" });
  });

  it("tolerates a missing VERSION_ID", () => {
    // Rolling releases legitimately omit it.
    expect(parseOsRelease("ID=arch\n")).toEqual({ id: "arch", versionId: null });
  });

  it("returns nulls for an empty file", () => {
    expect(parseOsRelease("")).toEqual({ id: null, versionId: null });
  });

  it("does not match a key that merely ends with the name", () => {
    // VERSION_CODENAME must not satisfy a VERSION_ID lookup.
    expect(parseOsRelease("VERSION_CODENAME=bookworm\n").versionId).toBeNull();
  });
});

describe("runningNodeTrack", () => {
  it("reports the major of the Node running the tests", () => {
    // Whatever runs this suite, the track must be the major of
    // process.versions.node — the point is that it is readable at all.
    expect(runningNodeTrack()).toBe(process.versions.node.split(".")[0]);
  });
});

describe("checkNodeVersionAtBoot", () => {
  it("warns, once, when the running major is below the minimum", () => {
    const warn = vi.fn();
    // Pick a minimum far above anything that could be running.
    const warned = checkNodeVersionAtBoot("999", warn);
    expect(warned).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(process.versions.node);
    expect(warn.mock.calls[0][0]).toContain("999");
  });

  it("stays silent when the running major meets the minimum", () => {
    const warn = vi.fn();
    expect(checkNodeVersionAtBoot("1", warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent at exactly the minimum", () => {
    const warn = vi.fn();
    const current = process.versions.node.split(".")[0];
    expect(checkNodeVersionAtBoot(current, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("declares a minimum matching package.json engines.node", () => {
    expect(NODE_MINIMUM_MAJOR).toBe("20");
  });
});
