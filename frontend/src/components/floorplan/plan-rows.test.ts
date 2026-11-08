import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import type { Pt } from "./cable-route"
import {
  CalloutBoard,
  MAX_CROWD_CALLOUTS,
  calloutSize,
  segmentsCross,
} from "./plan-callouts"
import type { CalloutItem } from "./plan-callouts"
import { alongBoxes, layoutPlanLabels, nameFitsTile } from "./plan-label-pass"
import type { PlanLabelInput } from "./plan-label-pass"
import { Occupancy, boxesHit } from "./plan-labels"
import type { Box } from "./plan-labels"
import { ROW_MIN, findRows, rowAngle, rowName } from "./plan-rows"
import type { RowTile } from "./plan-rows"

// Crowded plans: a row of racks named once along it, a few names stacked
// tidily beside their crowd, a big crowd in one plate - and nothing loose.

/** `n` racks 1 x 2 side by side from (x, y), turned `angle` about their
 * centres, the row running along their width (and the turn). */
function row(
  prefix: string,
  n: number,
  x: number,
  y: number,
  angle = 0,
  gap = 0
): RowTile[] {
  const r = (angle * Math.PI) / 180
  return Array.from({ length: n }, (_, i) => {
    const s = i * (1 + gap)
    return {
      id: `${prefix}${String(i + 1).padStart(2, "0")}`,
      x: x + Math.cos(r) * s,
      y: y + Math.sin(r) * s,
      w: 1,
      h: 2,
      angle,
      kind: "rack",
      name: `DH5-${prefix}${String(i + 1).padStart(2, "0")}`,
    }
  })
}

describe("findRows", () => {
  it("finds a straight row, its members in order along it", () => {
    const rows = findRows(row("A", 6, 10, 10))
    expect(rows.length).toBe(1)
    expect(rows[0].members).toEqual(["A01", "A02", "A03", "A04", "A05", "A06"])
    expect(rows[0].length).toBeCloseTo(6)
    expect(rows[0].depth).toBe(2)
    expect(rows[0].dir[0]).toBeCloseTo(1)
  })

  it("finds rows turned with their racks, the same in any order", () => {
    const tiles = [...row("A", 8, 10, 10, 28), ...row("B", 8, 8, 14, 28)]
    const rows = findRows(tiles)
    expect(rows.map((r) => r.members.length)).toEqual([8, 8])
    expect(rowAngle(rows[0].dir)).toBeCloseTo(28)
    const again = findRows([...tiles].reverse())
    expect(again).toEqual(rows)
  })

  it("reads a back-to-back row (turned a half turn) left to right", () => {
    const rows = findRows(row("A", 5, 10, 10, 208))
    expect(rows.length).toBe(1)
    // Its racks face the other way: the row still reads upright.
    expect(rowAngle(rows[0].dir)).toBeCloseTo(28)
    expect(rows[0].dir[0]).toBeGreaterThan(0)
  })

  it("splits a row at a gap a rack would fit in, keeps a seam", () => {
    const seam = findRows(row("A", 5, 10, 10, 0, 0.1))
    expect(seam.length).toBe(1)
    const a = row("A", 4, 10, 10)
    const b = row("B", 4, 16, 10)
    const rows = findRows([...a, ...b])
    expect(rows.map((r) => r.members[0]).sort()).toEqual(["A01", "B01"])
  })

  it("never joins racks of another turn, size or kind", () => {
    const a = row("A", 2, 10, 10)
    const turned = row("T", 1, 12, 10, 15)
    const big = { ...row("G", 1, 12, 10)[0], w: 2, h: 3 }
    const pdu = { ...row("P", 1, 12, 10)[0], kind: "pdu" }
    for (const odd of [turned[0], big, pdu])
      expect(findRows([...a, odd])).toEqual([])
    expect(findRows(row("A", ROW_MIN - 1, 10, 10))).toEqual([])
  })

  it("rows a block of racks along its longer chains", () => {
    // Two rows back to back, touching: each row its own, not a column of
    // two.
    const rows = findRows([...row("A", 6, 10, 10), ...row("B", 6, 10, 12)])
    expect(rows.map((r) => r.members.length)).toEqual([6, 6])
  })
})

