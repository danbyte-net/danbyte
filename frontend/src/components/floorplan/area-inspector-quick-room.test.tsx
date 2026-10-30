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
// only to users who may add rooms, and links the area to it.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { add: true },
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
      type === "room" && action === "add" ? perms.add : true,
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

function inspect() {
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
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return onChange
}

beforeEach(() => {
  perms.add = true
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
