import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const { parseDnsTestTarget } = await import("../../src/services/dnsService.js");

describe("parseDnsTestTarget", () => {
  it("treats an IP as a reverse (PTR) lookup", () => {
    expect(parseDnsTestTarget("8.8.8.8")).toEqual({ kind: "reverse", ip: "8.8.8.8" });
    expect(parseDnsTestTarget(" 2001:4860:4860::8888 ")).toEqual({ kind: "reverse", ip: "2001:4860:4860::8888" });
  });

  it("treats a hostname as a forward lookup", () => {
    expect(parseDnsTestTarget("NAS.Example.lan.")).toEqual({ kind: "forward", name: "nas.example.lan" });
    expect(parseDnsTestTarget("tower")).toEqual({ kind: "forward", name: "tower" });
  });

  it("strips a URL down to its host", () => {
    expect(parseDnsTestTarget("https://nas.example.lan:8443/graphql")).toEqual({ kind: "forward", name: "nas.example.lan" });
    expect(parseDnsTestTarget("http://10.0.0.5/")).toEqual({ kind: "reverse", ip: "10.0.0.5" });
    expect(parseDnsTestTarget("http://[fd00::5]:80/")).toEqual({ kind: "reverse", ip: "fd00::5" });
  });

  it("strips host:port and a trailing path", () => {
    expect(parseDnsTestTarget("nas.example.lan:443")).toEqual({ kind: "forward", name: "nas.example.lan" });
    expect(parseDnsTestTarget("nas.example.lan/ui")).toEqual({ kind: "forward", name: "nas.example.lan" });
  });

  it("rejects input that is neither", () => {
    expect(parseDnsTestTarget("")).toBeNull();
    expect(parseDnsTestTarget("not a host!")).toBeNull();
    expect(parseDnsTestTarget("https://")).toBeNull();
  });
});
