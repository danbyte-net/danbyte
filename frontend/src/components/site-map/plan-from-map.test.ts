// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import type { SiteMapOutline, SiteMapSite } from "@/lib/api"

import {
  EARTH_CIRCUMFERENCE_M,
  MAX_GRID,
  TileReadError,
  defaultPlanSite,
  latOf,
  mercX,
  mercY,
  metresPerUnit,
  pixelBox,
  plainAttribution,
  planFrame,
  renderMapImage,
  renderZoom,
  tileUrl,
  tilesFor,
} from "./plan-from-map"
import type { Bbox, PlanFrame } from "./plan-from-map"

// "New floor plan from this view": a map box becomes a grid at true scale
// (Web Mercator → metres at the box's latitude), the box snaps to whole
// cells, and the view renders from the tiles into one image.

const R = EARTH_CIRCUMFERENCE_M / (2 * Math.PI)
const rad = (d: number) => (d * Math.PI) / 180

function frameOf(b: Bbox, cell = 1000): PlanFrame {
  const f = planFrame(b, cell)
  if ("error" in f) throw new Error(f.error)
  return f
}

describe("planFrame", () => {
  it.each([0, 33.9, -33.9, 45, 56.15, 60, 70])(
    "measures the box in metres at latitude %s",
    (lat) => {
      const b = { south: lat, west: 10, north: lat + 0.003, east: 10.004 }
      const f = frameOf(b)
      // The sides on the sphere: along the middle parallel and the meridian.
      const w = rad(0.004) * R * Math.cos(rad(lat + 0.0015))
      const h = rad(0.003) * R
      // Snapped up to whole 1 m cells.
      expect(f.widthM).toBeGreaterThanOrEqual(w - 0.5)
      expect(f.widthM - w).toBeLessThan(1.5)
      expect(f.heightM).toBeGreaterThanOrEqual(h - 0.5)
      expect(f.heightM - h).toBeLessThan(1.5)
      expect(f.cellMm).toBe(1000)
      expect(f.gridWidth).toBe(Math.round(f.widthM))
      expect(f.gridHeight).toBe(Math.round(f.heightM))
    }
  )

  it("snaps the box east and south to whole cells", () => {
    const b = { south: 56, west: 10, north: 56.001, east: 10.0013 }
    const f = frameOf(b, 2000)
    expect(f.bbox.north).toBe(b.north)
    expect(f.bbox.west).toBe(b.west)
    expect(f.bbox.east).toBeGreaterThanOrEqual(b.east)
    expect(f.bbox.south).toBeLessThanOrEqual(b.south)
    // The snapped box measures whole cells, as the server measures it.
    const per = metresPerUnit(f.bbox)
    const w = (mercX(f.bbox.east) - mercX(f.bbox.west)) * per
    const h = (mercY(f.bbox.south) - mercY(f.bbox.north)) * per
    expect(Math.abs(w / 2 - f.gridWidth)).toBeLessThan(0.01)
    expect(Math.abs(h / 2 - f.gridHeight)).toBeLessThan(0.01)
  })

  it("raises the cell size to fit 512 cells", () => {
    const f = frameOf({ south: 56, west: 10, north: 56.005, east: 10.02 })
    expect(f.cellMm).toBeGreaterThan(1000)
    expect(f.gridWidth).toBeLessThanOrEqual(MAX_GRID)
  })

  it("refuses a box too large for a floor plan", () => {
    const f = planFrame({ south: 56, west: 10, north: 56.1, east: 10.2 }, 1000)
    expect("error" in f && f.error).toMatch(/zoom in/)
  })

  it("round-trips latitude through Mercator", () => {
    for (const lat of [-70, -12.5, 0, 41.2, 66.6])
      expect(latOf(mercY(lat))).toBeCloseTo(lat, 9)
  })
})

