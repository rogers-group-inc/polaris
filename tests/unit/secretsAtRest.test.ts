/**
 * tests/unit/secretsAtRest.test.ts
 *
 * The walk that the secret-at-rest layer in src/db.ts runs over Prisma args and
 * results. Two properties carry the weight here:
 *
 *   1. It finds secrets nested at RELATION depth, not just inside a config blob.
 *      Prisma query extensions fire for top-level operations only, so
 *      `asset.findUnique({ include: { monitorCredential: true } })` never enters
 *      the `credential` hooks — the monitor hot path, reservation push and
 *      description sync all load their secrets that way. Missing this shipped
 *      ciphertext to every SNMP / WinRM / SSH / FortiOS poll on the first
 *      install that set POLARIS_SECRET_KEY.
 *   2. It does not damage what it walks past. The transform REBUILDS every
 *      object it descends into, and a Date has no own enumerable properties — so
 *      descending into one yields `{}`. Harmless when the walk only ever saw JSON
 *      blobs; destroys every timestamp in a row now that it also walks results.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  transformSecretFields,
  containsSecretField,
  secretJsonFieldFor,
  SECRET_BEARING_MODELS,
  SECRET_CONFIG_KEYS,
  RESULT_WALK_DEPTH,
} from "../../src/utils/configSecretFields.js";

const seal = (s: string) => `SEALED(${s})`;
const open = (s: string) => (s.startsWith("SEALED(") ? s.slice(7, -1) : s);
const isSealed = (s: string) => s.startsWith("SEALED(");

/** A read result shaped like the monitor hot path's, secrets at relation depth. */
function assetRowWithNestedSecrets() {
  return {
    id: "a1",
    hostname: "sw-01",
    lastSeen: new Date("2026-08-01T12:00:00Z"),
    monitorCredential: {
      id: "c1",
      type: "snmp",
      config: { version: "2c", community: seal("public-ish") },
    },
    discoveredByIntegration: {
      id: "i1",
      type: "fortigate",
      config: { host: "10.0.0.1", apiToken: seal("fg-token") },
    },
  };
}

describe("transformSecretFields — nested relation payloads", () => {
  it("opens secrets nested behind a relation, not just at the blob root", () => {
    const out = transformSecretFields(
      assetRowWithNestedSecrets(), open, 0, RESULT_WALK_DEPTH,
    ) as ReturnType<typeof assetRowWithNestedSecrets>;
    expect(out.monitorCredential.config.community).toBe("public-ish");
    expect(out.discoveredByIntegration.config.apiToken).toBe("fg-token");
  });

  it("reaches a secret through an array of rows with a two-hop relation", () => {
    // The shape reservationService reads: subnet → integration → config.
    const rows = [
      { id: "r1", subnet: { id: "s1", integration: { config: { apiToken: seal("t1") } } } },
      { id: "r2", subnet: { id: "s2", integration: null } },
    ];
    const out = transformSecretFields(rows, open, 0, RESULT_WALK_DEPTH) as typeof rows;
    expect(out[0]!.subnet.integration!.config.apiToken).toBe("t1");
    expect(out[1]!.subnet.integration).toBeNull();
  });

  it("leaves the default blob-sized depth budget in place for write args", () => {
    // sealArgsData walks a config blob only and keeps the tighter budget; the
    // result walk opts into the deeper one because relation hops stack up first.
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    let deep: Record<string, unknown> = { community: "x" };
    for (const k of keys.reverse()) deep = { [k]: deep };
    const dig = (o: any) => keys.reduce((acc) => acc[Object.keys(acc)[0]!], o).community;

    expect(dig(transformSecretFields(deep, seal))).toBe("x"); // past the budget: untouched
    expect(dig(transformSecretFields(deep, seal, 0, RESULT_WALK_DEPTH))).toBe("SEALED(x)");
  });
});

