// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type {
  CablePlanRow,
  CablePlanSuggestion,
  FloorPlanCablePath,
  FloorPlanTile,
  StoredCablePath,
} from "@/lib/api"

import {
  EMPTY_CABLE_DRAFT,
  applyRoutes,
  cableDraftDirty,
  cableDraftPayload,
  defaultTicks,
  draftPlanInput,
  nextRunNumber,
  withDraftRoutes,
} from "./cable-draft"
import { usePlanDraft } from "./edit-history"

// "After placing" → Route cables: the routes applied into the draft (one
// undo step), what Save sends for them, and how the plan draws them.

function tile(id: string, x: number, y: number): FloorPlanTile {
  return { id, x, y, width: 1, height: 1 } as FloorPlanTile
}

function route(
  from: string,
  to: string,
  points: [number, number][],
  trays: string[] = []
): StoredCablePath {
  return {
    kind: trays.length ? "trays" : "direct",
    legs: [
      {
        from: { end: "A", tile: from, device: null, at: points[0] },
        to: { end: "B", tile: to, device: null, at: points.at(-1)! },
        points,
        trays: trays.map((id) => ({
          id,
          entry: points[0],
          exit: points.at(-1)!,
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
  }
}

function row(over: Partial<CablePlanRow> = {}): CablePlanRow {
  return {
    id: "c1",
    label: "C-1",
    length: null,
    length_unit: "m",
    length_source: "",
    can_change: true,
    path: null,
    route: route("new-1", "t2", [
      [0.5, 2.5],
      [10.5, 2.5],
    ]),
    reason: "",
    delta_mm: null,
    write_length: true,
    via: "direct",
    cable_version: "2026-10-30T10:00:00Z",
    ...over,
  }
}

const run: CablePlanSuggestion = {
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
}

let n = 100
const newId = () => `new-${++n}`

describe("defaultTicks", () => {
  it("routes a row it may, and fills a blank or computed length", () => {
    expect(defaultTicks(row())).toEqual({ route: true, length: true })
  })
  it("never ticks over a length a person entered", () => {
    expect(defaultTicks(row({ length: 8, write_length: false }))).toEqual({
      route: true,
      length: false,
    })
  })
  it("leaves a cable it may not change or that leaves the floor", () => {
    expect(defaultTicks(row({ can_change: false })).route).toBe(false)
    expect(
      defaultTicks(row({ off_floor: true, route: null, reason: "x" })).route
    ).toBe(false)
  })
})

describe("applyRoutes", () => {
  it("puts the ticked rows in the draft with their lengths", () => {
    const rows = [
      row(),
      row({ id: "c2", label: "C-2", write_length: false, length: 9 }),
      row({ id: "c3", label: "C-3" }),
    ]
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows,
      ticks: {
        c1: { route: true, length: true },
        c2: { route: true, length: true },
        c3: { route: false, length: false },
      },
      trays: [],
      newId,
    })
    expect(Object.keys(cd.routes).sort()).toEqual(["c1", "c2"])
    expect(cd.routes.c1.length).toBe("write")
    expect(cd.routes.c1.cableVersion).toBe("2026-10-30T10:00:00Z")
    // A measured length is replaced only because its tick said so.
    expect(cd.routes.c2.length).toBe("replace")
    expect(cd.trays).toEqual([])
  })

  it("keeps a suggested run as a new tray, named after the plan's", () => {
    const r = row({
      via: "suggest",
      route: route(
        "new-1",
        "t2",
        [
          [0.5, 2.5],
          [1, 2.5],
          [10, 2.5],
          [10.5, 2.5],
        ],
        ["run-1"]
      ),
    })
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [r],
      ticks: { c1: { route: true, length: false } },
      suggestions: [run],
      trays: [{ name: "Run 2" }, { name: "Ladder A" }],
      newId,
    })
    expect(cd.trays).toHaveLength(1)
    const tray = cd.trays[0]
    expect(tray.name).toBe("Run 3")
    expect(tray.id.startsWith("new-")).toBe(true)
    expect(tray.points).toEqual(run.run)
    expect(cd.routes.c1.route.tray_order).toEqual([tray.id])
    expect(cd.routes.c1.route.legs[0].trays[0].id).toBe(tray.id)
    expect(cd.routes.c1.length).toBeUndefined()
  })

  it("makes no tray for a run left as the cable's own path", () => {
    const own = route("new-1", "t2", [
      [0.5, 2.5],
      [10.5, 2.5],
    ])
    own.kind = "manual"
    own.legs[0].elevation_mm = 2700
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [row({ via: "suggest", route: own })],
      ticks: { c1: { route: true, length: true } },
      suggestions: [run],
      trays: [],
      newId,
    })
    expect(cd.trays).toEqual([])
    expect(cd.routes.c1.route.kind).toBe("manual")
  })

  it("nothing ticked changes nothing", () => {
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [row()],
      ticks: { c1: { route: false, length: false } },
      trays: [],
      newId,
    })
    expect(cd).toBe(EMPTY_CABLE_DRAFT)
    expect(cableDraftDirty(cd)).toBe(false)
  })
})

describe("nextRunNumber", () => {
  it("counts on from the highest Run", () => {
    expect(nextRunNumber([])).toBe(1)
    expect(nextRunNumber([{ name: "Run 4" }, { name: "Run 10" }])).toBe(11)
  })
})