describe("tiles", () => {
  const b = { south: 56, west: 10, north: 56.002, east: 10.003 }

  it("renders at the map's zoom, lowered to fit 4096 px", () => {
    expect(renderZoom(b, 18)).toBe(18)
    const p = pixelBox(b, 18)
    expect(p.x1 - p.x0).toBeLessThan(4096)
    const wide = { south: 56, west: 10, north: 56.02, east: 10.04 }
    const z = renderZoom(wide, 19)
    const q = pixelBox(wide, z)
    expect(Math.max(q.x1 - q.x0, q.y1 - q.y0)).toBeLessThanOrEqual(4096)
    expect(z).toBeLessThan(19)
  })

  it("covers the box with tiles placed at their offsets", () => {
    const { tiles, width, height } = tilesFor(b, 17)
    const p = pixelBox(b, 17)
    expect(width).toBe(Math.round(p.x1 - p.x0))
    expect(height).toBe(Math.round(p.y1 - p.y0))
    expect(tiles[0].dx).toBeLessThanOrEqual(0)
    expect(tiles[0].dy).toBeLessThanOrEqual(0)
    const last = tiles[tiles.length - 1]
    expect(last.dx + 256).toBeGreaterThanOrEqual(width)
    expect(last.dy + 256).toBeGreaterThanOrEqual(height)
  })

  it("fills Leaflet URL templates", () => {
    expect(tileUrl("https://{s}.t.example/{z}/{x}/{y}{r}.png", 3, 4, 5)).toBe(
      "https://a.t.example/3/4/5.png"
    )
    expect(tileUrl("https://sat.example/{z}/{y}/{x}", 3, 4, 5)).toBe(
      "https://sat.example/3/5/4"
    )
  })

  it("keeps the credit and drops the report link", () => {
    expect(
      plainAttribution(
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="x">Report a map issue</a>'
      )
    ).toBe("© OpenStreetMap contributors")
  })
})

describe("renderMapImage", () => {
  afterEach(() => vi.restoreAllMocks())

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
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
        cb(new Blob(["x"], { type }))
      }
    )
    return ctx
  }

  const b = { south: 56, west: 10, north: 56.001, east: 10.002 }

  it("draws every tile and the attribution into one image", async () => {
    const ctx = stubCanvas()
    const load = vi.fn(async (_url: string) => ({}) as CanvasImageSource)
    const out = await renderMapImage({
      bbox: b,
      mapZoom: 17,
      template: "https://t.example/{z}/{x}/{y}.png",
      attribution: "&copy; Tiles",
      load,
    })
    const { tiles } = tilesFor(b, 17)
    expect(load).toHaveBeenCalledTimes(tiles.length)
    expect(load.mock.calls[0][0]).toMatch(
      /^https:\/\/t\.example\/17\/\d+\/\d+\.png$/
    )
    expect(ctx.drawImage).toHaveBeenCalledTimes(tiles.length)
    expect(ctx.fillText).toHaveBeenCalledWith(
      "© Tiles",
      expect.any(Number),
      expect.any(Number)
    )
    expect(out.zoom).toBe(17)
    expect(out.blob.type).toBe("image/png")
  })

  it("fails as TileReadError when a tile can't be read", async () => {
    stubCanvas()
    const load = vi.fn(async () => {
      throw new Error("blocked")
    })
    await expect(
      renderMapImage({
        bbox: b,
        mapZoom: 17,
        template: "https://t.example/{z}/{x}/{y}.png",
        attribution: "",
        load,
      })
    ).rejects.toBeInstanceOf(TileReadError)
    // Each tile is tried twice before giving up.
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("treats a tainted canvas as unreadable tiles", async () => {
    stubCanvas()
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError")
    })
    await expect(
      renderMapImage({
        bbox: b,
        mapZoom: 17,
        template: "https://t.example/{z}/{x}/{y}.png",
        attribution: "",
        load: async () => ({}) as CanvasImageSource,
      })
    ).rejects.toBeInstanceOf(TileReadError)
  })
})

describe("defaultPlanSite", () => {
  const site = (id: string, lat: number | null, lng: number | null) =>
    ({ id, name: id, latitude: lat, longitude: lng }) as unknown as SiteMapSite
  const outline = (site_id: string, lat: number, lng: number) =>
    ({
      site_id,
      points: [
        [lat, lng],
        [lat, lng + 0.0001],
        [lat + 0.0001, lng],
      ],
    }) as unknown as SiteMapOutline
  const b = { south: 56, west: 10, north: 56.01, east: 10.01 }

  it("picks the site with most outlines and pins in view", () => {
    expect(
      defaultPlanSite(
        b,
        [site("a", 56.005, 10.005), site("b", 57, 11), site("c", null, null)],
        [outline("b", 56.002, 10.002), outline("b", 56.003, 10.003)]
      )
    ).toBe("b")
  })

  it("is null when nothing is in view", () => {
    expect(defaultPlanSite(b, [site("a", 57, 11)], [])).toBeNull()
  })
})
