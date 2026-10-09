import { afterEach, describe, it, expect } from "vitest";
import {
  _setRequestImplForTests,
  buildAuthHeaders,
  buildRequestUrl,
  discoverGenericApi,
  fetchGenericApiRecords,
  findInvalidPath,
  identityKeyFor,
  isSafeRequestPath,
  mapGenericRecord,
  parseNextLink,
  passesDeviceFilter,
  previewGenericApi,
  resolveSameOriginUrl,
  testConnection,
  type GenericApiConfig,
  type RawJsonResponse,
  type RequestJsonOptions,
} from "../../src/services/genericApiService.js";

const base: GenericApiConfig = {
  host: "inventory.example.com",
  useHttps: true,
  path: "/api/devices",
  recordsPath: "data",
  fieldMap: { id: "id", hostname: "name", ipAddress: "ip", macAddress: "nics[*].mac", serialNumber: "serial" },
};

/** A fake transport answering by URL; records every request it saw. */
function fakeTransport(answer: (url: URL, opts: RequestJsonOptions) => Partial<RawJsonResponse>) {
  const seen: Array<{ url: string; opts: RequestJsonOptions }> = [];
  _setRequestImplForTests(async (url, opts) => {
    seen.push({ url: url.toString(), opts });
    const a = answer(url, opts);
    return { status: 200, headers: {}, text: "", json: null, ...a };
  });
  return seen;
}

afterEach(() => _setRequestImplForTests(null));

describe("mapGenericRecord", () => {
  it("maps every field through its path and normalizes what it can", () => {
    const out = mapGenericRecord({
      id: 42, name: "cam-lobby", ip: "10.1.2.3/24", serial: "ACCC8E123456",
      nics: [{ mac: "ac-cc-8e-12-34-56" }, { mac: "00:00:00:00:00:00" }],
    }, base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record).toMatchObject({
      identity: "42",
      hostname: "cam-lobby",
      ipAddress: "10.1.2.3",
      // All-zero MAC dropped (rule 97), the rest colon-upper.
      macs: ["AC:CC:8E:12:34:56"],
      serialNumber: "ACCC8E123456",
    });
  });

  it("ignores a value in the IP field that is not an address", () => {
    const out = mapGenericRecord({ id: 1, ip: ["printer.local", "10.0.0.9"] }, base);
    expect(out.ok && out.record.ipAddress).toBe("10.0.0.9");
    const none = mapGenericRecord({ id: 1, ip: "http://10.0.0.9/" }, base);
    expect(none.ok && none.record.ipAddress).toBeNull();
  });

  it("refuses a placeholder serial (rule 84) — and so cannot key on one", () => {
    const cfg: GenericApiConfig = { ...base, identityField: "serialNumber" };
    const out = mapGenericRecord({ id: 1, serial: "To Be Filled By O.E.M." }, cfg);
    expect(out).toEqual({ ok: false, reason: 'no usable serialNumber at "serial"' });
  });

  it("says why a record has no identity instead of dropping it silently", () => {
    expect(mapGenericRecord({ name: "x" }, base)).toEqual({ ok: false, reason: 'no usable id at "id"' });
    expect(mapGenericRecord({ id: 1 }, { ...base, identityField: "hostname", fieldMap: { id: "id" } }))
      .toEqual({ ok: false, reason: "the identity field (hostname) is not mapped" });
  });

  it("maps the source's type word through the type map, lower-cased otherwise", () => {
    const cfg: GenericApiConfig = { ...base, fieldMap: { ...base.fieldMap, assetType: "kind" }, assetTypeMap: { "Network Camera": "other", Switch: "switch" } };
    const m = (kind: string) => { const o = mapGenericRecord({ id: 1, kind }, cfg); return o.ok ? o.record.assetType : "!"; };
    expect(m("switch")).toBe("switch");
    expect(m("NETWORK CAMERA")).toBe("other");
    expect(m("Printer")).toBe("printer");
  });

  it("uses the constant manufacturer only when the record names none", () => {
    const cfg: GenericApiConfig = { ...base, fieldMap: { ...base.fieldMap, manufacturer: "vendor" }, manufacturerDefault: "Axis" };
    const a = mapGenericRecord({ id: 1 }, cfg);
    const b = mapGenericRecord({ id: 2, vendor: "Bosch" }, cfg);
    expect(a.ok && a.record.manufacturer).toBe("Axis");
    expect(b.ok && b.record.manufacturer).toBe("Bosch");
  });
});

