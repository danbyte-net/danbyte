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

import type {
  CablePlanPreview,
  CablePlanRequest,
  CablePlanRow,
  FloorPlanTile,
  FloorPlanTray,
  StoredCablePath,
} from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  AfterPlacingCard,
  PlaceCablesPanel,
  placeCablesRequest,
  routableRows,
} from "./place-cables"
import type { AfterPlace, PlaceCablesApply } from "./place-cables"

// "After placing": one card for the room and the cables of what was just
// placed; the Route cables panel previews their routes, ticks per route
// and length, picks trays on the plan, suggests runs (kept as trays by
// default) and hands the ticked rows to the draft on Apply.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

afterEach(cleanup)
beforeEach(() => apiMock.mockReset())

const room = {
  room: { id: "r1", name: "Hall B", code: "B", color: "#22c55e" },
  objects: [{ kind: "rack", id: "rk", name: "RA" }],
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

function path(trays: string[] = [], kind?: StoredCablePath["kind"]) {
  const points: [number, number][] = [
    [0.5, 2.5],
    [10.5, 2.5],
  ]
  return {
    kind: kind ?? (trays.length ? "trays" : "direct"),
    legs: [
      {
        from: { end: "A", tile: "new-1", device: null, at: points[0] },
        to: { end: "B", tile: "t2", device: null, at: points[1] },
        points,
        trays: trays.map((id) => ({
          id,
          entry: points[0],
          exit: points[1],
          elevation_mm: 2700,
        })),
        waypoints: [],
      },
    ],
    tray_order: trays,
    run_mm: 6000,
    drop_a_mm: 800,
    drop_b_mm: 800,
    extra_mm: 0,
    slack_mm: 760,
    length_mm: 8500,
  } as StoredCablePath
}

function row(over: Partial<CablePlanRow>): CablePlanRow {
  return {
    id: "c1",
    label: "C-1",
    length: null,
    length_unit: "m",
    length_source: "",
    can_change: true,
    path: null,
    route: path(["tr1"]),
    reason: "",
    delta_mm: null,
    write_length: true,
    via: "trays",
    far: [{ hidden: false, device_name: "sw-b", port: "e1" }],
    off_floor: false,
    ...over,
  }
}

const tiles = [
  { id: "new-1", x: 0, y: 2, width: 1, height: 1 },
  { id: "t2", x: 10, y: 2, width: 1, height: 1 },
] as FloorPlanTile[]
const trays = [
  {
    id: "tr1",
    name: "T-03",
    points: [
      [0, 1],
      [11, 1],
    ],
  },
  {
    id: "tr2",
    name: "T-07",
    points: [
      [0, 4],
      [11, 4],
    ],
  },
] as unknown as FloorPlanTray[]

const after: AfterPlace = {
  objects: [{ kind: "rack", id: "rk", name: "RA" }],
  input: {
    new_tiles: [
      {
        id: "new-1",
        x: 0,
        y: 2,
        width: 1,
        height: 1,
        link_kind: "rack",
        link_id: "rk",
      },
    ],
  },
  room: null,
}

/** The answer to each preview: the rows as `make` says for the request. */
function answer(make: (req: CablePlanRequest) => Partial<CablePlanPreview>) {
  apiMock.mockImplementation(async (_url, init) => {
    const req = JSON.parse(String(init?.body ?? "{}")) as CablePlanRequest
    return {
      cables: [],
      suggestions: [],
      truncated: false,
      hidden_count: 0,
      cell_mm: 600,
      scale_source: null,
      ...make(req),
    }
  })
}
const lastRequest = () =>
  JSON.parse(String(apiMock.mock.calls.at(-1)![1]!.body)) as CablePlanRequest

type PanelProps = Parameters<typeof PlaceCablesPanel>[0]

function panel() {
  const props = {
    planId: "p1",
    after,
    tiles,
    trays,
    onPreviews: vi.fn<PanelProps["onPreviews"]>(),
    onTrayPick: vi.fn<PanelProps["onTrayPick"]>(),
    onApply: vi.fn<(a: PlaceCablesApply) => void>(),
    onClose: vi.fn(),
  }
  wrap(<PlaceCablesPanel {...props} />)
  return props
}

describe("AfterPlacingCard", () => {
  const card = (over: Partial<Parameters<typeof AfterPlacingCard>[0]>) =>
    wrap(
      <AfterPlacingCard
        room={null}
        roomBusy={false}
        onSetRoom={() => {}}
        cables={0}
        onRouteCables={() => {}}
        onDismiss={() => {}}
        {...over}
      />
    )

  it("shows nothing without a room or a cable to route", () => {
    const { container } = card({})
    expect(container.querySelector('[data-part="after-placing"]')).toBeNull()
  })

  it("offers the cables only when there are some", () => {
    const onRoute = vi.fn()
    card({ cables: 3, onRouteCables: onRoute })
    expect(screen.getByText("3 cables to objects on this floor")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Route 3 cables" }))
    expect(onRoute).toHaveBeenCalled()
    expect(screen.queryByText(/set room to/)).toBeNull()
  })

  it("is one card with the room offer", () => {
    const onSet = vi.fn()
    const onDismiss = vi.fn()
    const { container } = card({
      room,
      cables: 1,
      onSetRoom: onSet,
      onDismiss,
    })
    const cards = container.querySelectorAll('[data-part="after-placing"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].querySelector('[data-part="room-prompt"]')).toBeTruthy()
    expect(cards[0].querySelector('[data-part="place-cables"]')).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Set room" }))
    expect(onSet).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Route 1 cable" }))
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalled()
  })
})

describe("routableRows / placeCablesRequest", () => {
  it("counts the rows that may be routed", () => {
    expect(
      routableRows([
        row({}),
        row({ id: "c2", can_change: false }),
        row({ id: "c3", route: null, off_floor: true }),
      ]).map((r) => r.id)
    ).toEqual(["c1"])
  })

  it("asks for the placed objects against the draft, with the choices", () => {
    expect(
      placeCablesRequest(
        after,
        {
          c1: { via: "trays", trayIds: ["tr1"] },
          c2: { via: "suggest" },
          c3: { via: "auto" },
        },
        false
      )
    ).toEqual({
      objects: [{ kind: "rack", id: "rk" }],
      new_tiles: after.input.new_tiles,
      choices: {
        c1: { via: "trays", tray_ids: ["tr1"] },
        c2: { via: "suggest" },
      },
      keep_runs: false,
    })
  })
})

describe("PlaceCablesPanel", () => {
  it("previews the ticked routes with computed and stored lengths", async () => {
    answer(() => ({
      cables: [
        row({ length: 8, delta_mm: 500, write_length: false }),
        row({
          id: "c2",
          label: "C-2",
          route: null,
          off_floor: true,
          reason: "Leaves this floor.",
          far: [{ hidden: true, device_name: null, port: null }],
        }),
      ],
      scale_source: "assumed",
    }))
    const props = panel()
    await screen.findByText("C-1")
    expect(lastRequest().objects).toEqual([{ kind: "rack", id: "rk" }])
    expect(screen.getByText(/sw-b · e1 · T-03/)).toBeTruthy()
    expect(screen.getByText(/8 m \(\+0\.5 m\)/)).toBeTruthy()
    expect(
      screen.getByText("Drawing not calibrated - lengths may be wrong")
    ).toBeTruthy()
    // Leaving the floor: listed, not routed.
    expect(screen.getByText("Leaves this floor")).toBeTruthy()
    expect(screen.getByText("C-2 · Hidden")).toBeTruthy()
    await waitFor(() =>
      expect(props.onPreviews).toHaveBeenLastCalledWith(expect.any(Map))
    )
    const previews = props.onPreviews.mock.calls.at(-1)![0] as Map<
      string,
      unknown
    >
    expect([...previews.keys()]).toEqual(["c1"])
    // Unticking the route takes its preview away.
    fireEvent.click(screen.getByRole("checkbox", { name: "Route C-1" }))
    await waitFor(() =>
      expect(props.onPreviews).toHaveBeenLastCalledWith(undefined)
    )
  })

  it("routes a cable between floors through its riser", async () => {
    const up = path(["tr1"])
    up.riser = {
      tile: "t2",
      riser_mm: 3000,
      label: "R1",
      pair: "r9",
      floor_plan: { id: "p2", name: "Floor 2" },
    }
    answer(() => ({
      cables: [
        row({ route: up, via: "riser" }),
        row({
          id: "c2",
          label: "C-2",
          route: null,
          off_floor: true,
          reason: "Leaves this floor via R1.",
          via_riser: "R1",
        }),
      ],
    }))
    const props = panel()
    await screen.findByText("C-1")
    expect(screen.getByText(/T-03 → R1 to Floor 2/)).toBeTruthy()
    expect(screen.getByText("C-2 · sw-b · e1 · via R1")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 route" }))
    const applied = props.onApply.mock.calls[0][0]
    expect(applied.rows.map((r) => r.id)).toEqual(["c1"])
    expect(applied.rows[0].route?.riser?.tile).toBe("t2")
  })

  it("replaces a measured length only on its own tick", async () => {
    answer(() => ({ cables: [row({ length: 8, write_length: false })] }))
    const props = panel()
    await screen.findByText("Replace measured length")
    const length = screen.getByRole("checkbox", { name: "Length of C-1" })
    expect(length.getAttribute("data-state")).toBe("unchecked")
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 route" }))
    expect(props.onApply.mock.calls[0][0].ticks.c1).toEqual({
      route: true,
      length: false,
    })
    fireEvent.click(length)
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 route" }))
    expect(props.onApply.mock.calls[1][0].ticks.c1).toEqual({
      route: true,
      length: true,
    })
  })

  it("suggests runs for the cables no tray serves, kept as trays", async () => {
    answer((req) => {
      const via = req.choices?.c1.via
      if (via === "suggest")
        return {
          cables: [
            row({
              via: "suggest",
              route:
                req.keep_runs === false ? path([], "manual") : path(["run-1"]),
              suggestions: ["run-1"],
            }),
          ],
          suggestions: [
            {
              key: "run-1",
              level: "overhead",
              elevation_mm: 2700,
              points: [
                [0.5, 2.5],
                [10.5, 2.5],
              ],
              run: [
                [1, 2.5],
                [10, 2.5],
              ],
              cable_ids: ["c1"],
            },
          ],
        }
      if (via === "direct")
        return { cables: [row({ via: "direct", route: path() })] }
      return { cables: [row({ via: "direct", route: path() })] }
    })
    const props = panel()
    await screen.findByText("1 cable has no tray path")
    fireEvent.click(screen.getByRole("button", { name: "Suggest runs" }))
    await screen.findByText(/Suggested run/)
    expect(lastRequest().choices).toEqual({ c1: { via: "suggest" } })
    const keep = screen.getByRole("checkbox", { name: "Keep as a tray" })
    expect(keep.getAttribute("data-state")).toBe("checked")
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 route" }))
    const applied = props.onApply.mock.calls[0][0]
    expect(applied.suggestions.map((s) => s.key)).toEqual(["run-1"])
    expect(applied.rows[0].route?.tray_order).toEqual(["run-1"])
    // Untick: the run is the cable's own path.
    fireEvent.click(keep)
    await screen.findByText(/Suggested path/)
    expect(lastRequest().keep_runs).toBe(false)
  })

  it("picks trays on the plan for a cable", async () => {
    answer((req) => {
      const picked = req.choices?.c1.tray_ids ?? []
      return {
        cables: [
          row({
            via: picked.length ? "trays" : "direct",
            route: path(picked.length ? picked : []),
          }),
        ],
      }
    })
    const props = panel()
    await screen.findByText("1 cable has no tray path")
    fireEvent.click(screen.getByRole("button", { name: "Pick trays" }))
    await screen.findByText("Click trays on the plan")
    await waitFor(() =>
      expect(props.onTrayPick).toHaveBeenLastCalledWith(
        expect.objectContaining({ picked: [] })
      )
    )
    const pick = props.onTrayPick.mock.calls.at(-1)![0]!
    pick.onPick("tr2")
    await waitFor(() =>
      expect(lastRequest().choices).toEqual({
        c1: { via: "trays", tray_ids: ["tr2"] },
      })
    )
    await waitFor(() =>
      expect(props.onTrayPick).toHaveBeenLastCalledWith(
        expect.objectContaining({ picked: ["tr2"] })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(props.onTrayPick).toHaveBeenLastCalledWith(undefined)
    )
    expect(screen.getByText(/sw-b · e1 · T-07/)).toBeTruthy()
  })

  it("a cable the user may not change cannot be ticked", async () => {
    answer(() => ({ cables: [row({ can_change: false })] }))
    panel()
    const box = await screen.findByRole("checkbox", { name: "Route C-1" })
    expect(box.hasAttribute("disabled")).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "Apply 0 routes" })
        .hasAttribute("disabled")
    ).toBe(true)
  })
})