describe("rowName", () => {
  it("names a row by its letter and its range", () => {
    const names = ["DH5-B03", "DH5-B01", "DH5-B12", "DH5-B02"]
    expect(rowName(names)).toEqual({
      text: "Row B · B01–B12",
      short: "Row B",
    })
  })

  it("falls back to the range, then to the first and the last", () => {
    expect(rowName(["R01", "R02", "R10"]).text).toBe("R01–R10")
    expect(rowName(["web-01", "web-02", "web-03"]).text).toBe("01–03")
    expect(rowName(["alpha", "beta", "gamma"]).text).toBe("alpha–gamma")
    expect(rowName(["", ""]).text).toBe("")
  })
})

describe("text along a row", () => {
  it("is never upside down", () => {
    for (let deg = -360; deg <= 360; deg += 7.5) {
      const r = (deg * Math.PI) / 180
      const a = rowAngle([Math.cos(r), Math.sin(r)])
      expect(a).toBeGreaterThan(-90)
      expect(a).toBeLessThanOrEqual(90)
    }
    expect(rowAngle([-1, 0])).toBe(0)
    expect(rowAngle([0, 1])).toBe(90)
    expect(rowAngle([0, -1])).toBe(90)
  })

  it("takes boxes along it, not its whole slanted bounds", () => {
    const boxes = alongBoxes([100, 100], 45, { w: 100, h: 14 })
    const area = boxes.reduce((s, b) => s + b.w * b.h, 0)
    // Its bounds would be ~80 x 80.
    expect(area).toBeLessThan(80 * 80 * 0.5)
    expect(boxes.length).toBeGreaterThan(5)
  })
})

describe("a name fits its tile", () => {
  it("only whole and big enough to read", () => {
    const rack = { width: 1, height: 2 }
    expect(nameFitsTile(rack, "R1", false, 1)).toBe(true)
    // Cut short in a one-cell tile.
    expect(nameFitsTile(rack, "DH5-A01", false, 4)).toBe(false)
    // Fit labels: shrunk to fit, read once zoomed in.
    expect(nameFitsTile(rack, "DH5-A01", true, 0.5)).toBe(false)
    expect(nameFitsTile(rack, "DH5-A01", true, 2)).toBe(true)
  })
})

/** Boxes and leaders of a set of callouts, for the checks. */
const anyOverlap = (boxes: readonly Box[]) =>
  boxes.some((a, i) => boxes.some((b, j) => j > i && boxesHit(a, b)))
const anyCross = (ls: readonly [Pt, Pt][]) =>
  ls.some((a, i) => ls.some((b, j) => j > i && segmentsCross(a, b)))

