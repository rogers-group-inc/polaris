/**
 * tests/unit/mibUploadLimit.test.ts
 *
 * The MIB size ceiling and how an oversized upload is reported.
 *
 * The cap was 1 MB on the assumption that MIBs are under 100 KB. APC/Schneider
 * ship PowerNet-MIB as one ~3 MB module, so a UPS could not get its battery
 * objects into Polaris at all — and because multer's LIMIT_FILE_SIZE fell
 * through to the generic handler, the operator saw "Internal server error".
 */

import { describe, it, expect, vi } from "vitest";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { parseMib, MIB_MAX_BYTES } from "../../src/services/mibService.js";
import { errorHandler } from "../../src/api/middleware/errorHandler.js";
import { AppError } from "../../src/utils/errors.js";

/** A syntactically valid module padded with comment lines to `bytes`. */
function moduleOfSize(bytes: number): string {
  const head = "BIG-TEST-MIB DEFINITIONS ::= BEGIN\nIMPORTS enterprises FROM RFC1155-SMI;\nbigTest OBJECT IDENTIFIER ::= { enterprises 99999 }\n";
  const tail = "END\n";
  const line = "-- padding padding padding padding padding padding padding padding\n";
  let body = "";
  while (head.length + body.length + tail.length + line.length <= bytes) body += line;
  return head + body + tail;
}

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown } as { statusCode: number; body: unknown; status: (n: number) => unknown; json: (b: unknown) => unknown };
  res.status = (n: number) => { res.statusCode = n; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe("parseMib size ceiling", () => {
  it("accepts a module the size of APC PowerNet-MIB (~3 MB)", () => {
    const parsed = parseMib(moduleOfSize(3 * 1024 * 1024));
    expect(parsed.moduleName).toBe("BIG-TEST-MIB");
  });

  it("stays below the shipped nginx client_max_body_size (8m)", () => {
    expect(MIB_MAX_BYTES).toBeLessThan(8 * 1024 * 1024);
  });

  it("rejects a module over the ceiling with a 413 that names the limit", () => {
    let thrown: unknown;
    try { parseMib(moduleOfSize(MIB_MAX_BYTES + 1024)); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).httpStatus).toBe(413);
    expect((thrown as AppError).message).toMatch(/MIB files are limited to 6 MiB/);
  });
});

describe("errorHandler — multer rejections", () => {
  const next = vi.fn() as unknown as NextFunction;

  it("answers LIMIT_FILE_SIZE as a JSON 413, not a 500", () => {
    const res = fakeRes();
    errorHandler(new multer.MulterError("LIMIT_FILE_SIZE", "file"), {} as Request, res as unknown as Response, next);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: expect.stringMatching(/larger than this upload accepts/) });
  });

  it("answers any other multer rejection as a JSON 400", () => {
    const res = fakeRes();
    errorHandler(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "other"), {} as Request, res as unknown as Response, next);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/^Upload rejected:/);
  });
});
