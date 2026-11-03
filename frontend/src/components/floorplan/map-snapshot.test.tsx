// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { FloorPlan, SiteMapPayload } from "@/lib/api"
import type * as PlanFromMap from "@/components/site-map/plan-from-map"
import { latOf, lngOf } from "@/components/site-map/plan-from-map"
import { Dialog, DialogContent } from "@/components/ui/dialog"

import { frameReadout, SnapshotForm } from "./map-snapshot"
import type { FrameMapProps } from "./map-snapshot"
import { moveFrame, moveInner, resizeFrame } from "./plan-geo"

// From site map: the frame's handles grow it in whole cells, the readout
// follows, and Capture with a larger frame sends its size and where the
// grid sits in it.

const { apiMock, renderMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  renderMock: vi.fn(),
  toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/components/site-map/plan-from-map", async (orig) => ({
  ...(await orig<typeof PlanFromMap>()),
  renderMapImage: renderMock,
}))
vi.mock("sonner", () => ({ toast: toastMock }))

const TILES: SiteMapPayload["tiles"] = {
  url: "https://tile.example/{z}/{x}/{y}.png",
  attribution: "&copy; Example",
  osm_default: false,
  satellite: { url: "https://sat.example/{z}/{y}/{x}", attribution: "Sat" },
}

const HALL = {
  id: "fp1",
  name: "Hall",
  site: { id: "s1", name: "Campus" },
  grid_width: 30,
  grid_height: 20,
  cell_mm: 600,
  updated_at: "2026-10-31T10:00:00Z",
  geo: null,
  base_map: null,
  map_levels: 3,
  state: {},
} as unknown as FloorPlan

// The small map stands in for Leaflet: buttons drag a handle or the grid.
let props: FrameMapProps | null = null
function FakeMap(p: FrameMapProps) {
  props = p
  const f = p.frame
  const to = (cx: number, cy: number) => ({
    lng: lngOf(f.x + cx * f.cx),
    lat: latOf(f.y + cy * f.cy),
  })
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          p.onFrame(resizeFrame(f, "se", to(40.3, 29.8)), "resize")
        }
      >
        drag se
      </button>
      <button
        type="button"
        onClick={() => p.onFrame(resizeFrame(f, "e", to(2100, 0)), "resize")}
      >
        drag e far
      </button>
      <button
        type="button"
        onClick={() => p.onFrame(moveInner(f, -2 * f.cx, 0), "inner")}
      >
        drag grid
      </button>
      <button
        type="button"
        onClick={() => p.onFrame(resizeFrame(f, "w", to(9, 0)), "resize")}
      >
        drag w in
      </button>
      <button
        type="button"
        onClick={() => p.onFrame(resizeFrame(f, "e", to(5, 0)), "resize")}
      >
        drag e in
      </button>
      <button
        type="button"
        onClick={() => p.onFrame(moveFrame(f, 40 * f.cx, 0), "move")}
      >
        move frame
      </button>
    </div>
  )
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(["site-map"], {
    tiles: TILES,
    sites: [{ id: "s1", latitude: 56, longitude: 10 }],
  })
  return render(
    <QueryClientProvider client={qc}>
      <Dialog open>
        <DialogContent aria-describedby={undefined}>{ui}</DialogContent>
      </Dialog>
    </QueryClientProvider>
  )
}

const size = () => screen.getByTestId("frame-size").textContent

beforeEach(() => {
  props = null
  apiMock.mockReset()
  renderMock.mockReset()
  apiMock.mockResolvedValue(HALL)
  renderMock.mockResolvedValue({
    blob: new Blob(["png"], { type: "image/png" }),
    zoom: 19,
    width: 400,
    height: 300,
  })
})
afterEach(cleanup)

