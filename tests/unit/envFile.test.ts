/**
 * tests/unit/envFile.test.ts
 *
 * setEnvVar: rewrite one key of the runtime .env in place (comments and other
 * lines kept), append when absent, refuse malformed keys and newline values.
 * node:fs is replaced by an in-memory file so nothing touches the real .env.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fsState = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("../../src/utils/paths.js", () => ({ ENV_FILE: "/virtual/.env" }));
vi.mock("node:fs", () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    const v = fsState.files.get(p);
    if (v === undefined) throw new Error("ENOENT");
    return v;
  },
  writeFileSync: (p: string, data: string) => { fsState.files.set(p, data); },
}));

import { setEnvVar } from "../../src/utils/envFile.js";

const ENV = "/virtual/.env";
const read = () => fsState.files.get(ENV);

beforeEach(() => fsState.files.clear());

describe("setEnvVar", () => {
  it("creates the file when it does not exist", () => {
    setEnvVar("METRICS_TOKEN", "abc");
    expect(read()).toBe("METRICS_TOKEN=abc\n");
  });

  it("rewrites an existing key in place and keeps comments and other lines", () => {
    fsState.files.set(ENV, "# header\nA=1\nMETRICS_TOKEN=old\nB=2\n");
    setEnvVar("METRICS_TOKEN", "new");
    expect(read()).toBe("# header\nA=1\nMETRICS_TOKEN=new\nB=2\n");
  });

  it("appends when the key is only present commented out", () => {
    fsState.files.set(ENV, "# METRICS_TOKEN=old\n");
    setEnvVar("METRICS_TOKEN", "v");
    expect(read()).toBe("# METRICS_TOKEN=old\nMETRICS_TOKEN=v\n");
  });

  it("adds the missing newline before appending to a file without a trailing one", () => {
    fsState.files.set(ENV, "A=1");
    setEnvVar("B", "2");
    expect(read()).toBe("A=1\nB=2\n");
  });

  it("does not match a key that merely shares a prefix", () => {
    fsState.files.set(ENV, "TOKEN_OLD=x\n");
    setEnvVar("TOKEN", "y");
    expect(read()).toBe("TOKEN_OLD=x\nTOKEN=y\n");
  });

  // Was a bug until 2026-11-12 (CQ-T012): a string replacement expanded $& / $` / $' / $$ in the value.
  it("writes a value containing $ literally (no replacement-pattern expansion)", () => {
    fsState.files.set(ENV, "K=old\n");
    setEnvVar("K", "a$&b");
    expect(read()).toBe("K=a$&b\n");
  });

  it("refuses malformed keys", () => {
    for (const k of ["lower", "1ABC", "A-B", "A B", "", "A=B"]) {
      expect(() => setEnvVar(k, "v")).toThrow(/malformed env key/);
    }
    expect(read()).toBeUndefined();
  });

  it("refuses values containing a newline", () => {
    expect(() => setEnvVar("K", "a\nB=evil")).toThrow(/newline/);
    expect(() => setEnvVar("K", "a\rb")).toThrow(/newline/);
    expect(read()).toBeUndefined();
  });
});
