// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Cabinet, FloorPlanTile } from "@/lib/api"
import { CabinetLinkField } from "./cabinet-link-field"

// The tile inspector's Cabinet link: the cabinet picker for the plan's site,
// an offer to fit the tile to the cabinet's footprint, and the cabinet's
// name on a link picked but not saved yet.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))

const cabinet = (patch: Partial<Cabinet> = {}): Cabinet => ({
  id: "c1",
  numid: 7,
  name: "Test cabinet",
  facility_id: "",
  site: { id: "s1", name: "København HQ" },
  location: null,
  role: null,
  cabinet_type: null,
  status: null,
  rails: [],
  description: "",
  document_count: 0,
  device_count: 0,
  tags: [],
  custom_fields: {},
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  created_at: "",
  updated_at: "",
  ...patch,
})

const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile =>
  ({
    id: "t1",
    x: 2,
    y: 3,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "",
    status: "",
    link_kind: "cabinet",
    linked: { kind: "cabinet", id: "c1", name: "", route: "" },
    ...patch,
  }) as FloorPlanTile

let detail: Cabinet
beforeEach(() => {
  detail = cabinet()
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/cabinets/?picker=1"))
      return Promise.resolve({
        count: 1,
        results: [{ id: "c1", name: "Test cabinet", site: detail.site }],
      })
    if (path === "/api/cabinets/c1/") return Promise.resolve(detail)
    return new Promise(() => undefined)
  })
})
afterEach(cleanup)

function mount(t: FloorPlanTile) {
  const onPick = vi.fn()
  const onName = vi.fn()
  const onFit = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CabinetLinkField
        tile={t}
        siteId="s1"
        cellMm={600}
        onPick={onPick}
        onName={onName}
        onFit={onFit}
      />
    </QueryClientProvider>
  )
  return { onPick, onName, onFit }
}

const fitButton = () => screen.findByRole("button", { name: /Fit to cabinet/ })

describe("CabinetLinkField", () => {
  it("picks among the cabinets at the plan's site", async () => {
    mount(tile({ link_kind: "cabinet", linked: null }))
    expect(screen.getByText("Cabinet")).toBeTruthy()
    await vi.waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/cabinets/?picker=1&site=s1")
    )
    // Nothing picked yet: nothing to fit, and no cabinet to read.
    expect(screen.queryByRole("button", { name: /Fit to cabinet/ })).toBeNull()
    expect(apiMock).not.toHaveBeenCalledWith("/api/cabinets/c1/")
  })

  it("offers to fit the tile to the cabinet's footprint", async () => {
    detail = cabinet({ outer_width_mm: 1200, outer_depth_mm: 300 })
    const { onFit } = mount(tile({ linked: { ...tile().linked!, name: "K1" } }))
    const button = await fitButton()
    expect(button.textContent).toContain("2×1")
    fireEvent.click(button)
    expect(onFit).toHaveBeenCalledWith({ width: 2, height: 1 })
  })

  it("turns the footprint with the tile's facing", async () => {
    detail = cabinet({ outer_width_mm: 1200, outer_depth_mm: 300 })
    mount(tile({ orientation: 90 }))
    expect((await fitButton()).textContent).toContain("1×2")
  })

  it("makes no offer when the tile already fits", async () => {
    const { onName } = mount(tile())
    // The cabinet has loaded once its name has been handed over.
    await vi.waitFor(() => expect(onName).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /Fit to cabinet/ })).toBeNull()
  })

  it("names a fresh link after its cabinet", async () => {
    const { onName } = mount(tile())
    await vi.waitFor(() => expect(onName).toHaveBeenCalledWith("Test cabinet"))
  })

  it("leaves a link that has its name alone", async () => {
    detail = cabinet({ outer_width_mm: 1200 })
    const { onName } = mount(
      tile({ linked: { kind: "cabinet", id: "c1", name: "K1", route: "" } })
    )
    await fitButton()
    expect(onName).not.toHaveBeenCalled()
  })
})