describe("identityKeyFor", () => {
  it("normalizes per field, so one device keys the same however the feed spells it", () => {
    expect(identityKeyFor("macAddress", "aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(identityKeyFor("macAddress", "00:00:00:00:00:00")).toBeNull();
    expect(identityKeyFor("hostname", "Cam-01.Corp.")).toBe("cam-01.corp");
    expect(identityKeyFor("id", " 17 ")).toBe("17");
    expect(identityKeyFor("id", "")).toBeNull();
  });
});

describe("passesDeviceFilter", () => {
  it("include wins; empty keeps everything; a nameless record fails an include list", () => {
    expect(passesDeviceFilter("cam-1", [], [])).toBe(true);
    expect(passesDeviceFilter("cam-1", ["cam-*"], ["*"])).toBe(true);
    expect(passesDeviceFilter("sw-1", ["cam-*"], [])).toBe(false);
    expect(passesDeviceFilter(null, ["cam-*"], [])).toBe(false);
    expect(passesDeviceFilter("lab-cam", [], ["lab-*"])).toBe(false);
    expect(passesDeviceFilter(null, [], ["lab-*"])).toBe(true);
  });
});

describe("request building — what keeps an operator-shaped request on its host", () => {
  it("builds the URL from host + port + path and refuses a path that names another host", () => {
    expect(buildRequestUrl({ ...base, port: 8443 }).toString()).toBe("https://inventory.example.com:8443/api/devices");
    expect(isSafeRequestPath("/x?y=1")).toBe(true);
    expect(isSafeRequestPath("//evil.example/x")).toBe(false);
    expect(isSafeRequestPath("https://evil.example/x")).toBe(false);
    expect(isSafeRequestPath("/x\r\nHost: evil")).toBe(false);
    expect(() => buildRequestUrl({ ...base, path: "//evil.example/x" })).toThrow(/single/);
  });

  it("refuses the blocked ranges (netGuard) before any request is made", () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "localhost", "[::1]"]) {
      expect(() => buildRequestUrl({ ...base, host }), host).toThrow(/blocked range/);
    }
  });

  it("puts the query-string credential on the URL only in query mode", () => {
    expect(buildRequestUrl({ ...base, authType: "query", apiToken: "s3cr3t", authQueryParam: "key" }).searchParams.get("key")).toBe("s3cr3t");
    expect(buildRequestUrl({ ...base, authType: "bearer", apiToken: "s3cr3t" }).search).toBe("");
  });

  it("builds each auth type's header, and drops a custom header whose name could inject", () => {
    expect(buildAuthHeaders({ ...base, authType: "bearer", apiToken: "t" }).Authorization).toBe("Bearer t");
    expect(buildAuthHeaders({ ...base, authType: "basic", username: "u", password: "p" }).Authorization)
      .toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    expect(buildAuthHeaders({ ...base, authType: "header", apiToken: "t", authHeaderName: "X-Auth" })["X-Auth"]).toBe("t");
    expect(buildAuthHeaders({ ...base, authType: "oauth2" }, "tok").Authorization).toBe("Bearer tok");
    const h = buildAuthHeaders({ ...base, headers: [{ name: "X-Tenant", value: "a\r\nb" }, { name: "Bad\r\nName", value: "x" }, { name: "Host:", value: "y" }] });
    expect(h["X-Tenant"]).toBe("ab");
    expect(Object.keys(h)).toEqual(["X-Tenant"]);
  });

  it("accepts a next-page URL only on the endpoint's own origin", () => {
    const cur = new URL("https://inventory.example.com:443/api/devices");
    expect(resolveSameOriginUrl("/api/devices?page=2", cur, base)?.toString()).toBe("https://inventory.example.com/api/devices?page=2");
    expect(resolveSameOriginUrl("https://evil.example/api", cur, base)).toBeNull();
    expect(resolveSameOriginUrl("http://inventory.example.com/api", cur, base)).toBeNull();
  });

  it("reads rel=next out of a Link header", () => {
    expect(parseNextLink('<https://x/a?page=1>; rel="prev", <https://x/a?page=3>; rel="next"')).toBe("https://x/a?page=3");
    expect(parseNextLink("<https://x/a>; rel=last")).toBeNull();
    expect(parseNextLink(undefined)).toBeNull();
  });

  it("names the first unparseable path", () => {
    expect(findInvalidPath({ recordsPath: "data", fieldMap: { id: "id", hostname: "a[" } })).toMatch(/^hostname path:/);
    expect(findInvalidPath(base)).toBeNull();
  });
});

