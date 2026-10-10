// @vitest-environment jsdom
import { cleanup, render, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanDrawing } from "@/lib/api"
import {
  CadLayer,
  applyLayerVisibility,
  fetchServerRender,
  normaliseStrokes,
  parseCadSvg,
  useCadSource,
  visibleSvgText,
} from "./cad-layer"
import type { CadSource } from "./cad-layer"
import { placementOf } from "./cad-math"

// The drawing on the 2D canvas: the sanitised SVG parsed (never an
// unexpected root), inlined under the placement transform, layers and text
// hidden by attribute; and, for a large drawing, a server render shown as
// one image.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

const FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50">
<g data-layer="WALLS" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M0 0L100 0" stroke="#ff0000" stroke-width="0.25"/><g data-kind="text"><text transform="matrix(1 0 0 1 10 10)" font-size="2" fill="#fff" stroke="none">Room 1</text></g></g>
<g data-layer="A &quot;quoted&quot; [layer]" fill="none"><path d="M0 10L50 10" stroke="#00ff00" stroke-width="1"/></g>
</svg>`

const drawing = (patch: Partial<FloorPlanDrawing> = {}): FloorPlanDrawing =>
  ({
    id: "d1",
    status: "ready",
    source_kind: "dxf",
    source_name: "hall.dxf",
    rendered_url: "/media/floor-plans/cad/p1/drawing.svg",
    updated_at: "2026-10-01T00:00:00Z",
    processed_at: "2026-10-01T00:00:00Z",
    rendered_elements: 6,
    mm_per_unit: 10,
    size: { width: 100, height: 50 },
    size_mm: { width: 1000, height: 500 },
    layers: [],
    placement: {},
    ...patch,
  }) as FloorPlanDrawing

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => apiMock.mockReset())

describe("parseCadSvg", () => {
  it("refuses a root that is not svg", () => {
    expect(() =>
      parseCadSvg('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>')
    ).toThrow()
    expect(() => parseCadSvg("<svg><g>")).toThrow()
    expect(() => parseCadSvg("not xml")).toThrow()
  })

  it("strips scripts, handlers and references", () => {
    const root = parseCadSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1">
        <script>alert(1)</script>
        <g data-layer="L" onclick="alert(2)"><path d="M0 0" fill="url(http://x/y)"/>
          <use xlink:href="#a"/><foreignObject><div/></foreignObject></g>
      </svg>`
    )
    expect(root.querySelector("script")).toBeNull()
    expect(root.querySelector("use")).toBeNull()
    expect(root.querySelector("foreignObject")).toBeNull()
    expect(root.querySelector("g")!.hasAttribute("onclick")).toBe(false)
    expect(root.querySelector("path")!.hasAttribute("fill")).toBe(false)
    expect(root.querySelector("g")!.getAttribute("data-layer")).toBe("L")
  })

  it("keeps lineweights readable as screen px", () => {
    const root = parseCadSvg(FIXTURE)
    normaliseStrokes(root)
    const widths = Array.from(root.querySelectorAll("path")).map((p) =>
      Number(p.getAttribute("stroke-width"))
    )
    expect(widths).toEqual([0.75, 2])
  })
})

describe("layer hiding", () => {
  it("hides by name, quotes and brackets included, and hides text", () => {
    const root = parseCadSvg(FIXTURE)
    applyLayerVisibility(root, ['A "quoted" [layer]'], true)
    const [walls, quoted] = Array.from(root.querySelectorAll("g[data-layer]"))
    expect(walls.getAttribute("display")).toBeNull()
    expect(quoted.getAttribute("display")).toBe("none")
    expect(
      root.querySelector('g[data-kind="text"]')!.getAttribute("display")
    ).toBe("none")
    applyLayerVisibility(root, [], false)
    expect(quoted.getAttribute("display")).toBeNull()
    expect(
      root.querySelector('g[data-kind="text"]')!.getAttribute("display")
    ).toBeNull()
  })

  it("leaves hidden layers out of the raster text", () => {
    const root = parseCadSvg(FIXTURE)
    const text = visibleSvgText(root, ["WALLS"], false, {
      width: 400,
      height: 200,
    })
    expect(text).not.toContain('data-layer="WALLS"')
    expect(text).toContain('width="400"')
    // The cached root is never touched.
    expect(root.querySelectorAll("g[data-layer]")).toHaveLength(2)
  })
})

