import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import {
  DETAIL_ENTER_PX_PER_M,
  DETAIL_EXIT_PX_PER_M,
  FULL_SHOWS,
  ROOM_ENTER_PX_PER_M,
  ROOM_EXIT_PX_PER_M,
  buildingFootprint,
  countOf,
  detailLevel,
  hiddenAreaNames,
  levelShows,
  placeRoomLabels,
  pxPerMetre,
  quadsOverlap,
  readDetailMode,
  roomFacts,
  roomNesting,
  shortTileNames,
  upright,
} from "./plan-detail"
import { planRooms } from "./plan-lod"
import { rowHead, rowName } from "./plan-rows"
import type { AreaShape, Pt } from "./shapes"

// Detail by zoom (plan-detail.ts): the level a zoom is at, what each
// level draws, the rooms' facts and labels, short names, the area names'
// collision pass and the building's footprint.

const area = (id: string, patch: Partial<AreaShape> = {}): AreaShape =>
  ({
    kind: "area",
    id,
    shape: "rect",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    points: [],
    room: null,
    location: null,
    label: id,
    color: "",
    fill_opacity: 12,
    border: "solid",
    show_name: true,
    z: 0,
    locked: false,
    created_at: "",
    updated_at: "",
    ...patch,
  })

const tile = (
  id: string,
  x: number,
  y: number,
  patch: Partial<FloorPlanTile> = {}
): FloorPlanTile =>
  ({
    id,
    x,
    y,
    width: 1,
    height: 2,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "",
    status: "",
    linked: { kind: "rack", id: `r-${id}`, name: id },
    ...patch,
  }) as unknown as FloorPlanTile

const typed = (name: string, isZone = false) =>
  ({
    id: name,
    name,
    slug: name,
    color: "#0ea5e9",
    icon: "",
    default_width: 1,
    default_height: 1,
    is_zone: isZone,
    has_fov: false,
  }) as FloorPlanTile["tile_type"]

describe("the level", () => {
  it("is the plan's metre on screen", () => {
    // 40 px a cell of 600 mm: 66.7 px a metre.
    expect(pxPerMetre(40, 600)).toBeCloseTo(66.67, 1)
  })

  it("steps overview, room, detail as the metre grows", () => {
    expect(detailLevel(5)).toBe("overview")
    expect(detailLevel(20)).toBe("room")
    expect(detailLevel(80)).toBe("detail")
  })

  it("holds each level until the wider threshold back", () => {
    // Up: the entry thresholds.
    expect(detailLevel(ROOM_ENTER_PX_PER_M - 0.5, "overview")).toBe("overview")
    expect(detailLevel(ROOM_ENTER_PX_PER_M, "overview")).toBe("room")
    expect(detailLevel(DETAIL_ENTER_PX_PER_M - 0.5, "room")).toBe("room")
    expect(detailLevel(DETAIL_ENTER_PX_PER_M, "room")).toBe("detail")
    // Down: held past the entry, let go under the exit.
    expect(detailLevel(DETAIL_EXIT_PX_PER_M + 0.5, "detail")).toBe("detail")
    expect(detailLevel(DETAIL_EXIT_PX_PER_M - 0.5, "detail")).toBe("room")
    expect(detailLevel(ROOM_EXIT_PX_PER_M + 0.5, "room")).toBe("room")
    expect(detailLevel(ROOM_EXIT_PX_PER_M - 0.5, "room")).toBe("overview")
    // A zoom about a threshold does not flicker.
    let lvl = detailLevel(ROOM_ENTER_PX_PER_M + 0.1, "overview")
    for (const ppm of [10, 10.5, 9.5, 10.9, 9.2]) {
      lvl = detailLevel(ppm, lvl)
      expect(lvl).toBe("room")
    }
  })

  it("jumps straight to detail from afar", () => {
    expect(detailLevel(200, "overview")).toBe("detail")
    expect(detailLevel(2, "detail")).toBe("overview")
  })

  it("reads Auto unless the plan chose Always full", () => {
    expect(readDetailMode(undefined)).toBe("auto")
    expect(readDetailMode("full")).toBe("full")
    expect(readDetailMode("x")).toBe("auto")
  })
})

