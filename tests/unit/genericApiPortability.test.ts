/**
 * tests/unit/genericApiPortability.test.ts — `.genericapi.json` export /
 * import (public/js/genericapi-portability.js, business rule 100).
 *
 * The file exists so a mapping written once for a product can be posted for
 * anyone running Polaris. What is pinned:
 *
 *  - **every export is a valid import** — the round trip loses nothing but
 *    what the export deliberately drops;
 *  - **secrets never leave**, nor the value of a header whose name says it
 *    carries a credential (extra headers are stored unsealed);
 *  - **connection details stay home unless asked for** — host, port, username,
 *    client id and token URL say where an install's systems are;
 *  - **an import never carries a secret** — the importer re-strips rather than
 *    trusting the file;
 *  - another kind of Polaris export, bad JSON, prototype keys and deep nesting
 *    are refused with a message an operator can act on.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/genericapi-portability.js"), "utf8");

interface Portability {
  FORMAT_VERSION: number;
  FILE_SUFFIX: string;
  MAX_IMPORT_BYTES: number;
  SECRET_KEYS: string[];
  CONNECTION_KEYS: string[];
  nameFromFilename: (f: string) => string;
  filenameForExport: (n: string) => string;
  stripConfig: (c: unknown, o?: unknown) => { config: any; removed: string[] };
  buildExportFile: (c: unknown, o?: unknown) => any;
  parseImportFile: (text: string, filename?: string) => any;
  assertSafeKeys: (v: unknown, d: number) => void;
}

let P: Portability;

beforeAll(() => {
  const g = globalThis as Record<string, any>;
  const win: Record<string, any> = {};
  g.window = win;
  (0, eval)(SRC);
  P = win.PolarisGenericApiPortability as Portability;
});

/** A stored configuration, secrets and all. */
const stored = () => ({
  host: "cmdb.corp.example",
  port: 8443,
  useHttps: true,
  verifySsl: true,
  method: "GET",
  path: "/api/v2/devices",
  body: "",
  headers: [{ name: "X-Tenant", value: "east" }, { name: "Authorization", value: "Bearer leaked" }, { name: "X-Session-Id", value: "s1" }],
  authType: "oauth2",
  apiToken: "",
  username: "svc-polaris",
  password: "pw",
  tokenUrl: "https://login.corp.example/token",
  clientId: "client-123",
  clientSecret: "shh",
  scope: "read",
  pagination: { mode: "page", pageParam: "page", sizeParam: "per_page", pageSize: 200, startPage: 1, maxPages: 50 },
  recordsPath: "data",
  fieldMap: { id: "id", hostname: "name", warrantyExpiry: "warranty.end" },
  detailQueries: [{ name: "HW", method: "GET", path: "/api/v2/devices/{{id}}/hw", body: "", fieldMap: { serialNumber: "serial" } }],
  detailConcurrency: 4,
  identityField: "id",
  verboseLogging: true,
  verboseLoggingEnabledAt: "2026-10-01T00:00:00Z",
});

describe("export", () => {
  it("drops every secret, the install-local switches, and (by default) the connection details", () => {
    const file = P.buildExportFile(stored(), { name: "Facilities CMDB" });
    expect(file.polarisGenericApi).toBe(P.FORMAT_VERSION);
    expect(file.name).toBe("Facilities CMDB");
    for (const k of [...P.SECRET_KEYS, ...P.CONNECTION_KEYS, "verboseLogging", "verboseLoggingEnabledAt"]) {
      expect(file.config).not.toHaveProperty(k);
    }
    const text = JSON.stringify(file);
    // Short values checked as whole JSON strings, longer ones anywhere in the file.
    for (const leak of ["pw", "shh", "s1"]) expect(text).not.toContain(`"${leak}"`);
    for (const leak of ["leaked", "svc-polaris", "client-123", "corp.example"]) expect(text).not.toContain(leak);
  });

  it("blanks a credential-looking header's value but keeps its name and the other headers", () => {
    const { config, removed } = P.stripConfig(stored());
    expect(config.headers).toEqual([
      { name: "X-Tenant", value: "east" },
      { name: "Authorization", value: "" },
      { name: "X-Session-Id", value: "" },
    ]);
    expect(removed).toEqual(expect.arrayContaining(["header:Authorization", "header:X-Session-Id"]));
  });

  it("lists what the importer must fill in, credential first", () => {
    const file = P.buildExportFile(stored(), {});
    expect(file.needs[0]).toBe("clientSecret");
    expect(file.needs).toEqual(expect.arrayContaining(["host", "port", "username", "clientId", "tokenUrl", "header:Authorization"]));
    expect(P.buildExportFile({ ...stored(), authType: "none", headers: [] }, { includeConnection: true }).needs).toEqual([]);
  });

  it("keeps the connection details when asked — never the secrets", () => {
    const file = P.buildExportFile(stored(), { includeConnection: true });
    expect(file.config).toMatchObject({ host: "cmdb.corp.example", port: 8443, username: "svc-polaris", clientId: "client-123" });
    expect(file.config).not.toHaveProperty("clientSecret");
    expect(file.config).not.toHaveProperty("password");
  });

  it("puts the hints before the configuration, for a person reading the file", () => {
    const keys = Object.keys(P.buildExportFile(stored(), { name: "x" }));
    expect(keys.indexOf("needs")).toBeLessThan(keys.indexOf("config"));
  });

  it("does not modify the configuration it was given", () => {
    const cfg = stored();
    P.buildExportFile(cfg, {});
    expect(cfg.clientSecret).toBe("shh");
    expect(cfg.headers[1].value).toBe("Bearer leaked");
  });
});

