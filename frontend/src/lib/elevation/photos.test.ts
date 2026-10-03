// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { PNG_1PX } from "./__fixtures__/rack"
import { imageSize, inlinePhotos } from "./photos"

// The photos a drawing embeds: read for their size from their own bytes,
// inlined as `data:` URIs the PDF's sanitizer accepts, within a budget.

const bytesOf = (dataUri: string) =>
  Uint8Array.from(atob(dataUri.split(",")[1]), (c) => c.charCodeAt(0))

/** The 1×1 PNG, its header saying `w`×`h`. */
function png(w: number, h: number): Uint8Array {
  const b = bytesOf(PNG_1PX)
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

const jpeg = (w: number, h: number) =>
  // SOI, an APP0 segment, then the baseline frame header.
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
  ])

const riff = (chunk: string, data: number[]) =>
  Uint8Array.from([
    ..."RIFF".split("").map((c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ..."WEBP".split("").map((c) => c.charCodeAt(0)),
    ...chunk.split("").map((c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ...data,
  ])

describe("imageSize", () => {
  it("reads PNG, JPEG, GIF and WebP headers", () => {
    expect(imageSize(png(640, 64))).toEqual({
      kind: "png",
      width: 640,
      height: 64,
    })
    expect(imageSize(jpeg(1920, 200))).toEqual({
      kind: "jpeg",
      width: 1920,
      height: 200,
    })
    expect(
      imageSize(Uint8Array.from([71, 73, 70, 56, 57, 97, 0x2c, 0x01, 0x32, 0]))
    ).toEqual({ kind: "gif", width: 300, height: 50 })
    // VP8X: 24-bit sizes less one.
    expect(
      imageSize(riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0, 0x3f, 0, 0]))
    ).toEqual({ kind: "webp", width: 640, height: 64 })
    // VP8L: 14-bit sizes less one, packed after the signature.
    const w = 639
    const h = 63
    expect(
      imageSize(
        riff("VP8L", [
          0x2f,
          w & 0xff,
          ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
          (h >> 2) & 0xff,
          (h >> 10) & 0x0f,
          0,
          0,
          0,
          0,
          0,
        ])
      )
    ).toEqual({ kind: "webp", width: 640, height: 64 })
    // VP8: after the frame tag and the start code.
    expect(
      imageSize(
        riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x40, 0x00])
      )
    ).toEqual({ kind: "webp", width: 640, height: 64 })
  })

  it("is null for anything else", () => {
    expect(imageSize(new TextEncoder().encode("<svg/>"))).toBeNull()
    expect(imageSize(new Uint8Array(0))).toBeNull()
    expect(
      imageSize(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0]))
    ).toBeNull()
  })
})

describe("inlinePhotos", () => {
  afterEach(() => vi.restoreAllMocks())

  function serve(files: Partial<Record<string, Uint8Array | number>>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      const f = files[String(url)]
      if (f === undefined || typeof f === "number")
        return Promise.resolve(new Response(null, { status: f ?? 404 }))
      return Promise.resolve(new Response(f as BodyInit))
    })
  }

  it("inlines each photo once, with its aspect, and counts the ones that won't load", async () => {
    const fetch = serve({
      "/media/a.png": png(400, 40),
      "/media/b.jpg": jpeg(100, 200),
      "/media/gone.png": 404,
      "/media/not-an-image.png": new TextEncoder().encode("<html>"),
    })
    const out = await inlinePhotos(
      new Map([
        ["/media/a.png", 300],
        ["/media/b.jpg", 50],
        ["/media/gone.png", 80],
        ["/media/not-an-image.png", 80],
      ])
    )
    expect(out.missing).toBe(2)
    expect([...out.photos.keys()].sort()).toEqual([
      "/media/a.png",
      "/media/b.jpg",
    ])
    const a = out.photos.get("/media/a.png")!
    expect(a.aspect).toBeCloseTo(0.1)
    expect(a.src).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
    expect(out.photos.get("/media/b.jpg")!.src).toMatch(
      /^data:image\/jpeg;base64,/
    )
    expect(out.photos.get("/media/b.jpg")!.aspect).toBe(2)
    // Same-origin, with the session: the media a page may see.
    expect(fetch).toHaveBeenCalledWith("/media/a.png", {
      credentials: "same-origin",
    })
    // The 404 was asked for twice, then given up.
    expect(
      fetch.mock.calls.filter(([u]) => u === "/media/gone.png")
    ).toHaveLength(2)
  })

  it("leaves out a GIF it cannot redraw, which the PDF would refuse", async () => {
    serve({
      "/media/old.gif": Uint8Array.from([71, 73, 70, 56, 57, 97, 10, 0, 10, 0]),
    })
    const out = await inlinePhotos(new Map([["/media/old.gif", 10]]))
    expect(out).toEqual({ photos: new Map(), missing: 1 })
  })

  it("keeps the drawing under its budget, the largest photos going first", async () => {
    serve({
      "/media/small.png": png(10, 10),
      "/media/big.png": Uint8Array.from([
        ...png(10, 10),
        ...new Uint8Array(3000),
      ]),
    })
    const requests = new Map([
      ["/media/small.png", 10],
      ["/media/big.png", 10],
    ])
    const all = await inlinePhotos(requests)
    const small = all.photos.get("/media/small.png")!.src.length
    const out = await inlinePhotos(requests, { budget: small + 10 })
    expect([...out.photos.keys()]).toEqual(["/media/small.png"])
    expect(out.missing).toBe(1)
  })
})