describe("fetchGenericApiRecords — pagination", () => {
  it("page mode with a size parameter stops on a short page", async () => {
    const seen = fakeTransport((url) => {
      const page = Number(url.searchParams.get("page"));
      const rows = page === 1 ? [{ id: 1 }, { id: 2 }] : page === 2 ? [{ id: 3 }] : [];
      return { json: { data: rows } };
    });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "page", pageParam: "page", sizeParam: "per_page", pageSize: 2 } });
    expect(r.records.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ pages: 2, complete: true });
    expect(seen.map((s) => s.url)).toEqual([
      "https://inventory.example.com/api/devices?page=1&per_page=2",
      "https://inventory.example.com/api/devices?page=2&per_page=2",
    ]);
  });

  it("page mode WITHOUT a size parameter keeps asking until an empty page", async () => {
    fakeTransport((url) => {
      const page = Number(url.searchParams.get("page"));
      return { json: { data: page <= 2 ? [{ id: page }] : [] } };
    });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "page" } });
    expect(r.records.map((x) => x.id)).toEqual([1, 2]);
    expect(r.pages).toBe(3);
    expect(r.complete).toBe(true);
  });

  it("offset mode advances by the items read", async () => {
    const seen = fakeTransport((url) => {
      const off = Number(url.searchParams.get("offset"));
      return { json: { data: off < 4 ? [{ id: off }, { id: off + 1 }] : [] } };
    });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "offset", sizeParam: "limit", pageSize: 2 } });
    expect(r.records.map((x) => x.id)).toEqual([0, 1, 2, 3]);
    expect(seen.map((s) => new URL(s.url).searchParams.get("offset"))).toEqual(["0", "2", "4"]);
  });

  it("cursor mode sends the cursor back, and follows a same-origin next URL", async () => {
    fakeTransport((url) => {
      if (!url.searchParams.get("cursor") && !url.pathname.endsWith("/p3")) return { json: { data: [{ id: 1 }], next: "c2" } };
      if (url.searchParams.get("cursor") === "c2") return { json: { data: [{ id: 2 }], next: "/api/p3" } };
      return { json: { data: [{ id: 3 }], next: null } };
    });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "cursor", cursorPath: "next", cursorParam: "cursor" } });
    expect(r.records.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(r.complete).toBe(true);
  });

  it("stops — incomplete — when a cursor URL points at another host", async () => {
    const seen = fakeTransport(() => ({ json: { data: [{ id: 1 }], next: "https://evil.example/p2" } }));
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "cursor", cursorPath: "next" } });
    expect(seen).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/different host/);
  });

  it("link mode follows rel=next", async () => {
    fakeTransport((url) => url.searchParams.get("p") === "2"
      ? { json: { data: [{ id: 2 }] } }
      : { json: { data: [{ id: 1 }] }, headers: { link: '</api/devices?p=2>; rel="next"' } });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "link" } });
    expect(r.records.map((x) => x.id)).toEqual([1, 2]);
  });

  it("a source that ignores the page parameter is caught on page 2, and the read is incomplete", async () => {
    const seen = fakeTransport(() => ({ json: { data: [{ id: 1 }, { id: 2 }] } }));
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "page", sizeParam: "n", pageSize: 2 } });
    expect(seen).toHaveLength(2);
    expect(r.records).toHaveLength(2);
    expect(r.complete).toBe(false);
  });

  it("the page limit and the record limit both mark the read incomplete", async () => {
    fakeTransport(() => ({ json: { data: [{ id: Math.random() }] } }));
    const byPages = await fetchGenericApiRecords({ ...base, pagination: { mode: "page", maxPages: 3 } });
    expect(byPages).toMatchObject({ pages: 3, complete: false });

    fakeTransport(() => ({ json: { data: [{ id: 1 }, { id: 2 }, { id: 3 }] } }));
    const byRecords = await fetchGenericApiRecords({ ...base, maxRecords: 2 });
    expect(byRecords.records).toHaveLength(2);
    expect(byRecords.complete).toBe(false);
  });

  it("a failing FIRST page throws; a failing later page returns what was read, incomplete", async () => {
    fakeTransport(() => ({ status: 401, text: "nope" }));
    await expect(fetchGenericApiRecords(base)).rejects.toThrow(/refused the credentials/);

    fakeTransport((url) => url.searchParams.get("page") === "1" ? { json: { data: [{ id: 1 }] } } : { status: 500, text: "boom" });
    const r = await fetchGenericApiRecords({ ...base, pagination: { mode: "page" } });
    expect(r.records).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.warnings[0]).toMatch(/Page 2 failed: .*HTTP 500/);
  });

  it("reports a redirect instead of following it, and a non-JSON body", async () => {
    fakeTransport(() => ({ status: 302 }));
    await expect(fetchGenericApiRecords(base)).rejects.toThrow(/redirects are not followed/);
    fakeTransport(() => ({ status: 200, json: undefined, text: "<html>" }));
    await expect(fetchGenericApiRecords(base)).rejects.toThrow(/did not answer with JSON/);
  });

  it("POSTs the configured body, and refuses one that is not JSON", async () => {
    const seen = fakeTransport(() => ({ json: { data: [] } }));
    await fetchGenericApiRecords({ ...base, method: "POST", body: '{"query":"all"}' });
    expect(seen[0].opts).toMatchObject({ method: "POST", body: '{"query":"all"}' });
    await expect(fetchGenericApiRecords({ ...base, method: "POST", body: "{nope" })).rejects.toThrow(/not valid JSON/);
  });

  it("fetches an OAuth token first and sends it as a bearer", async () => {
    const seen = fakeTransport((url) => url.pathname === "/oauth/token"
      ? { json: { access_token: "abc" } }
      : { json: { data: [] } });
    await fetchGenericApiRecords({ ...base, authType: "oauth2", tokenUrl: "https://login.example.com/oauth/token", clientId: "c", clientSecret: "s" });
    expect(seen[0].opts.body).toBe("grant_type=client_credentials&client_id=c&client_secret=s");
    expect(seen[1].opts.headers.Authorization).toBe("Bearer abc");
  });

  it("refuses a token URL in a blocked range", async () => {
    fakeTransport(() => ({ json: {} }));
    await expect(fetchGenericApiRecords({ ...base, authType: "oauth2", tokenUrl: "http://169.254.169.254/token" })).rejects.toThrow(/blocked range/);
  });
});

