import { afterEach, describe, it, expect } from "vitest";
import {
  _setRequestImplForTests,
  buildAuthHeaders,
  buildRequestUrl,
  detailPlaceholders,
  discoverGenericApi,
  fetchDetailsForRecord,
  fetchGenericApiDetails,
  fetchGenericApiRecords,
  discoverGenericApiNetwork,
  fetchJsonDocument,
  fillDetailTemplate,
  findInvalidMonitorQuery,
  findInvalidNetworkQuery,
  mapNetworkAddress,
  mapNetworkSubnet,
  findInvalidPath,
  genericApiWidgetId,
  genericApiWidgetSlug,
  syncGenericApiMonitorDefaults,
  parseLooseDate,
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

// ─── The fields past Location ────────────────────────────────────────────────

describe("mapGenericRecord — ownership, lifecycle, tags, coordinates", () => {
  const cfg: GenericApiConfig = {
    ...base,
    fieldMap: {
      ...base.fieldMap,
      assetTag: "tag", department: "owner.dept", assignedTo: "owner.email", description: "notes",
      tags: "labels[*]", purchaseOrder: "po", acquiredAt: "bought", warrantyExpiry: "warranty.end",
      latitude: "geo.lat", longitude: "geo.lng",
    },
  };

  it("maps each one, parsing dates and keeping the coordinates only as a valid pair", () => {
    const out = mapGenericRecord({
      id: 1, tag: "ACME-1", owner: { dept: "Ops", email: "a@example.com" }, notes: "Lobby camera",
      labels: ["east", "lobby", "east"], po: 4471, bought: "2024-02-03", warranty: { end: 1803859200 },
      geo: { lat: "36.16", lng: -86.78 },
    }, cfg);
    expect(out.ok && out.record).toMatchObject({
      assetTag: "ACME-1", department: "Ops", assignedTo: "a@example.com", description: "Lobby camera",
      tags: ["east", "lobby"], purchaseOrder: "4471",
      acquiredAt: "2024-02-03T00:00:00.000Z", warrantyExpiry: "2027-03-01T00:00:00.000Z",
      latitude: 36.16, longitude: -86.78,
    });
    const half = mapGenericRecord({ id: 1, geo: { lat: 36.16 } }, cfg);
    expect(half.ok && [half.record.latitude, half.record.longitude]).toEqual([null, null]);
    const zero = mapGenericRecord({ id: 1, geo: { lat: 0, lng: 0 } }, cfg);
    expect(zero.ok && zero.record.latitude).toBeNull();
  });
});

describe("parseLooseDate", () => {
  it("reads ISO strings and epoch seconds or milliseconds, and refuses placeholders", () => {
    expect(parseLooseDate("2025-06-30T12:00:00Z")).toBe("2025-06-30T12:00:00.000Z");
    expect(parseLooseDate("1751284800")).toBe("2025-06-30T12:00:00.000Z");
    expect(parseLooseDate("1751284800000")).toBe("2025-06-30T12:00:00.000Z");
    expect(parseLooseDate("0")).toBeNull();
    expect(parseLooseDate("9999-12-31")).toBeNull();
    expect(parseLooseDate("soon")).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
  });
});

// ─── Detail queries ──────────────────────────────────────────────────────────

describe("detail query templates", () => {
  it("finds {{…}} placeholders and refuses an unclosed one, leaving JSON braces alone", () => {
    expect(detailPlaceholders("/api/devices/{{id}}/hw?x={{ meta.site }}")).toEqual(["id", "meta.site"]);
    expect(detailPlaceholders('{"id": "{{uuid}}", "deep": {"a": 1}}')).toEqual(["uuid"]);
    expect(detailPlaceholders("/api/{{id")).toBeNull();
    expect(detailPlaceholders("/api/{{}}")).toBeNull();
    expect(detailPlaceholders("/plain")).toEqual([]);
  });

  it("URL-encodes a value into a path so it cannot add a segment, a query or a host", () => {
    const raw = { id: "a/b?c=d#e", host: "//evil.example" };
    expect(fillDetailTemplate("/api/devices/{{id}}", raw, "path")).toEqual({ ok: true, value: "/api/devices/a%2Fb%3Fc%3Dd%23e" });
    expect(fillDetailTemplate("/api/{{host}}", raw, "path")).toEqual({ ok: true, value: "/api/%2F%2Fevil.example" });
  });

  it("refuses a dot segment and a missing value", () => {
    expect(fillDetailTemplate("/api/devices/{{id}}/x", { id: ".." }, "path").ok).toBe(false);
    expect(fillDetailTemplate("/api/devices/{{id}}/x", { id: "." }, "path").ok).toBe(false);
    const missing = fillDetailTemplate("/api/devices/{{nope}}", { id: 1 }, "path");
    expect(missing).toEqual({ ok: false, reason: "the record has no usable value at {{nope}}" });
  });

  it("string-escapes a value into a JSON body", () => {
    const out = fillDetailTemplate('{"name": "{{name}}"}', { name: 'say "hi"\n' }, "body");
    expect(out.ok && JSON.parse(out.value)).toEqual({ name: 'say "hi"' });
  });
});

describe("findInvalidPath — detail queries", () => {
  it("checks the path, its placeholders, each mapped path, and refuses an id mapping", () => {
    expect(findInvalidPath({ ...base, detailQueries: [{ path: "/d/{{id}}", fieldMap: { model: "hw.model" } }] })).toBeNull();
    expect(findInvalidPath({ ...base, detailQueries: [{ path: "//evil.example/x" }] })).toMatch(/single "\/"/);
    expect(findInvalidPath({ ...base, detailQueries: [{ path: "/d/{{id" }] })).toMatch(/no matching/);
    expect(findInvalidPath({ ...base, detailQueries: [{ path: "/d/{{a[}}" }] })).toMatch(/placeholder/);
    expect(findInvalidPath({ ...base, detailQueries: [{ path: "/d", fieldMap: { model: "hw[" } }] })).toMatch(/model path/);
    expect(findInvalidPath({ ...base, detailQueries: [{ name: "HW", path: "/d", fieldMap: { id: "x" } }] })).toMatch(/"HW".*main query only/);
  });
});

describe("mapGenericRecord — detail layers", () => {
  it("a detail field wins over the main record's, the later query over the earlier, and the identity stays the main record's", () => {
    const cfg: GenericApiConfig = { ...base, identityField: "serialNumber" };
    const out = mapGenericRecord(
      { id: 7, name: "list-name", serial: "MAINSERIAL1", nics: [{ mac: "aa:bb:cc:00:00:01" }] },
      cfg,
      [
        { doc: { hw: { serial: "DETAILSERIAL", model: "M1" }, mac: "aa:bb:cc:00:00:02" }, fieldMap: { serialNumber: "hw.serial", model: "hw.model", macAddress: "mac" } },
        { doc: { model: "M2", hostname: "" }, fieldMap: { model: "model", hostname: "hostname" } },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.identity).toBe("MAINSERIAL1");
    expect(out.record.serialNumber).toBe("DETAILSERIAL");
    expect(out.record.model).toBe("M2");
    // An empty value in a detail response falls through to the main record.
    expect(out.record.hostname).toBe("list-name");
    // MACs from every layer are kept.
    expect(out.record.macs).toEqual(["AA:BB:CC:00:00:02", "AA:BB:CC:00:00:01"]);
  });
});

describe("fetchDetailsForRecord / fetchGenericApiDetails", () => {
  const cfg: GenericApiConfig = {
    ...base,
    authType: "bearer",
    apiToken: "tok",
    detailQueries: [
      { name: "HW", path: "/api/devices/{{id}}/hw", fieldMap: { model: "model" } },
      { name: "Owner", path: "/api/owners/search", method: "POST", body: '{"device": "{{id}}"}', fieldMap: { assignedTo: "email" } },
    ],
  };

  it("sends each query to the endpoint's origin with the run's auth, and POSTs the filled body", async () => {
    const seen = fakeTransport((url) => ({ json: url.pathname.endsWith("/hw") ? { model: "X1" } : { email: "o@example.com" } }));
    const d = await fetchDetailsForRecord({ id: "dev 1" }, cfg, { Authorization: "Bearer tok" });
    expect(d.failures).toEqual([]);
    expect(d.requests).toBe(2);
    expect(seen.map((s) => s.url)).toEqual([
      "https://inventory.example.com/api/devices/dev%201/hw",
      "https://inventory.example.com/api/owners/search",
    ]);
    expect(seen[0].opts.headers.Authorization).toBe("Bearer tok");
    expect(seen[0].opts.method).toBe("GET");
    expect(seen[0].opts.headers["Content-Type"]).toBeUndefined();
    expect(seen[1].opts.method).toBe("POST");
    expect(seen[1].opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen[1].opts.body!)).toEqual({ device: "dev 1" });
    const out = mapGenericRecord({ id: "dev 1" }, cfg, d.layers);
    expect(out.ok && [out.record.model, out.record.assignedTo]).toEqual(["X1", "o@example.com"]);
  });

  it("a failed query costs only its own fields and says why", async () => {
    fakeTransport((url) => (url.pathname.endsWith("/hw") ? { status: 404, text: "not found" } : { json: { email: "o@example.com" } }));
    const d = await fetchDetailsForRecord({ id: 1 }, cfg, {});
    expect(d.layers).toHaveLength(1);
    expect(d.failures[0]).toMatch(/^HW: HW answered HTTP 404/);
  });

  it("a redirect is reported, never followed", async () => {
    const seen = fakeTransport(() => ({ status: 302, headers: { location: "https://elsewhere.example/" } }));
    const d = await fetchDetailsForRecord({ id: 1 }, { ...cfg, detailQueries: [cfg.detailQueries![0]] }, {});
    expect(d.failures[0]).toMatch(/redirect/);
    expect(seen).toHaveLength(1);
  });

  it("runs across records with the concurrency limit and counts the records that failed", async () => {
    let inFlight = 0;
    let peak = 0;
    _setRequestImplForTests(async (url) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const fail = url.pathname.includes("/3/");
      return { status: fail ? 500 : 200, headers: {}, text: "", json: fail ? null : { model: "m" } };
    });
    const records = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const run = await fetchGenericApiDetails(records, { ...cfg, detailQueries: [cfg.detailQueries![0]], detailConcurrency: 3 }, {});
    expect(peak).toBeLessThanOrEqual(3);
    expect(run.requests).toBe(10);
    expect(run.recordsWithFailures).toBe(1);
    expect(run.perRecord).toHaveLength(10);
    expect(run.warnings[0]).toMatch(/failed for 1 record/);
  });

  it("makes no request when there are no detail queries", async () => {
    const seen = fakeTransport(() => ({ json: {} }));
    const run = await fetchGenericApiDetails([{ id: 1 }], base, {});
    expect(run.requests).toBe(0);
    expect(seen).toHaveLength(0);
  });
});

