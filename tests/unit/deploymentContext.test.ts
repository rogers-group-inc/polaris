/**
 * tests/unit/deploymentContext.test.ts — runtimeIsContainer's signals and
 * describeDatabaseEndpoint (utils/deploymentContext.ts, CQ-B042).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsState = vi.hoisted(() => ({ files: new Set<string>(), cgroup: "0::/\n" as string | null }));
vi.mock("node:fs", async (orig) => ({
  ...(await orig<typeof import("node:fs")>()),
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (p === "/proc/1/cgroup" && fsState.cgroup !== null) return fsState.cgroup;
    throw new Error("ENOENT");
  },
}));

const ctx = await import("../../src/utils/deploymentContext.js");

const saved = { state: process.env.POLARIS_STATE_DIR, k8s: process.env.KUBERNETES_SERVICE_HOST };
beforeEach(() => {
  fsState.files.clear();
  fsState.cgroup = "0::/\n";
  delete process.env.POLARIS_STATE_DIR;
  delete process.env.KUBERNETES_SERVICE_HOST;
  ctx.resetDeploymentContextCache();
});
afterEach(() => {
  if (saved.state === undefined) delete process.env.POLARIS_STATE_DIR; else process.env.POLARIS_STATE_DIR = saved.state;
  if (saved.k8s === undefined) delete process.env.KUBERNETES_SERVICE_HOST; else process.env.KUBERNETES_SERVICE_HOST = saved.k8s;
});

describe("runtimeIsContainer", () => {
  it("is false on a bare host with a cgroup-v2 root and no markers", () => {
    expect(ctx.runtimeIsContainer()).toBe(false);
  });

  it("detects Docker (/.dockerenv), Podman (/run/.containerenv) and Kubernetes", () => {
    fsState.files.add("/.dockerenv");
    expect(ctx.runtimeIsContainer()).toBe(true);
    ctx.resetDeploymentContextCache(); fsState.files.clear();
    fsState.files.add("/run/.containerenv");
    expect(ctx.runtimeIsContainer()).toBe(true);
    ctx.resetDeploymentContextCache(); fsState.files.clear();
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    expect(ctx.runtimeIsContainer()).toBe(true);
  });

  it("reads a container runtime name out of a cgroup-v1 line", () => {
    fsState.cgroup = "12:pids:/docker/abc123\n";
    expect(ctx.runtimeIsContainer()).toBe(true);
  });

  it("treats only the image's pinned state dir as a container signal", () => {
    process.env.POLARIS_STATE_DIR = "/app/state";
    expect(ctx.runtimeIsContainer()).toBe(true);
    ctx.resetDeploymentContextCache();
    process.env.POLARIS_STATE_DIR = "/app/state/";
    expect(ctx.runtimeIsContainer()).toBe(true);
  });

  it("a bare-metal install that relocates state (SELinux / STIG) is NOT a container", () => {
    process.env.POLARIS_STATE_DIR = "/var/lib/polaris";
    expect(ctx.runtimeIsContainer()).toBe(false);
  });
});

describe("describeDatabaseEndpoint", () => {
  it("reads host and port, defaulting the port to 5432", () => {
    expect(ctx.describeDatabaseEndpoint("postgresql://u:p@db.example.com:6432/polaris")).toEqual({ host: "db.example.com", port: 6432 });
    expect(ctx.describeDatabaseEndpoint("postgresql://u:p@db.example.com/polaris")).toEqual({ host: "db.example.com", port: 5432 });
  });

  it("keeps a bracketed IPv6 host whole", () => {
    expect(ctx.describeDatabaseEndpoint("postgresql://u:p@[2001:db8::5]:5433/polaris")).toEqual({ host: "2001:db8::5", port: 5433 });
  });

  it("says local socket for a socket-only URL instead of inventing localhost:5432", () => {
    expect(ctx.describeDatabaseEndpoint("postgresql:///polaris?host=/var/run/postgresql")).toEqual({
      host: "local socket (/var/run/postgresql)", port: null,
    });
  });

  it("is unknown when unset or unparseable", () => {
    expect(ctx.describeDatabaseEndpoint(undefined)).toEqual({ host: "unknown", port: null });
    expect(ctx.describeDatabaseEndpoint("not a url")).toEqual({ host: "unknown", port: null });
  });
});
