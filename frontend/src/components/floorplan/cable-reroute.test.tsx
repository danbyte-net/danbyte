// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  CablePlanPreview,
  CablePlanRequest,
  CablePlanRow,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
  StoredCablePath,
} from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { applyRoutes, draftPlanInput, EMPTY_CABLE_DRAFT } from "./cable-draft"
import { pathRoute } from "./cable-draw"
import { CablePopover } from "./cable-popover"
import {
  changedTrayIds,
  mergeIds,
  movedTileIds,
  routesTouched,
  staleRouteIds,
} from "./cable-reroute"
import {
  draftReducer,
  emptyDraft,
  initDraftHistory,
  usePlanDraft,
} from "./edit-history"
import { PlaceCablesPanel, RerouteCard, rerouteRequest } from "./place-cables"
import type { PlaceCablesApply } from "./place-cables"
import { PlanToolbar } from "./plan-toolbar"
import type { PlanShape } from "./shapes"
import type { StructShape } from "./structure"
import { useMoveReroute } from "./use-move-reroute"
import type { EditTile } from "./use-plan-edit-state"

// Re-routing after a move: a finished draft step that moved a tile (or
// changed a tray) a stored route uses offers "Update N routes?"; the panel
// previews the routes again with their length deltas; Apply folds them
// into the move's step, so one undo takes back both; declining leaves the
// routes drawn out of date. Out-of-date routes are also offered from a
// route's popover and from More → Update out-of-date routes….

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
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

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

const tile = (id: string, x: number, y = 2) =>
  ({ id, x, y, width: 1, height: 1, updated_at: "" }) as EditTile