describe("what each level shows", () => {
  it("Always full shows everything at every level, as before", () => {
    for (const lvl of ["overview", "room", "detail"] as const)
      expect(levelShows(lvl, "full")).toBe(FULL_SHOWS)
    expect(FULL_SHOWS).toMatchObject({
      tiles: true,
      callouts: "all",
      hallPlates: true,
      cones: "all",
      pattern: "full",
      doors: true,
      areaNames: "plain",
      roomLabels: false,
      maskMap: false,
      shortNames: false,
      capacity: "all",
    })
  })

  it("overview: rooms only", () => {
    const s = levelShows("overview", "auto")
    expect(s).toMatchObject({
      tiles: false,
      callouts: "none",
      rows: false,
      hallPlates: false,
      zones: "none",
      cones: "none",
      coverage: false,
      pattern: "none",
      trays: false,
      cables: false,
      doors: false,
      raised: false,
      areaNames: "none",
      roomLabels: true,
      maskMap: true,
    })
  })

  it("room: rows and icons, callouts and names for the focus only", () => {
    const s = levelShows("room", "auto")
    expect(s).toMatchObject({
      tiles: true,
      tileNames: "focus",
      callouts: "focus",
      rows: true,
      hallPlates: false,
      zones: "light",
      cones: "focus",
      pattern: "none",
      doors: true,
      areaNames: "sorted",
      roomLabels: false,
    })
  })

  it("detail: short names, the bar on the focus, a fine hatch", () => {
    const s = levelShows("detail", "auto")
    expect(s).toMatchObject({
      tiles: true,
      tileNames: "all",
      shortNames: true,
      capacity: "focus",
      quietMarks: true,
      callouts: "all",
      zones: "light",
      cones: "focus",
      pattern: "fine",
    })
  })

  it("keeps the bars when Colour by is a capacity measure", () => {
    expect(
      levelShows("detail", "auto", { capacityColour: true }).capacity
    ).toBe("all")
  })

  it("draws every cone with Camera coverage on", () => {
    const s = levelShows("detail", "auto", { coverage: true })
    expect(s.cones).toBe("all")
    expect(s.coverage).toBe(true)
    expect(levelShows("overview", "auto", { coverage: true }).cones).toBe(
      "none"
    )
  })
})

describe("short names", () => {
  it("leave out what the row's label says", () => {
    const names = ["DH5-A01", "DH5-A02", "DH5-A03"]
    expect(rowHead(names)).toBe("DH5-")
    // The row's label says the rest: "Row A · A01–A03".
    expect(rowName(names).text).toBe("Row A · A01–A03")
    const short = shortTileNames([{ members: ["a", "b", "c"], names }])
    expect([...short]).toEqual([
      ["a", "A01"],
      ["b", "A02"],
      ["c", "A03"],
    ])
  })

  it("keep a name that shares no head", () => {
    expect(rowHead(["R01", "R02", "R03"])).toBe("")
    expect(
      shortTileNames([{ members: ["a", "b"], names: ["web-1", "db-2"] }]).size
    ).toBe(0)
  })
})

describe("a room's facts", () => {
  const rooms = planRooms([
    area("Data Hall 5", { x: 0, y: 0, width: 20, height: 20 }),
    area("UPS room", { x: 30, y: 0, width: 10, height: 10 }),
    area("Stair N", { x: 50, y: 0, width: 5, height: 5 }),
    area("Office", { x: 60, y: 0, width: 10, height: 10 }),
  ])
  const ups = typed("UPS")
  const tiles = [
    tile("r1", 1, 1),
    tile("r2", 2, 1),
    tile("r3", 3, 1),
    tile("u1", 31, 1, { linked: null, tile_type: ups }),
    tile("u2", 33, 1, { linked: null, tile_type: ups }),
    tile("u3", 35, 1, { linked: null, tile_type: ups }),
    tile("s1", 51, 1, { linked: null, tile_type: typed("Stairs") }),
    tile("z1", 61, 1, {
      linked: null,
      tile_type: typed("Cold aisle", true),
    }),
    tile("c1", 62, 1, { linked: null, tile_type: typed("Cooling unit") }),
    tile("c2", 63, 1, { linked: null, tile_type: typed("Cooling unit") }),
  ]
  const facts = roomFacts(rooms, tiles, {
    fillOf: (t) =>
      new Map([
        ["r1", { used: 21, total: 42 }],
        ["r2", { used: 42, total: 42 }],
      ]).get(t.id),
    checkOf: (t) => (t.id === "r2" || t.id === "r3" ? "down" : null),
  })

  it("counts the racks and how full they are", () => {
    expect(facts.get("Data Hall 5")?.text).toBe("3 racks · 75% full")
  })

  it("counts other kinds by their type", () => {
    expect(facts.get("UPS room")?.text).toBe("3 UPS")
    expect(facts.get("Office")?.text).toBe("2 cooling units")
  })

  it("says nothing of a lone tile the room is named for, nor zones", () => {
    expect(facts.get("Stair N")?.text).toBe("")
  })

  it("carries the worst alarm and how many", () => {
    expect(facts.get("Data Hall 5")?.alarm).toEqual({
      check: "down",
      count: 2,
    })
    expect(facts.get("UPS room")?.alarm).toBeNull()
  })

  it("counts a type's name plainly", () => {
    expect(countOf("UPS", 3)).toBe("3 UPS")
    expect(countOf("Cooling unit", 6)).toBe("6 cooling units")
    expect(countOf("Switchgear", 2)).toBe("2 switchgear")
    expect(countOf("Desk", 1)).toBe("1 desk")
  })
})