describe("discoverGenericApi — detail queries", () => {
  const cfg: GenericApiConfig = { ...base, detailQueries: [{ path: "/api/devices/{{id}}", fieldMap: { hostname: "name", model: "model" } }] };

  it("settles presence from the list, so a failed detail never drops a record or an identity", async () => {
    fakeTransport((url) => {
      if (url.pathname === "/api/devices") return { json: { data: [{ id: 1 }, { id: 2 }, { id: 2 }] } };
      if (url.pathname === "/api/devices/1") return { json: { name: "from-detail", model: "M" } };
      return { status: 500, text: "boom" };
    });
    const r = await discoverGenericApi(cfg);
    expect(r.presentIdentities).toEqual(["1", "2"]);
    expect(r.duplicates).toBe(1);
    expect(r.records.map((x) => [x.identity, x.hostname])).toEqual([["1", "from-detail"], ["2", null]]);
    // Detail requests are made once per surviving record, never for the duplicate.
    expect(r.detailRequests).toBe(2);
    expect(r.detailFailures).toBe(1);
    expect(r.complete).toBe(true);
  });

  it("filters on a hostname a detail query supplied", async () => {
    fakeTransport((url) => (url.pathname === "/api/devices"
      ? { json: { data: [{ id: 1 }, { id: 2 }] } }
      : { json: { name: url.pathname.endsWith("/1") ? "cam-1" : "printer-2" } }));
    const r = await discoverGenericApi({ ...cfg, deviceInclude: ["cam-*"] });
    expect(r.records.map((x) => x.hostname)).toEqual(["cam-1"]);
    expect(r.filtered).toBe(1);
  });

  it("fetches one OAuth token for the list and every detail request", async () => {
    const seen = fakeTransport((url) => (url.pathname === "/token"
      ? { json: { access_token: "t1" } }
      : url.pathname === "/api/devices" ? { json: { data: [{ id: 1 }, { id: 2 }] } } : { json: {} }));
    await discoverGenericApi({ ...cfg, authType: "oauth2", tokenUrl: "https://inventory.example.com/token", clientId: "c", clientSecret: "s" });
    expect(seen.filter((s) => s.url.endsWith("/token"))).toHaveLength(1);
    expect(seen.filter((s) => !s.url.endsWith("/token")).every((s) => s.opts.headers.Authorization === "Bearer t1")).toBe(true);
  });
});