describe("every export is a valid import", () => {
  it("round-trips everything the export keeps", () => {
    const file = P.buildExportFile(stored(), { name: "Facilities CMDB", includeConnection: true });
    const back = P.parseImportFile(JSON.stringify(file), "whatever.json");
    expect(back.name).toBe("Facilities CMDB");
    expect(back.config).toEqual(file.config);
    expect(back.problems).toEqual([]);
    expect(back.needs).toEqual(file.needs);
  });
});

describe("import", () => {
  it("never carries a secret, whatever the file says", () => {
    const back = P.parseImportFile(JSON.stringify({ polarisGenericApi: 1, config: stored() }));
    for (const k of P.SECRET_KEYS) expect(back.config).not.toHaveProperty(k);
    expect(back.config.headers[1]).toEqual({ name: "Authorization", value: "" });
    // Connection details ARE kept — an operator restoring their own export wants them.
    expect(back.config.host).toBe("cmdb.corp.example");
  });

  it("accepts a bare configuration and names it from the file", () => {
    const back = P.parseImportFile(JSON.stringify({ path: "/x", recordsPath: "items" }), "Axis Camera Station.genericapi.json");
    expect(back.config).toEqual({ path: "/x", recordsPath: "items" });
    expect(back.name).toBe("Axis Camera Station");
  });

  it("flags a newer format version without refusing it", () => {
    const back = P.parseImportFile(JSON.stringify({ polarisGenericApi: 2, config: { path: "/x" } }));
    expect(back.problems[0]).toMatch(/format version 2/);
  });

  it("refuses what is not a Generic API configuration, saying why", () => {
    expect(() => P.parseImportFile("")).toThrow(/empty/);
    expect(() => P.parseImportFile("{nope")).toThrow(/valid JSON/);
    expect(() => P.parseImportFile("[1,2]")).toThrow(/doesn't contain/);
    expect(() => P.parseImportFile(JSON.stringify({ polarisDiscovery: 1, scan: {} }))).toThrow(/different kind/);
    expect(() => P.parseImportFile(JSON.stringify({ hello: "world" }))).toThrow(/isn't a Generic API configuration/);
    expect(() => P.parseImportFile("x".repeat(P.MAX_IMPORT_BYTES + 1))).toThrow(/too large/);
  });

  it("refuses prototype keys and runaway nesting", () => {
    expect(() => P.parseImportFile('{"config": {"path": "/x", "__proto__": {"polluted": 1}}}')).toThrow(/__proto__/);
    let deep: any = { path: "/x" };
    for (let i = 0; i < 30; i++) deep = { a: deep };
    expect(() => P.assertSafeKeys(deep, 0)).toThrow(/nested too deeply/);
  });
});

describe("file names", () => {
  it("round-trips a name through the export file name", () => {
    expect(P.filenameForExport("Facilities: CMDB/East")).toBe("Facilities- CMDB-East.genericapi.json");
    expect(P.filenameForExport("")).toBe("generic-api.genericapi.json");
    expect(P.nameFromFilename("C:\\Downloads\\Axis.genericapi.json")).toBe("Axis");
    expect(P.nameFromFilename("..json")).toBe("");
  });
});