describe("CadLayer", () => {
  const renderLayer = (source: CadSource, d = drawing()) =>
    render(
      <svg>
        <CadLayer
          drawing={d}
          source={source}
          placement={placementOf(d, { hidden_layers: ["WALLS"] })}
          pxPerMm={40 / 600}
        />
      </svg>
    )

  it("inlines the drawing under the placement transform", () => {
    const svg = parseCadSvg(FIXTURE)
    const { container } = renderLayer({
      mode: "inline",
      svg,
      imageUrl: null,
      loading: false,
      error: null,
    })
    const g = container.querySelector("[data-cad-layer]")!
    expect(g.getAttribute("transform")).toBe(
      "scale(0.066667) translate(500 250) rotate(0) scale(10) translate(-50 -25)"
    )
    expect(g.getAttribute("opacity")).toBe("0.6")
    expect(g.getAttribute("pointer-events")).toBe("none")
    expect(container.querySelectorAll("g[data-layer]")).toHaveLength(2)
    expect(
      container.querySelector('g[data-layer="WALLS"]')!.getAttribute("display")
    ).toBe("none")
    expect(container.textContent).toContain("Room 1")
    // The cached parse keeps its own nodes.
    expect(svg.querySelectorAll("g[data-layer]")).toHaveLength(2)
  })

  it("draws a server render as one image", () => {
    const { container } = renderLayer({
      mode: "image",
      svg: null,
      imageUrl: "/media/floor-plans/cad/p1/variant-k.svg",
      loading: false,
      error: null,
    })
    const img = container.querySelector("image")!
    expect(img.getAttribute("href")).toBe(
      "/media/floor-plans/cad/p1/variant-k.svg"
    )
    expect(img.getAttribute("width")).toBe("100")
    expect(container.querySelectorAll("g[data-layer]")).toHaveLength(0)
  })
})

describe("useCadSource", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  )

  it("fetches and inlines a drawing under the budget", async () => {
    const fetchMock = vi.fn(async () => new Response(FIXTURE))
    vi.stubGlobal("fetch", fetchMock)
    const d = drawing()
    const { result } = renderHook(() => useCadSource("p1", d, placementOf(d)), {
      wrapper,
    })
    await waitFor(() => expect(result.current.svg).not.toBeNull())
    expect(result.current.mode).toBe("inline")
    expect(fetchMock).toHaveBeenCalledWith(
      "/media/floor-plans/cad/p1/drawing.svg",
      { credentials: "same-origin" }
    )
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("asks the server for a render above the budget", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    apiMock.mockResolvedValue({
      key: "k1",
      status: "ready",
      url: "/media/floor-plans/cad/p1/variant-k1.svg",
      error: "",
    })
    const d = drawing({ rendered_elements: 500 })
    const { result } = renderHook(
      () =>
        useCadSource("p1", d, placementOf(d, { hidden_layers: ["DIMS"] }), 100),
      { wrapper }
    )
    await waitFor(() =>
      expect(result.current.imageUrl).toBe(
        "/media/floor-plans/cad/p1/variant-k1.svg"
      )
    )
    expect(result.current.mode).toBe("image")
    expect(apiMock).toHaveBeenCalledWith(
      "/api/floor-plans/p1/drawing/render/",
      {
        method: "POST",
        body: JSON.stringify({ hidden_layers: ["DIMS"], hide_text: false }),
      }
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the rendered file itself when nothing is hidden", () => {
    const d = drawing({ rendered_elements: 500 })
    const { result } = renderHook(
      () => useCadSource("p1", d, placementOf(d), 100),
      { wrapper }
    )
    expect(result.current).toMatchObject({
      mode: "image",
      imageUrl: "/media/floor-plans/cad/p1/drawing.svg",
    })
    expect(apiMock).not.toHaveBeenCalled()
  })
})

describe("fetchServerRender", () => {
  it("polls by key until the render is ready", async () => {
    apiMock
      .mockResolvedValueOnce({ key: "k 1", status: "queued" })
      .mockResolvedValueOnce({ key: "k 1", status: "queued" })
      .mockResolvedValueOnce({ key: "k 1", status: "ready", url: "/m/v.svg" })
    const r = await fetchServerRender("p1", ["A"], true, { interval: 0 })
    expect(r.url).toBe("/m/v.svg")
    expect(apiMock).toHaveBeenLastCalledWith(
      "/api/floor-plans/p1/drawing/render/?key=k%201"
    )
    expect(apiMock).toHaveBeenCalledTimes(3)
  })
})
