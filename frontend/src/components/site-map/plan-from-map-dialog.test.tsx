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
import type { SiteMapPayload, SiteMapSite } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import type * as PlanFromMap from "./plan-from-map"
import { PlanFromMapDialog } from "./plan-from-map-dialog"

// The Site map's "New floor plan from this view": the dialog renders the
// view from the tiles, posts it with the box to /api/floor-plans/from-map/
// and opens the new plan; when the tiles can't be read it offers the plan
// with the outlines only.

const { apiMock, navMock, renderMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  navMock: vi.fn(),
  renderMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navMock,
}))
vi.mock("./plan-from-map", async (orig) => ({
  ...(await orig<typeof PlanFromMap>()),
  renderMapImage: renderMock,
}))

const TILES: SiteMapPayload["tiles"] = {
  url: "https://tile.example/{z}/{x}/{y}.png",
  attribution: "&copy; Example",
  osm_default: false,
  satellite: { url: "https://sat.example/{z}/{y}/{x}", attribution: "Sat" },
}
const SITES = [
  { id: "s1", name: "Campus", latitude: 56.0005, longitude: 10.001 },
  { id: "s2", name: "Depot", latitude: 57, longitude: 11 },
] as unknown as SiteMapSite[]
const FRAME = {
  bbox: { south: 56, west: 10, north: 56.001, east: 10.002 },
  zoom: 18,
}

function setup() {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PlanFromMapDialog
          frame={FRAME}
          tiles={TILES}
          sites={SITES}
          outlines={[]}
          basemap="map"
          onClose={onClose}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { onClose }
}

const sent = () => apiMock.mock.calls[0][1]!.body as FormData

beforeEach(() => {
  apiMock.mockReset()
  navMock.mockReset()
  renderMock.mockReset()
  apiMock.mockResolvedValue({
    id: "fp1",
    areas_created: 2,
    outlines_skipped: [],
  })
})
afterEach(cleanup)

describe("PlanFromMapDialog", () => {
  it("renders the view, creates the plan and opens it", async () => {
    renderMock.mockResolvedValue({
      blob: new Blob(["png"], { type: "image/png" }),
      zoom: 18,
      width: 500,
      height: 300,
    })
    const { onClose } = setup()
    // The site in view is picked; the grid is previewed.
    expect(screen.getByText("Campus")).toBeTruthy()
    expect(screen.getByTestId("plan-frame").textContent).toMatch(
      /\d+ × \d+ cells of 1 m/
    )
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(navMock).toHaveBeenCalled())
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mapZoom: 18,
        template: TILES.url,
        attribution: TILES.attribution,
        jpeg: false,
      })
    )
    expect(apiMock.mock.calls[0][0]).toBe("/api/floor-plans/from-map/")
    const fd = sent()
    expect(fd.get("name")).toBe("Site plan")
    expect(fd.get("site_id")).toBe("s1")
    expect(fd.get("cell_mm")).toBe("1000")
    expect(fd.get("basemap")).toBe("map")
    expect(fd.get("zoom")).toBe("18")
    expect(fd.get("background_image")).toBeInstanceOf(Blob)
    const bbox = JSON.parse(fd.get("bbox") as string) as number[]
    expect(bbox[0]).toBeLessThanOrEqual(56)
    expect(bbox[2]).toBe(56.001)
    expect(navMock).toHaveBeenCalledWith({
      to: "/floorplans/$id",
      params: { id: "fp1" },
    })
    expect(onClose).toHaveBeenCalled()
  })

  it("offers the outlines only when the tiles can't be read", async () => {
    const { TileReadError } =
      await vi.importActual<typeof PlanFromMap>("./plan-from-map")
    renderMock.mockRejectedValue(new TileReadError())
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await screen.findByRole("alert")
    expect(apiMock).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Create without background" })
    )
    await waitFor(() => expect(navMock).toHaveBeenCalled())
    const fd = sent()
    expect(fd.get("background_image")).toBeNull()
    expect(fd.get("site_id")).toBe("s1")
  })

  it("renders satellite imagery as JPEG with its attribution", async () => {
    renderMock.mockResolvedValue({
      blob: new Blob(["jpg"], { type: "image/jpeg" }),
      zoom: 18,
      width: 500,
      height: 300,
    })
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(navMock).toHaveBeenCalled())
    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        template: TILES.satellite.url,
        attribution: "Sat",
        jpeg: true,
      })
    )
    expect(sent().get("basemap")).toBe("sat")
  })

  it("shows a name clash on the name", async () => {
    const { ApiError } = await vi.importActual<typeof Api>("@/lib/api")
    renderMock.mockResolvedValue({
      blob: new Blob(["png"]),
      zoom: 18,
      width: 1,
      height: 1,
    })
    apiMock.mockRejectedValue(
      new ApiError(400, {
        name: ["Campus already has a floor plan named this."],
      })
    )
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await screen.findByText("Campus already has a floor plan named this.")
    expect(navMock).not.toHaveBeenCalled()
  })
})
