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

// A plain area's Type: the tenant's area types as their colour badges, "+"
// to make one there and then (for those who may add area types), and a
// type dropped as soon as the area stands for a room or a location.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { add: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) =>
    Promise.resolve(
      path.startsWith("/api/area-types/")
        ? {
            results: [
              {
                id: "t1",
                name: "Parking",
                slug: "parking",
                color: "#2563eb",
                pattern: "hatched",
                icon: "car",
              },
            ],
          }
        : { results: [] }
    ),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (type: string, action: string) =>
      type === "areatype" && action === "add" ? perms.add : true,
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
  area_type: null,
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

function inspect(shape: AreaShape = area) {
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
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return onChange
}

beforeEach(() => {
  perms.add = true
  apiMock.mockResolvedValue({
    id: "t9",
    name: "Fence",
    color: "",
    pattern: "solid",
    icon: "",
  })
})
afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

describe("a plain area's type", () => {
  it("is offered under Just an area only", () => {
    inspect()
    expect(screen.getByText("Type")).toBeTruthy()
    cleanup()
    inspect({
      ...area,
      room: { id: "r1", name: "Room 210", code: "", color: "#22c55e" },
    })
    expect(screen.queryByText("Type")).toBeNull()
  })

  it("picks a type from the catalog", async () => {
    const onChange = inspect()
    fireEvent.click(screen.getByRole("combobox", { name: "Type" }))
    fireEvent.click(await screen.findByText("Parking"))
    expect(onChange).toHaveBeenCalledWith({
      area_type: expect.objectContaining({ id: "t1", pattern: "hatched" }),
    })
  })

  it("makes a new type with + and sets it", async () => {
    const onChange = inspect()
    fireEvent.click(screen.getByRole("button", { name: "New area type" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getAllByRole("textbox")[0], {
      target: { value: "Fence" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: /^(Create|Add)/ })
    )
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        area_type: {
          id: "t9",
          name: "Fence",
          color: "",
          pattern: "solid",
          icon: "",
        },
      })
    )
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/area-types/")
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: "Fence" })
  })

  it("has no + without permission to add area types", () => {
    perms.add = false
    inspect()
    expect(screen.queryByRole("button", { name: "New area type" })).toBeNull()
  })

  it("is dropped when the area comes to stand for a room", () => {
    const onChange = inspect({
      ...area,
      area_type: {
        id: "t1",
        name: "Parking",
        color: "#2563eb",
        pattern: "hatched",
        icon: "car",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Room" }))
    expect(onChange).toHaveBeenCalledWith({
      room: null,
      location: null,
      area_type: null,
    })
  })
})
