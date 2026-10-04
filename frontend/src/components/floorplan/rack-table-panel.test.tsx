// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"

import type { PlanRack } from "./plan-racks"
import { RackTablePanel, matchesRackSearch } from "./rack-table-panel"

// The floor plan's rack table (#247): the racks list's columns and filters
// under the plan. A row under the pointer points at its rack on the plan, a
// click on the row focuses it, and a filter tells the plan which racks are
// still listed so it can fade the rest.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
  }: {
    children: ReactNode
    to: string
    search?: Record<string, string>
  }) => (
    <a
      href={`${to}${search ? `?${new URLSearchParams(search).toString()}` : ""}`}
      // The router's link navigates in place; jsdom would try a document.
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  ),
}))
vi.mock("@/components/planning/planned-change-badge", () => ({
  PlannedChangeMarker: () => null,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) =>
    path.startsWith("/api/prefs/columns/")
      ? Promise.resolve({ source: "none", data: null, is_forced: false })
      : new Promise(() => undefined)
  )
})
afterEach(cleanup)

const ports = (connected: number, total: number) => ({
  total,
  connected,
  reserved: 0,
  free: total - connected,
  marked: 0,
})

function rack(id: string, name: string, patch: Partial<PlanRack> = {}) {
  return {
    id,
    numid: null,
    name,
    facility_id: "",
    site: { id: "s1", name: "Lab" },
    role: {
      id: "rr1",
      name: "Compute",
      slug: "compute",
      color: "#6366f1",
      icon: "",
    },
    rack_type: null,
    status: null,
    location: null,
    width: 19,
    max_weight: null,
    max_weight_unit: "kg",
    total_weight_kg: 0,
    max_weight_kg: null,
    power: {
      available_w: 5_000,
      allocated_w: 2_500,
      maximum_w: 0,
      supply: "feed",
    },
    ports: ports(3, 15),
    panel_ports: ports(0, 0),
    u_height: 24,
    starting_unit: 1,
    desc_units: false,
    outer_width_mm: null,
    outer_depth_mm: null,
    description: "",
    device_count: 7,
    document_count: 0,
    used_units: 5,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    tileIds: [`tile-${id}`],
    ...patch,
  } as PlanRack
}

const RACKS = [
  rack("r1", "CL-R01"),
  rack("r2", "CL-R02", { device_count: 13, ports: ports(26, 30) }),
  rack("r3", "Hall-B-07", { device_count: 2 }),
]

function mount(
  props: Partial<React.ComponentProps<typeof RackTablePanel>> = {}
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(["user-prefs"], {
    values: { page_size: 25 },
    defaults: {},
    user_set: [],
  })
  const handlers = {
    onHover: vi.fn(),
    onFocus: vi.fn(),
    onMatchChange: vi.fn(),
    onClose: vi.fn(),
  }
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RackTablePanel racks={RACKS} {...handlers} {...props} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return handlers
}

const rowOf = (name: string) =>
  screen.getByText(name).closest("tr") as HTMLTableRowElement

describe("RackTablePanel", () => {
  it("lists the plan's racks with the factory's capacity columns", () => {
    mount()
    for (const header of ["Name", "Role", "Used", "Power", "Ports"])
      expect(screen.getAllByText(header).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Panel ports").length).toBeGreaterThan(0)
    // The ports open the Port utilization page on the rack's devices.
    expect(screen.getByText("26 / 30").closest("a")?.getAttribute("href")).toBe(
      "/port-utilization?rack=r2"
    )
  })

  it("points at the rack under the pointer, and at none once it leaves", () => {
    const { onHover } = mount()
    fireEvent.mouseEnter(rowOf("CL-R02"))
    fireEvent.mouseLeave(rowOf("CL-R02").parentElement!)
    expect(onHover.mock.calls.map((c) => c[0]?.id ?? null)).toEqual([
      "r2",
      null,
    ])
  })

  it("focuses the rack a row click names, not one its link opens", () => {
    const { onFocus } = mount()
    fireEvent.click(screen.getByText("CL-R01")) // the name link
    expect(onFocus).not.toHaveBeenCalled()
    // A plain cell of the row: its device count.
    fireEvent.click(screen.getByText("13"))
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onFocus.mock.calls[0][0].id).toBe("r2")
  })

  it("hands the plan the racks a filter keeps, and none when it is cleared", () => {
    const { onMatchChange } = mount()
    // Unfiltered: nothing to fade.
    expect(onMatchChange).toHaveBeenLastCalledWith(null)
    const box = screen.getByLabelText("Find rack")
    fireEvent.change(box, { target: { value: "cl-r" } })
    const kept = onMatchChange.mock.lastCall![0] as ReadonlySet<string>
    expect([...kept].sort()).toEqual(["r1", "r2"])
    expect(screen.getByText("2 of 3")).toBeTruthy()
    // A filter that keeps nothing fades every rack.
    fireEvent.change(box, { target: { value: "nothing" } })
    expect([...(onMatchChange.mock.lastCall![0] as Set<string>)]).toEqual([])
    fireEvent.change(box, { target: { value: "" } })
    expect(onMatchChange).toHaveBeenLastCalledWith(null)
  })

  it("closes from its own button", () => {
    const { onClose } = mount()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("matchesRackSearch", () => {
  it("matches a rack's name or facility ID, any case", () => {
    const r = rack("r9", "DC1-A07", { facility_id: "FAC-0042" })
    expect(matchesRackSearch(r, "")).toBe(true)
    expect(matchesRackSearch(r, "a07")).toBe(true)
    expect(matchesRackSearch(r, "fac-00")).toBe(true)
    expect(matchesRackSearch(r, "B07")).toBe(false)
  })
})
