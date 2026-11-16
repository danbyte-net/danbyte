// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import L from "leaflet"

const addVectorLayer = vi.fn()
vi.mock("./vector-basemap", () => ({ addVectorLayer }))

import { basemapConfig, setBasemap, webglAvailable } from "./map-core"
import type { SiteMapPayload } from "@/lib/api"

const TILES: SiteMapPayload["tiles"] = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "OSM",
  osm_default: true,
  satellite: { url: "https://sat.example/{z}/{y}/{x}", attribution: "Esri" },
  basemap: "vector",
  vector: {
    url: "https://vector.openstreetmap.org/shortbread_v1/tilejson.json",
    attribution: "OSM",
    osm_default: true,
  },
  labels: "en_local",
}

function makeMap() {
  const el = document.createElement("div")
  document.body.appendChild(el)
  return L.map(el).setView([25.2, 55.27], 12)
}

const webgl = (on: boolean) =>
  vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((kind: string) =>
      on && kind.startsWith("webgl")
        ? ({} as WebGLRenderingContext)
        : null) as never)

const tileLayers = (map: L.Map) => {
  const out: L.TileLayer[] = []
  map.eachLayer((l) => {
    if (l instanceof L.TileLayer) out.push(l)
  })
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
  addVectorLayer.mockReset()
})

describe("basemapConfig", () => {
  it("draws the street map from vector tiles when the deployment does", () => {
    const cfg = basemapConfig(TILES, "map", "dark")
    expect(cfg.vector).toMatchObject({
      url: TILES.vector!.url,
      labels: "en_local",
      theme: "dark",
    })
    expect(cfg.vector?.labelsOnly).toBeUndefined()
    expect(cfg.raster.url).toBe(TILES.url)
  })

  it("keeps satellite imagery and adds vector labels on top", () => {
    const cfg = basemapConfig(TILES, "sat", "light")
    expect(cfg.raster).toEqual({ ...TILES.satellite, className: "" })
    expect(cfg.vector?.labelsOnly).toBe(true)
  })

  it("is raster only for a raster deployment", () => {
    const cfg = basemapConfig({ ...TILES, basemap: "raster" }, "map", "light")
    expect(cfg.vector).toBeUndefined()
  })
})

describe("setBasemap", () => {
  it("falls back to raster tiles without WebGL, quietly", () => {
    webgl(false)
    expect(webglAvailable()).toBe(false)
    const map = makeMap()
    const ref = { current: [] as L.Layer[] }
    const onFallback = vi.fn()
    setBasemap(map, ref, basemapConfig(TILES, "map", "light"), onFallback)
    expect(onFallback).toHaveBeenCalledWith("webgl")
    expect(
      tileLayers(map).map((l) => (l as unknown as { _url: string })._url)
    ).toEqual([TILES.url])
    expect(addVectorLayer).not.toHaveBeenCalled()
    map.remove()
  })

  it("falls back to raster when the vector source can't be read", async () => {
    webgl(true)
    addVectorLayer.mockRejectedValue(new Error("unreadable"))
    const map = makeMap()
    const ref = { current: [] as L.Layer[] }
    const onFallback = vi.fn()
    setBasemap(map, ref, basemapConfig(TILES, "map", "light"), onFallback)
    expect(tileLayers(map)).toHaveLength(0)
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledWith("source"))
    expect(tileLayers(map)).toHaveLength(1)
    expect(ref.current).toHaveLength(1)
    map.remove()
  })

  it("uses the vector layer and drops it when the swap was cancelled", async () => {
    webgl(true)
    const layer = L.layerGroup()
    addVectorLayer.mockImplementation(async (map: L.Map) => layer.addTo(map))
    const map = makeMap()
    const ref = { current: [] as L.Layer[] }
    setBasemap(map, ref, basemapConfig(TILES, "map", "light"))
    await vi.waitFor(() => expect(ref.current).toEqual([layer]))
    expect(addVectorLayer.mock.calls[0][1]).toMatchObject({
      labels: "en_local",
    })

    const late = L.layerGroup()
    let release!: () => void
    addVectorLayer.mockImplementation(
      (m: L.Map) => new Promise((r) => (release = () => r(late.addTo(m))))
    )
    const cancel = setBasemap(map, ref, basemapConfig(TILES, "map", "dark"))
    expect(map.hasLayer(layer)).toBe(false)
    cancel()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    release()
    await vi.waitFor(() => expect(map.hasLayer(late)).toBe(false))
    expect(ref.current).toEqual([])
    map.remove()
  })
})