describe("testConnection / previewGenericApi — detail queries", () => {
  const cfg: GenericApiConfig = { ...base, detailQueries: [{ name: "HW", path: "/api/devices/{{id}}", fieldMap: { model: "model" } }] };

  it("Test fails when a detail query fails for the first record, and says which", async () => {
    fakeTransport((url) => (url.pathname === "/api/devices" ? { json: { data: [{ id: 1 }] } } : { status: 403 }));
    const t = await testConnection(cfg);
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/detail query failed.*HW: HW refused the credentials/);
  });

  it("Test reports the detail queries answering", async () => {
    fakeTransport((url) => (url.pathname === "/api/devices" ? { json: { data: [{ id: 1 }] } } : { json: { model: "M" } }));
    expect((await testConnection(cfg)).message).toMatch(/1 detail query answered/);
  });

  it("Preview returns each detail response for the first mapped record and the per-row failures", async () => {
    fakeTransport((url) => {
      if (url.pathname === "/api/devices") return { json: { data: [{ name: "no id" }, { id: 1 }, { id: 2 }] } };
      if (url.pathname === "/api/devices/1") return { json: { model: "M1" } };
      return { status: 500, text: "boom" };
    });
    const p = await previewGenericApi(cfg, 10);
    expect(p.sampleDetails).toEqual([{ name: "HW", path: "/api/devices/1", ok: true, response: { model: "M1" }, error: null }]);
    expect(p.rows.map((r) => r.outcome.ok && r.outcome.record.model)).toEqual([false, "M1", null]);
    expect(p.rows[2].detailFailures[0]).toMatch(/^HW: HW answered HTTP 500/);
  });
});

