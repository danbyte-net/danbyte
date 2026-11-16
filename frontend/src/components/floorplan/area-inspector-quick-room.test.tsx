// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { AreaInspector } from "./shape-inspector"
import type { AreaShape } from "./shapes"

// An area's Room picker offers "+" to make a room in the floor's location,
// only to users who may add rooms, and links the area to it. A linked
// area's Room colour is the room's own, changed on the room by those who
// may change it.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { add: true, change: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: () => Promise.resolve([]),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (type: string, action: string) =>
      type === "room" && action === "add"
        ? perms.add
        : action === "change"
          ? perms.change
          : true,
  }),
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub
}

const plan = {
  id: "p1",
  state: {},
  cell_mm: 600,
  site: { id: "s1", name: "AMS" },
  location: { id: "loc1", name: "Hall", slug: "hall" },
} as unknown as FloorPlan

const area: AreaShape = {
  kind: "area",
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
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
}

function inspect(
  shape: AreaShape = area,
  onLinkColour: (kind: string, id: string, color: string) => void = vi.fn()
) {
  const onChange = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <AreaInspector
          plan={plan}
          area={shape}
          onChange={onChange}
          onRestack={vi.fn()}
          onDelete={vi.fn()}
          onLinkColour={onLinkColour}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return onChange
}

beforeEach(() => {
  perms.add = true
  perms.change = true
  apiMock.mockResolvedValue({ id: "r9", name: "Server room" })
})
afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

describe("making a room from an area", () => {
  it("creates it in the floor's location and links the area", async () => {
    const onChange = inspect()
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    fireEvent.click(screen.getByRole("button", { name: "New room in Hall" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Server room" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^(Create|Add)/ })
    )
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        room: { id: "r9", name: "Server room", code: "", color: "" },
      })
    )
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/rooms/")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Server room",
      location_id: "loc1",
    })
  })

  it("is not offered without permission to add rooms", () => {
    perms.add = false
    inspect()
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    expect(
      screen.queryByRole("button", { name: "New room in Hall" })
    ).toBeNull()
  })
})

describe("the room colour", () => {
  const inRoom: AreaShape = {
    ...area,
    room: { id: "r1", name: "Room 210", code: "210", color: "#22c55e" },
  }

  it("is the room's own, changed on the room and repainted", async () => {
    apiMock.mockResolvedValue({})
    const onLinkColour = vi.fn()
    inspect(inRoom, onLinkColour)
    expect(screen.getByText("Room colour")).toBeTruthy()
    const hex = screen.getByDisplayValue("#22c55e")
    fireEvent.change(hex, { target: { value: "#3b82f6" } })
    fireEvent.keyDown(hex, { key: "Enter" })
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/rooms/r1/")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({ color: "#3b82f6" })
    await waitFor(() =>
      expect(onLinkColour).toHaveBeenCalledWith("room", "r1", "#3b82f6")
    )
  })

  it("is read-only without change on the room", () => {
    perms.change = false
    inspect(inRoom)
    expect(screen.getByText("Room colour")).toBeTruthy()
    expect(screen.queryByDisplayValue("#22c55e")).toBeNull()
    // Only the name's own colour picker: none for the room's.
    const name = screen.getByText("Room colour").closest("aside")!
    const pickers = name.querySelectorAll('[aria-label="Open color picker"]')
    expect(pickers).toHaveLength(1)
    expect(pickers[0].closest('[data-part="area-name-style"]')).not.toBeNull()
  })

  it("a location link edits the location's colour", async () => {
    apiMock.mockResolvedValue({})
    inspect({
      ...area,
      location: { id: "l2", name: "Cage", color: "#f97316" },
    })
    expect(screen.getByText("Location colour")).toBeTruthy()
    const hex = screen.getByDisplayValue("#f97316")
    fireEvent.change(hex, { target: { value: "#000000" } })
    fireEvent.keyDown(hex, { key: "Enter" })
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(apiMock.mock.calls[0][0]).toBe("/api/locations/l2/")
  })
})

describe("the name's look", () => {
  it("sets a position from the grid, the plan's default shown first", () => {
    const onChange = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <AreaInspector
            plan={plan}
            area={area}
            onChange={onChange}
            onRestack={vi.fn()}
            onDelete={vi.fn()}
            nameDefault={{ position: "center", size: "l" }}
          />
        </TooltipProvider>
      </QueryClientProvider>
    )
    const grid = screen.getByRole("group", { name: "Name position" })
    expect(within(grid).getByLabelText("Centre").dataset.state).toBe("on")
    fireEvent.click(within(grid).getByLabelText("Bottom right"))
    expect(onChange).toHaveBeenLastCalledWith({
      name_style: { position: "bottom-right" },
    })
    fireEvent.click(screen.getByLabelText("Backplate"))
    expect(onChange).toHaveBeenLastCalledWith({ name_style: { plate: true } })
  })

  it("goes back to the plan's default", () => {
    const onChange = inspect({ ...area, name_style: { size: "s" } })
    fireEvent.click(screen.getByText("Use plan default"))
    expect(onChange).toHaveBeenLastCalledWith({ name_style: {} })
  })

  it("is not offered while the name is hidden", () => {
    inspect({ ...area, show_name: false })
    expect(screen.queryByRole("group", { name: "Name position" })).toBeNull()
  })
})