describe("From site map", () => {
  it("reads the frame as cells and metres", () => {
    expect(frameReadout(30, 20, 600)).toBe("30 × 20 cells · 18 × 12 m")
  })

  it("snaps a resize to whole cells, centres the grid and grows on Capture", async () => {
    wrap(<SnapshotForm plan={HALL} onClose={vi.fn()} renderMap={FakeMap} />)
    expect(size()).toContain("30 × 20 cells · 18 × 12 m")
    expect(size()).not.toContain("levels")
    fireEvent.click(screen.getByText("drag se"))
    expect(size()).toContain("40 × 30 cells · 24 × 18 m")
    expect(size()).toContain("Grows all 3 levels")
    // The grid stays in the middle until it is dragged.
    expect([props!.frame.ix, props!.frame.iy]).toEqual([5, 5])
    fireEvent.click(screen.getByText("drag grid"))
    expect(props!.frame.ix).toBe(3)
    fireEvent.click(screen.getByRole("button", { name: "Capture" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/floor-plans/fp1/map/")
    const fd = init!.body as FormData
    expect(fd.get("grid")).toBe("[40,30]")
    expect(fd.get("offset")).toBe("[3,5]")
    expect(fd.get("version")).toBe(HALL.updated_at)
    expect(JSON.parse(String(fd.get("bbox")))).toHaveLength(4)
  })

  it("disables Capture past 2048 cells a side", () => {
    wrap(<SnapshotForm plan={HALL} onClose={vi.fn()} renderMap={FakeMap} />)
    fireEvent.click(screen.getByText("drag e far"))
    expect(size()).toContain("2100 × 20 cells")
    expect(size()).toContain("At most 2048 cells a side")
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Capture" })
        .disabled
    ).toBe(true)
  })

  it("reads the map's detail", () => {
    wrap(<SnapshotForm plan={HALL} onClose={vi.fn()} renderMap={FakeMap} />)
    // Zoom 19 at 56° N: about 0.17 m a pixel.
    expect(size()).toMatch(/≈ 0\.1\d m\/px/)
  })

  describe("on a plan tied to the map", () => {
    const geo = {
      bbox: [56, 10, 56.000108, 10.000291] as [number, number, number, number],
      mpc: 0.6,
      zoom: 19,
      basemap: "sat" as const,
      captured_at: null,
      attribution: "",
    }
    const anchored = {
      ...HALL,
      geo,
      frame_extent: { x: 2, y: 3, w: 10, h: 8 },
    } as unknown as FloorPlan

    it("moves the frame anywhere and re-anchors there", async () => {
      wrap(
        <SnapshotForm plan={anchored} onClose={vi.fn()} renderMap={FakeMap} />
      )
      const before = props!.frame.x
      fireEvent.click(screen.getByText("move frame"))
      expect(props!.frame.x).toBeGreaterThan(before)
      expect(size()).toContain("Moves all 3 levels")
      fireEvent.click(screen.getByRole("button", { name: "Capture" }))
      await waitFor(() => expect(apiMock).toHaveBeenCalled())
      const fd = apiMock.mock.calls[0][1]!.body as FormData
      expect(fd.get("grid")).toBe("[30,20]")
      expect(fd.get("offset")).toBe("[0,0]")
      expect(JSON.parse(String(fd.get("bbox")))[1]).toBeGreaterThan(10)
    })

    it("shrinks to what is drawn and moves it with the trimmed cells", async () => {
      wrap(
        <SnapshotForm plan={anchored} onClose={vi.fn()} renderMap={FakeMap} />
      )
      fireEvent.click(screen.getByText("drag e in"))
      fireEvent.click(screen.getByText("drag w in"))
      expect(size()).toContain("10 × 20 cells · 6 × 12 m")
      expect(size()).toContain("Shrinks all 3 levels")
      fireEvent.click(screen.getByRole("button", { name: "Capture" }))
      await waitFor(() => expect(apiMock).toHaveBeenCalled())
      const fd = apiMock.mock.calls[0][1]!.body as FormData
      expect(fd.get("grid")).toBe("[10,20]")
      expect(fd.get("offset")).toBe("[-2,0]")
    })

    it("refreshes its own box when the frame is left as it is", async () => {
      wrap(
        <SnapshotForm plan={anchored} onClose={vi.fn()} renderMap={FakeMap} />
      )
      fireEvent.click(screen.getByRole("button", { name: "Capture" }))
      await waitFor(() => expect(apiMock).toHaveBeenCalled())
      const fd = apiMock.mock.calls[0][1]!.body as FormData
      expect(fd.get("grid")).toBeNull()
      expect(fd.get("bbox")).toBeNull()
    })
  })

  it("captures the grid's own frame without growing it", async () => {
    wrap(<SnapshotForm plan={HALL} onClose={vi.fn()} renderMap={FakeMap} />)
    fireEvent.click(screen.getByRole("button", { name: "Capture" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const fd = apiMock.mock.calls[0][1]!.body as FormData
    expect(fd.get("grid")).toBeNull()
    expect(fd.get("bbox")).toBeTruthy()
  })
})
