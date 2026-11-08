import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import type { Pt } from "./cable-route"
import { layoutIcons } from "./icon-layout"
import { layoutPlanLabels } from "./plan-label-pass"
import type { IconClusterLabel, PlanLabelInput } from "./plan-label-pass"
import { NEAR_LEADER_PLATES, calloutSize } from "./plan-callouts"
import {
  HALL_ENTER_PX,
  HALL_EXIT_PX,
  ROW_ICON_ENTER_PX,
  ROW_ICON_EXIT_PX,
  barThickness,
  planLod,
  planRooms,
  planRows,
  roomAt,
  rowPitch,
  symbolBox,
  wallOf,
  withSymbols,
} from "./plan-lod"
import type { PlanLod } from "./plan-lod"
import type { AreaShape } from "./shapes"

// Rows from afar: one symbol per row, never chopped into clusters; a
// room's rows one summary once they run together; infrastructure summed
// up wall by wall on its room.

const tile = (
  id: string,
  x: number,
  y: number,
  w = 1,
  h = 2,
  kind = "rack",
  name = id
) =>
  ({
    id,
    x,
    y,
    width: w,
    height: h,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: name,
    color: "#2563eb",
    status: "",
    linked: kind ? { kind, id: `o-${id}`, name, route: "/r" } : null,
  }) as unknown as FloorPlanTile

const area = (
  id: string,
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
) =>
  ({
    kind: "area",
    id,
    label,
    shape: "rect",
    x,
    y,
    width,
    height,
    rotation,
    points: [],
    show_name: true,
    room: null,
    location: null,
    area_type: null,
  }) as unknown as AreaShape

/** A hall at (x0, y0): `rows` rows of `n` racks, `pitch` cells apart,
 * named "<hall>-A01" … in a room round them. */
function hall(
  name: string,
  x0: number,
  y0: number,
  rows: number,
  n: number,
  pitch = 4
) {
  const tiles: FloorPlanTile[] = []
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < n; i++) {
      const id = `${name}-${String.fromCharCode(65 + r)}${String(i + 1).padStart(2, "0")}`
      tiles.push(tile(id, x0 + 2 + i, y0 + 2 + r * pitch))
    }
  const room = area(`room-${name}`, name, x0, y0, n + 4, rows * pitch + 4)
  return { tiles, room }
}

const iconsOf = (tiles: readonly FloorPlanTile[]) =>
  new Set(tiles.map((t) => t.id))

function lodAt(
  tiles: FloorPlanTile[],
  areas: AreaShape[],
  scale: number,
  prev: PlanLod | null = null
) {
  const rooms = planRooms(areas)
  const rows = planRows(tiles, rooms)
  return planLod(rows, {
    tiles,
    iconIds: iconsOf(tiles),
    rooms,
    scale,
    prev,
  })
}