describe("cableDraftPayload", () => {
  const tiles = [tile("new-1", 0, 2), tile("t2", 10, 2)]

  it("sends the kept runs and the routes with their legs", () => {
    const own = route("new-1", "t2", [
      [0.5, 2.5],
      [10.5, 2.5],
    ])
    own.kind = "manual"
    own.legs[0].elevation_mm = 2700
    const cd = {
      routes: {
        c1: {
          cable: "c1",
          label: "C-1",
          route: route(
            "new-1",
            "t2",
            [
              [0.5, 2.5],
              [10.5, 2.5],
            ],
            ["new-7"]
          ),
          version: "v1",
          length: "replace" as const,
          cableVersion: "cv",
          rev: 1,
        },
        c2: { cable: "c2", label: "C-2", route: own, rev: 2 },
      },
      trays: [
        {
          id: "new-7",
          name: "Run 1",
          points: run.run!,
          level: "overhead" as const,
        } as never,
      ],
    }
    const out = cableDraftPayload(cd, tiles)
    expect(out.trays).toEqual({
      create: [
        { key: "new-7", name: "Run 1", points: run.run, level: "overhead" },
      ],
    })
    expect(out.cable_paths!.upsert).toEqual([
      {
        cable: "c1",
        kind: "trays",
        legs: [
          {
            points: [
              [0.5, 2.5],
              [10.5, 2.5],
            ],
          },
        ],
        tray_order: ["new-7"],
        version: "v1",
        replace_length: true,
        cable_version: "cv",
      },
      {
        cable: "c2",
        kind: "manual",
        legs: [
          {
            points: [
              [0.5, 2.5],
              [10.5, 2.5],
            ],
            elevation_mm: 2700,
          },
        ],
        tray_order: [],
      },
    ])
    expect(out.dropped).toEqual([])
  })

  it("an end moved since: routed again on the server, without its legs", () => {
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [row()],
      ticks: { c1: { route: true, length: true } },
      trays: [],
      newId,
    })
    const out = cableDraftPayload(cd, [tile("new-1", 3, 2), tile("t2", 10, 2)])
    const up = out.cable_paths!.upsert[0]
    expect(up.legs).toBeUndefined()
    expect(up.write_length).toBe(true)
  })

  it("an end gone: left out and named", () => {
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [row()],
      ticks: { c1: { route: true, length: false } },
      trays: [],
      newId,
    })
    const out = cableDraftPayload(cd, [tile("t2", 10, 2)])
    expect(out.cable_paths).toBeUndefined()
    expect(out.dropped).toEqual(["C-1"])
  })

  it("an empty draft sends nothing", () => {
    expect(cableDraftPayload(EMPTY_CABLE_DRAFT, tiles)).toEqual({
      dropped: [],
    })
  })
})

describe("withDraftRoutes", () => {
  it("draws a draft route as the cable's path, and adds cables not listed", () => {
    const cd = applyRoutes(EMPTY_CABLE_DRAFT, {
      rows: [row(), row({ id: "c9", label: "C-9" })],
      ticks: {
        c1: { route: true, length: false },
        c9: { route: true, length: false },
      },
      trays: [],
      newId,
    })
    const listed = [
      {
        id: "c1",
        label: "C-1",
        color: "",
        type: "",
        a_tiles: [],
        b_tiles: ["t2"],
        a_points: [],
        b_points: [],
        tray_ids: [],
        path: null,
      },
    ] as FloorPlanCablePath[]
    const out = withDraftRoutes(listed, cd)
    expect(out).toHaveLength(2)
    expect(out[0].path?.version).toMatch(/^draft-/)
    expect(out[1].id).toBe("c9")
    expect(withDraftRoutes(listed, EMPTY_CABLE_DRAFT)).toBe(listed)
  })
})

describe("draftPlanInput", () => {
  it("names the unsaved tiles, the moved ones, the deleted ones", () => {
    const placed = {
      ...tile("new-1", 4, 6),
      linked: { kind: "device", id: "d1", name: "ap" },
    } as FloorPlanTile
    const moved = tile("t2", 6, 2)
    const zone = tile("new-2", 0, 0)
    const input = draftPlanInput({
      tiles: [placed, moved, zone, tile("t3", 1, 1)],
      dirtyIds: new Set(["new-1", "t2", "new-2"]),
      deletedIds: new Set(["t9", "area:a1"]),
      cd: EMPTY_CABLE_DRAFT,
      isTemp: (id) => id.startsWith("new-"),
    })
    expect(input).toEqual({
      positions: { t2: { x: 6, y: 2, width: 1, height: 1 } },
      new_tiles: [
        {
          id: "new-1",
          x: 4,
          y: 6,
          width: 1,
          height: 1,
          link_kind: "device",
          link_id: "d1",
        },
      ],
      removed_tiles: ["t9"],
    })
  })
})

describe("the cable draft in the plan's history", () => {
  it("an apply is one undo step, and a load forgets it", () => {
    const { result } = renderHook(() => usePlanDraft<FloorPlanTile>())
    act(() => result.current.load([tile("t2", 10, 2)]))
    act(() =>
      result.current.setCables((cd) =>
        applyRoutes(cd, {
          rows: [row(), row({ id: "c2", label: "C-2" })],
          ticks: {
            c1: { route: true, length: true },
            c2: { route: true, length: false },
          },
          trays: [],
          newId,
        })
      )
    )
    expect(Object.keys(result.current.cables.routes)).toHaveLength(2)
    expect(result.current.canUndo).toBe(true)
    act(() => {
      result.current.undo()
    })
    expect(result.current.cables).toBe(EMPTY_CABLE_DRAFT)
    expect(result.current.canUndo).toBe(false)
    act(() => {
      result.current.redo()
    })
    expect(Object.keys(result.current.cables.routes)).toHaveLength(2)
    act(() => result.current.load([]))
    expect(result.current.cables).toBe(EMPTY_CABLE_DRAFT)
  })
})
