import { afterEach, describe, expect, it, vi } from "vitest"

import { fabric } from "./__fixtures__/fabric"
import { base64, inlinePhotos, MAX_PIXELS, rasterSize, svgSize } from "./png"
import { toSvg } from "./svg"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("rasterSize", () => {
  it("scales a small drawing as asked", () => {
    expect(rasterSize(600, 400, 2)).toEqual({
      width: 1200,
      height: 800,
      scale: 2,
    })
  })

  it("steps the scale down to the pixel cap", () => {
    const r = rasterSize(6000, 4000, 3)
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_PIXELS)
    expect(r.scale).toBeLessThan(1)
    expect(r.width / r.height).toBeCloseTo(1.5, 2)
  })

  it("keeps the longest side in range", () => {
    const r = rasterSize(40000, 100, 1, Infinity)
    expect(r.width).toBeLessThanOrEqual(16384)
  })
})

describe("svgSize", () => {
  it("reads the writer's root size", () => {
    const b = fabric.bounds
    expect(svgSize(toSvg(fabric))).toEqual({ w: b.w + 48, h: b.h + 48 })
  })
})

describe("base64", () => {
  it("matches the platform encoder, past the chunk size", () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 7) % 256)
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
  })
})

describe("inlinePhotos", () => {
  const withPhoto = (href: string) => ({
    ...fabric,
    nodes: fabric.nodes.map((n) =>
      n.photo ? { ...n, photo: { ...n.photo, href } } : n
    ),
  })

  it("leaves a document without external photos alone", async () => {
    expect(await inlinePhotos(fabric)).toBe(fabric)
  })

  it("turns a fetched photo into a data: URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          })
      )
    )
    const out = await inlinePhotos(withPhoto("/media/device-type-images/a.png"))
    const photo = out.nodes.find((n) => n.id === "dev:patch-a")!
    expect(photo.photo!.href).toBe("data:image/png;base64,AQID")
  })

  it("draws a photo that will not load as its card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    )
    const out = await inlinePhotos(withPhoto("/media/missing.png"))
    const node = out.nodes.find((n) => n.id === "dev:patch-a")!
    expect(node.kind).toBe("card")
    expect(node.photo).toBeUndefined()
  })
})