describe("rows from afar", () => {
  it("draws a row of icons as one symbol, never chopped into clusters", () => {
    const h = hall("DH1", 0, 0, 3, 12, 6)
    // 12 px per cell: racks icons, rows 72 px apart, 144 px long.
    const lod = lodAt(h.tiles, [h.room], 12)
    expect(lod.halls).toEqual([])
    expect(lod.rows.map((r) => r.row.members.length)).toEqual([12, 12, 12])
    expect(lod.rows.every((r) => r.bar)).toBe(true)
    expect(lod.rows.map((r) => r.row.text)).toEqual([
      "Row A · A01–A12",
      "Row B · B01–B12",
      "Row C · C01–C12",
    ])
    expect(lod.rows[0].row.short).toBe("Row A · 12")
    // What is left for the clusters: nothing of a row.
    const loose = h.tiles.filter((t) => !lod.ownerOf.has(t.id))
    expect(loose).toEqual([])
    const layout = withSymbols(
      layoutIcons(
        loose.map((t) => ({ id: t.id, c: [t.x + 0.5, t.y + 1] as Pt })),
        12,
        { side: 28 }
      ),
      lod
    )
    expect(layout.clusters.map((c) => c.form)).toEqual(["row", "row", "row"])
    expect(layout.clusterOf.get("DH1-B07")?.id).toBe(lod.rows[1].id)
  })

  it("only clusters what is in no row, and never across rooms", () => {
    // Two crowds of loose devices, touching, in two rooms side by side.
    const a = [0, 1, 2, 3, 4].map((i) =>
      tile(`a${i}`, 9, 4 + i * 0.6, 1, 1, "device")
    )
    const b = [0, 1, 2, 3, 4].map((i) =>
      tile(`b${i}`, 10.2, 4 + i * 0.6, 1, 1, "device")
    )
    const rooms = planRooms([
      area("west", "West", 0, 0, 10, 10),
      area("east", "East", 10, 0, 10, 10),
    ])
    const items = [...a, ...b].map((t) => ({
      id: t.id,
      c: [t.x + 0.5, t.y + 0.5] as Pt,
    }))
    const roomOf = new Map(items.map((x) => [x.id, roomAt(rooms, x.c)?.id]))
    const layout = layoutIcons(items, 12, {
      side: 28,
      groupOf: (id) => roomOf.get(id),
    })
    for (const c of layout.clusters)
      expect(new Set(c.members.map((id) => roomOf.get(id))).size).toBe(1)
    const mixed = layoutIcons(items, 12, { side: 28 })
    expect(
      mixed.clusters.some(
        (c) => new Set(c.members.map((id) => roomOf.get(id))).size > 1
      )
    ).toBe(true)
  })

  it("folds a room's rows into one summary on the room", () => {
    const h1 = hall("Data Hall 1", 0, 0, 4, 10, 4)
    const h2 = hall("Data Hall 2", 80, 0, 3, 8, 4)
    // A loose rack in hall 1 goes with it.
    const loose = tile("Data Hall 1-X", 13, 15)
    const tiles = [...h1.tiles, ...h2.tiles, loose]
    // 4 cells x 5 px = 20 px between rows: under HALL_ENTER_PX.
    const lod = lodAt(tiles, [h1.room, h2.room], 5)
    expect(lod.rows).toEqual([])
    expect(lod.halls.map((h) => h.text)).toEqual([
      "Data Hall 1 · 41 racks",
      "Data Hall 2 · 24 racks",
    ])
    expect(lod.halls[0].members).toContain("Data Hall 1-X")
    expect(lod.halls[0].room.at).toEqual([7, 10])
    // A summary is a plate on its room, not a cluster.
    const layout = withSymbols(
      { scale: 5, offsets: new Map(), clusters: [], clusterOf: new Map() },
      lod
    )
    const c = layout.clusterOf.get("Data Hall 2-C08")!
    expect(c.form).toBe("hall")
    const box = symbolBox(c, 5)!
    expect(box.x + box.w / 2).toBeCloseTo(86)
    expect(box.h * 5).toBeCloseTo(22)
  })

  it("keeps a lone row a row, however far out", () => {
    const h = hall("Cage", 0, 0, 1, 6)
    const lod = lodAt(h.tiles, [h.room], 2)
    expect(lod.halls).toEqual([])
    expect(lod.rows.length).toBe(1)
    // 6 cells x 2 px: too short for a bar - one icon with its count.
    expect(lod.rows[0].bar).toBe(false)
  })

  it("waits for the wider threshold back (hysteresis)", () => {
    const h = hall("DH", 0, 0, 3, 12, 4)
    const pitch = rowPitch(planRows(h.tiles, planRooms([h.room])))
    expect(pitch).toBeCloseTo(4)
    // Between the two thresholds: as it was.
    const mid = (HALL_ENTER_PX + HALL_EXIT_PX) / 2 / pitch
    const open = lodAt(h.tiles, [h.room], mid)
    expect(open.halls).toEqual([])
    const shut = lodAt(h.tiles, [h.room], (HALL_ENTER_PX - 1) / pitch)
    expect(shut.halls.length).toBe(1)
    expect(lodAt(h.tiles, [h.room], mid, shut).halls.length).toBe(1)
    expect(
      lodAt(h.tiles, [h.room], (HALL_EXIT_PX + 1) / pitch, shut).halls
    ).toEqual([])
    // A row's bar and its icon the same way: 12 cells long.
    const lone = hall("L", 0, 0, 1, 12)
    const between = (ROW_ICON_ENTER_PX + ROW_ICON_EXIT_PX) / 2 / 12
    const bar = lodAt(lone.tiles, [lone.room], between)
    expect(bar.rows[0].bar).toBe(true)
    const icon = lodAt(lone.tiles, [lone.room], (ROW_ICON_ENTER_PX - 1) / 12)
    expect(icon.rows[0].bar).toBe(false)
    expect(lodAt(lone.tiles, [lone.room], between, icon).rows[0].bar).toBe(
      false
    )
  })

  it("folds summaries that would touch into the room round both", () => {
    const outer = area("hall", "Data Hall 1", 0, 0, 60, 40)
    const c1 = hall("C101", 5, 5, 2, 6, 3)
    const c2 = hall("C102", 35, 5, 2, 6, 3)
    const main = hall("DH1", 5, 20, 3, 12, 4)
    const tiles = [...c1.tiles, ...c2.tiles, ...main.tiles]
    const areas = [outer, c1.room, c2.room]
    // Close up the cages' summaries stand apart; far out they and the
    // hall's rows read as the hall.
    const near = lodAt(tiles, areas, 8)
    expect(near.halls.map((h) => h.room.id).sort()).toEqual([
      "room-C101",
      "room-C102",
    ])
    const far = lodAt(tiles, areas, 1)
    expect(far.halls.map((h) => h.text)).toEqual(["Data Hall 1 · 60 racks"])
  })

  it("finds the room and the wall a point is by, turned or not", () => {
    const rooms = planRooms([
      area("big", "Big", 0, 0, 100, 100),
      area("small", "Small", 10, 10, 20, 10, 90),
    ])
    expect(roomAt(rooms, [20, 15])?.id).toBe("small")
    expect(roomAt(rooms, [80, 80])?.id).toBe("big")
    expect(roomAt(rooms, [200, 80])).toBeNull()
    const big = rooms.find((r) => r.id === "big")!
    expect(wallOf(big, [2, 50])).toBe("left")
    expect(wallOf(big, [50, 98])).toBe("bottom")
    // Turned a quarter: its own left wall is at the top of the plan.
    const small = rooms.find((r) => r.id === "small")!
    expect(wallOf(small, [20, 6])).toBe("left")
  })

  it("lays out a 300-rack hall's symbols fast", () => {
    const h = hall("H", 0, 0, 15, 20, 4)
    const t0 = performance.now()
    const rooms = planRooms([h.room])
    const rows = planRows(h.tiles, rooms)
    let prev: PlanLod | null = null
    for (const scale of [16, 12, 8, 6, 4, 3, 2]) {
      prev = planLod(rows, {
        tiles: h.tiles,
        iconIds: iconsOf(h.tiles),
        rooms,
        scale,
        prev,
      })
    }
    expect(performance.now() - t0).toBeLessThan(500)
    expect(rows.length).toBe(15)
    expect(prev!.halls.length).toBe(1)
  })
})

