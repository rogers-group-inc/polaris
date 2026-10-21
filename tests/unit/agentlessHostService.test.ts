/**
 * tests/unit/agentlessHostService.test.ts
 *
 * Pure parsers for the agentless host collectors — the unit-test surface, the
 * way parseLinuxPs / parseWindowsProcessJson are for the processes stream.
 * Fixtures in, rows out, malformed input skipped rather than thrown.
 */

import { describe, it, expect } from "vitest";
import {
  parseLinuxCpuMem,
  parseLinuxInterfaces,
  parseLinuxStorage,
  parseWindowsCpuMem,
  parseWindowsInterfaces,
  parseWindowsStorage,
  parseWindowsLinkSpeed,
  parseJournalctl,
  parseWindowsEventLog,
  journalPriorityToLevel,
  winEventLevelToLevel,
  buildJournalctlCommand,
  buildWindowsEventLogScript,
  LINUX_INTERFACES_COMMAND,
  WINDOWS_INTERFACES_SCRIPT,
} from "../../src/services/agentlessHostService.js";

describe("parseLinuxCpuMem", () => {
  // Two /proc/stat snapshots then /proc/meminfo, separated by ---.
  const sample = [
    "cpu  100 0 100 800 0 0 0 0",
    "cpu  200 0 200 1400 0 0 0 0",
    "---",
    "MemTotal:       16384000 kB",
    "MemFree:          512000 kB",
    "MemAvailable:    8192000 kB",
  ].join("\n");

  // Totals 1000 → 1800 (Δ800); idle+iowait 800 → 1400 (Δ600). Busy is the
  // remainder: 200/800 = 25%.
  it("derives CPU from the delta between the two snapshots", () => {
    expect(parseLinuxCpuMem(sample).cpuPct).toBe(25);
  });

  // MemAvailable, not MemFree: page cache is not "used" in any sense an
  // operator means, and MemFree makes every healthy Linux box look full.
  it("uses MemAvailable for the used figure", () => {
    const t = parseLinuxCpuMem(sample);
    expect(t.memTotalBytes).toBe(16384000 * 1024);
    expect(t.memUsedBytes).toBe((16384000 - 8192000) * 1024);
    expect(t.memPct).toBe(50);
  });

  // A counter that went backwards means the host rebooted between snapshots;
  // a fabricated 0% or 100% would be worse than no reading.
  it("returns null CPU when the counters go backwards or do not move", () => {
    expect(parseLinuxCpuMem("cpu 200 0 200 1400 0\ncpu 100 0 100 800 0\n---\n").cpuPct).toBeNull();
    expect(parseLinuxCpuMem("cpu 100 0 100 800 0\ncpu 100 0 100 800 0\n---\n").cpuPct).toBeNull();
  });

  it("survives truncated or empty output", () => {
    expect(parseLinuxCpuMem("").cpuPct).toBeNull();
    expect(parseLinuxCpuMem("garbage").memTotalBytes).toBeNull();
    // One snapshot is not a rate.
    expect(parseLinuxCpuMem("cpu 100 0 100 800 0\n---\nMemTotal: 100 kB").cpuPct).toBeNull();
  });

  // Per-core rows (cpu0, cpu1…) must not be mistaken for the aggregate.
  it("ignores per-core rows", () => {
    const withCores = [
      "cpu  100 0 100 800 0", "cpu0 50 0 50 400 0",
      "cpu  200 0 200 1400 0", "cpu0 100 0 100 700 0",
      "---", "MemTotal: 1000 kB", "MemAvailable: 500 kB",
    ].join("\n");
    expect(parseLinuxCpuMem(withCores).cpuPct).toBe(25);
  });
});