describe("a crowd's stack", () => {
  const items = (n: number, dx = 30, dy = 7): CalloutItem[] =>
    Array.from({ length: n }, (_, i) => {
      const anchor = { x: 200 + i * dx, y: 200 + (i % 2) * dy, w: 12, h: 24 }
      return {
        id: `T${i}`,
        anchor,
        size: calloutSize(`T${i}`, []),
        group: "crowd",
        container: anchor,
      }
    })

  it("stacks on one side, in order, its leaders never crossing", () => {
    const its = items(5)
    const solid = new Occupancy(64)
    for (const one of its) solid.add(one.anchor)
    const board = new CalloutBoard({ free: (b) => solid.free(b) })
    const reach = 2 * calloutSize("", []).h
    const got = board.stack(its, reach)!
    expect(got).not.toBeNull()
    const placed = its.map((one) => got.get(one.id)!)
    expect(new Set(placed.map((p) => p.side)).size).toBe(1)
    expect(anyOverlap(placed.map((p) => p.box))).toBe(false)
    expect(anyCross(placed.map((p) => p.leader))).toBe(false)
    // In the order of their tiles along the stack.
    const xs = placed.map((p) => p.box.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    // As near as it fits: the stack no farther out than `reach`.
    for (const p of placed) {
      const gap =
        p.side === "top"
          ? 200 - (p.box.y + p.box.h)
          : p.side === "bottom"
            ? p.box.y - (200 + 7 + 24)
            : 0
      expect(gap).toBeLessThanOrEqual(reach + 1e-6)
    }
  })

  it("keeps off what was placed, else takes nothing", () => {
    const its = items(3)
    const solid = new Occupancy(64)
    for (const one of its) solid.add(one.anchor)
    // Everything round the crowd taken.
    solid.add({ x: 100, y: 100, w: 300, h: 98 })
    solid.add({ x: 100, y: 233, w: 300, h: 100 })
    solid.add({ x: 100, y: 198, w: 98, h: 35 })
    solid.add({ x: 274, y: 198, w: 126, h: 35 })
    const board = new CalloutBoard({ free: (b) => solid.free(b) })
    expect(board.stack(its, 2 * calloutSize("", []).h)).toBeNull()
  })
})

// The 2D pass on a crowded floor.
const tile = (
  id: string,
  x: number,
  y: number,
  w = 1,
  h = 2,
  kind = "rack",
  orientation = 0
) =>
  ({
    id,
    x,
    y,
    width: w,
    height: h,
    orientation,
    tile_type: null,
    role_type: null,
    label: id,
    color: "#2563eb",
    status: "",
    linked: kind ? { kind, id: `o-${id}`, name: id, route: "/r" } : null,
  }) as unknown as FloorPlanTile

function input(
  tiles: FloorPlanTile[],
  k: number,
  patch: Partial<PlanLabelInput> = {}
): PlanLabelInput {
  const scale = 40 * k
  return {
    scale,
    unitsPerPx: k,
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

describe("the 2D pass on a crowded floor", () => {
  it("names a crowd past the cap in one plate, a small one in a stack", () => {
    // Scattered racks a cell apart diagonally: no row, one crowd.
    const scatter = (n: number, x0: number) =>
      Array.from({ length: n }, (_, i) =>
        tile(`S${x0}-${i}`, x0 + (i % 3) * 1.6, 100 + i * 1.3)
      )
    const big = layoutPlanLabels(
      input(scatter(MAX_CROWD_CALLOUTS + 3, 50), 0.3)
    )
    expect(big.rows).toEqual([])
    expect(big.callouts.length).toBe(1)
    expect(big.callouts[0].members?.length).toBe(MAX_CROWD_CALLOUTS + 3)
    expect(big.callouts[0].name).toBe("S50-0–S50-8")
    const small = layoutPlanLabels(input(scatter(3, 50), 0.3))
    expect(small.callouts.length).toBe(3)
    expect(small.callouts.every((c) => !c.members)).toBe(true)
    expect(new Set(small.callouts.map((c) => c.side)).size).toBe(1)
    expect(small.tiles).toEqual([])
  })

  it("names turned rows along them, never upside down", () => {
    const tiles = [0, 1, 2, 3, 4, 5].map((i) => {
      const r = (28 * Math.PI) / 180
      return tile(
        `R-B${String(i + 1).padStart(2, "0")}`,
        100 + Math.cos(r) * i,
        100 + Math.sin(r) * i,
        1,
        2,
        "rack",
        208
      )
    })
    const got = layoutPlanLabels(input(tiles, 0.4, { angleOf: () => 28 }))
    expect(got.rows.length).toBe(1)
    expect(got.rows[0].angle).toBeCloseTo(28)
    expect(got.rows[0].text).toBe("Row B · B01–B06")
    expect(got.callouts).toEqual([])
  })

  it("lays out a 300-rack hall in rows, fast, and reuses it", () => {
    const tiles: FloorPlanTile[] = []
    for (let r = 0; r < 15; r++)
      for (let i = 0; i < 20; i++)
        tiles.push(
          tile(
            `H${String.fromCharCode(65 + r)}${String(i + 1).padStart(2, "0")}`,
            10 + i,
            10 + r * 4
          )
        )
    // A few units by the wall.
    for (let i = 0; i < 6; i++)
      tiles.push(tile(`CRAH-${i}`, 4, 10 + i * 10, 1, 3, ""))
    const t0 = performance.now()
    const got = layoutPlanLabels(input(tiles, 0.4))
    const took = performance.now() - t0
    expect(took).toBeLessThan(3000)
    expect(got.rows.length).toBe(15)
    expect(got.rows.every((r) => r.members.length === 20)).toBe(true)
    expect(got.callouts.map((c) => c.id).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `CRAH-${i}`)
    )
    expect(got.tiles).toEqual([])
    const scale = 40 * 0.4
    const boxes = got.callouts.map((c) => ({
      x: c.at[0] * scale - c.size.w / 2,
      y: c.at[1] * scale - c.size.h / 2,
      w: c.size.w,
      h: c.size.h,
    }))
    expect(anyOverlap(boxes)).toBe(false)
    const t1 = performance.now()
    const again = layoutPlanLabels(input(tiles, 0.4))
    expect(performance.now() - t1).toBeLessThan(took + 50)
    expect(again.rows).toEqual(got.rows)
  })
})
