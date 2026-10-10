// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanDrawing } from "@/lib/api"
import { CadPanel } from "./cad-panel"
import { useCadDrawing } from "./use-cad-drawing"

// The drawing panel and its state: a viewer sees the drawing and may hide
// layers for themselves (never saved); an editor's changes save at once and
// get the placement, fit and calibrate controls.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

// The opacity slider (Radix) measures itself.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

const DRAWING = {
  id: "d1",
  status: "ready",
  error: "",
  source_kind: "dxf",
  source_name: "hall.dxf",
  rendered_url: "/media/floor-plans/cad/p1/drawing.svg",
  updated_at: "2026-10-01T00:00:00Z",
  processed_at: "2026-10-01T00:00:00Z",
  rendered_elements: 10,
  simplified: [],
  units: "mm",
  units_mm_per_unit: 1,
  mm_per_unit: 1,
  scale_source: "units",
  calibration: null,
  size: { width: 12000, height: 8000 },
  size_mm: { width: 12000, height: 8000 },
  layers: [
    {
      name: "WALLS",
      color: "#ff0000",
      on: true,
      frozen: false,
      entity_count: 40,
      kinds: { geometry: 40, hatch: 0, dimension: 0, text: 0 },
    },
    {
      name: "DIMS",
      color: "#00ff00",
      on: true,
      frozen: false,
      entity_count: 5,
      kinds: { geometry: 0, hatch: 0, dimension: 5, text: 0 },
    },
  ],
  placement: {
    x_mm: 0,
    y_mm: 0,
    rotation: 0,
    opacity: 60,
    hidden_layers: [],
    hide_text: false,
  },
} as unknown as FloorPlanDrawing

const PLAN = {
  id: "p1",
  cell_mm: 600,
  background_image: null,
  drawing: {
    id: "d1",
    status: "ready",
    source_kind: "dxf",
    source_name: "hall.dxf",
    rendered_url: DRAWING.rendered_url,
    updated_at: DRAWING.updated_at,
  },
} as unknown as FloorPlan

const makeWrapper = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(async (path, init) => {
    if (init?.method === "PATCH")
      return {
        ...DRAWING,
        placement: {
          ...DRAWING.placement,
          ...JSON.parse(String(init.body)),
        },
      }
    if (path === "/api/floor-plans/p1/drawing/") return DRAWING
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(cleanup)

const patches = () =>
  apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH")

describe("useCadDrawing", () => {
  it("keeps a viewer's layer choice local and drops placement edits", async () => {
    const { result } = renderHook(() => useCadDrawing(PLAN, false), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.drawing).not.toBeNull())
    act(() => result.current.change({ hidden_layers: ["DIMS"], opacity: 10 }))
    expect(result.current.placement.hidden_layers).toEqual(["DIMS"])
    expect(result.current.placement.opacity).toBe(60)
    expect(patches()).toHaveLength(0)
  })

  it("saves an editor's change at once", async () => {
    const { result } = renderHook(() => useCadDrawing(PLAN, true), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.drawing).not.toBeNull())
    act(() => result.current.change({ rotation: 90 }))
    expect(result.current.placement.rotation).toBe(90)
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual([
      "/api/floor-plans/p1/drawing/",
      { method: "PATCH", body: JSON.stringify({ rotation: 90 }) },
    ])
    await waitFor(() =>
      expect(result.current.drawing?.placement.rotation).toBe(90)
    )
  })
})

describe("CadPanel", () => {
  const Harness = ({ canEdit }: { canEdit: boolean }) => {
    const cad = useCadDrawing(PLAN, canEdit)
    return (
      <CadPanel
        cad={cad}
        plan={PLAN}
        canEdit={canEdit}
        onCalibrate={() => {}}
        onClose={() => {}}
      />
    )
  }

  it("gives a viewer the layers, not the placement", async () => {
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <Harness canEdit={false} />
      </Wrapper>
    )
    await screen.findByText("WALLS")
    expect(screen.queryByText("Placement")).toBeNull()
    expect(screen.queryByRole("button", { name: "Calibrate" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Architecture only" }))
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", { name: "DIMS" })
          .getAttribute("aria-checked")
      ).toBe("false")
    )
    expect(
      screen
        .getByRole("checkbox", { name: "WALLS" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(patches()).toHaveLength(0)
  })

  it("gives an editor placement, fit and calibrate", async () => {
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <Harness canEdit />
      </Wrapper>
    )
    await screen.findByText("WALLS")
    expect(screen.getByText("Placement")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Fit grid to drawing" })
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Calibrate" })).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "WALLS" }))
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(JSON.parse(String(patches()[0][1]!.body))).toEqual({
      hidden_layers: ["WALLS"],
    })
  })
})