// ─── Monitor queries (rule 100(i)) ───────────────────────────────────────────

describe("findInvalidMonitorQuery", () => {
  const ok = (over: Record<string, unknown>) => ({ monitorQueries: [{ stream: "responseTime", scope: "fleet", path: "/s", matchPath: "id", map: { up: "state" }, ...over }] }) as any;

  it("accepts a well-formed query of each scope", () => {
    expect(findInvalidMonitorQuery(ok({}))).toBeNull();
    expect(findInvalidMonitorQuery(ok({ scope: "asset", path: "/d/{{identity}}", matchPath: "" }))).toBeNull();
    expect(findInvalidMonitorQuery({ monitorQueries: [] })).toBeNull();
  });

  it("refuses what would read wrong or reach another host", () => {
    expect(findInvalidMonitorQuery(ok({ path: "//evil.example/x" }))).toMatch(/single "\/"/);
    expect(findInvalidMonitorQuery(ok({ path: "/s/{{id}}" }))).toMatch(/fleet query .* cannot hold/);
    expect(findInvalidMonitorQuery(ok({ matchPath: "" }))).toMatch(/needs the path that holds each record's identity/);
    expect(findInvalidMonitorQuery(ok({ map: { up: "s[" } }))).toMatch(/up path/);
    expect(findInvalidMonitorQuery(ok({ map: { cpuPct: "cpu" } }))).toMatch(/not a responseTime field/);
    expect(findInvalidMonitorQuery(ok({ map: {} }))).toMatch(/map "up"/);
    expect(findInvalidMonitorQuery(ok({ stream: "storage", map: { mountPath: "m" } }))).toMatch(/map "total"/);
    expect(findInvalidMonitorQuery(ok({ stream: "cpuMemory", map: { memTotal: "t" } }))).toMatch(/one of "cpuPct" \/ "memPct" \/ "memUsed"/);
    expect(findInvalidMonitorQuery(ok({ scope: "asset", path: "/d/{{a[}}", matchPath: "" }))).toMatch(/placeholder/);
  });

  it("checks widgets: at least one, a path each, a valid StateMap, and names unique across the integration", () => {
    const w = (widgets: unknown[]) => ({ monitorQueries: [{ stream: "widgets", scope: "asset", path: "/d/{{identity}}", widgets }] }) as any;
    expect(findInvalidMonitorQuery(w([{ name: "Toner", type: "gauge", path: "t" }]))).toBeNull();
    expect(findInvalidMonitorQuery(w([]))).toMatch(/at least one widget/);
    expect(findInvalidMonitorQuery(w([{ name: "T", type: "gauge", path: "" }]))).toMatch(/needs a path/);
    expect(findInvalidMonitorQuery(w([{ name: "D", type: "state", path: "d", stateMap: { mode: "sometimes" } }]))).toMatch(/widget "D"/);
    expect(findInvalidMonitorQuery({ monitorQueries: [
      { stream: "widgets", scope: "asset", path: "/a/{{identity}}", widgets: [{ name: "Toner", type: "gauge", path: "t" }] },
      { stream: "widgets", scope: "asset", path: "/b/{{identity}}", widgets: [{ name: "toner ", type: "line", path: "t" }] },
    ] } as any)).toMatch(/two widgets are named/);
  });
});

describe("genericApiWidgetId", () => {
  it("keys a widget by its integration and a slug of its name", () => {
    expect(genericApiWidgetSlug("  Toner Level (%) ")).toBe("toner-level");
    expect(genericApiWidgetSlug("!!!")).toBe("widget");
    expect(genericApiWidgetId("int1", "Toner Level")).toBe("ga:int1:toner-level");
  });
});

describe("syncGenericApiMonitorDefaults", () => {
  const rt = { stream: "responseTime", scope: "fleet", path: "/s" } as any;
  const cpu = { stream: "cpuMemory", scope: "fleet", path: "/s", useByDefault: false } as any;
  const widgets = { stream: "widgets", scope: "fleet", path: "/s" } as any;

  it("stores nothing when nothing is stored and no query asks to be the default", () => {
    expect(syncGenericApiMonitorDefaults(undefined, [cpu, widgets], { intervalSeconds: 60 })).toBeUndefined();
  });

  it("seeds from the manual tier the first time, then sets each defaulted stream", () => {
    expect(syncGenericApiMonitorDefaults(undefined, [rt, cpu], { intervalSeconds: 45, cpuMemoryPolling: "snmp" }))
      .toEqual({ intervalSeconds: 45, cpuMemoryPolling: "snmp", responseTimePolling: "genericapi" });
  });

  it("keeps every other key, and clears a stream left on genericapi whose query is gone", () => {
    const stored = { intervalSeconds: 30, interfacesPolling: "genericapi", storagePolling: "snmp" };
    expect(syncGenericApiMonitorDefaults(stored, [rt], null))
      .toEqual({ intervalSeconds: 30, storagePolling: "snmp", responseTimePolling: "genericapi" });
  });
});

describe("fetchJsonDocument", () => {
  it("returns the document, or why not — a 404 is 'not found', anything else is 'could not ask'", async () => {
    const seen = fakeTransport((url) => {
      if (url.pathname === "/ok") return { json: { a: 1 } };
      if (url.pathname === "/gone") return { status: 404 };
      return { status: 500, text: "boom" };
    });
    expect(await fetchJsonDocument(base, { path: "/ok" }, { Authorization: "Bearer t" })).toEqual({ ok: true, doc: { a: 1 } });
    expect(await fetchJsonDocument(base, { path: "/gone" }, {})).toMatchObject({ ok: false, notFound: true });
    expect(await fetchJsonDocument(base, { path: "/err" }, {})).toMatchObject({ ok: false, notFound: false, error: expect.stringMatching(/HTTP 500/) });
    expect(seen[0].opts.headers.Authorization).toBe("Bearer t");
  });

  it("never throws: a blocked host or a bad body comes back as a failure", async () => {
    fakeTransport(() => ({ json: {} }));
    expect(await fetchJsonDocument({ ...base, host: "169.254.169.254" }, { path: "/x" }, {})).toMatchObject({ ok: false, notFound: false });
    expect(await fetchJsonDocument(base, { path: "/x", method: "POST", body: "{nope" }, {})).toMatchObject({ ok: false, error: /not valid JSON/ });
  });
});

// ─── Network queries (rule 100(j)) ───────────────────────────────────────────

describe("mapNetworkSubnet", () => {
  const q = (map: Record<string, string>) => ({ kind: "subnets", path: "/p", map }) as any;

  it("reads a whole CIDR, or a network beside a prefix length or a dotted netmask, normalizing host bits", () => {
    expect(mapNetworkSubnet({ p: "10.1.2.77/24", n: "Core", v: "12", d: "Servers" }, q({ cidr: "p", name: "n", vlan: "v", purpose: "d" })))
      .toEqual({ ok: true, value: { cidr: "10.1.2.0/24", name: "Core", vlan: 12, purpose: "Servers" } });
    expect(mapNetworkSubnet({ net: "192.168.5.0", len: 23 }, q({ network: "net", prefixLength: "len" }))).toMatchObject({ ok: true, value: { cidr: "192.168.4.0/23" } });
    expect(mapNetworkSubnet({ net: "172.16.8.0", mask: "255.255.252.0" }, q({ network: "net", netmask: "mask" }))).toMatchObject({ ok: true, value: { cidr: "172.16.8.0/22" } });
  });

  it("refuses IPv6 by name, garbage, a missing network; drops an out-of-range VLAN", () => {
    expect(mapNetworkSubnet({ p: "2001:db8::/64" }, q({ cidr: "p" }))).toMatchObject({ ok: false, reason: /IPv6/ });
    expect(mapNetworkSubnet({ p: "not a network" }, q({ cidr: "p" }))).toMatchObject({ ok: false, reason: /not an IPv4 network/ });
    expect(mapNetworkSubnet({}, q({ cidr: "p" }))).toMatchObject({ ok: false, reason: /no network/ });
    expect(mapNetworkSubnet({ p: "10.0.0.0/8", v: 5000 }, q({ cidr: "p", vlan: "v" }))).toMatchObject({ ok: true, value: { vlan: null } });
  });
});

describe("mapNetworkAddress", () => {
  it("reads the address and what its kind carries; the zero MAC is no MAC", () => {
    const lease = { kind: "leases", path: "/l", map: { ipAddress: "ip", macAddress: "mac", hostname: "h", expiresAt: "e" } } as any;
    expect(mapNetworkAddress({ ip: "10.0.0.9/24", mac: "aa-bb-cc-00-00-01", h: "cam", e: 1803859200 }, lease)).toEqual({ ok: true, value: {
      ipAddress: "10.0.0.9", macAddress: "AA:BB:CC:00:00:01", hostname: "cam", expiresAt: "2027-03-01T00:00:00.000Z", owner: null, notes: null,
    } });
    expect(mapNetworkAddress({ ip: "10.0.0.9", mac: "00:00:00:00:00:00" }, lease)).toMatchObject({ ok: true, value: { macAddress: null } });
    const assign = { kind: "assignments", path: "/a", map: { ipAddress: "ip", owner: "o", notes: "n" } } as any;
    expect(mapNetworkAddress({ ip: "10.0.0.10", o: "Ops", n: "printer" }, assign)).toMatchObject({ ok: true, value: { owner: "Ops", notes: "printer", expiresAt: null } });
  });

  it("refuses IPv6, a non-address and a missing one", () => {
    const q = { kind: "reservations", path: "/r", map: { ipAddress: "ip" } } as any;
    expect(mapNetworkAddress({ ip: "fe80::1" }, q)).toMatchObject({ ok: false, reason: /IPv6/ });
    expect(mapNetworkAddress({ ip: "host-1" }, q)).toMatchObject({ ok: false, reason: /not an IPv4 address/ });
    expect(mapNetworkAddress({}, q)).toMatchObject({ ok: false, reason: /no address/ });
  });
});

describe("findInvalidNetworkQuery", () => {
  const cfg = (over: Record<string, unknown>) => ({ networkQueries: [{ kind: "subnets", path: "/p", map: { cidr: "prefix" }, ...over }] }) as any;

  it("accepts a well-formed query and an empty list", () => {
    expect(findInvalidNetworkQuery(cfg({}))).toBeNull();
    expect(findInvalidNetworkQuery({ networkQueries: [] })).toBeNull();
  });

  it("refuses what would read wrong or reach another host", () => {
    expect(findInvalidNetworkQuery(cfg({ path: "//evil.example/p" }))).toMatch(/single "\/"/);
    expect(findInvalidNetworkQuery(cfg({ path: "/p/{{id}}" }))).toMatch(/cannot hold/);
    expect(findInvalidNetworkQuery(cfg({ map: { ipAddress: "ip" } }))).toMatch(/not a subnets field/);
    expect(findInvalidNetworkQuery(cfg({ map: { name: "n" } }))).toMatch(/one of "cidr" \/ "network"/);
    expect(findInvalidNetworkQuery(cfg({ map: { network: "n" } }))).toMatch(/prefixLength" or "netmask"/);
    expect(findInvalidNetworkQuery(cfg({ kind: "leases", map: { hostname: "h" } }))).toMatch(/map "ipAddress"/);
    expect(findInvalidNetworkQuery(cfg({ map: { cidr: "a[" } }))).toMatch(/cidr path/);
  });
});

describe("discoverGenericApiNetwork / Test / Preview", () => {
  const netCfg: GenericApiConfig = {
    ...base,
    readDevices: false,
    networkQueries: [
      { name: "Prefixes", kind: "subnets", path: "/api/prefixes", recordsPath: "results", map: { cidr: "prefix" } },
      { name: "Leases", kind: "leases", path: "/api/leases", map: { ipAddress: "ip" } },
    ],
  };

  it("reads each query, maps every record, counts what did not map", async () => {
    fakeTransport((url) => (url.pathname === "/api/prefixes"
      ? { json: { results: [{ prefix: "10.0.0.0/24" }, { prefix: "2001:db8::/64" }] } }
      : { json: [{ ip: "10.0.0.5" }] }));
    const r = await discoverGenericApiNetwork(netCfg);
    expect(r.map((x) => [x.query.kind, x.subnets.length, x.addresses.length, x.unmapped, x.complete])).toEqual([
      ["subnets", 1, 0, 1, true],
      ["leases", 0, 1, 0, true],
    ]);
    expect(r[0].unmappedReasons[0]).toMatch(/IPv6/);
  });

  it("one query failing costs only that query, marked incomplete with its error", async () => {
    fakeTransport((url) => (url.pathname === "/api/prefixes" ? { status: 500, text: "boom" } : { json: [{ ip: "10.0.0.5" }] }));
    const r = await discoverGenericApiNetwork(netCfg);
    expect(r[0]).toMatchObject({ complete: false, error: expect.stringMatching(/HTTP 500/) });
    expect(r[1]).toMatchObject({ complete: true, error: null });
  });

  it("Test Connection on a network-only feed tests the network queries, and says which failed", async () => {
    const seen = fakeTransport((url) => (url.pathname === "/api/prefixes" ? { json: { results: [{ prefix: "10.0.0.0/24" }] } } : { json: [] }));
    const t = await testConnection(netCfg);
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/Network query "Leases" — the records path .* found no records/);
    // No device request on a network-only feed.
    expect(seen.some((s) => s.url.endsWith("/api/devices"))).toBe(false);
    fakeTransport(() => ({ json: { results: [{ prefix: "10.0.0.0/24" }] } }));
    const ok = await testConnection({ ...netCfg, networkQueries: [netCfg.networkQueries![0]] });
    expect(ok).toEqual({ ok: true, message: "Connected — 1 network query answered" });
  });

  it("Preview carries each network query's first page, and skips the device read on a network-only feed", async () => {
    fakeTransport((url) => (url.pathname === "/api/prefixes" ? { json: { results: [{ prefix: "10.9.0.0/16" }] } } : { json: [{ ip: "10.9.0.1" }] }));
    const p = await previewGenericApi(netCfg);
    expect(p.ok).toBe(true);
    expect(p.rows).toEqual([]);
    expect(p.network.map((n) => [n.name, n.ok, n.rows[0]?.outcome.ok])).toEqual([["Prefixes", true, true], ["Leases", true, true]]);
  });
});
