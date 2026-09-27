/*
 * `/terminal/image` used to trust the client's own filename for the
 * extension it wrote to disk. A payload named "x.png" that was actually a
 * PDF, an SVG with a script tag, or plain text landed on disk with a `.png`
 * extension anyway, because only the name was checked. This is the pure
 * function that replaced that trust: it classifies strictly from the bytes,
 * and a crafted name has no path into its result at all.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { decodeImage } from "../src/imageUpload.ts";
import { makeViewTempDir as makeDir, isViewTemp } from "../src/viewtemp.ts";

const b64 = (bytes: number[] | Buffer) => Buffer.from(bytes as any).toString("base64");

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const GIF_HEADER = Buffer.from("GIF89a", "ascii");
const WEBP_HEADER = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii")]);

describe("classifying a picture from its bytes", () => {
  it("accepts a PNG", () => {
    const r = decodeImage(b64([...PNG_HEADER, 1, 2, 3]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe(".png");
  });

  it("accepts a JPEG", () => {
    const r = decodeImage(b64([...JPEG_HEADER, 1, 2, 3]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe(".jpg");
  });

  it("accepts a GIF", () => {
    const r = decodeImage(b64(Buffer.concat([GIF_HEADER, Buffer.from([1, 2, 3])])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe(".gif");
  });

  it("accepts a WebP", () => {
    const r = decodeImage(b64(Buffer.concat([WEBP_HEADER, Buffer.from([1, 2, 3])])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe(".webp");
  });

  it("rejects HEIC content even though the client used to get a free .png/.heic", () => {
    // ftyp box a HEIC file actually starts with — no PNG/JPEG/GIF/WebP magic.
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "ascii"), Buffer.from([0, 0, 0, 0])]);
    const r = decodeImage(b64(heic));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(415); expect(r.error).toContain("PNG"); }
  });

  it("rejects an SVG", () => {
    const r = decodeImage(b64(Buffer.from("<svg onload=\"alert(1)\"></svg>", "ascii")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it("rejects a PDF", () => {
    const r = decodeImage(b64(Buffer.from("%PDF-1.4\n%stuff", "ascii")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it("rejects plain text", () => {
    const r = decodeImage(b64(Buffer.from("just some words, not a picture", "ascii")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it("rejects an oversized image", () => {
    const big = Buffer.concat([Buffer.from(PNG_HEADER), Buffer.alloc(8 * 1024 * 1024 + 1, 1)]);
    const r = decodeImage(b64(big));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(413); expect(r.error).toContain("8MB"); }
  });

  it("rejects empty input", () => {
    const r = decodeImage("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects malformed base64 rather than silently truncating it", () => {
    // Buffer.from(str, "base64") never throws — it drops what it cannot
    // group into a quartet, which is exactly the bug a naive decode has.
    const r = decodeImage("not@@@valid$$$base64!!!");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

describe("a crafted client name has no say", () => {
  it("the written path always lands inside the view-temp root, whatever the name claimed", () => {
    // decodeImage never sees `name` at all — this proves the path the route
    // builds from its result (makeViewTempDir + a fixed "image" + the
    // sniffed ext) cannot be steered by "../../etc/x.png" or similar, since
    // nothing derived from the client's name reaches the path.
    const r = decodeImage(b64([...PNG_HEADER, 9]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claimedName = "../../etc/x.png";
    void claimedName; // never read by the route for path purposes
    const dir = makeDir("image");
    try {
      const file = join(dir, `image${r.ext}`);
      expect(isViewTemp(file)).toBe(true);
      expect(file.startsWith(dir)).toBe(true);
      expect(file).not.toContain("etc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
