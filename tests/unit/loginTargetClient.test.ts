// @vitest-environment happy-dom
/**
 * tests/unit/loginTargetClient.test.ts — re-scan F11. public/js/login.js reads
 * the polaris_next cookie and navigates to it after sign-in. Its guard only
 * looked at the first two characters, and the URL parser strips tab / CR / LF
 * before resolving, so "/\t/evil.example" passed the guard and left the
 * origin. `safeLoginTarget` now refuses control characters and resolves the
 * value with the URL parser, requiring the same origin and a single leading
 * slash (the server's safeNextPath rule).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "login.js"), "utf-8").replace(/\r\n/g, "\n");
const start = SRC.indexOf("function safeLoginTarget(");
const end = SRC.indexOf("\n}\n", start);
const safeLoginTarget = new Function(`${SRC.slice(start, end + 2)}\nreturn safeLoginTarget;`)() as (raw: unknown) => string;

describe("safeLoginTarget", () => {
  it("keeps a same-origin path with its query and hash", () => {
    expect(safeLoginTarget("/assets.html?id=a1#sources")).toBe("/assets.html?id=a1#sources");
    expect(safeLoginTarget("/alert-ack.html?id=n1")).toBe("/alert-ack.html?id=n1");
  });

  it("refuses control-character smuggling the URL parser would strip (F11)", () => {
    for (const raw of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\u0000x", "/\u007f/evil"]) {
      expect(safeLoginTarget(raw)).toBe("/");
    }
  });

  it("refuses everything off-origin or ambiguous", () => {
    for (const raw of ["//evil.example", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "evil", "", null, 7]) {
      expect(safeLoginTarget(raw)).toBe("/");
    }
  });

  it("never sends the user back to the login page", () => {
    expect(safeLoginTarget("/login.html")).toBe("/");
    expect(safeLoginTarget("/login.html?local=1")).toBe("/");
  });
});