describe("discoverGenericApi", () => {
  it("counts unmapped, duplicate and filtered records, keeping the PRE-filter identity set", async () => {
    fakeTransport(() => ({
      json: { data: [
        { id: 1, name: "cam-1" },
        { id: 2, name: "lab-cam" },
        { id: 1, name: "cam-1 again" },
        { name: "no-id" },
      ] },
    }));
    const r = await discoverGenericApi({ ...base, deviceExclude: ["lab-*"] });
    expect(r.records.map((x) => x.identity)).toEqual(["1"]);
    expect(r.presentIdentities).toEqual(["1", "2"]);
    expect(r).toMatchObject({ unmapped: 1, duplicates: 1, filtered: 1, rawCount: 4, complete: true });
    expect(r.unmappedReasons[0]).toBe('record 4: no usable id at "id"');
  });
});

describe("testConnection / previewGenericApi", () => {
  it("passes only when the first page has records and at least one maps", async () => {
    fakeTransport(() => ({ json: { data: [{ id: 1 }] } }));
    expect(await testConnection(base)).toEqual({ ok: true, message: "Connected — first page: 1 record(s), 1 mapped" });
    fakeTransport(() => ({ json: { items: [{ id: 1 }] } }));
    expect((await testConnection(base)).message).toMatch(/found no records/);
    fakeTransport(() => ({ json: { data: [{ name: "x" }] } }));
    expect((await testConnection(base)).message).toMatch(/none mapped: no usable id/);
    expect((await testConnection({ ...base, host: "127.0.0.1" })).ok).toBe(false);
  });

  it("previews the first raw record and the mapped rows, marking filtered ones", async () => {
    fakeTransport(() => ({ json: { data: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { name: "c" }] } }));
    const p = await previewGenericApi({ ...base, deviceInclude: ["a"] }, 10);
    expect(p.ok).toBe(true);
    expect(p.sampleRecord).toEqual({ id: 1, name: "a" });
    expect(p.rows.map((r) => [r.outcome.ok, r.filteredOut])).toEqual([[true, false], [true, true], [false, false]]);
  });

  it("reports a path that does not parse without making a request", async () => {
    const seen = fakeTransport(() => ({ json: {} }));
    const p = await previewGenericApi({ ...base, recordsPath: "data[" });
    expect(p.ok).toBe(false);
    expect(p.message).toMatch(/Records path/);
    expect(seen).toHaveLength(0);
  });
});
