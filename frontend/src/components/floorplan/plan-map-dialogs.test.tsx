// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { FloorPlan, SiteMapPayload } from "@/lib/api"
import type * as PlanFromMap from "@/components/site-map/plan-from-map"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  capturedLabel,
  ExpandPlanDialog,
  RefreshMapDialog,
} from "./plan-map-dialogs"
import { grownBbox, NO_GROWTH } from "./plan-geo"

// Refresh map renders the plan's box again from the tiles and uploads it as
// the background; Expand grows the box by metres per side, renders the new
// box and posts both; either falls back gracefully when the browser can't
// read the tiles, then offers the new outlines inside the box.

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
vi.mock("@/lib/datetime", () => ({
  useDateFormat: () => ({ formatDate: () => "1 Oct 2026" }),
}))
// Leaflet's map needs a real layout; the dialog's handles are covered by
// the plan-geo sums.
vi.mock("./expand-map", () => ({
  ExpandMap: () => <div data-testid="expand-map" />,
}))

const TILES: SiteMapPayload["tiles"] = {
  url: "https://tile.example/{z}/{x}/{y}.png",
  attribution: "&copy; Example",
  osm_default: false,
  satellite: { url: "https://sat.example/{z}/{y}/{x}", attribution: "Sat" },
}

const PLAN = {
  id: "fp1",
  name: "Campus",
  grid_width: 124,
  grid_height: 111,
  cell_mm: 1000,
  updated_at: "2026-10-31T10:00:00Z",
  geo: {
    bbox: [56, 10, 56.001, 10.002],
    mpc: 1,
    zoom: 18,
    basemap: "map",
    captured_at: "2026-10-01T09:00:00Z",
    attribution: "© Example",
  },
} as unknown as FloorPlan

let outlines: unknown[] = []

function route(path: string, init?: RequestInit) {
  if (path === "/api/site-map/") return Promise.resolve({ tiles: TILES })
  if (path.endsWith("/import-outlines/")) {
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (body.dry_run) return Promise.resolve({ outlines })
    return Promise.resolve({
      created: body.apply.length,
      skipped: [],
      outlines: [],
    })
  }
  if (path.endsWith("/expand/"))
    return Promise.resolve({
      ...PLAN,
      grid_width: 134,
      expanded: { background: "padded" },
    })
  return Promise.resolve(PLAN)
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The tile servers, as the Site map already loaded them.
  qc.setQueryData(["site-map"], { tiles: TILES })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

const call = (suffix: string) =>
  apiMock.mock.calls.find(([p]) => p.endsWith(suffix))
const form = (suffix: string) => call(suffix)![1]!.body as FormData

const IMG = {
  blob: new Blob(["png"], { type: "image/png" }),
  zoom: 18,
  width: 500,
  height: 450,
}

beforeEach(() => {
  apiMock.mockReset()
  renderMock.mockReset()
  Object.values(toastMock).forEach((f) => f.mockReset())
  apiMock.mockImplementation(route)
  outlines = []
})
afterEach(cleanup)

describe("capturedLabel", () => {
  it("reads the capture date, or nothing", () => {
    expect(capturedLabel(PLAN.geo, () => "1 Oct 2026")).toBe(
      "Map captured 1 Oct 2026"
    )
    expect(capturedLabel({ ...PLAN.geo!, captured_at: null }, String)).toBe(
      null
    )
    expect(capturedLabel(null, String)).toBe(null)
  })
})

describe("Refresh map", () => {
  it("renders the same box and uploads it as the background", async () => {
    renderMock.mockResolvedValue(IMG)
    const onOpenChange = vi.fn()
    wrap(<RefreshMapDialog plan={PLAN} open onOpenChange={onOpenChange} />)
    expect(screen.getByText(/Map captured/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }))
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bbox: { south: 56, west: 10, north: 56.001, east: 10.002 },
        mapZoom: 18,
        template: TILES.satellite.url,
        jpeg: true,
      })
    )
    const fd = form("/background/")
    expect(fd.get("map_refresh")).toBe("1")
    expect(fd.get("basemap")).toBe("sat")
    expect(fd.get("background_image")).toBeInstanceOf(Blob)
    expect(toastMock.success).toHaveBeenCalledWith("Map refreshed")
  })

  it("keeps the background when the tiles can't be read", async () => {
    const { TileReadError } =
      await import("@/components/site-map/plan-from-map")
    renderMock.mockRejectedValue(new TileReadError())
    wrap(<RefreshMapDialog plan={PLAN} open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /stays as it is/
    )
    expect(call("/background/")).toBeUndefined()
  })

  it("then offers the new outlines, ticked", async () => {
    renderMock.mockResolvedValue(IMG)
    outlines = [
      { id: "o1", label: "Shed", location: null, color: "" },
      {
        id: "o2",
        label: "B2",
        location: { id: "l2", name: "Building B" },
        color: "#2563eb",
      },
    ]
    const onOpenChange = vi.fn()
    wrap(<RefreshMapDialog plan={PLAN} open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(await screen.findByText("New outlines on the map")).toBeTruthy()
    fireEvent.click(screen.getByText("Shed"))
    fireEvent.click(screen.getByRole("button", { name: "Add 1 as areas" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const applied = apiMock.mock.calls.filter(
      ([p, i]) =>
        p.endsWith("/import-outlines/") && String(i?.body).includes("apply")
    )
    expect(JSON.parse(String(applied[0][1]!.body))).toEqual({ apply: ["o2"] })
  })
})

describe("Expand", () => {
  it("grows by metres per side, renders the new box and posts both", async () => {
    renderMock.mockResolvedValue(IMG)
    const onOpenChange = vi.fn()
    wrap(<ExpandPlanDialog plan={PLAN} open onOpenChange={onOpenChange} />)
    const expand = screen.getByRole("button", { name: "Expand" })
    expect((expand as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("West (m)"), {
      target: { value: "9.5" },
    })
    fireEvent.change(screen.getByLabelText("North (m)"), {
      target: { value: "4" },
    })
    expect(screen.getByTestId("expand-frame").textContent).toMatch(
      /134 × 115 cells of 1 m/
    )
    fireEvent.click(expand)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const want = grownBbox(PLAN as never, { ...NO_GROWTH, west: 10, north: 4 })
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({ bbox: want, template: TILES.url })
    )
    const fd = form("/expand/")
    expect(JSON.parse(String(fd.get("bbox")))).toEqual([
      want.south,
      want.west,
      want.north,
      want.east,
    ])
    expect(fd.get("version")).toBe(PLAN.updated_at)
    expect(fd.get("background_image")).toBeInstanceOf(Blob)
    expect(toastMock.success).toHaveBeenCalledWith(
      "Expanded to 134 × 111 cells"
    )
  })

  it("refuses more than 512 cells with the reason", () => {
    wrap(<ExpandPlanDialog plan={PLAN} open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("East (m)"), {
      target: { value: "400" },
    })
    expect(screen.getByTestId("expand-frame").textContent).toMatch(
      /524 × 111 cells; a plan has at most 512/
    )
    expect(screen.getByRole("button", { name: "Expand" }).disabled).toBe(true)
  })

  it("still grows when the tiles can't be read, keeping the old picture", async () => {
    const { TileReadError } =
      await import("@/components/site-map/plan-from-map")
    renderMock.mockRejectedValue(new TileReadError())
    const onOpenChange = vi.fn()
    wrap(<ExpandPlanDialog plan={PLAN} open onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByLabelText("South (m)"), {
      target: { value: "3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Expand" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const fd = form("/expand/")
    expect(fd.get("background_image")).toBeNull()
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/old background stays/)
    )
  })
})
