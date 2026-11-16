// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  FloorPlan,
  FloorPlanArea,
  FloorPlanContents,
  FloorPlanLabel,
  FloorPlanTile,
  FloorPlanWall,
  RaisedFloorArea,
} from "@/lib/api"
import { planContentBox } from "@/components/floorplan/plan-view"
import type { PlanShape } from "@/components/floorplan/shapes"
import { FloorplanWidget } from "./widget-floorplan"

// The dashboard's Floor plan widget draws the plan as its page does for a
// viewer: the page's PlanCanvas, fed the walls, raised floors, areas and
// labels, and the Display settings saved on the plan.

const { apiMock, canvasProps } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  canvasProps: [] as Record<string, unknown>[],
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: () => Promise.resolve({ count: 0, results: [] }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => () => Promise.resolve(),
}))
vi.mock("@/components/floorplan/plan-canvas", () => ({
  PlanCanvas: (props: Record<string, unknown>) => {
    canvasProps.push(props)
    return <div data-testid="plan-canvas" />
  },
}))

const PLAN = {
  id: "p1",
  name: "Hall A",
  grid_width: 40,
  grid_height: 20,
  cell_mm: 600,
  layout_mode: "grid",
  kind: "plan",
  background_image: null,
  background_opacity: 1,
  drawing: null,
  stack: null,
  state: {
    hidden: { tiles: ["t2"], tileTypes: [], roleTypes: [] },
    mute_background: false,
    show_cable_links: true,
    area_names: { position: "center", size: "l" },
  },
} as unknown as FloorPlan

const tile = (id: string, x: number) =>
  ({
    id,
    x,
    y: 2,
    width: 1,
    height: 1,
    rotation: 0,
  }) as unknown as FloorPlanTile

const WALL = {
  id: "w1",
  label: "",
  points: [
    [2, 2],
    [10, 2],
  ],
  height_mm: null,
  color: "",
  openings: [],
} as unknown as FloorPlanWall
const RAISED = {
  id: "r1",
  x: 3,
  y: 3,
  width: 2,
  height: 2,
  points: [],
  plenum_mm: 300,
  label: "",
  color: "",
} as unknown as RaisedFloorArea
const AREA = {
  id: "a1",
  shape: "rect",
  x: 1,
  y: 1,
  width: 4,
  height: 3,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Office",
  color: "",
  fill_opacity: 0.2,
  border: "solid",
  z: 0,
} as unknown as FloorPlanArea
const LABEL = {
  id: "l1",
  text: "North",
  x: 6,
  y: 6,
  width: null,
  height: null,
  rotation: 0,
  font_mm: 300,
  weight: "normal",
  align: "left",
  color: "",
  plate: false,
  z: 0,
} as unknown as FloorPlanLabel

const CONTENTS: FloorPlanContents = {
  version: "2026-11-13T09:00:00Z",
  tiles: [tile("t1", 4), tile("t2", 8)],
  trays: [],
  walls: [WALL],
  raised_floors: [RAISED],
  areas: [AREA],
  labels: [LABEL],
}

beforeEach(() => {
  canvasProps.length = 0
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/api/floor-plans/p1/"
        ? PLAN
        : path.endsWith("/contents/")
          ? CONTENTS
          : path.endsWith("/cable-paths/")
            ? { cables: [] }
            : path.endsWith("/state/")
              ? { tiles: {} }
              : path === "/api/floorplan-popover/"
                ? { fields: [], tile_overrides: {} }
                : {}
    )
  )
})
afterEach(cleanup)

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FloorplanWidget planId="p1" />
    </QueryClientProvider>
  )
}

const last = () => canvasProps[canvasProps.length - 1]

describe("FloorplanWidget", () => {
  it("draws the plan's walls, areas and labels with its saved display", async () => {
    mount()
    await screen.findByTestId("plan-canvas")
    await waitFor(() => expect((last().walls as unknown[]).length).toBe(1))
    const p = last()
    expect(p.canEdit).toBe(false)
    expect((p.walls as FloorPlanWall[]).map((w) => w.id)).toEqual(["w1"])
    expect((p.areas as RaisedFloorArea[]).map((a) => a.id)).toEqual(["r1"])
    expect(
      (p.shownShapes as PlanShape[]).map((s) => `${s.kind}:${s.id}`).sort()
    ).toEqual(["area:a1", "label:l1"])
    // The plan's saved state: a hidden tile stays off, the prefs follow.
    expect((p.shownTiles as FloorPlanTile[]).map((t) => t.id)).toEqual(["t1"])
    const prefs = p.prefs as Record<string, unknown>
    expect(prefs.muteBackground).toBe(false)
    expect(prefs.showCableLinks).toBe(true)
    expect(prefs.areaNames).toMatchObject({ position: "center", size: "l" })
    // The page's query keys: one read of each, polled live state.
    const paths = apiMock.mock.calls.map(([path]) => path)
    expect(paths).toContain("/api/floor-plans/p1/contents/")
    expect(paths).toContain("/api/floor-plans/p1/state/")
    expect(paths).toContain("/api/floor-plans/p1/cable-paths/")
  })
})

describe("planContentBox", () => {
  const plan = PLAN
  it("frames what is drawn, with a cell of room", () => {
    const box = planContentBox(
      plan,
      [tile("t1", 20)],
      [],
      [{ ...WALL, part: "wall" }]
    )
    expect(box).toEqual({ x: 1, y: 1, w: 21, h: 3 })
  })
  it("frames the grid for an empty plan or one with a background", () => {
    expect(planContentBox(plan, [], [], [])).toEqual({
      x: 0,
      y: 0,
      w: 40,
      h: 20,
    })
    expect(
      planContentBox(
        { ...plan, background_image: "/m/b.png" },
        [tile("t1", 4)],
        [],
        []
      )
    ).toEqual({ x: 0, y: 0, w: 40, h: 20 })
  })
})
