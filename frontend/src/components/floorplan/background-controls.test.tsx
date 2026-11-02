// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanBaseMap } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  metresPerUnit,
  mercX,
  mercY,
} from "@/components/site-map/plan-from-map"

import { BackgroundControls } from "./background-controls"
import { frameAt } from "./plan-geo"
import type { CadDrawingState } from "./use-cad-drawing"

// The Background popover holds both layers: the map (From site map…, or
// Update snapshot, the basemap switch and Remove) and the floor drawing,
// each with its eye and opacity.

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: vi.fn(() => new Promise(() => {})),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )

afterEach(cleanup)

// The opacity sliders measure themselves.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

const mut = () => ({ mutate: vi.fn(), isPending: false })
const cad = {
  summary: null,
  drawing: null,
  upload: mut(),
  remove: mut(),
  reprocess: mut(),
  placement: { opacity: 100 },
  change: vi.fn(),
} as unknown as CadDrawingState

const MAP: FloorPlanBaseMap = {
  id: "m1",
  image: "/media/floor-plans/maps/a.png",
  bbox: [56, 10, 56.001, 10.002],
  zoom: 18,
  basemap: "sat",
  attribution: "",
  captured_at: "2026-10-31T10:00:00Z",
  floors: 3,
}

const plan = (patch: Partial<FloorPlan> = {}) =>
  ({
    id: "p1",
    name: "B1",
    site: { id: "s1", name: "Campus" },
    grid_width: 30,
    grid_height: 20,
    cell_mm: 600,
    background_image: null,
    background_opacity: 60,
    background_shown: true,
    base_map: null,
    map_opacity: 60,
    map_shown: null,
    map_visible: false,
    drawing: null,
    geo: null,
    ...patch,
  }) as unknown as FloorPlan

function controls(p: FloorPlan) {
  const patchPlan = mut()
  render(
    <BackgroundControls
      plan={p}
      cad={cad}
      uploadBackground={mut() as never}
      patchPlan={patchPlan as never}
      onImageOverDrawing={vi.fn()}
    />
  )
  return patchPlan
}

describe("BackgroundControls", () => {
  it("offers a snapshot from the site map on a plan with none", () => {
    controls(plan())
    expect(screen.getByRole("button", { name: "From site map…" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Show map" })).toBeNull()
    expect(screen.queryByText("Update snapshot")).toBeNull()
  })

  it("shows a basement's hidden building map and turns it on", () => {
    const patchPlan = controls(
      plan({
        base_map: MAP,
        map_visible: false,
        geo: {
          bbox: MAP.bbox!,
          mpc: 0.6,
          zoom: 18,
          basemap: "sat",
          captured_at: MAP.captured_at,
          attribution: "",
        },
      })
    )
    expect(screen.getByText(/Map captured/).textContent).toContain("3")
    expect(screen.getByRole("button", { name: "Update snapshot" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    // Hidden: no opacity slider for it.
    expect(screen.queryByRole("slider", { name: "Map opacity" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Show map" }))
    expect(patchPlan.mutate).toHaveBeenCalledWith({ map_shown: true })
  })

  it("has no Update snapshot for a map with no geo anchor", () => {
    controls(plan({ base_map: MAP, map_visible: true }))
    expect(screen.queryByText("Update snapshot")).toBeNull()
    expect(screen.getByRole("button", { name: "Hide map" })).toBeTruthy()
  })

  it("hides the floor drawing with its eye", () => {
    const patchPlan = controls(
      plan({ background_image: "/media/floor-plans/x.png" })
    )
    expect(screen.getByRole("button", { name: "Replace image…" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Hide floor drawing" }))
    expect(patchPlan.mutate).toHaveBeenCalledWith({ background_shown: false })
  })
})

describe("frameAt", () => {
  it("frames the grid's real size around the centre", () => {
    const b = frameAt({ lat: 56, lng: 10 }, 18, 12)
    const per = metresPerUnit(b)
    expect((mercX(b.east) - mercX(b.west)) * per).toBeCloseTo(18, 1)
    expect((mercY(b.south) - mercY(b.north)) * per).toBeCloseTo(12, 1)
    expect((b.west + b.east) / 2).toBeCloseTo(10, 6)
    expect(b.north).toBeGreaterThan(b.south)
  })
})
