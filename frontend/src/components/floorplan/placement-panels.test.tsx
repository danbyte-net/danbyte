// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan, FloorPlanConflict, FloorPlanTile } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { linkedTile } from "./placement"
import {
  AssignRoomsDialog,
  ConflictDialog,
  PlanEmptyState,
  RoomPrompt,
  SelectionToolbar,
  useSetRooms,
} from "./placement-panels"
import type { RoomPromptState } from "./placement-panels"
import type { AreaShape } from "./shapes"

// The room prompt after a drop (never applied by itself), the bulk room
// assignment, the conflict dialog after a refused save, the floating
// toolbar and the empty floor's guidance.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({ apiAll: () => Promise.resolve([]) }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
// Radix measures the tooltip arrow; jsdom has no ResizeObserver.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({})
})

const room210 = { id: "r210", name: "Room 210", code: "210", color: "#22c55e" }
const plan = {
  id: "p1",
  cell_mm: 600,
  layout_mode: "free",
  location: { id: "loc1", name: "Building A" },
} as unknown as FloorPlan

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

/** The prompt as the editor wires it: Set room writes, × drops it. */
function PromptHarness({ prompt }: { prompt: RoomPromptState }) {
  const setRooms = useSetRooms("p1")
  const [shown, setShown] = useState(true)
  if (!shown) return null
  return (
    <RoomPrompt
      prompt={prompt}
      busy={setRooms.isPending}
      onSet={() =>
        setRooms.mutate(prompt, { onSuccess: () => setShown(false) })
      }
      onDismiss={() => setShown(false)}
    />
  )
}

const prompt: RoomPromptState = {
  room: room210,
  objects: [{ kind: "device", id: "d1", name: "sw1" }],
}