describe("parseLinuxInterfaces", () => {
  const sample = [
    "IF=eth0", "OPER=up", "MAC=aa:bb:cc:dd:ee:ff", "SPEED=1000",
    "RXB=123456", "TXB=654321", "RXE=1", "TXE=2",
    "IF=lo", "OPER=unknown", "MAC=00:00:00:00:00:00", "SPEED=",
    "RXB=10", "TXB=10", "RXE=0", "TXE=0",
  ].join("\n");

  it("reads one row per interface with counters and link rate", () => {
    const rows = parseLinuxInterfaces(sample);
    expect(rows.map((r) => r.ifName)).toEqual(["eth0", "lo"]);
    const eth0 = rows[0];
    expect(eth0.operStatus).toBe("up");
    expect(eth0.macAddress).toBe("aa:bb:cc:dd:ee:ff");
    expect(eth0.speedBps).toBe(1_000_000_000); // sysfs reports Mbit/s
    expect(eth0.inOctets).toBe(123456);
    expect(eth0.outErrors).toBe(2);
  });

  // A virtual or unplugged NIC reports nothing (or -1). Only a real negotiated
  // rate is a reading — 0 bps would render as a broken link.
  it("leaves speed null when there is no negotiated rate", () => {
    expect(parseLinuxInterfaces(sample)[1].speedBps).toBeNull();
    expect(parseLinuxInterfaces("IF=x\nSPEED=-1")[0].speedBps).toBeNull();
  });

  // Business rule 126: `ip -o addr` lines (ADDR=addr/prefix), as a real Linux
  // host printed them — one reportable address per family, loopback and
  // link-local never. Before this the collector recorded no address at all.
  it("reads the interface's IPv4 and IPv6 from the ADDR lines", () => {
    const rows = parseLinuxInterfaces([
      "IF=eth0", "OPER=up", "ADDR=192.0.2.10/24", "ADDR=fe80::78d0:2bff:feef:ee/64", "ADDR=2001:db8::10/64",
      "IF=lo", "OPER=unknown", "ADDR=127.0.0.1/8", "ADDR=::1/128",
      "IF=eth1", "OPER=down",
    ].join("\n"));
    expect(rows.map((r) => [r.ifName, r.ipAddress, r.ipv6Address])).toEqual([
      ["eth0", "192.0.2.10", "2001:db8::10"],
      ["lo", null, null],
      ["eth1", null, null],
    ]);
  });

  it("asks iproute2 for every interface's addresses", () => {
    expect(LINUX_INTERFACES_COMMAND).toMatch(/ip -o addr show dev "\$n"/);
  });

  it("maps operstate onto an admin flag", () => {
    expect(parseLinuxInterfaces("IF=a\nOPER=down")[0].adminStatus).toBe("down");
    expect(parseLinuxInterfaces("IF=a\nOPER=up")[0].adminStatus).toBe("up");
  });

  it("returns nothing for empty or unrecognisable output", () => {
    expect(parseLinuxInterfaces("")).toEqual([]);
    expect(parseLinuxInterfaces("no equals signs here")).toEqual([]);
  });
});

describe("parseLinuxStorage", () => {
  const sample = [
    "Filesystem     Type  1024-blocks     Used Available Capacity Mounted on",
    "/dev/sda1      ext4     41152812  8123456  30934012      21% /",
    "tmpfs          tmpfs     8192000        0   8192000       0% /dev/shm",
    "/dev/sdb1      xfs     104857600 52428800  52428800      50% /data",
    "udev           devtmpfs  4096000        0   4096000       0% /dev",
  ].join("\n");

  it("reads real filesystems and converts 1K blocks to bytes", () => {
    const rows = parseLinuxStorage(sample);
    expect(rows.map((r) => r.mountPath)).toEqual(["/", "/data"]);
    expect(rows[1].totalBytes).toBe(104857600 * 1024);
    expect(rows[1].usedBytes).toBe(52428800 * 1024);
  });

  // tmpfs / devtmpfs are kernel bookkeeping — rows nobody can act on.
  it("drops pseudo-filesystems", () => {
    const paths = parseLinuxStorage(sample).map((r) => r.mountPath);
    expect(paths).not.toContain("/dev/shm");
    expect(paths).not.toContain("/dev");
  });

  // -P keeps each mount on one line, but a mount point can still contain
  // spaces, so the path is the remainder of the line rather than one field.
  it("keeps a mount path containing spaces intact", () => {
    const rows = parseLinuxStorage(
      "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n" +
      "/dev/sdc1 ext4 1000 500 500 50% /mnt/my volume",
    );
    expect(rows[0].mountPath).toBe("/mnt/my volume");
  });

  it("skips zero-size mounts and junk", () => {
    expect(parseLinuxStorage("Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/x ext4 0 0 0 0% /empty")).toEqual([]);
    expect(parseLinuxStorage("")).toEqual([]);
  });
});

