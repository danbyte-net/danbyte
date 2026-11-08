// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { SiteMapOutline, SiteMapOutlineDrilldown } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { OutlinePanel } from "./outline-panel"

// Clicking a building outline while viewing opens its panel: the location's
// type, what stands in it, its floor plans, and the way in - "Open floor
// plan" (the first floor of its own floor plan, else the site-wide one) and
// "Open location".

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

afterEach(cleanup)

const OUTLINE: SiteMapOutline = {
  id: "o1",
  site_id: "s1",
  location_id: "l1",
  location: {
    id: "l1",
    name: "Building A",
    code: "A1",
    color: "#2563eb",
    icon: "building",
    location_type: { id: "t1", name: "Building", color: "#2563eb", icon: "" },
  },
  points: [
    [56, 10],
    [56, 10.001],
    [56.001, 10.001],
  ],
  label: "",
  color: "",
  z: 0,
  locked: false,
  display_label: "A1",
  display_color: "#2563eb",
  created_at: "",
  updated_at: "",
}

const DRILL: SiteMapOutlineDrilldown = {
  id: "o1",
  display_label: "A1",
  display_color: "#2563eb",
  site: { id: "s1", name: "Campus" },
  location: OUTLINE.location,
  counts: { locations: 2, rooms: 5, racks: 3, devices: 40 },
  floor_plans: [
    {
      id: "st1",
      name: "Building A",
      location: { id: "l1", name: "Building A" },
      site_wide: false,
      floor_count: 3,
      first_floor_id: "f-ground",
    },
    {
      id: "st2",
      name: "Campus",
      location: null,
      site_wide: true,
      floor_count: 1,
      first_floor_id: "f-campus",
    },
  ],
  open_floor_id: "f-ground",
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    path === "/api/site-map-outlines/o1/drilldown/"
      ? Promise.resolve(DRILL)
      : Promise.reject(new Error(path))
  )
})

function mount(outline: SiteMapOutline) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/site-map",
    component: () => <OutlinePanel outline={outline} onClose={() => {}} />,
  })
  const router = createRouter({
    routeTree: root.addChildren([map]),
    history: createMemoryHistory({ initialEntries: ["/site-map"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("OutlinePanel", () => {
  it("drills into the building", async () => {
    mount(OUTLINE)
    const panel = await screen.findByRole("complementary", { name: "Location" })
    expect(within(panel).getByText("Building")).toBeTruthy()
    expect(await within(panel).findByText("40")).toBeTruthy()
    const open = within(panel).getByRole("link", { name: "Open floor plan" })
    expect(open.getAttribute("href")).toBe("/floorplans/f-ground")
    expect(
      within(panel)
        .getByRole("link", { name: "Open location" })
        .getAttribute("href")
    ).toBe("/locations/l1")
    const plans = within(panel).getByRole("region", { name: "Floor plans" })
    const links = within(plans).getAllByRole("link")
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/floorplans/f-ground",
      "/floorplans/f-campus",
    ])
    expect(within(plans).getByText("Site-wide")).toBeTruthy()
  })

  it("an unlinked outline opens the site-wide plan only", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve({
        ...DRILL,
        location: null,
        counts: null,
        floor_plans: [DRILL.floor_plans[1]],
        open_floor_id: "f-campus",
      })
    )
    mount({
      ...OUTLINE,
      location: null,
      location_id: null,
      display_label: "Gate",
    })
    const panel = await screen.findByRole("complementary", { name: "Outline" })
    expect(within(panel).getByText("Not linked to a location.")).toBeTruthy()
    const open = await within(panel).findByRole("link", {
      name: "Open floor plan",
    })
    expect(open.getAttribute("href")).toBe("/floorplans/f-campus")
    expect(
      within(panel).queryByRole("link", { name: "Open location" })
    ).toBeNull()
  })
})
