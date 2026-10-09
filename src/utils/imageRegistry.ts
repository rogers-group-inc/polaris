/**
 * src/utils/imageRegistry.ts — read a published container image's build facts
 * straight from its registry (OCI Distribution API), without pulling it.
 *
 * Used by the Docker update check (services/updateService.ts →
 * checkForUpdates): a container has no .git tree to fetch, so "is there a
 * newer Polaris?" is answered by comparing this image's baked-in
 * POLARIS_BUILD_COMMIT_COUNT with the same variable in the config of the
 * published tag. Anonymous pulls only — the published image is public, and
 * the registry's bearer-token challenge (ghcr.io, Docker Hub) is answered
 * with an anonymous token.
 */

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

export interface ImageBuildInfo {
  /** POLARIS_BUILD_COMMIT_COUNT from the image's Env, or null when absent / unparseable. */
  commitCount: number | null;
  /** org.opencontainers.image.revision — the full commit SHA the image was built from. */
  revision: string | null;
  /** org.opencontainers.image.source — the repository URL. */
  source: string | null;
  /** org.opencontainers.image.created */
  created: string | null;
}

type FetchFn = typeof fetch;

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const TIMEOUT_MS = 15_000;

/**
 * Parse `[registry/]repository[:tag]`. A first segment with a dot, a colon or
 * equal to "localhost" is a registry host (the Docker CLI's rule); otherwise
 * the ref is a Docker Hub one, where single-segment names live under library/.
 * Digest refs (`@sha256:`) are refused: a pinned digest never has an update.
 */
export function parseImageRef(ref: string): ImageRef {
  const trimmed = ref.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error(`Invalid image reference: "${ref}"`);
  if (trimmed.includes("@")) throw new Error(`Image reference is pinned to a digest: "${ref}"`);

  let rest = trimmed;
  let registry = "registry-1.docker.io";
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first === "docker.io" ? "registry-1.docker.io" : first;
      rest = rest.slice(slash + 1);
    }
  }

  let tag = "latest";
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest || !tag) throw new Error(`Invalid image reference: "${ref}"`);
  if (registry === "registry-1.docker.io" && !rest.includes("/")) rest = `library/${rest}`;
  return { registry, repository: rest.toLowerCase(), tag };
}

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
export function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) params[m[1]] = m[2];
  return params.realm ? params : null;
}

/** Docker platform architecture for this process (index entries name it this way). */
export function dockerArch(nodeArch: string = process.arch): string {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "ia32") return "386";
  return nodeArch; // arm64, arm, ppc64, s390x match already
}

/**
 * Fetch the build facts of `ref`'s config blob: manifest (resolving a
 * multi-arch index to linux/<this arch>), then the config JSON. Throws on any
 * registry or network failure; the caller reports it as "couldn't check".
 */
export async function fetchImageBuildInfo(ref: string, fetchImpl: FetchFn = fetch): Promise<ImageBuildInfo> {
  const { registry, repository, tag } = parseImageRef(ref);
  const base = `https://${registry}/v2/${repository}`;
  let token: string | null = null;

  async function get(url: string, accept?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (accept) headers.Accept = accept;
    if (token) headers.Authorization = `Bearer ${token}`;
    let res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 && !token) {
      const challenge = parseBearerChallenge(res.headers.get("www-authenticate"));
      if (!challenge) throw new Error(`${registry} refused the request (401) without a bearer challenge`);
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      tokenUrl.searchParams.set("scope", challenge.scope || `repository:${repository}:pull`);
      const tokenRes = await fetchImpl(tokenUrl.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!tokenRes.ok) throw new Error(`${registry} token request failed (${tokenRes.status})`);
      const body = (await tokenRes.json()) as { token?: string; access_token?: string };
      token = body.token || body.access_token || null;
      if (!token) throw new Error(`${registry} returned no token`);
      headers.Authorization = `Bearer ${token}`;
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    if (!res.ok) throw new Error(`${registry} answered ${res.status} for ${url.replace(base, repository)}`);
    return res;
  }

  let manifest = (await (await get(`${base}/manifests/${encodeURIComponent(tag)}`, MANIFEST_ACCEPT)).json()) as any;

  if (Array.isArray(manifest?.manifests)) {
    const arch = dockerArch();
    const entry = manifest.manifests.find(
      (m: any) => m?.platform?.os === "linux" && m?.platform?.architecture === arch,
    );
    if (!entry?.digest) throw new Error(`${repository}:${tag} has no linux/${arch} image`);
    manifest = (await (await get(`${base}/manifests/${entry.digest}`, MANIFEST_ACCEPT)).json()) as any;
  }

  const configDigest: unknown = manifest?.config?.digest;
  if (typeof configDigest !== "string") throw new Error(`${repository}:${tag} manifest has no config digest`);
  const config = (await (await get(`${base}/blobs/${configDigest}`)).json()) as any;

  const env: string[] = Array.isArray(config?.config?.Env) ? config.config.Env : [];
  const labels: Record<string, string> = config?.config?.Labels ?? {};
  const countLine = env.find((e) => typeof e === "string" && e.startsWith("POLARIS_BUILD_COMMIT_COUNT="));
  const count = countLine ? Number.parseInt(countLine.split("=")[1], 10) : NaN;

  return {
    commitCount: Number.isFinite(count) && count > 0 ? count : null,
    revision: labels["org.opencontainers.image.revision"] || null,
    source: labels["org.opencontainers.image.source"] || null,
    created: labels["org.opencontainers.image.created"] || config?.created || null,
  };
}
