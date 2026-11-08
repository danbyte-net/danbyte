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
import type { AreaShape, PlanShape } from "./shapes"

// Quick add on a site-wide floor (one made from the Site map): the Room
// picker's "+" asks for the room's location too - the one drawn around the
// area first - and the Location picker's "+" makes a location at the
// floor's site, each linking the area to what it made.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { room: true, location: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) =>
    Promise.resolve(
      path.startsWith("/api/locations/")
        ? {
            results: [
              { id: "bA", name: "Building A", color: "#f97316", parent: null },
              { id: "bB", name: "Building B", color: "#2563eb", parent: null },
            ],
          }
        : path.startsWith("/api/location-types/")
          ? { results: [{ id: "t1", name: "Building", color: "#22c55e" }] }
          : { results: [] }
    ),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (type: string, action: string) =>
      action !== "add"
        ? true
        : type === "room"
          ? perms.room
          : type === "location"
            ? perms.location
            : true,
  }),
}))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
if (!("ResizeObserver" in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

const plan = {
  id: "p1",
  name: "Site",
  cell_mm: 600,
  grid_width: 40,
  grid_height: 30,
  stack: null,
  site: { id: "s1", name: "AMS" },
  location: null,
} as unknown as FloorPlan

const base: AreaShape = {
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 6,
  y: 6,
  width: 2,
  height: 2,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 1,
  locked: false,
  created_at: "",
  updated_at: "",
}
// Building B drawn around the area.
const around: AreaShape = {
  ...base,
  id: "a0",
  x: 2,
  y: 2,
  width: 12,
  height: 10,
  z: 0,
  location: { id: "bB", name: "Building B", color: "#2563eb" },
}

function inspect(shapes: PlanShape[] = [around, base]) {
  const onChange = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <AreaInspector
          plan={plan}
          area={base}
          shapes={shapes}
          onChange={onChange}
          onRestack={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return onChange
}

beforeEach(() => {
  perms.room = true
  perms.location = true
})
afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

describe("a room on a site-wide floor", () => {
  it("asks for its location, the one drawn around first", async () => {
    apiMock.mockResolvedValue({ id: "r9", name: "Server room" })
    const onChange = inspect()
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    fireEvent.click(screen.getByRole("button", { name: "New room at AMS" }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() =>
      expect(within(dialog).getByText("Building B")).toBeTruthy()
    )
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Server room" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        room: { id: "r9", name: "Server room", code: "", color: "" },
      })
    )
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/rooms/")
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Server room",
      location_id: "bB",
    })
  })

  it("waits for a location when none is drawn around", async () => {
    inspect([base])
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    fireEvent.click(screen.getByRole("button", { name: "New room at AMS" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Server room" },
    })
    expect(
      within(dialog)
        .getByRole("button", {
          name: "Create",
        })
        .hasAttribute("disabled")
    ).toBe(true)
  })

  it("is not offered without permission to add rooms", () => {
    perms.room = false
    inspect()
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    expect(screen.queryByRole("button", { name: "New room at AMS" })).toBeNull()
  })
})

describe("a new location", () => {
  it("is made at the floor's site and linked", async () => {
    apiMock.mockResolvedValue({ id: "l9", name: "Gatehouse", color: "" })
    const onChange = inspect()
    fireEvent.click(screen.getByRole("button", { name: "Location" }))
    fireEvent.click(screen.getByRole("button", { name: "New location at AMS" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Parent")).toBeTruthy()
    expect(within(dialog).getByText("Location type")).toBeTruthy()
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "Gatehouse" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        location: { id: "l9", name: "Gatehouse", color: "" },
      })
    )
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/locations/")
    // Parent and type are optional: left empty, they are not sent.
    expect(JSON.parse(String(init?.body))).toEqual({
      site_id: "s1",
      name: "Gatehouse",
    })
  })

  it("is not offered without permission to add locations", () => {
    perms.location = false
    inspect()
    fireEvent.click(screen.getByRole("button", { name: "Location" }))
    expect(
      screen.queryByRole("button", { name: "New location at AMS" })
    ).toBeNull()
  })
})