describe("the label pass from afar", () => {
  function input(
    tiles: FloorPlanTile[],
    scale: number,
    patch: Partial<PlanLabelInput> = {}
  ): PlanLabelInput {
    return {
      scale,
      unitsPerPx: scale / 40,
      font: 11,
      chipFont: 10,
      repeat: 280,
      gap: 4,
      bounds: { x: 0, y: 0, w: 400 * scale, h: 400 * scale },
      tiles,
      cellMm: 600,
      callouts: {},
      ...patch,
    }
  }

  /** The clusters the canvas hands the pass for `lod`. */
  function symbols(lod: PlanLod, scale: number): IconClusterLabel[] {
    const layout = withSymbols(
      { scale, offsets: new Map(), clusters: [], clusterOf: new Map() },
      lod
    )
    return layout.clusters.map((c) => ({
      id: c.id,
      box: symbolBox(c, scale)!,
      name: c.text ?? "",
      members: c.members,
      row: c.row?.bar
        ? {
            centre: c.anchor,
            dir: c.row.dir,
            length: c.row.length,
            thick: barThickness(c.row.depth, scale),
            text: c.text!,
            short: c.short!,
          }
        : undefined,
      hall: c.form === "hall" ? c.room : undefined,
    }))
  }

  it("names each row bar along it, short when the full name is long", () => {
    const h = hall("DH1", 0, 0, 3, 12, 6)
    const lod = lodAt(h.tiles, [h.room], 6)
    const got = layoutPlanLabels(
      input(h.tiles, 6, {
        iconIds: iconsOf(h.tiles),
        iconClusters: symbols(lod, 6),
        areas: [h.room],
      })
    )
    // 72 px of row: "Row A · A01–A12" does not fit along it.
    expect(got.rows.map((r) => r.text)).toEqual([
      "Row A · 12",
      "Row B · 12",
      "Row C · 12",
    ])
    expect(got.callouts).toEqual([])
    const wide = layoutPlanLabels(
      input(h.tiles, 12, {
        iconIds: iconsOf(h.tiles),
        iconClusters: symbols(lodAt(h.tiles, [h.room], 12), 12),
      })
    )
    expect(wide.rows[0].text).toBe("Row A · A01–A12")
  })

  it("hides the room's own name under its summary", () => {
    const h = hall("Data Hall 1", 0, 0, 4, 10, 4)
    const lod = lodAt(h.tiles, [h.room], 5)
    expect(lod.halls.length).toBe(1)
    const got = layoutPlanLabels(
      input(h.tiles, 5, {
        iconIds: iconsOf(h.tiles),
        iconClusters: symbols(lod, 5),
        areas: [h.room],
      })
    )
    expect(got.areas.get(h.room.id)).toBeNull()
    expect(got.callouts).toEqual([])
    expect(got.rows).toEqual([])
  })

  it("sums up crowded infrastructure per wall, its leaders short", () => {
    // Cooling units along both long walls of a hall - apart, so no row,
    // but too close for a box each.
    const room = area("dh", "Data Hall 1", 0, 0, 30, 60)
    const units: FloorPlanTile[] = []
    for (let i = 0; i < 12; i++) {
      units.push(
        tile(
          `w${i}`,
          0.5,
          2 + i * 2.2,
          1.5,
          1.5,
          "",
          `CRAH-DH1-${String(i + 1).padStart(2, "0")}`
        )
      )
      units.push(tile(`e${i}`, 28, 2 + i * 2.2, 1.5, 1.5, "", `UPS-E${i + 1}`))
    }
    const rooms = planRooms([room])
    const scale = 4
    const got = layoutPlanLabels(
      input(units, scale, { roomOf: (p) => roomAt(rooms, p), areas: [room] })
    )
    expect(got.callouts.length).toBeGreaterThan(0)
    // Every unit named, by its own box or a summary.
    const named = new Set(
      got.callouts.flatMap((c) => (c.members ? [...c.members] : [c.id]))
    )
    expect(named.size).toBe(24)
    const summaries = got.callouts.filter((c) => c.members)
    expect(summaries.length).toBeGreaterThan(0)
    for (const s of summaries) {
      // One wall, one kind, said by name.
      const sides = new Set(s.members!.map((id) => id[0]))
      expect(sides.size).toBe(1)
      expect(s.name).toMatch(/^(CRAH-DH1|UPS-E) ×\d+$/)
    }
    // Never a leader across the hall.
    const reach = NEAR_LEADER_PLATES * calloutSize("", []).h
    for (const c of got.callouts) {
      const [p, q] = c.leader
      const len = Math.hypot(p[0] - q[0], p[1] - q[1]) * scale
      expect(len).toBeLessThanOrEqual(reach * 2 + 1)
    }
  })
})
