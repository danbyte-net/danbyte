// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanPlaceable } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { PlacePicker, UnplacedList } from "./place-picker"
import { PLACE_MIME } from "./placement"

// The Place picker ranks the site's objects by the room near the pointer,
// shows each one's room and where it already stands, places on a click and
// drags one or several onto the plan; the Objects panel's Not placed list
// drags the floor's unplaced objects.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const plan = {
  id: "p1",
  cell_mm: 600,
  layout_mode: "grid",
  location: { id: "loc1", name: "Building A" },
} as unknown as FloorPlan

const room210 = { id: "r210", name: "Room 210", code: "210", color: "#22c55e" }

const row = (patch: Partial<FloorPlanPlaceable>): FloorPlanPlaceable => ({
  kind: "device",
  id: "d1",
  name: "sw1",
  rank: 1,
  room: null,
  location: null,
  status: null,
  role: null,
  photo: null,
  placed_count: 0,
  placed_on: [],
  ...patch,
})

const ROWS = [
  row({ id: "a", name: "sw-room", rank: 0, room: room210 }),
  row({
    id: "b",
    name: "sw-here",
    rank: 0,
    room: room210,
    placed_count: 1,
    placed_on: [
      {
        floor_plan: { id: "p1", name: "Ground", stack: "" },
        tile_id: "t9",
        this_floor: true,
      },
    ],
  }),
  row({ id: "c", name: "sw-floor", rank: 1 }),
  row({
    id: "d",
    kind: "rack",
    name: "R9",
    rank: 2,
    placed_count: 1,
    placed_on: [
      {
        floor_plan: { id: "p2", name: "Floor 1", stack: "" },
        tile_id: "t1",
        this_floor: false,
      },
    ],
  }),
]

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({ results: ROWS })
})

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

function openPicker(extra: Partial<Parameters<typeof PlacePicker>[0]> = {}) {
  const props = {
    plan,
    open: true,
    onOpenChange: vi.fn(),
    near: { room: room210, location: null },
    onPlace: vi.fn(),
    onShow: vi.fn(),
    onAssignRooms: vi.fn(),
    ...extra,
  }
  wrap(<PlacePicker {...props} />)
  return props
}

describe("the Place picker", () => {
  it("asks for the room near the pointer and groups by rank", async () => {
    openPicker()
    await screen.findByText("sw-room")
    expect(apiMock.mock.calls[0][0]).toContain(
      "/api/floor-plans/p1/placeable/?near_room=r210"
    )
    const groups = [...document.querySelectorAll("[data-group]")].map((g) =>
      g.getAttribute("data-group")
    )
    expect(groups).toEqual(["In Room 210", "In Building A", "Elsewhere"])
  })

  it("shows each row's room and where it is placed", async () => {
    openPicker()
    const here = (await screen.findByText("sw-here")).closest(
      "[data-placeable]"
    ) as HTMLElement
    expect(within(here).getByText("On this floor")).toBeTruthy()
    expect(within(here).getByText("Room 210")).toBeTruthy()
    const rack = screen
      .getByText("R9")
      .closest("[data-placeable]") as HTMLElement
    expect(within(rack).getByText("Floor 1")).toBeTruthy()
  })

  it("places a click in the middle of the view; one on this floor is shown", async () => {
    const props = openPicker()
    fireEvent.click(await screen.findByText("sw-room"))
    expect(props.onPlace).toHaveBeenCalledWith([ROWS[0]])
    fireEvent.click(screen.getByText("sw-here"))
    expect(props.onShow).toHaveBeenCalledWith("t9")
  })

  it("drags the ticked rows together", async () => {
    openPicker()
    await screen.findByText("sw-room")
    fireEvent.click(screen.getByLabelText("Select sw-room"))
    fireEvent.click(screen.getByLabelText("Select sw-floor"))
    const set = vi.fn()
    const el = screen.getByText("sw-room").closest("[data-placeable]")!
    const ev = createEvent.dragStart(el)
    Object.defineProperty(ev, "dataTransfer", {
      value: { setData: set, effectAllowed: "" },
    })
    fireEvent(el, ev)
    expect(set.mock.calls[0][0]).toBe(PLACE_MIME)
    expect(
      JSON.parse(set.mock.calls[0][1]).map((r: FloorPlanPlaceable) => r.id)
    ).toEqual(["a", "c"])
    expect(screen.getByRole("button", { name: "Place 2" })).toBeTruthy()
  })

  it("clears the near room", async () => {
    openPicker()
    await screen.findByText("sw-room")
    fireEvent.click(screen.getByLabelText("Clear near"))
    await waitFor(() =>
      expect(apiMock.mock.calls.at(-1)![0]).toBe(
        "/api/floor-plans/p1/placeable/?"
      )
    )
  })
})

describe("Not placed", () => {
  it("lists the floor's unplaced objects to drag", async () => {
    const onPlace = vi.fn()
    wrap(<UnplacedList planId="p1" onPlace={onPlace} />)
    await screen.findByText("sw-room")
    expect(apiMock.mock.calls[0][0]).toBe(
      "/api/floor-plans/p1/placeable/?unplaced=1&limit=200"
    )
    expect(screen.getByText("Not placed")).toBeTruthy()
    const el = screen.getByText("sw-floor").closest("[data-placeable]")!
    expect(el.getAttribute("draggable")).toBe("true")
    fireEvent.click(screen.getByText("sw-floor"))
    expect(onPlace).toHaveBeenCalledWith([ROWS[2]])
  })

  it("is nothing when everything is placed", async () => {
    apiMock.mockResolvedValue({ results: [] })
    const { container } = wrap(<UnplacedList planId="p1" onPlace={vi.fn()} />)
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })
})
