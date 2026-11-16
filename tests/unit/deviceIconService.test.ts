/**
 * tests/unit/deviceIconService.test.ts — services/deviceIconService.ts,
 * operator-uploaded device icons for the Device Map.
 *
 * The contract (polaris-change-impact → settings-platform.md): keys are
 * `<canonical manufacturer>/<type lowercased | model as typed>`, the
 * manufacturer half through the alias map at upload AND at resolution; the
 * type must be in the live asset-type registry; PNG / JPEG / WebP / SVG only,
 * 256 KB raster / 32 KB SVG; a raster's magic bytes must match its declared
 * type; an SVG is refused on any SVG_REJECT_PATTERNS match (the security
 * boundary) and is stored rasterized to a 512 px PNG; upload upserts on
 * (scope, key); resolution is most-specific-wins (model → type → null) and
 * needs a manufacturer. updateIconKey is pinned by deviceIconUpdateKey.test.ts.
 *
 * Prisma is the shared stub; @resvg/resvg-js (native) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  resvgCtor: vi.fn(),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    constructor(data: unknown, opts: unknown) { h.resvgCtor(data, opts); }
    render() { return { asPng: () => h.png }; }
  },
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { setAliasMap, _resetAliasMap } from "../../src/utils/manufacturerNormalize.js";
import { setAssetTypeRegistry, BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";
import {
  uploadIcon, listIcons, getIconImage, deleteIcon, loadIconResolutionCache, resolveIconUrl, type UploadedIcon,
} from "../../src/services/deviceIconService.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVEfmt ")]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

function input(over: Partial<UploadedIcon> = {}): UploadedIcon {
  return { scope: "manufacturer-type", manufacturer: "Fortinet", typeOrModel: "firewall", filename: "fgt.png", mimeType: "image/png", data: PNG, ...over };
}
const svgInput = (svg: string, over: Partial<UploadedIcon> = {}) =>
  input({ mimeType: "image/svg+xml", filename: "logo.svg", data: Buffer.from(svg, "utf8"), ...over });

const UPLOADED_AT = new Date("2026-11-01T00:00:00Z");

beforeEach(() => {
  resetDbStub();
  h.resvgCtor.mockReset();
  _resetAliasMap();
  setAliasMap([["Fortinet, Inc.", "Fortinet"], ["fortinet inc", "Fortinet"], ["nobody", ""]]);
  setAssetTypeRegistry([
    ...BUILT_IN_ASSET_TYPES.map((n) => ({ name: n, label: n, isBuiltIn: true })),
    { name: "ups", label: "UPS", isBuiltIn: false },
  ]);
  stubbed(prisma.deviceIcon.upsert).mockImplementation(async (args: { create: Record<string, unknown> }) => ({
    id: "icon-1", uploadedAt: UPLOADED_AT, ...args.create,
  }));
});

const upsertArgs = () => stubbed(prisma.deviceIcon.upsert).mock.calls[0][0];

// ─── uploadIcon — keys ─────────────────────────────────────────────────────

describe("uploadIcon — the key", () => {
  it("upserts on (scope, key) with the alias-canonical manufacturer and a lowercased type, and returns the summary without bytes", async () => {
    const out = await uploadIcon(input({ manufacturer: "  Fortinet, Inc. ", typeOrModel: " Firewall ", uploadedBy: "alice" }));
    const args = upsertArgs();
    expect(args.where).toEqual({ scope_key: { scope: "manufacturer-type", key: "Fortinet/firewall" } });
    expect(args.create).toMatchObject({ scope: "manufacturer-type", key: "Fortinet/firewall", filename: "fgt.png", mimeType: "image/png", size: PNG.length, uploadedBy: "alice" });
    expect(args.create.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(args.create.data).equals(PNG)).toBe(true);
    expect(args.update).toMatchObject({ filename: "fgt.png", mimeType: "image/png", size: PNG.length, uploadedBy: "alice", uploadedAt: expect.any(Date) });
    expect(out).toEqual({ id: "icon-1", scope: "manufacturer-type", key: "Fortinet/firewall", filename: "fgt.png", mimeType: "image/png", size: PNG.length, uploadedBy: "alice", uploadedAt: UPLOADED_AT });
    expect("data" in out).toBe(false);
  });

  it("keeps a model tail as typed (trimmed), and uploadedBy defaults to null", async () => {
    await uploadIcon(input({ scope: "manufacturer-model", manufacturer: "fortinet inc", typeOrModel: "  FortiGate-60F " }));
    expect(upsertArgs().where.scope_key).toEqual({ scope: "manufacturer-model", key: "Fortinet/FortiGate-60F" });
    expect(upsertArgs().create.uploadedBy).toBeNull();
    expect(upsertArgs().update.uploadedBy).toBeNull();
  });

  it("a manufacturer with no alias is kept as typed (trimmed)", async () => {
    await uploadIcon(input({ manufacturer: " APC " , typeOrModel: "ups" }));
    expect(upsertArgs().where.scope_key.key).toBe("APC/ups");
  });

  it("accepts a custom asset type from the live registry", async () => {
    await expect(uploadIcon(input({ typeOrModel: "UPS" }))).resolves.toMatchObject({ key: "Fortinet/ups" });
  });

  it("refuses a bad scope, a blank manufacturer or tail, and an unknown type — 400, nothing stored", async () => {
    for (const bad of [
      input({ scope: "manufacturer" as never }),
      input({ manufacturer: "" }),
      input({ manufacturer: "   " }),
      input({ manufacturer: "nobody" }), // alias collapses it to ""
      input({ typeOrModel: "" }),
      input({ scope: "manufacturer-model", typeOrModel: "  " }),
      input({ typeOrModel: "toaster" }),
    ]) {
      await expect(uploadIcon(bad)).rejects.toMatchObject({ httpStatus: 400 });
    }
    expect(prisma.deviceIcon.upsert).not.toHaveBeenCalled();
  });

  it("names what is missing", async () => {
    await expect(uploadIcon(input({ typeOrModel: "" }))).rejects.toThrow("Asset type is required");
    await expect(uploadIcon(input({ scope: "manufacturer-model", typeOrModel: "" }))).rejects.toThrow("Model is required");
    await expect(uploadIcon(input({ manufacturer: "nobody" }))).rejects.toThrow("Manufacturer is required");
    await expect(uploadIcon(input({ typeOrModel: "toaster" }))).rejects.toThrow(/Invalid asset type "toaster"/);
  });
});

// ─── uploadIcon — raster validation ────────────────────────────────────────

describe("uploadIcon — raster images", () => {
  it("accepts PNG, JPEG and WebP whose bytes match the declared type, storing them as sent", async () => {
    for (const [mimeType, data] of [["image/png", PNG], ["image/jpeg", JPEG], ["image/webp", WEBP]] as const) {
      resetDbStub();
      stubbed(prisma.deviceIcon.upsert).mockImplementation(async (a: { create: Record<string, unknown> }) => ({ id: "i", uploadedAt: UPLOADED_AT, ...a.create }));
      await expect(uploadIcon(input({ mimeType, data }))).resolves.toMatchObject({ mimeType });
      expect(Buffer.from(upsertArgs().create.data).equals(data)).toBe(true);
    }
    expect(h.resvgCtor).not.toHaveBeenCalled();
  });

  it("refuses an unsupported format, an empty file, and bytes that are no known image", async () => {
    await expect(uploadIcon(input({ mimeType: "image/gif", data: Buffer.from("GIF89a") }))).rejects.toThrow(/Unsupported image format "image\/gif"/);
    await expect(uploadIcon(input({ data: Buffer.alloc(0) }))).rejects.toThrow("Empty file upload");
    await expect(uploadIcon(input({ data: Buffer.from("not an image at all") }))).rejects.toThrow(/doesn't look like a valid PNG/);
    await expect(uploadIcon(input({ data: PNG.subarray(0, 4) }))).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses bytes of one format declared as another", async () => {
    await expect(uploadIcon(input({ mimeType: "image/jpeg", data: PNG }))).rejects.toThrow("File contents are image/png but upload declared image/jpeg");
    await expect(uploadIcon(input({ mimeType: "image/png", data: WEBP }))).rejects.toThrow("File contents are image/webp but upload declared image/png");
  });

  it("caps a raster at 256 KB (inclusive)", async () => {
    const at = Buffer.concat([PNG, Buffer.alloc(256 * 1024 - PNG.length)]);
    await expect(uploadIcon(input({ data: at }))).resolves.toBeTruthy();
    await expect(uploadIcon(input({ data: Buffer.concat([at, Buffer.alloc(1)]) }))).rejects.toThrow(/Icon too large \(262145 bytes; max 262144 for raster\)/);
  });

  // Was a bug until 2026-11-14: detectMagicMime checks only "RIFF" for image/webp (MAGIC_BYTES), although
  // its own comment says the signature is "RIFF....WEBP" and the contract says
  // a raster "requires magic-byte prefix matching declared mimeType". Input: a
  // RIFF WAVE (or AVI) file declared image/webp. Wrong: accepted and stored as
  // an icon. Right: 400 "doesn't look like a valid PNG / JPEG / WebP image" —
  // bytes 8..11 must read "WEBP".
  it("refuses a RIFF file that is not WebP (a WAV) declared as image/webp", async () => {
    await expect(uploadIcon(input({ mimeType: "image/webp", data: WAV }))).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.deviceIcon.upsert).not.toHaveBeenCalled();
  });
});

// ─── uploadIcon — SVG ──────────────────────────────────────────────────────

describe("uploadIcon — SVG", () => {
  it("rasterizes a clean SVG to a 512 px-wide PNG and stores it as image/png with a .png name", async () => {
    const out = await uploadIcon(svgInput(SVG, { filename: "Logo.SVG" }));
    expect(h.resvgCtor).toHaveBeenCalledTimes(1);
    expect(h.resvgCtor.mock.calls[0][1]).toEqual({ fitTo: { mode: "width", value: 512 } });
    const args = upsertArgs();
    expect(args.create).toMatchObject({ mimeType: "image/png", filename: "Logo.png", size: h.png.length });
    expect(Array.from(args.create.data)).toEqual(Array.from(h.png));
    expect(args.update).toMatchObject({ mimeType: "image/png", filename: "Logo.png", size: h.png.length });
    expect(out.mimeType).toBe("image/png");
  });

  it("a name without .svg gets .png appended", async () => {
    await uploadIcon(svgInput(SVG, { filename: "logo" }));
    expect(upsertArgs().create.filename).toBe("logo.png");
  });

  it("accepts a BOM, leading whitespace and an XML prolog", async () => {
    await expect(uploadIcon(svgInput(`${String.fromCharCode(0xfeff)} \n<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`))).resolves.toBeTruthy();
  });

  it("keeps in-document references: <use href=\"#id\"> and url(#gradient)", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><use xlink:href="#g"/></svg>';
    await expect(uploadIcon(svgInput(svg))).resolves.toBeTruthy();
  });

  it("refuses a file that is not an SVG, and a prolog with no <svg> element", async () => {
    await expect(uploadIcon(svgInput("<html><body/></html>"))).rejects.toThrow(/doesn't look like an SVG/);
    await expect(uploadIcon(svgInput("hello"))).rejects.toThrow(/doesn't look like an SVG/);
    await expect(uploadIcon(svgInput('<?xml version="1.0"?><note/>'))).rejects.toThrow("SVG payload missing <svg> root element");
  });

  it("refuses every dynamic or external construct (the security boundary), naming it", async () => {
    const wrap = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`;
    const cases: Array<[string, string]> = [
      [wrap("<script>alert(1)</script>"), "<script>"],
      [wrap("< SCRIPT src=x></script>"), "<script>"],
      [wrap("<foreignObject><div/></foreignObject>"), "<foreignObject>"],
      [wrap("<iframe/>"), "<iframe>"],
      [wrap("<object/>"), "<object>"],
      [wrap("<embed/>"), "<embed>"],
      [`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>${wrap("")}`, "<!DOCTYPE>"],
      [`<?xml version="1.0"?><!ENTITY x "y">${wrap("")}`, "<!ENTITY>"],
      [`<?xml version="1.0"?><?xml-stylesheet href="#s"?>${wrap("")}`, "xml-stylesheet PI"],
      [wrap("", ' onload="alert(1)"'), "on*= event handler"],
      [wrap('<rect\nonclick = "x"/>'), "on*= event handler"],
      [wrap('<a href="javascript:alert(1)"/>'), "javascript: URL"],
      [wrap("<a href='&#9;javascript:alert(1)'/>"), "javascript: URL"],
      // An entity-escaped first letter slips past the javascript: pattern but
      // not the external-href one (anything not starting with "#").
      [wrap("<a href=' &#x6A;avascript:alert(1)'/>"), "external href"],
      [wrap('<a xlink:href="j a v a s c r i p t:x"/>'), "javascript: URL"],
      [wrap('<image href="https://evil.example/x.png"/>'), "external href"],
      [wrap('<image xlink:href="data:image/png;base64,AAAA"/>'), "external href"],
      [wrap('<use href="//evil.example/a.svg#x"/>'), "external href"],
      [wrap("<style>@import 'x.css';</style>"), "@import in <style>"],
      [wrap("<rect style=\"fill:url('https://evil.example/p')\"/>"), "external url() in CSS"],
      [wrap("<rect style=\"fill:url(data:image/png;base64,AA)\"/>"), "external url() in CSS"],
    ];
    for (const [svg, name] of cases) {
      const err = await uploadIcon(svgInput(svg)).catch((e) => e);
      expect(err, svg).toMatchObject({ httpStatus: 400 });
      expect(err.message, svg).toContain(`contains ${name}`);
    }
    expect(h.resvgCtor).not.toHaveBeenCalled();
    expect(prisma.deviceIcon.upsert).not.toHaveBeenCalled();
  });

  it("caps an SVG at 32 KB (inclusive), before parsing it", async () => {
    const pad = (n: number) => SVG.replace("</svg>", `<!--${"x".repeat(n)}--></svg>`);
    const at = pad(32 * 1024 - Buffer.byteLength(SVG) - 7);
    expect(Buffer.byteLength(at)).toBe(32 * 1024);
    await expect(uploadIcon(svgInput(at))).resolves.toBeTruthy();
    await expect(uploadIcon(svgInput(at + " "))).rejects.toThrow(/max 32768 for SVG/);
  });

  it("an SVG resvg cannot parse is a 400 naming the parser's complaint", async () => {
    h.resvgCtor.mockImplementation(() => { throw new Error("unexpected end of stream"); });
    await expect(uploadIcon(svgInput(SVG))).rejects.toMatchObject({ httpStatus: 400, message: "SVG could not be parsed: unexpected end of stream" });
    expect(prisma.deviceIcon.upsert).not.toHaveBeenCalled();
  });
});

// ─── list / get / delete ───────────────────────────────────────────────────

describe("listIcons / getIconImage / deleteIcon", () => {
  it("lists without the image bytes, ordered by scope then key", async () => {
    const rows = [{ id: "a", scope: "manufacturer-model", key: "APC/SMT1500", filename: "a.png", mimeType: "image/png", size: 1, uploadedBy: null, uploadedAt: UPLOADED_AT }];
    stubbed(prisma.deviceIcon.findMany).mockResolvedValue(rows);
    expect(await listIcons()).toEqual(rows);
    const args = stubbed(prisma.deviceIcon.findMany).mock.calls[0][0];
    expect(args.select.data).toBeUndefined();
    expect(args.select).toMatchObject({ id: true, scope: true, key: true, size: true });
    expect(args.orderBy).toEqual([{ scope: "asc" }, { key: "asc" }]);
  });

  it("returns an icon's bytes as a Buffer with its type, or null", async () => {
    stubbed(prisma.deviceIcon.findUnique).mockResolvedValueOnce({ mimeType: "image/png", data: new Uint8Array([1, 2, 3]) });
    const img = await getIconImage("icon-1");
    expect(img?.mimeType).toBe("image/png");
    expect(Buffer.isBuffer(img?.data)).toBe(true);
    expect([...img!.data]).toEqual([1, 2, 3]);
    expect(stubbed(prisma.deviceIcon.findUnique).mock.calls[0][0]).toEqual({ where: { id: "icon-1" }, select: { mimeType: true, data: true } });
    stubbed(prisma.deviceIcon.findUnique).mockResolvedValueOnce(null);
    expect(await getIconImage("missing")).toBeNull();
  });

  it("delete answers true, and false when the row could not be deleted", async () => {
    stubbed(prisma.deviceIcon.delete).mockResolvedValueOnce({});
    expect(await deleteIcon("icon-1")).toBe(true);
    expect(stubbed(prisma.deviceIcon.delete).mock.calls[0][0]).toEqual({ where: { id: "icon-1" } });
    stubbed(prisma.deviceIcon.delete).mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "P2025" }));
    expect(await deleteIcon("gone")).toBe(false);
  });

  it("deleteIcon rethrows anything other than not-found", async () => {
    // Was a bug until 2026-11-16: a DB outage answered false (reported as not found).
    stubbed(prisma.deviceIcon.delete).mockRejectedValueOnce(new Error("connection refused"));
    await expect(deleteIcon("icon-1")).rejects.toThrow("connection refused");
  });
});

// ─── resolution ────────────────────────────────────────────────────────────

describe("loadIconResolutionCache / resolveIconUrl", () => {
  async function cacheOf(rows: Array<{ id: string; scope: string; key: string }>) {
    stubbed(prisma.deviceIcon.findMany).mockResolvedValue(rows);
    return loadIconResolutionCache();
  }

  it("loads every icon once, keyed scope|key, selecting no bytes", async () => {
    const cache = await cacheOf([{ id: "m", scope: "manufacturer-model", key: "Fortinet/FortiGate-60F" }, { id: "t", scope: "manufacturer-type", key: "Fortinet/firewall" }]);
    expect([...cache.entries()]).toEqual([["manufacturer-model|Fortinet/FortiGate-60F", "m"], ["manufacturer-type|Fortinet/firewall", "t"]]);
    expect(stubbed(prisma.deviceIcon.findMany).mock.calls[0][0]).toEqual({ select: { id: true, scope: true, key: true } });
  });

  it("most specific wins: the model icon over the type icon, the type icon when the model has none", async () => {
    const cache = await cacheOf([{ id: "m", scope: "manufacturer-model", key: "Fortinet/FortiGate-60F" }, { id: "t", scope: "manufacturer-type", key: "Fortinet/firewall" }]);
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: "FortiGate-60F", assetType: "firewall" }, cache)).toBe("/api/v1/device-icons/m/image");
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: "FortiGate-100F", assetType: "firewall" }, cache)).toBe("/api/v1/device-icons/t/image");
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: null, assetType: "firewall" }, cache)).toBe("/api/v1/device-icons/t/image");
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: "FortiGate-100F", assetType: null }, cache)).toBeNull();
  });

  it("canonicalizes the asset's manufacturer through the alias map, lowercases its type and trims its model", async () => {
    const cache = await cacheOf([{ id: "m", scope: "manufacturer-model", key: "Fortinet/FortiGate-60F" }, { id: "t", scope: "manufacturer-type", key: "Fortinet/firewall" }]);
    expect(resolveIconUrl({ manufacturer: " Fortinet, Inc. ", model: " FortiGate-60F ", assetType: null }, cache)).toBe("/api/v1/device-icons/m/image");
    expect(resolveIconUrl({ manufacturer: "FORTINET INC", model: null, assetType: " Firewall " }, cache)).toBe("/api/v1/device-icons/t/image");
  });

  it("a model matches as typed (case-sensitive, as it is stored)", async () => {
    const cache = await cacheOf([{ id: "m", scope: "manufacturer-model", key: "Fortinet/FortiGate-60F" }]);
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: "fortigate-60f", assetType: null }, cache)).toBeNull();
  });

  it("no manufacturer, no icon — there is no vendor-less fallback", async () => {
    const cache = await cacheOf([{ id: "t", scope: "manufacturer-type", key: "/firewall" }, { id: "t2", scope: "manufacturer-type", key: "Fortinet/firewall" }]);
    for (const manufacturer of [null, "", "   "]) {
      expect(resolveIconUrl({ manufacturer, model: "X", assetType: "firewall" }, cache)).toBeNull();
    }
  });

  it("an empty cache resolves nothing", () => {
    expect(resolveIconUrl({ manufacturer: "Fortinet", model: "FortiGate-60F", assetType: "firewall" }, new Map())).toBeNull();
  });

  it("an uploaded key is exactly what resolution looks for (one canonical form both ways)", async () => {
    await uploadIcon(input({ manufacturer: "Fortinet, Inc.", typeOrModel: " Firewall " }));
    const { scope, key } = upsertArgs().where.scope_key;
    const cache = await cacheOf([{ id: "up", scope, key }]);
    expect(resolveIconUrl({ manufacturer: "fortinet inc", model: "unknown", assetType: "FIREWALL" }, cache)).toBe("/api/v1/device-icons/up/image");
  });
});