describe("the room prompt", () => {
  it("changes nothing until it is clicked", () => {
    wrap(<PromptHarness prompt={prompt} />)
    expect(screen.getByText(/sw1: set room to/)).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("dismissed, it never writes", () => {
    wrap(<PromptHarness prompt={prompt} />)
    fireEvent.click(screen.getByLabelText("Dismiss"))
    expect(screen.queryByText(/set room to/)).toBeNull()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("one click writes the object's room through its own endpoint", async () => {
    wrap(<PromptHarness prompt={prompt} />)
    fireEvent.click(screen.getByRole("button", { name: "Set room" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/devices/d1/")
    expect(init?.method).toBe("PATCH")
    expect(JSON.parse(String(init?.body))).toEqual({ room_id: "r210" })
  })
})

describe("Assign rooms from areas", () => {
  it("lists the mismatches and applies only the ticked ones", async () => {
    apiMock.mockImplementation(async (_path, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.dry_run)
        return {
          objects: [
            {
              kind: "device",
              id: "d1",
              name: "sw1",
              tile_id: "t1",
              room: null,
              area_room: room210,
              can_change: true,
            },
            {
              kind: "rack",
              id: "r1",
              name: "R1",
              tile_id: "t2",
              room: null,
              area_room: room210,
              can_change: true,
            },
            {
              kind: "device",
              id: "d2",
              name: "locked",
              tile_id: "t3",
              room: null,
              area_room: room210,
              can_change: false,
            },
          ],
        }
      return { applied: body.apply, skipped: [] }
    })
    wrap(<AssignRoomsDialog planId="p1" open onOpenChange={() => {}} />)
    await screen.findByText("sw1")
    // What the user may not change is never ticked.
    const locked = screen.getByLabelText("locked")
    expect(locked.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByLabelText("R1"))
    fireEvent.click(screen.getByRole("button", { name: "Assign 1" }))
    await waitFor(() =>
      expect(apiMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    expect(JSON.parse(String(apiMock.mock.calls[1][1]?.body))).toEqual({
      apply: [{ kind: "device", id: "d1" }],
    })
  })
})

describe("Changed elsewhere", () => {
  const conflicts: FloorPlanConflict[] = [
    { kind: "tile", id: "t1", current: null, changed_by: "bob" },
    {
      kind: "label",
      id: "l1",
      current: { text: "B" } as unknown as FloorPlanConflict["current"],
      changed_by: "",
    },
  ]

  it("asks per row, keeping mine by default", () => {
    const onResolve = vi.fn()
    wrap(
      <ConflictDialog
        conflicts={conflicts}
        nameOf={(c) => (c.kind === "tile" ? "sw1" : "North side")}
        saving={false}
        onResolve={onResolve}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText("Deleted by bob")).toBeTruthy()
    expect(screen.getByText("Changed")).toBeTruthy()
    const label = document.querySelector('[data-conflict="l1"]')!
    fireEvent.click(
      [...label.querySelectorAll("button")].find(
        (b) => b.textContent === "Take theirs"
      )!
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onResolve).toHaveBeenCalledWith({ l1: "theirs" })
  })
})

describe("the floating toolbar", () => {
  const area: AreaShape = {
    kind: "area",
    id: "a1",
    shape: "rect",
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    rotation: 0,
    points: [],
    room: room210,
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
  const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile => ({
    ...linkedTile(
      {
        kind: "device",
        id: "d1",
        name: "sw1",
        rank: 0,
        room: null,
        location: null,
        status: null,
        role: null,
        photo: null,
        placed_count: 0,
        placed_on: [],
      },
      { x: 1, y: 1, width: 1, height: 1 },
      "t1",
      "icon"
    ),
    ...patch,
  })
  const handlers = () => ({
    onTileDisplay: vi.fn(),
    onRestackTile: vi.fn(),
    onDeleteTile: vi.fn(),
    onSetRoom: vi.fn(),
    onChangeShape: vi.fn(),
    onRestackShape: vi.fn(),
    onDeleteShape: vi.fn(),
  })

  it("offers the area's room for a tile standing in another room", () => {
    const h = handlers()
    wrap(
      <SelectionToolbar
        plan={plan}
        tile={tile()}
        shape={null}
        shapes={[area]}
        {...h}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Set room/ }))
    expect(h.onSetRoom).toHaveBeenCalledWith({
      room: room210,
      objects: [{ kind: "device", id: "d1", name: "sw1" }],
    })
    fireEvent.click(screen.getByLabelText("Bring forward"))
    expect(h.onRestackTile).toHaveBeenCalledWith("t1", 1)
    fireEvent.click(screen.getByLabelText("Delete"))
    expect(h.onDeleteTile).toHaveBeenCalledWith("t1")
  })

  it("has no room button when the room already matches", () => {
    wrap(
      <SelectionToolbar
        plan={plan}
        tile={tile({ linked: { ...tile().linked!, room: room210 } })}
        shape={null}
        shapes={[area]}
        {...handlers()}
      />
    )
    expect(screen.queryByRole("button", { name: /Set room/ })).toBeNull()
  })

  it("switches a device with a photo between photo and tile", () => {
    const h = handlers()
    const photo = {
      url: "/m/a.png",
      aspect: 0.5,
      source: "type" as const,
      width_mm: null,
    }
    const t = tile({ photo })
    wrap(
      <SelectionToolbar plan={plan} tile={t} shape={null} shapes={[]} {...h} />
    )
    fireEvent.click(screen.getByLabelText("Show as photo"))
    expect(h.onTileDisplay).toHaveBeenCalledWith(t, "photo")
  })

  it("offers the photo on a grid plan too", () => {
    const h = handlers()
    const t = tile({
      photo: { url: "/m/a.png", aspect: 0.5, source: "type", width_mm: null },
    })
    wrap(
      <SelectionToolbar
        plan={{ ...plan, layout_mode: "grid" }}
        tile={t}
        shape={null}
        shapes={[]}
        {...h}
      />
    )
    fireEvent.click(screen.getByLabelText("Show as photo"))
    expect(h.onTileDisplay).toHaveBeenCalledWith(t, "photo")
  })

  it("without a photo, the button is disabled and says where one comes from", async () => {
    const h = handlers()
    wrap(
      <SelectionToolbar
        plan={plan}
        tile={tile()}
        shape={null}
        shapes={[]}
        {...h}
      />
    )
    const tip =
      "No photo: add an image to the device or a front image to its type"
    const btn = screen.getByLabelText(tip)
    expect(btn.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(btn)
    expect(h.onTileDisplay).not.toHaveBeenCalled()
    fireEvent.focus(btn)
    expect((await screen.findByRole("tooltip")).textContent).toContain(tip)
    expect(screen.queryByLabelText("Show as photo")).toBeNull()
  })

  it("locks an area, and links its room from a picker", () => {
    const h = handlers()
    wrap(
      <SelectionToolbar
        plan={plan}
        tile={null}
        shape={area}
        shapes={[area]}
        {...h}
      />
    )
    fireEvent.click(screen.getByLabelText("Lock"))
    expect(h.onChangeShape).toHaveBeenCalledWith("a1", { locked: true })
    expect(screen.getByLabelText("Link room")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Send back"))
    expect(h.onRestackShape).toHaveBeenCalledWith("a1", -1)
  })
})

describe("an empty floor", () => {
  it("offers the next steps", () => {
    const onDrawRoom = vi.fn()
    const onPlace = vi.fn()
    wrap(<PlanEmptyState onDrawRoom={onDrawRoom} onPlace={onPlace} />)
    fireEvent.click(screen.getByRole("button", { name: "Draw a room" }))
    fireEvent.click(screen.getByRole("button", { name: "Place devices" }))
    expect(onDrawRoom).toHaveBeenCalled()
    expect(onPlace).toHaveBeenCalled()
  })
})