describe("Windows parsers", () => {
  it("parseWindowsCpuMem converts KB to bytes and derives the percentage", () => {
    const t = parseWindowsCpuMem(JSON.stringify({ cpu: 17, totalKb: 8388608, freeKb: 4194304 }));
    expect(t.cpuPct).toBe(17);
    expect(t.memTotalBytes).toBe(8388608 * 1024);
    expect(t.memUsedBytes).toBe(4194304 * 1024);
    expect(t.memPct).toBe(50);
  });

  it("parseWindowsCpuMem tolerates junk", () => {
    expect(parseWindowsCpuMem("not json").cpuPct).toBeNull();
    expect(parseWindowsCpuMem("").memTotalBytes).toBeNull();
  });

  // Get-NetAdapter.LinkSpeed is a DISPLAY string, not a number.
  it("parseWindowsLinkSpeed reads the display string", () => {
    expect(parseWindowsLinkSpeed("1 Gbps")).toBe(1_000_000_000);
    expect(parseWindowsLinkSpeed("100 Mbps")).toBe(100_000_000);
    expect(parseWindowsLinkSpeed("2.5 Gbps")).toBe(2_500_000_000);
    expect(parseWindowsLinkSpeed("")).toBeNull();
    expect(parseWindowsLinkSpeed("fast")).toBeNull();
    expect(parseWindowsLinkSpeed(1000)).toBe(1000);
  });

  it("parseWindowsInterfaces normalises the MAC to colons", () => {
    const rows = parseWindowsInterfaces(JSON.stringify([
      { n: "Ethernet", admin: "Up", oper: "Up", speed: "1 Gbps", mac: "AA-BB-CC-DD-EE-FF", ip: "10.0.0.5", rxb: 5, txb: 6, rxe: 0, txe: 0 },
    ]));
    expect(rows).toHaveLength(1);
    // Every other source in Polaris uses colons and the identity joins assume it.
    expect(rows[0].macAddress).toBe("aa:bb:cc:dd:ee:ff");
    expect(rows[0].speedBps).toBe(1_000_000_000);
    expect(rows[0].ipAddress).toBe("10.0.0.5");
    expect(rows[0].operStatus).toBe("up");
  });

  // Business rule 126: the script now sends every address on the adapter
  // (`ips`, privacy addresses last); one reportable address per family is kept.
  it("parseWindowsInterfaces picks one IPv4 and one IPv6 out of the adapter's addresses", () => {
    const rows = parseWindowsInterfaces(JSON.stringify([
      { n: "Ethernet", ips: ["fe80::1%12", "2001:db8::10", "169.254.3.4", "192.0.2.10", "2001:db8::99"] },
      { n: "Loopback", ips: ["::1", "127.0.0.1"] },
      { n: "Wi-Fi", ips: "2001:db8::20" },
      { n: "Old", ip: "192.0.2.30" },
    ]));
    expect(rows.map((r) => [r.ifName, r.ipAddress, r.ipv6Address])).toEqual([
      ["Ethernet", "192.0.2.10", "2001:db8::10"],
      ["Loopback", null, null],
      ["Wi-Fi", null, "2001:db8::20"],
      ["Old", "192.0.2.30", null],
    ]);
  });

  it("the Windows script reads both families, privacy addresses last, without Sort-Object", () => {
    expect(WINDOWS_INTERFACES_SCRIPT).not.toMatch(/-AddressFamily IPv4/);
    expect(WINDOWS_INTERFACES_SCRIPT).not.toMatch(/\bsort\b|Sort-Object/i);
    expect(WINDOWS_INTERFACES_SCRIPT.indexOf("-ne 'Random'")).toBeLessThan(WINDOWS_INTERFACES_SCRIPT.indexOf("-eq 'Random'"));
  });

  // ConvertTo-Json emits a bare object, not an array, for a single row.
  it("parseWindowsInterfaces accepts a single non-array object", () => {
    expect(parseWindowsInterfaces(JSON.stringify({ n: "Ethernet" }))).toHaveLength(1);
  });

  it("parseWindowsInterfaces skips rows with no name", () => {
    expect(parseWindowsInterfaces(JSON.stringify([{ mac: "AA-BB" }]))).toEqual([]);
  });

  it("parseWindowsStorage derives used from size minus remaining", () => {
    const rows = parseWindowsStorage(JSON.stringify([
      { path: "C:", size: 1000, free: 400 },
      { path: "D:", size: 0, free: 0 },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0].mountPath).toBe("C:");
    expect(rows[0].usedBytes).toBe(600);
  });

  it("parseWindowsStorage tolerates junk", () => {
    expect(parseWindowsStorage("nope")).toEqual([]);
    expect(parseWindowsStorage("")).toEqual([]);
  });
});

describe("event-log severity mapping", () => {
  // journald priorities 0-7, collapsed to the sink's four so agentless entries
  // sort alongside the agent's under the same min-level filter.
  it("collapses journald priorities", () => {
    expect(journalPriorityToLevel(0)).toBe("critical");
    expect(journalPriorityToLevel(2)).toBe("critical");
    expect(journalPriorityToLevel(3)).toBe("error");
    expect(journalPriorityToLevel(4)).toBe("warning");
    expect(journalPriorityToLevel(6)).toBe("info");
    // journald emits PRIORITY as a STRING in JSON output.
    expect(journalPriorityToLevel("3")).toBe("error");
    // Unknown must not become "critical" — an unparseable field is not an
    // emergency, and treating it as one would page someone.
    expect(journalPriorityToLevel(undefined)).toBe("info");
    expect(journalPriorityToLevel("nonsense")).toBe("info");
  });

  it("maps Get-WinEvent levels", () => {
    expect(winEventLevelToLevel(1)).toBe("critical");
    expect(winEventLevelToLevel(2)).toBe("error");
    expect(winEventLevelToLevel(3)).toBe("warning");
    expect(winEventLevelToLevel(4)).toBe("info");
    expect(winEventLevelToLevel(0)).toBe("info");
    expect(winEventLevelToLevel(undefined)).toBe("info");
  });
});

describe("parseJournalctl", () => {
  // journalctl -o json emits ONE OBJECT PER LINE, not a JSON array.
  const sample = [
    JSON.stringify({ __REALTIME_TIMESTAMP: "1756400000000000", PRIORITY: "3", SYSLOG_IDENTIFIER: "sshd", _SYSTEMD_UNIT: "sshd.service", MESSAGE: "Failed password for root" }),
    JSON.stringify({ __REALTIME_TIMESTAMP: "1756400001000000", PRIORITY: "4", SYSLOG_IDENTIFIER: "kernel", MESSAGE: "link down" }),
  ].join("\n");

  it("parses line-delimited JSON into sink entries", () => {
    const rows = parseJournalctl(sample, 100);
    expect(rows).toHaveLength(2);
    expect(rows[0].level).toBe("error");
    expect(rows[0].channel).toBe("sshd");
    expect(rows[0].provider).toBe("sshd.service");
    expect(rows[0].message).toContain("Failed password");
    expect(rows[1].level).toBe("warning");
  });

  // __REALTIME_TIMESTAMP is MICROSECONDS since epoch, as a string.
  it("converts the microsecond timestamp", () => {
    expect(parseJournalctl(sample, 100)[0].timestamp).toBe(new Date(1756400000000).toISOString());
  });

  it("skips malformed lines rather than failing the batch", () => {
    expect(parseJournalctl("not json\n" + sample + "\n{broken", 100)).toHaveLength(2);
  });

  it("drops entries with no message and honours the cap", () => {
    expect(parseJournalctl(JSON.stringify({ PRIORITY: 3 }), 100)).toEqual([]);
    expect(parseJournalctl(sample, 1)).toHaveLength(1);
  });
});

describe("parseWindowsEventLog", () => {
  const sample = JSON.stringify([
    { t: "2026-08-28T12:00:00.0000000Z", ch: "System", prov: "Service Control Manager", id: 7040, lvl: 3, msg: "A service changed state" },
    { t: "2026-08-28T12:01:00.0000000Z", ch: "Application", prov: "App", id: 1000, lvl: 2, msg: "Faulting application" },
  ]);

  it("maps rows onto sink entries", () => {
    const rows = parseWindowsEventLog(sample, 100);
    expect(rows).toHaveLength(2);
    expect(rows[0].eventId).toBe(7040);
    expect(rows[0].level).toBe("warning");
    expect(rows[1].level).toBe("error");
    expect(rows[1].channel).toBe("Application");
  });

  it("accepts a single non-array object and honours the cap", () => {
    expect(parseWindowsEventLog(JSON.stringify({ ch: "System", msg: "one", lvl: 2 }), 100)).toHaveLength(1);
    expect(parseWindowsEventLog(sample, 1)).toHaveLength(1);
  });

  it("tolerates junk", () => {
    expect(parseWindowsEventLog("nope", 100)).toEqual([]);
    expect(parseWindowsEventLog("", 100)).toEqual([]);
  });
});

describe("event-log command builders", () => {
  // Warning-and-above only: the sink writes into the audit Event table, which
  // the syslog / SFTP archivers ship off-host. Over-collecting here is not just
  // noisy, it is someone else's disk.
  it("journalctl asks for warning and above within the window", () => {
    const cmd = buildJournalctlCommand(15, 200);
    expect(cmd).toContain("-p warning");
    expect(cmd).toContain('--since "-15min"');
    expect(cmd).toContain("-n 200");
    expect(cmd).toContain("-o json");
  });

  it("the Windows script filters to levels 1-3 within the window", () => {
    const s = buildWindowsEventLogScript(15, 200);
    expect(s).toContain("Level=@(1,2,3)");
    expect(s).toContain("AddMinutes(-15)");
    expect(s).toContain("-MaxEvents 200");
  });

  // These numbers are interpolated into a remote command line, so they must be
  // integers and must never fall to zero (journalctl -n 0 returns nothing).
  it("clamps the window and cap to sane integers", () => {
    expect(buildJournalctlCommand(0, 0)).toContain('--since "-1min"');
    expect(buildJournalctlCommand(0, 0)).toContain("-n 1");
    expect(buildJournalctlCommand(2.7, 9.9)).toContain('--since "-2min"');
  });
});
