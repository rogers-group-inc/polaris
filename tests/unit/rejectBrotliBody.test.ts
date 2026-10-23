import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { contentEncodingHasBrotli, rejectBrotliBody } from "../../src/api/middleware/rejectBrotliBody.js";

function app(guarded: boolean) {
  const a = express();
  if (guarded) a.use(rejectBrotliBody);
  a.use(express.json());
  a.post("/echo", (req, res) => res.json({ got: req.body }));
  return a;
}

const BODY = JSON.stringify({ hello: "world" });

describe("contentEncodingHasBrotli", () => {
  it("matches br as any listed coding, case- and space-insensitively", () => {
    expect(contentEncodingHasBrotli("br")).toBe(true);
    expect(contentEncodingHasBrotli("BR")).toBe(true);
    expect(contentEncodingHasBrotli("gzip, br")).toBe(true);
    expect(contentEncodingHasBrotli(["identity", " br "])).toBe(true);
  });

  it("does not match other codings or a substring", () => {
    expect(contentEncodingHasBrotli(undefined)).toBe(false);
    expect(contentEncodingHasBrotli("")).toBe(false);
    expect(contentEncodingHasBrotli("gzip")).toBe(false);
    expect(contentEncodingHasBrotli("x-brotli-ish")).toBe(false);
  });
});

describe("rejectBrotliBody", () => {
  it("is needed: without it, express.json() decodes a br body", async () => {
    // Pins WHY the guard exists — if body-parser ever stops decoding br on its
    // own, this fails and the guard can be reconsidered.
    const res = await request(app(false))
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .serialize((b: Buffer) => b)
      .send(brotliCompressSync(Buffer.from(BODY)));
    expect(res.status).toBe(200);
    expect(res.body.got).toEqual({ hello: "world" });
  });

  it("refuses a br body with 415 before the parser sees it", async () => {
    const res = await request(app(true))
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .serialize((b: Buffer) => b)
      .send(brotliCompressSync(Buffer.from(BODY)));
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Brotli/);
  });

  it("refuses br inside a coding list", async () => {
    const res = await request(app(true))
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip, br")
      .serialize((b: Buffer) => b)
      .send(Buffer.from("x"));
    expect(res.status).toBe(415);
  });

  it("leaves plain and gzip bodies alone", async () => {
    const plain = await request(app(true)).post("/echo").send({ hello: "world" });
    expect(plain.status).toBe(200);
    expect(plain.body.got).toEqual({ hello: "world" });

    const gz = await request(app(true))
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize((b: Buffer) => b)
      .send(gzipSync(Buffer.from(BODY)));
    expect(gz.status).toBe(200);
    expect(gz.body.got).toEqual({ hello: "world" });
  });
});