/** A stored route t1 → t2 along tray tr1. */
function stored(
  from = "t1",
  to = "t2",
  trays = ["tr1"],
  length = 8500
): StoredCablePath {
  const points: [number, number][] = [
    [0.5, 2.5],
    [0.5, 1],
    [10.5, 1],
    [10.5, 2.5],
  ]
  return {
    kind: "trays",
    legs: [
      {
        from: { end: "A", tile: from, device: null, at: [0.5, 2.5] },
        to: { end: "B", tile: to, device: null, at: [10.5, 2.5] },
        points,
        trays: trays.map((id) => ({
          id,
          entry: [0.5, 1],
          exit: [10.5, 1],
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
    length_mm: length,
    version: "v1",
  }
}

const cable = (
  id: string,
  path: StoredCablePath | null
): FloorPlanCablePath => ({
  id,
  label: id.toUpperCase(),
  color: "",
  type: "",
  path,
  a_tiles: [],
  b_tiles: [],
  a_points: [],
  b_points: [],
  tray_ids: path?.tray_order ?? [],
})

const tray = (id: string, points: [number, number][]) =>
  ({
    part: "tray",
    id,
    name: id,
    kind: "",
    color: "",
    points,
    level: "overhead",
    elevation_mm: null,
    description: "",
    cables: [],
    hidden_cable_count: 0,
    created_at: "",
    updated_at: "",
  }) as unknown as StructShape

const tr1 = tray("tr1", [
  [0, 1],
  [11, 1],
])

describe("what a step touched", () => {
  it("finds the tiles moved and the trays changed", () => {
    const a = [tile("t1", 0), tile("t2", 10), tile("t3", 20)]
    const b = [a[0], { ...a[1], x: 14 }, { ...a[2], label: "x" }]
    expect([...movedTileIds(a, b)]).toEqual(["t2"])
    const moved = tray("tr1", [
      [0, 5],
      [11, 5],
    ])
    expect([...changedTrayIds([tr1], [moved])]).toEqual(["tr1"])
    expect([...changedTrayIds([tr1], [])]).toEqual(["tr1"])
    expect([...changedTrayIds([tr1], [{ ...tr1 }])]).toEqual([])
  })

  it("asks only about cables with a stored route on a moved tile", () => {
    const tiles = [tile("t1", 0), tile("t2", 14), tile("t3", 20)]
    const paths = [
      cable("c1", stored()),
      cable("c2", null),
      cable("c3", stored("t1", "t9")),
    ]
    expect(routesTouched(paths, tiles, new Set(["t2"]), new Set())).toEqual([
      "c1",
    ])
    // A tile without stored routes: nothing to ask.
    expect(routesTouched(paths, tiles, new Set(["t3"]), new Set())).toEqual([])
    // Moved back to where the route left it: up to date again.
    expect(
      routesTouched(
        paths,
        [tile("t1", 0), tile("t2", 10)],
        new Set(["t2"]),
        new Set()
      )
    ).toEqual([])
  })

  it("a tray the route rides changed touches it", () => {
    const paths = [cable("c1", stored()), cable("c2", stored("t1", "t2", []))]
    expect(
      routesTouched(paths, [tile("t1", 0)], new Set(), new Set(["tr1"]))
    ).toEqual(["c1"])
  })

  it("keeps a prompt's cables in order", () => {
    expect(mergeIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"])
    expect(mergeIds(undefined, ["x"])).toEqual(["x"])
  })
})

describe("out-of-date drawing", () => {
  const tileById = new Map([
    ["t1", tile("t1", 0)],
    ["t2", tile("t2", 10)],
  ])
  const trays = (pts: [number, number][]) =>
    new Map([["tr1", { ...tr1, points: pts } as unknown as FloorPlanTray]])

  it("is up to date where it was routed", () => {
    const r = pathRoute(
      "c1",
      stored(),
      tileById,
      trays([
        [0, 1],
        [11, 1],
      ])
    )!
    expect(r.stale).toBe(false)
    expect(staleRouteIds(new Map([["c1", r]]))).toEqual([])
  })

  it("a tray reshaped or deleted in the draft leaves it out of date", () => {
    const moved = pathRoute(
      "c1",
      stored(),
      tileById,
      trays([
        [0, 5],
        [11, 5],
      ])
    )!
    expect(moved.stale).toBe(true)
    const gone = pathRoute("c1", stored(), tileById, new Map())!
    expect(gone.stale).toBe(true)
    expect(staleRouteIds(new Map([["c1", gone]]))).toEqual(["c1"])
  })
})

describe("the move and its re-route are one undo step", () => {
  type D = ReturnType<typeof emptyDraft<{ id: string; x: number }>>
  const move = (d: D): D => ({ ...d, tiles: [{ id: "a", x: 5 }] })
  const reroute = (d: D): D => ({
    ...d,
    cables: { ...d.cables, trays: [{ id: "run" } as FloorPlanTray] },
  })

  it("amend folds into the step it names", () => {
    let h = initDraftHistory(emptyDraft([{ id: "a", x: 0 }]))
    h = draftReducer(h, { kind: "do", apply: move })
    const rev = h.rev
    h = draftReducer(h, { kind: "amend", apply: reroute, rev })
    expect(h.present.cables.trays).toHaveLength(1)
    expect(h.past).toHaveLength(1)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(0)
    expect(h.present.cables.trays).toHaveLength(0)
    h = draftReducer(h, { kind: "redo" })
    expect(h.present.tiles[0].x).toBe(5)
    expect(h.present.cables.trays).toHaveLength(1)
  })

  it("a draft changed since takes it as a step of its own", () => {
    let h = initDraftHistory(emptyDraft([{ id: "a", x: 0 }]))
    h = draftReducer(h, { kind: "do", apply: move })
    const rev = h.rev
    h = draftReducer(h, {
      kind: "do",
      apply: (d) => ({ ...d, tiles: [{ id: "a", x: 6 }] }),
    })
    h = draftReducer(h, { kind: "amend", apply: reroute, rev })
    expect(h.past).toHaveLength(3)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.cables.trays).toHaveLength(0)
    expect(h.present.tiles[0].x).toBe(6)
  })
})

describe("useMoveReroute", () => {
  function setup(paths: FloorPlanCablePath[]) {
    return renderHook(() => {
      const draft = usePlanDraft<EditTile, PlanShape, StructShape>()
      const reroute = useMoveReroute({
        draft,
        cablePaths: paths,
        enabled: true,
      })
      return { draft, ...reroute }
    })
  }
  const load = (r: ReturnType<typeof setup>) =>
    act(() =>
      r.result.current.draft.load([tile("t1", 0), tile("t2", 10)], [], [tr1])
    )
  const moveT2 = (r: ReturnType<typeof setup>, x: number) =>
    act(() =>
      r.result.current.draft.setTiles((ts) =>
        ts.map((t) => (t.id === "t2" ? { ...t, x } : t))
      )
    )

  it("asks after a move of a tile with stored routes", async () => {
    const r = setup([cable("c1", stored()), cable("c2", null)])
    load(r)
    expect(r.result.current.prompt).toBeNull()
    moveT2(r, 14)
    await waitFor(() =>
      expect(r.result.current.prompt?.cableIds).toEqual(["c1"])
    )
    expect(r.result.current.prompt?.rev).toBe(r.result.current.draft.rev)
  })

  it("does not ask when the tile moved has no stored routes", async () => {
    const r = setup([cable("c2", null)])
    load(r)
    moveT2(r, 14)
    await act(async () => {})
    expect(r.result.current.prompt).toBeNull()
  })

  it("waits for a drag to end", async () => {
    const r = setup([cable("c1", stored())])
    load(r)
    act(() => r.result.current.draft.beginGesture())
    moveT2(r, 12)
    moveT2(r, 14)
    await act(async () => {})
    expect(r.result.current.prompt).toBeNull()
    act(() => r.result.current.draft.endGesture())
    await waitFor(() =>
      expect(r.result.current.prompt?.cableIds).toEqual(["c1"])
    )
  })

  it("undoing the move drops the prompt", async () => {
    const r = setup([cable("c1", stored())])
    load(r)
    moveT2(r, 14)
    await waitFor(() => expect(r.result.current.prompt).not.toBeNull())
    act(() => {
      r.result.current.draft.undo()
    })
    await waitFor(() => expect(r.result.current.prompt).toBeNull())
  })

  it("a tray reshaped in the draft asks too", async () => {
    const r = setup([cable("c1", stored())])
    load(r)
    act(() =>
      r.result.current.draft.setStructure((s) =>
        s.map((x) =>
          x.id === "tr1"
            ? ({
                ...x,
                points: [
                  [0, 5],
                  [11, 5],
                ],
              } as StructShape)
            : x
        )
      )
    )
    await waitFor(() =>
      expect(r.result.current.prompt?.cableIds).toEqual(["c1"])
    )
  })

  it("Apply joins the move: one undo takes back both", async () => {
    const r = setup([cable("c1", stored())])
    load(r)
    moveT2(r, 14)
    await waitFor(() => expect(r.result.current.prompt).not.toBeNull())
    const rev = r.result.current.prompt!.rev!
    const row = {
      id: "c1",
      label: "C1",
      length: null,
      length_unit: "m",
      length_source: "",
      can_change: true,
      path: stored(),
      route: stored("t1", "t2", ["tr1"], 10900),
      reason: "",
      delta_mm: null,
      write_length: true,
    } as CablePlanRow
    act(() =>
      r.result.current.draft.amend(
        (d) => ({
          ...d,
          cables: applyRoutes(d.cables, {
            rows: [row],
            ticks: { c1: { route: true, length: true } },
            trays: [],
            newId: () => "x",
          }),
        }),
        rev
      )
    )
    expect(r.result.current.draft.cables.routes.c1).toBeTruthy()
    await act(async () => {})
    // Applying asks nothing new.
    expect(r.result.current.prompt?.rev).toBe(rev)
    act(() => {
      r.result.current.draft.undo()
    })
    expect(r.result.current.draft.cables).toEqual(EMPTY_CABLE_DRAFT)
    expect(r.result.current.draft.tiles.find((t) => t.id === "t2")!.x).toBe(10)
  })
})

describe("RerouteCard", () => {
  it("asks, and dismissing changes nothing", () => {
    const onReview = vi.fn()
    const onDismiss = vi.fn()
    wrap(<RerouteCard count={2} onReview={onReview} onDismiss={onDismiss} />)
    expect(screen.getByText("Update 2 routes?")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    expect(onReview).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it("hides with nothing to route", () => {
    const { container } = wrap(
      <RerouteCard count={0} onReview={() => {}} onDismiss={() => {}} />
    )
    expect(container.querySelector("[data-part=reroute-prompt]")).toBeNull()
  })
})

describe("Update routes panel", () => {
  const tiles = [tile("t1", 0), tile("t2", 14)] as FloorPlanTile[]
  const trays = [{ ...tr1, part: undefined }] as unknown as FloorPlanTray[]
  const rows: CablePlanRow[] = [
    {
      id: "c1",
      label: "C-1",
      length: 9,
      length_unit: "m",
      length_source: "",
      can_change: true,
      path: stored(),
      route: stored("t1", "t2", ["tr1"], 10900),
      reason: "",
      delta_mm: 1900,
      write_length: false,
      via: "trays",
    },
    {
      id: "c2",
      label: "C-2",
      length: null,
      length_unit: "m",
      length_source: "",
      can_change: true,
      path: stored(),
      route: stored("t1", "t2", ["tr1"], 10900),
      reason: "",
      delta_mm: null,
      write_length: true,
      via: "trays",
    },
  ]

  function open() {
    apiMock.mockImplementation(
      async () =>
        ({
          cables: rows,
          suggestions: [],
          truncated: false,
          hidden_count: 0,
          cell_mm: 600,
          scale_source: null,
        }) satisfies CablePlanPreview
    )
    const onApply = vi.fn<(a: PlaceCablesApply) => void>()
    const base = rerouteRequest(
      ["c1", "c2"],
      draftPlanInput({
        tiles,
        dirtyIds: new Set(["t2"]),
        deletedIds: new Set(["tray:tr9"]),
        cd: undefined,
        isTemp: () => false,
      })
    )
    wrap(
      <PlaceCablesPanel
        planId="p1"
        base={base}
        title="Update routes"
        tiles={tiles}
        trays={trays}
        onPreviews={() => {}}
        onTrayPick={() => {}}
        onApply={onApply}
        onClose={() => {}}
      />
    )
    return onApply
  }

  it("previews the cables against the draft", async () => {
    open()
    await screen.findByText("C-1")
    const req = JSON.parse(
      String(apiMock.mock.calls[0][1]!.body)
    ) as CablePlanRequest
    expect(req.cable_ids).toEqual(["c1", "c2"])
    expect(req.positions).toEqual({
      t2: { x: 14, y: 2, width: 1, height: 1 },
    })
    expect(req.removed_trays).toEqual(["tr9"])
    expect(screen.getAllByText("Update routes").length).toBeGreaterThan(0)
  })

  it("shows each length against the stored one", async () => {
    open()
    await screen.findByText("C-1")
    // The cable's own length, and the route's delta to it.
    expect(screen.getByText(/9 m \(\+1\.9 m\)/)).toBeTruthy()
    // No length: the stored route's length and the change.
    expect(screen.getByText(/was 8\.5 m \(\+2\.4 m\)/)).toBeTruthy()
  })

  it("a length a person entered is replaced only when ticked", async () => {
    const onApply = open()
    await screen.findByText("C-1")
    const replace = screen.getByRole("checkbox", { name: "Length of C-1" })
    expect(replace.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText("Replace measured length")).toBeTruthy()
    const setLen = screen.getByRole("checkbox", { name: "Length of C-2" })
    expect(setLen.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(screen.getByRole("checkbox", { name: "Route C-2" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 route" }))
    const { ticks } = onApply.mock.calls[0][0]
    expect(ticks.c1).toEqual({ route: true, length: false })
    expect(ticks.c2).toEqual({ route: false, length: false })
  })
})

describe("Re-route from the popover", () => {
  const target = (pinned: boolean) => ({
    ids: ["c1"],
    x: 10,
    y: 10,
    pinned,
  })
  const route = (stale: boolean) =>
    new Map([
      [
        "c1",
        {
          id: "c1",
          points: [],
          segs: [],
          trayIds: [],
          routed: true,
          runCells: 10,
          dropsMm: [0, 0],
          stored: true,
          stale,
        },
      ],
    ]) as unknown as Parameters<typeof CablePopover>[0]["routes"]

  it("offers Re-route on an out-of-date route", () => {
    const onReroute = vi.fn()
    wrap(
      <CablePopover
        target={target(true)}
        cablePaths={[cable("c1", stored())]}
        routes={route(true)}
        trays={[]}
        cellMm={600}
        onOpenChange={() => {}}
        onReroute={onReroute}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Re-route/ }))
    expect(onReroute).toHaveBeenCalledWith("c1")
  })

  it("not on a route that is up to date, or without Edit", () => {
    wrap(
      <CablePopover
        target={target(true)}
        cablePaths={[cable("c1", stored())]}
        routes={route(false)}
        trays={[]}
        cellMm={600}
        onOpenChange={() => {}}
        onReroute={() => {}}
      />
    )
    expect(screen.queryByRole("button", { name: /Re-route/ })).toBeNull()
    cleanup()
    wrap(
      <CablePopover
        target={target(true)}
        cablePaths={[cable("c1", stored())]}
        routes={route(true)}
        trays={[]}
        cellMm={600}
        onOpenChange={() => {}}
      />
    )
    expect(screen.queryByRole("button", { name: /Re-route/ })).toBeNull()
  })
})

describe("More → Update out-of-date routes…", () => {
  function toolbar(onUpdateStale?: () => void) {
    const props = {
      plan: { id: "p1" },
      view3d: false,
      canEdit: true,
      mode: "layout",
      tiles: [],
      search: "",
      onSearchChange: () => {},
      onPickTile: () => {},
      onFit: () => {},
      showGrid: true,
      onShowGridChange: () => {},
      prefs: {
        colorBy: "type",
        showRacks: false,
        showObjects: false,
        setViewPref: () => {},
      },
      hasRacks: false,
      drawingOpen: false,
      onToggleDrawing: () => {},
      exportMenu: null,
      onOpenSettings: () => {},
      onOpenBackground: () => {},
      onUpdateStale,
      canUndo: false,
      canRedo: false,
      onUndo: () => {},
      onRedo: () => {},
      isDirty: true,
      saving: false,
      onSave: () => {},
    } as unknown as Parameters<typeof PlanToolbar>[0]
    wrap(<PlanToolbar {...props} />)
  }
  const openMore = () => {
    const more = screen.getByRole("button", { name: /More/ })
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false })
  }

  it("opens the batch with unsaved edits", async () => {
    const onUpdateStale = vi.fn()
    toolbar(onUpdateStale)
    openMore()
    fireEvent.click(await screen.findByText("Update out-of-date routes…"))
    expect(onUpdateStale).toHaveBeenCalled()
  })

  it("is not offered with no route out of date", async () => {
    toolbar(undefined)
    openMore()
    await screen.findByRole("menuitemcheckbox", { name: "Grid" })
    expect(screen.queryByText("Update out-of-date routes…")).toBeNull()
  })
})
