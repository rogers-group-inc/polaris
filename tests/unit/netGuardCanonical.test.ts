/**
 * tests/unit/netGuardCanonical.test.ts
 *
 * Business rule 110: the guard judges the ADDRESS, not the text. Every spelling
 * the URL parser or getaddrinfo accepts for a blocked address is blocked, a
 * name is judged by what it resolves to, and the LAN stays reachable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  isBlockedOutboundHost,
  isBlockedLlmHost,
  isLoopbackHost,
  guardedLookup,
  resolveAllowedHost,
  _setResolverForTests,
} from "../../src/utils/netGuard.js";

// What `new URL("http://" + host).hostname` yields is what reaches the guard.
const urlHost = (h: string): string => new URL(`http://${h}/`).hostname;

describe("alternate spellings of loopback and metadata are blocked", () => {
  it.each([
    "127.1",
    "127.0.1",
    "2130706433",
    "0x7f000001",
    "0x7f.1",
    "0177.0.0.1",
    "017700000001",
    "127.0.0.1.",
    "0",
    "0.0.0.0",
    "2852039166", // 169.254.169.254
    "0xa9fea9fe",
    "169.254.169.254.",
    "localhost.",
    "LOCALHOST",
    "foo.localhost.",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "0000:0000:0000:0000:0000:0000:0000:0001",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "fe80::1%eth0",
    "febf::1",
    "ff02::1",
  ])("blocks %s", (h) => {
    expect(isBlockedOutboundHost(h)).toBe(true);
  });

  it.each(["127.0.0.1", "127.1", "[::ffff:127.0.0.1]", "[0:0:0:0:0:0:0:1]", "2130706433", "0x7f.1", "[::ffff:7f00:1]"])(
    "blocks what the URL parser makes of %s",
    (h) => {
      expect(isBlockedOutboundHost(urlHost(h))).toBe(true);
    },
  );

  it("refuses a host whose last label is numeric but is not an IPv4 address", () => {
    expect(isBlockedOutboundHost("1.2.3.4.5")).toBe(true);
    expect(isBlockedOutboundHost("999.1")).toBe(true);
    expect(isBlockedOutboundHost("0xzz")).toBe(false); // an ordinary label, not a number
  });
});

describe("the LAN and public addresses stay allowed", () => {
  it.each([
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "8.8.8.8",
    "100.64.0.1",
    "fc00::1",
    "fd12:3456::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:c0a8:101",
    "64:ff9b::808:808",
    "2002:c0a8:101::1",
    "fw1.corp.example.com",
    "host1",
    "3com.example.com",
    "",
  ])("allows %j", (h) => {
    expect(isBlockedOutboundHost(h)).toBe(false);
  });
});

describe("loopback is separable for the LLM allow-loopback opt-in", () => {
  it.each(["127.1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:7f00:1", "localhost.", "2130706433"])(
    "%s is loopback and allowed when asked",
    (h) => {
      expect(isLoopbackHost(h)).toBe(true);
      expect(isBlockedLlmHost(h, false)).toBe(true);
      expect(isBlockedLlmHost(h, true)).toBe(false);
    },
  );

  it.each(["169.254.169.254", "2852039166", "::ffff:a9fe:a9fe", "0.0.0.0", "ff02::1"])(
    "%s stays blocked even with allow-loopback",
    (h) => {
      expect(isLoopbackHost(h)).toBe(false);
      expect(isBlockedLlmHost(h, true)).toBe(true);
    },
  );
});

describe("guardedLookup — a name is judged by what it resolves to", () => {
  const lookupMock = vi.fn();
  beforeEach(() => {
    lookupMock.mockReset();
    _setResolverForTests({
      all: (h, o, cb) => lookupMock(h, o, cb),
      allAsync: async () => [],
    });
  });

  const run = (host: string, opts: Parameters<typeof guardedLookup>[0] = {}, options: object = {}) =>
    new Promise<{ err: any; address?: any; family?: number }>((resolve) => {
      guardedLookup(opts)(host, options as any, ((err: any, address: any, family: number) =>
        resolve({ err, address, family })) as any);
    });

  const answer = (addrs: Array<{ address: string; family: number }>) =>
    lookupMock.mockImplementation((_h: string, _o: object, cb: Function) => cb(null, addrs));

  it("refuses a name that resolves to loopback", async () => {
    answer([{ address: "127.0.0.1", family: 4 }]);
    const r = await run("rebind.example.com");
    expect(r.err?.code).toBe("BLOCKED_HOST");
  });

  it("refuses a name when ANY record is blocked", async () => {
    answer([{ address: "10.0.0.5", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    expect((await run("two.example.com")).err?.code).toBe("BLOCKED_HOST");
  });

  it("refuses a name that resolves to a mapped IPv6 spelling", async () => {
    answer([{ address: "::ffff:7f00:1", family: 6 }]);
    expect((await run("six.example.com")).err?.code).toBe("BLOCKED_HOST");
  });

  it("hands back the checked address for a LAN name", async () => {
    answer([{ address: "10.1.2.3", family: 4 }]);
    const r = await run("fw1.corp.example.com");
    expect(r.err).toBeNull();
    expect(r.address).toBe("10.1.2.3");
    expect(r.family).toBe(4);
  });

  it("returns the whole list when the caller asked for all", async () => {
    answer([{ address: "10.1.2.3", family: 4 }]);
    const r = await run("fw1.corp.example.com", {}, { all: true });
    expect(r.address).toEqual([{ address: "10.1.2.3", family: 4 }]);
  });

  it("lets loopback through only when allowLoopback is set", async () => {
    answer([{ address: "127.0.0.1", family: 4 }]);
    expect((await run("ollama.lan", { allowLoopback: true })).err).toBeNull();
    answer([{ address: "169.254.169.254", family: 4 }]);
    expect((await run("ollama.lan", { allowLoopback: true })).err?.code).toBe("BLOCKED_HOST");
  });

  it("passes a resolver error through", async () => {
    lookupMock.mockImplementation((_h: string, _o: object, cb: Function) => cb(new Error("ENOTFOUND")));
    expect((await run("nope.example.com")).err?.message).toBe("ENOTFOUND");
  });
});

describe("resolveAllowedHost", () => {
  const asyncMock = vi.fn();
  beforeEach(() => {
    asyncMock.mockReset();
    _setResolverForTests({ all: () => {}, allAsync: (h) => asyncMock(h) });
  });

  it("refuses a literal without resolving", async () => {
    await expect(resolveAllowedHost("2130706433")).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(asyncMock).not.toHaveBeenCalled();
  });

  it("returns an allowed literal untouched", async () => {
    expect(await resolveAllowedHost("10.0.0.1")).toBe("10.0.0.1");
    expect(asyncMock).not.toHaveBeenCalled();
  });

  it("refuses a name whose records include a blocked one", async () => {
    asyncMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }, { address: "::1", family: 6 }]);
    await expect(resolveAllowedHost("rebind.example.com")).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("returns the first checked address of an allowed name", async () => {
    asyncMock.mockResolvedValue([{ address: "10.9.9.9", family: 4 }]);
    expect(await resolveAllowedHost("fw1.corp.example.com")).toBe("10.9.9.9");
  });

  it("returns null when the name does not resolve (the request reports its own error)", async () => {
    asyncMock.mockRejectedValue(new Error("ENOTFOUND"));
    expect(await resolveAllowedHost("nope.example.com")).toBeNull();
  });

  it("honours allowLoopback", async () => {
    expect(await resolveAllowedHost("127.0.0.1", { allowLoopback: true })).toBe("127.0.0.1");
    await expect(resolveAllowedHost("169.254.169.254", { allowLoopback: true })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });
});