describe("the overview's room labels", () => {
  const hall = area("Data Hall 1", { x: 0, y: 0, width: 40, height: 30 })
  const facts = new Map([
    ["Data Hall 1", { text: "72 racks · 61% full", alarm: null }],
  ])

  it("centres the name with its facts where both fit", () => {
    const rooms = planRooms([hall])
    const [l] = placeRoomLabels([hall], rooms, facts, 10)
    expect(l).toMatchObject({
      id: "Data Hall 1",
      at: [20, 15],
      angle: 0,
      facts: "72 racks · 61% full",
    })
  })

  it("leaves out the facts, then the label, as the room shrinks", () => {
    const rooms = planRooms([hall])
    // 40 cells at 2.7 px: 108 px - the name fits, its facts do not.
    expect(placeRoomLabels([hall], rooms, facts, 2.7)[0]?.facts).toBe("")
    expect(placeRoomLabels([hall], rooms, facts, 1)).toEqual([])
  })

  it("turns along a long narrow room where only that fits", () => {
    const strip = area("Generator yard", {
      x: 0,
      y: 0,
      width: 4,
      height: 60,
    })
    const [l] = placeRoomLabels([strip], planRooms([strip]), new Map(), 10)
    expect(l.angle).toBe(90)
  })

  it("gives way to the bigger room when two would touch", () => {
    const big = area("Big", { x: 0, y: 0, width: 30, height: 10 })
    const small = area("Small", { x: 12, y: 3, width: 6, height: 4 })
    const rooms = planRooms([big, small])
    const labels = placeRoomLabels([big, small], rooms, new Map(), 10)
    expect(labels.map((l) => l.id)).toEqual(["Big"])
  })

  it("names a part of a room under it, and no outline round rooms", () => {
    const building = area("ASB1", { x: 0, y: 0, width: 100, height: 100 })
    const a = area("Hall A", { x: 0, y: 0, width: 50, height: 60 })
    const b = area("Hall B", { x: 50, y: 0, width: 50, height: 60 })
    const cage = area("Cage", { x: 30, y: 40, width: 15, height: 15 })
    const shapes = [building, a, b, cage]
    const rooms = planRooms(shapes)
    expect(roomNesting(rooms).outlines).toEqual(new Set(["ASB1"]))
    const labels = placeRoomLabels(shapes, rooms, new Map(), 4)
    expect(labels.map((l) => l.id).sort()).toEqual(["Cage", "Hall A", "Hall B"])
    expect(labels.find((l) => l.id === "Cage")?.minor).toBe(true)
    expect(labels.find((l) => l.id === "Hall A")?.minor).toBe(false)
  })

  it("puts the alarm's badge by the name", () => {
    const rooms = planRooms([hall])
    const [l] = placeRoomLabels(
      [hall],
      rooms,
      new Map([
        ["Data Hall 1", { text: "", alarm: { check: "down", count: 2 } }],
      ]),
      10
    )
    expect(l).toMatchObject({ badge: "2 down", check: "down" })
  })

  it("reads a turn upright", () => {
    expect(upright(118)).toBe(-62)
    expect(upright(28)).toBe(28)
    expect(upright(180)).toBe(0)
  })
})

describe("the area names' collision pass", () => {
  it("hides a name wider than its room", () => {
    const tiny = area("Meeting room 4", { width: 2, height: 2 })
    expect(hiddenAreaNames([tiny], { cell: 40 })).toEqual(new Set([tiny.id]))
  })

  it("keeps the bigger room's name where two would overlap", () => {
    const big = area("Kitchen 2", { x: 0, y: 0, width: 13, height: 17 })
    // Its corner on the big one's name.
    const small = area("Meet", {
      x: 0.5,
      y: 0.2,
      width: 6,
      height: 3,
    })
    const hidden = hiddenAreaNames([small, big], { cell: 40 })
    expect(hidden).toEqual(new Set(["Meet"]))
  })

  it("checks turned names as turned", () => {
    const a: Pt[] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [0, 1],
    ]
    const far: Pt[] = a.map(([x, y]) => [x + 10, y])
    expect(quadsOverlap(a, a)).toBe(true)
    expect(quadsOverlap(a, far)).toBe(false)
  })

  it("leaves out what it is told to", () => {
    const room = area("Hall", { width: 30, height: 30 })
    expect(
      hiddenAreaNames([room], { cell: 40, skip: new Set(["Hall"]) })
    ).toEqual(new Set(["Hall"]))
  })
})

describe("the building's footprint", () => {
  const grid = { grid_width: 100, grid_height: 100 }
  const ring: [number, number][] = [
    [10, 10],
    [50, 10],
    [50, 40],
    [10, 40],
    [10, 10],
  ]

  it("is the outer walls' ring and the areas", () => {
    const fp = buildingFootprint(
      [{ points: ring, exterior: true }],
      [area("Hall", { x: 12, y: 12, width: 5, height: 5 })],
      grid
    )
    expect(fp).toHaveLength(2)
    expect(fp[0]).toEqual(ring.slice(0, -1))
  })

  it("is the areas alone without outer walls, and nothing on an empty plan", () => {
    expect(
      buildingFootprint(
        [{ points: ring, exterior: false }],
        [area("Hall", { x: 12, y: 12, width: 5, height: 5 })],
        grid
      )
    ).toHaveLength(1)
    expect(buildingFootprint([], [], grid)).toEqual([])
  })
})
