/**
 * tests/unit/imageRegistry.test.ts — src/utils/imageRegistry.ts, the registry
 * read behind the Docker update check.
 *
 * The fetch flow is driven by a scripted fake registry shaped like ghcr.io:
 * the first manifest GET answers 401 with a bearer challenge, the token
 * endpoint hands out an anonymous token, `latest` is a multi-arch index, and
 * the blob is the image config carrying POLARIS_BUILD_COMMIT_COUNT.
 */

import { describe, it, expect } from "vitest";
import {
  parseImageRef,
  parseBearerChallenge,
  dockerArch,
  fetchImageBuildInfo,
} from "../../src/utils/imageRegistry.js";

describe("parseImageRef", () => {
  it("splits a ghcr.io ref", () => {
    expect(parseImageRef("ghcr.io/rogers-group-inc/polaris:latest")).toEqual({
      registry: "ghcr.io", repository: "rogers-group-inc/polaris", tag: "latest",
    });
  });
  it("defaults the tag to latest", () => {
    expect(parseImageRef("ghcr.io/rogers-group-inc/polaris").tag).toBe("latest");
  });
  it("treats a first segment without a dot as a Docker Hub namespace", () => {
    expect(parseImageRef("someone/polaris:0.9")).toEqual({
      registry: "registry-1.docker.io", repository: "someone/polaris", tag: "0.9",
    });
  });
  it("puts a bare Docker Hub name under library/", () => {
    expect(parseImageRef("nginx").repository).toBe("library/nginx");
  });
  it("keeps a registry port and does not read it as a tag", () => {
    expect(parseImageRef("mirror.local:5000/polaris")).toEqual({
      registry: "mirror.local:5000", repository: "polaris", tag: "latest",
    });
  });
  it("refuses a digest-pinned ref and an empty one", () => {
    expect(() => parseImageRef("ghcr.io/x/y@sha256:abc")).toThrow(/digest/);
    expect(() => parseImageRef("  ")).toThrow();
  });
});

describe("parseBearerChallenge", () => {
  it("reads realm, service and scope", () => {
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"')).toEqual({
      realm: "https://ghcr.io/token", service: "ghcr.io", scope: "repository:a/b:pull",
    });
  });
  it("returns null for Basic or a missing header", () => {
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge(null)).toBeNull();
  });
});

describe("dockerArch", () => {
  it("maps Node's arch names onto Docker's", () => {
    expect(dockerArch("x64")).toBe("amd64");
    expect(dockerArch("arm64")).toBe("arm64");
  });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeRegistry(env: string[], labels: Record<string, string> = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const arch = dockerArch();
  const fn = (async (input: any, init?: any) => {
    const url = String(input);
    const auth = init?.headers?.Authorization ?? null;
    calls.push({ url, auth });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (!auth) {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/p:pull"' },
      });
    }
    if (url.endsWith("/manifests/latest")) {
      return json({ manifests: [
        { digest: "sha256:other", platform: { os: "linux", architecture: arch === "amd64" ? "arm64" : "amd64" } },
        { digest: "sha256:mine", platform: { os: "linux", architecture: arch } },
      ] });
    }
    if (url.endsWith("/manifests/sha256:mine")) return json({ config: { digest: "sha256:cfg" } });
    if (url.endsWith("/blobs/sha256:cfg")) return json({ config: { Env: env, Labels: labels } });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("fetchImageBuildInfo", () => {
  it("answers the bearer challenge, resolves the index to this arch and reads the config", async () => {
    const reg = fakeRegistry(
      ["PATH=/usr/bin", "POLARIS_BUILD_COMMIT_COUNT=3962"],
      {
        "org.opencontainers.image.revision": "43f9a1cac6a2bf6d020a8c18db3588651051fe61",
        "org.opencontainers.image.source": "https://github.com/o/p",
      },
    );
    const info = await fetchImageBuildInfo("ghcr.io/o/p:latest", reg.fn);
    expect(info.commitCount).toBe(3962);
    expect(info.revision).toBe("43f9a1cac6a2bf6d020a8c18db3588651051fe61");
    expect(info.source).toBe("https://github.com/o/p");
    // One token fetch; every later request carries it.
    expect(reg.calls.filter((c) => c.url.startsWith("https://ghcr.io/token"))).toHaveLength(1);
    expect(reg.calls.some((c) => c.url.endsWith("/manifests/sha256:other"))).toBe(false);
    expect(reg.calls.at(-1)!.auth).toBe("Bearer anon");
  });

  it("reports a missing or zero commit count as null", async () => {
    expect((await fetchImageBuildInfo("ghcr.io/o/p:latest", fakeRegistry(["PATH=/x"]).fn)).commitCount).toBeNull();
    expect((await fetchImageBuildInfo("ghcr.io/o/p:latest", fakeRegistry(["POLARIS_BUILD_COMMIT_COUNT=0"]).fn)).commitCount).toBeNull();
  });

  it("throws when the registry refuses", async () => {
    const fn = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(fetchImageBuildInfo("ghcr.io/o/p:latest", fn)).rejects.toThrow(/404/);
  });
});