describe("transformSecretFields — walks past non-plain objects intact", () => {
  it("preserves Date instances rather than rebuilding them as {}", () => {
    const out = transformSecretFields(
      assetRowWithNestedSecrets(), open, 0, RESULT_WALK_DEPTH,
    ) as ReturnType<typeof assetRowWithNestedSecrets>;
    expect(out.lastSeen).toBeInstanceOf(Date);
    expect(out.lastSeen.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("preserves Buffers and class instances", () => {
    class Decimalish { constructor(public readonly n: string) {} }
    const row = {
      blob: Buffer.from("binary"),
      amount: new Decimalish("1.5"),
      config: { password: seal("pw") },
    };
    const out = transformSecretFields(row, open, 0, RESULT_WALK_DEPTH) as typeof row;
    expect(Buffer.isBuffer(out.blob)).toBe(true);
    expect(out.blob.toString()).toBe("binary");
    expect(out.amount).toBeInstanceOf(Decimalish);
    expect(out.amount.n).toBe("1.5");
    expect(out.config.password).toBe("pw");
  });

  it("never mutates its input — Prisma shares args and results with the caller", () => {
    const row = assetRowWithNestedSecrets();
    transformSecretFields(row, open, 0, RESULT_WALK_DEPTH);
    expect(row.monitorCredential.config.community).toBe(seal("public-ish"));
  });
});

describe("containsSecretField — the allocation-free pre-scan", () => {
  it("agrees with the transform about whether there is work to do", () => {
    expect(containsSecretField(assetRowWithNestedSecrets(), isSealed)).toBe(true);
    expect(containsSecretField({ id: "a", hostname: "sw-01", lastSeen: new Date() }, isSealed)).toBe(false);
  });

  it("ignores secret-named keys that are not sealed, so plaintext rows skip the rebuild", () => {
    expect(containsSecretField({ config: { community: "plaintext" } }, isSealed)).toBe(false);
  });

  it("ignores sealed-looking values under a non-secret key", () => {
    expect(containsSecretField({ config: { description: seal("not-a-secret") } }, isSealed)).toBe(false);
  });

  it("does not descend into non-plain objects", () => {
    class Weird { get community() { return seal("boom"); } }
    expect(containsSecretField({ x: new Weird() }, isSealed)).toBe(false);
  });

  it("terminates on a self-referential structure instead of recursing forever", () => {
    const loop: Record<string, unknown> = { id: "x" };
    loop.self = loop;
    expect(() => containsSecretField(loop, isSealed)).not.toThrow();
    expect(containsSecretField(loop, isSealed)).toBe(false);
  });
});

describe("secret-bearing model map", () => {
  it("maps Setting to `value` and the config-shaped models to `config`", () => {
    expect(secretJsonFieldFor("Setting")).toBe("value");
    for (const m of SECRET_BEARING_MODELS) {
      if (m === "Setting") continue;
      expect(secretJsonFieldFor(m)).toBe("config");
    }
    expect(secretJsonFieldFor("Asset")).toBeNull();
  });

  it("covers the secret keys each masking layer already knows about", () => {
    // Cross-check against the per-type masking lists this set is derived from —
    // a field masked on read but missing here is stored in the clear.
    for (const k of ["community", "authKey", "privKey", "password", "privateKey",
                     "apiToken", "fortigateApiToken", "clientSecret", "bindPassword",
                     "accessToken", "webhookUrl", "passphrase", "signingKey"]) {
      expect(SECRET_CONFIG_KEYS.has(k)).toBe(true);
    }
  });

  // The three places that name the secret-bearing tables must agree. db.ts
  // seals on write and opens on read; the backfill seals rows written before a
  // key was set; SECRET_BEARING_MODELS / secretJsonFieldFor is the declared
  // list. A table added to one and not the others is either stored in the clear
  // (no write hook), left in the clear on an existing install (no backfill), or
  // sealed by the backfill and then never opened on read (no read hook). Read
  // as source text: the hooks are inside a Prisma $extends call and the
  // backfill's tables are inline findMany calls, neither exported.
  it("db.ts hooks, the backfill job and SECRET_BEARING_MODELS name the same tables and columns", () => {
    const camel = (m: string) => m[0].toLowerCase() + m.slice(1);
    const declared = new Map([...SECRET_BEARING_MODELS].map((m) => [camel(m), secretJsonFieldFor(m)]));

    const dbSrc = readFileSync(resolve(__dirname, "../../src/db.ts"), "utf8");
    const hooked = new Map([...dbSrc.matchAll(/^\s*(\w+): secretHooks\("(\w+)"\)/gm)].map((m) => [m[1], m[2]]));

    const jobSrc = readFileSync(resolve(__dirname, "../../src/jobs/backfillSecretEncryption.ts"), "utf8");
    const backfilled = new Map(
      [...jobSrc.matchAll(/prismaBase\.(\w+)\.findMany\(\{ select: \{ \w+: true, (\w+): true \} \}\)/g)]
        .map((m) => [m[1], m[2]]),
    );

    expect(declared.size).toBeGreaterThan(0);
    expect(Object.fromEntries(hooked)).toEqual(Object.fromEntries(declared));
    expect(Object.fromEntries(backfilled)).toEqual(Object.fromEntries(declared));
  });
});
