// @vitest-environment jsdom
// "Floor plan from map" with a vector basemap (#467): the view is rendered
// offscreen by MapLibre (stubbed here - jsdom has no WebGL), drawn into the
// same image with the attribution, and falls back to raster tiles when the
// vector render can't run.
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SiteMapPayload } from "@/lib/api"

import { renderPlanImage } from "./plan-from-map-dialog"
import {
  MAX_VECTOR_EDGE,
  MIN_IMAGE_EDGE,
  renderMapImage,
  TileReadError,
  vectorImageSize,
} from "./plan-from-map"

const TILES: SiteMapPayload["tiles"] = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "raster credit",
  osm_default: true,
  satellite: { url: "https://sat.example/{z}/{y}/{x}", attribution: "Esri" },
  basemap: "vector",
  vector: {
    url: "https://vector.openstreetmap.org/shortbread_v1/tilejson.json",
    attribution: "&copy; OpenStreetMap contributors",
    osm_default: true,
  },
  labels: "en",
}

// Dubai Marina, one block.
const b = { south: 25.08, west: 55.14, north: 25.082, east: 55.143 }

function stubCanvas() {
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: () => ({ width: 100 }),
    font: "",
    fillStyle: "",
    textBaseline: "",
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  )
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
    type?: string
  ) {
    cb(new Blob(["x"], { type }))
  })
  return ctx
}

afterEach(() => vi.restoreAllMocks())

describe("vectorImageSize", () => {
  it("keeps the box's shape between the minimum and MapLibre's canvas limit", () => {
    const small = vectorImageSize(b, 15)
    expect(Math.max(small.width, small.height)).toBe(MIN_IMAGE_EDGE)
    const big = vectorImageSize(
      { south: 25, west: 55, north: 25.2, east: 55.4 },
      18
    )
    expect(Math.max(big.width, big.height)).toBe(MAX_VECTOR_EDGE)
    expect(big.zoom).toBeLessThan(18)
    expect(small.width / small.height).toBeCloseTo(big.width / big.height, 0)
  })
})

describe("renderMapImage with vector tiles", () => {
  it("draws the vector render and the attribution into one image", async () => {
    const ctx = stubCanvas()
    const img = {} as CanvasImageSource
    const vector = vi.fn(async () => img)
    const load = vi.fn()
    const out = await renderMapImage({
      bbox: b,
      mapZoom: 17,
      template: TILES.url,
      attribution: "&copy; OpenStreetMap contributors",
      load,
      vector,
    })
    const size = vectorImageSize(b, 17)
    expect(vector).toHaveBeenCalledWith(b, size.width, size.height)
    expect(load).not.toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalledWith(
      img,
      0,
      0,
      size.width,
      size.height
    )
    expect(ctx.fillText).toHaveBeenCalledWith(
      "© OpenStreetMap contributors",
      expect.any(Number),
      expect.any(Number)
    )
    expect(out).toMatchObject({ width: size.width, height: size.height })
    expect(out.blob.type).toBe("image/png")
  })

  it("reports a failed vector render as unreadable tiles", async () => {
    stubCanvas()
    await expect(
      renderMapImage({
        bbox: b,
        mapZoom: 17,
        template: TILES.url,
        attribution: "",
        vector: async () => {
          throw new Error("context lost")
        },
      })
    ).rejects.toBeInstanceOf(TileReadError)
  })
})

describe("renderPlanImage", () => {
  const args = {
    bbox: b,
    mapZoom: 17,
    template: TILES.url,
    attribution: TILES.attribution,
  }

  it("renders the street map from vector tiles in the user's language", async () => {
    const ctx = stubCanvas()
    const renderVectorBox = vi.fn(async () => document.createElement("canvas"))
    const loadVector = vi.fn(async () => ({ renderVectorBox }) as never)
    await renderPlanImage(TILES, "map", args, { webgl: () => true, loadVector })
    expect(renderVectorBox).toHaveBeenCalledWith(
      expect.objectContaining({ url: TILES.vector!.url, labels: "en", bbox: b })
    )
    // The vector credit, not the raster one.
    expect(ctx.fillText.mock.calls[0][0]).toBe("© OpenStreetMap contributors")
  })

  it("uses the raster tiles without WebGL, for satellite, and after a failed render", async () => {
    stubCanvas()
    const loadVector = vi.fn(async () => {
      throw new TileReadError()
    })
    for (const [basemap, webgl] of [
      ["map", false],
      ["sat", true],
      ["map", true],
    ] as const) {
      const load = vi.fn(async () => ({}) as CanvasImageSource)
      await renderPlanImage(
        TILES,
        basemap,
        { ...args, load },
        { webgl: () => webgl, loadVector: loadVector as never }
      )
      expect(load).toHaveBeenCalled()
    }
    // Only the WebGL street map tried the vector render.
    expect(loadVector).toHaveBeenCalledTimes(1)
  })
})
