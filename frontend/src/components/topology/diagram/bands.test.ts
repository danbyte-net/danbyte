import { describe, expect, it } from "vitest"

import {
  BAND,
  arrangeBands,
  bandRows,
  clearBands,
  drawnRegions,
  fitRows,
  handDrawn,
  isRow,
  membersOf,
  newRow,
  newSide,
  normalizeRegions,
  paintOrder,
  reorderRow,
  reorderRows,
  resizeRow,
  rowAt,
  rowsAt,
  rowsSig,
  ruleRow,
  snapSide,
  titleSpot,
} from "./bands"
import type { ArrangeCard, Region } from "./bands"
import { boxAround, dropPlacement, NEW_CARD, placeNewcomers } from "./placement"
import type { Rect } from "./types"

const row = (id: string, y: number, h = 160, over: Partial<Region> = {}) =>
  ({
    id,
    kind: "band",
    orient: "h",
    label: id,
    color: null,
    x: 0,
    y,
    w: 1000,
    h,
    ...over,
  }) as Region

const side = (id: string, y: number, h: number, x = 1016): Region => ({
  id,
  kind: "band",
  orient: "v",
  label: id,
  color: "#0ea5e9",
  x,
  y,
  w: 72,
  h,
})

const zone = (id: string): Region => ({
  id,
  label: id,
  color: "#10b981",
  x: 50,
  y: 50,
  w: 200,
  h: 100,
})

/** A card box centred on (x, y). */
const at = (x: number, y: number, w = 120, h = 60): Rect =>
  boxAround({ x, y }, { w, h })

const ROLES = {
  spine: { id: "00000000-0000-4000-8000-000000000001", name: "Spine" },
  leaf: { id: "00000000-0000-4000-8000-000000000002", name: "Leaf" },
  border: { id: "00000000-0000-4000-8000-000000000003", name: "Border" },
  server: { id: "00000000-0000-4000-8000-000000000004", name: "Server" },
}

const card = (
  id: string,
  box: Rect,
  role: { id: string; name: string } | null,
  type?: { id: string; name: string }
): ArrangeCard => ({ id, box, role, ...(type ? { type } : {}) })

/** The cards of a small fabric as an auto layout left them: spines on
 * top, leaves under them, servers at the bottom - a little jumbled. */
function fabric(): ArrangeCard[] {
  return [
    card("dev:s2", at(500, 40), ROLES.spine),
    card("dev:s1", at(200, 30), ROLES.spine),
    card("dev:l1", at(100, 300), ROLES.leaf),
    card("dev:l2", at(400, 280), ROLES.leaf),
    card("dev:l3", at(700, 310, 200, 90), ROLES.leaf),
    card("dev:b1", at(900, 60), ROLES.border),
    card("dev:h1", at(300, 600), ROLES.server),
    card("dev:x1", at(600, 620), null),
  ]
}

const counter = () => {
  let n = 0
  return () => `new${++n}`
}

const centreIn = (r: Rect, [x, y]: [number, number]) =>
  x > r.x && x < r.x + r.w && y > r.y + BAND.TITLE && y < r.y + r.h

describe("normalizeRegions", () => {
  it("keeps what is well formed and fixes what it can", () => {
    const out = normalizeRegions([
      {
        id: "a",
        label: "A",
        x: 1.4,
        y: 2.6,
        w: 300,
        h: 10,
        color: "#0EA5E9",
        kind: "band",
      },
      {
        id: "b",
        label: "B",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        color: "#123456",
        kind: "band",
        orient: "v",
      },
      { id: "c", label: "C", x: 0, y: 0, w: 100, h: 100, color: "#123456" },
      { id: "a", label: "dup", x: 0, y: 0, w: 1, h: 1, color: null },
      { label: "no id", x: 0, y: 0, w: 1, h: 1 },
      { id: "nan", x: Number.NaN, y: 0, w: 1, h: 1 },
      "junk",
    ])
    expect(out).toEqual([
      {
        id: "a",
        label: "A",
        x: 1,
        y: 3,
        w: 300,
        h: BAND.MIN_H,
        color: "#0ea5e9",
        kind: "band",
        orient: "h",
      },
      {
        id: "b",
        label: "B",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        color: null,
        kind: "band",
        orient: "v",
      },
      { id: "c", label: "C", x: 0, y: 0, w: 100, h: 100, color: "#123456" },
    ])
    expect(normalizeRegions(null)).toEqual([])
  })

  it("keeps a band's rule", () => {
    const [r] = normalizeRegions([
      { ...row("r", 0), rule: { by: "role", ids: [ROLES.spine.id, 7] } },
    ])
    expect(r.rule).toEqual({ by: "role", ids: [ROLES.spine.id] })
  })
})

describe("membership", () => {
  const regions = [
    row("top", 0),
    row("mid", 200),
    side("wan", 0, 360),
    zone("z"),
  ]

  it("puts a card in the row its centre is in, and nowhere else", () => {
    const m = membersOf(regions, {
      a: at(100, 80),
      b: at(900, 250),
      // Its box pokes into "top", its centre is in the gap.
      c: at(100, 180),
      d: at(1050, 100),
    })
    expect(m.get("top")).toEqual(["a"])
    expect(m.get("mid")).toEqual(["b"])
    // Side bands and zones own nothing.
    expect(m.has("wan")).toBe(false)
    expect(m.has("z")).toBe(false)
  })

  it("gives a card in two rows to the tighter one", () => {
    const inner = row("inner", 20, 60, { x: 50, w: 200 })
    expect(rowAt([row("outer", 0, 400), inner], { x: 100, y: 50 })?.id).toBe(
      "inner"
    )
  })

  it("stacks side bands, then rows, then zones", () => {
    expect(paintOrder(regions).map((r) => r.id)).toEqual([
      "wan",
      "top",
      "mid",
      "z",
    ])
  })
})

describe("arrangeBands", () => {
  it("makes one row per role, stacked in the layout's order", () => {
    const { positions, regions } = arrangeBands({
      cards: fabric(),
      by: "role",
      newId: counter(),
    })
    const rows = regions.filter(isRow)
    // Border's card sits high, so it ranks with the spines; no role last.
    expect(rows.map((r) => r.label)).toEqual([
      "Spine",
      "Border",
      "Leaf",
      "Server",
      "No role",
    ])
    // Every row as wide as the widest, stacked with a gap and no overlap.
    expect(new Set(rows.map((r) => r.w)).size).toBe(1)
    expect(new Set(rows.map((r) => r.x)).size).toBe(1)
    for (let i = 1; i < rows.length; i++)
      expect(rows[i].y).toBe(rows[i - 1].y + rows[i - 1].h + BAND.GAP)
    // Every card placed, inside its own row, below the title.
    expect(Object.keys(positions).sort()).toEqual(
      fabric()
        .map((c) => c.id)
        .sort()
    )
    const inRow = (id: string, label: string) =>
      centreIn(rows.find((r) => r.label === label)!, positions[id])
    expect(inRow("dev:s1", "Spine") && inRow("dev:s2", "Spine")).toBe(true)
    expect(inRow("dev:l3", "Leaf") && inRow("dev:x1", "No role")).toBe(true)
    // In a row, the cards keep their left-to-right order.
    expect(positions["dev:s1"][0]).toBeLessThan(positions["dev:s2"][0])
    expect(positions["dev:l1"][0]).toBeLessThan(positions["dev:l2"][0])
    expect(positions["dev:l2"][0]).toBeLessThan(positions["dev:l3"][0])
    // Rows remember what they were made from.
    expect(rows[0].rule).toEqual({ by: "role", ids: [ROLES.spine.id] })
    expect(rows[4].rule).toEqual({ by: "role", ids: [] })
  })

  it("keeps cards clear of each other and within the row's height", () => {
    const cards = fabric()
    const { positions, regions } = arrangeBands({ cards, by: "role" })
    const boxes = cards.map((c) =>
      boxAround(
        { x: positions[c.id][0], y: positions[c.id][1] },
        { w: c.box.w, h: c.box.h }
      )
    )
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const hit =
          a.x < b.x + b.w &&
          b.x < a.x + a.w &&
          a.y < b.y + b.h &&
          b.y < a.y + a.h
        expect(hit).toBe(false)
      }
    const leaf = regions.find((r) => r.label === "Leaf")!
    // The tallest leaf (90) sets the row's height.
    expect(leaf.h).toBe(BAND.TITLE + BAND.PAD_TOP + BAND.PAD_BOTTOM + 90)
  })

  it("follows the Levels order, one row per level", () => {
    const { regions } = arrangeBands({
      cards: fabric(),
      by: "role",
      levels: {
        order: ["Server", "Leaf", "Spine", "Border"],
        bonds: ["Border"],
      },
      newId: counter(),
    })
    const rows = regions.filter(isRow)
    expect(rows.map((r) => r.label)).toEqual([
      "Server",
      "Leaf",
      "Spine + Border",
      "No role",
    ])
    expect(rows[2].rule?.ids).toEqual([ROLES.spine.id, ROLES.border.id].sort())
  })

  it("ranks a side-to-side layout along x, and keeps a stack's own order", () => {
    // Core at the left, leaves in the middle (stacked down), servers right.
    const cards = [
      card("dev:srv", at(900, 100), ROLES.server),
      card("dev:l2", at(500, 300), ROLES.leaf),
      card("dev:l1", at(500, 100), ROLES.leaf),
      card("dev:core", at(100, 200), ROLES.spine),
    ]
    const first = arrangeBands({ cards, by: "role", axis: "x" })
    expect(first.regions.filter(isRow).map((r) => r.label)).toEqual([
      "Spine",
      "Leaf",
      "Server",
    ])
    // Across the row, in the order they stood down the column.
    expect(first.positions["dev:l1"][0]).toBeLessThan(
      first.positions["dev:l2"][0]
    )
    // Once there are rows, their stack is the order, whatever the axis.
    const moved = cards.map((c) => {
      const [x, y] = first.positions[c.id]
      return { ...c, box: boxAround({ x, y }, c.box) }
    })
    const again = arrangeBands({
      cards: moved,
      by: "role",
      axis: "x",
      regions: first.regions,
    })
    expect(again.regions.filter(isRow).map((r) => r.label)).toEqual([
      "Spine",
      "Leaf",
      "Server",
    ])
    expect(again.positions).toEqual(first.positions)
  })

  it("groups by device type", () => {
    const A = { id: "00000000-0000-4000-8000-00000000000a", name: "QFX5120" }
    const B = { id: "00000000-0000-4000-8000-00000000000b", name: "PA-3420" }
    const { regions, positions } = arrangeBands({
      cards: [
        card("dev:1", at(0, 500), null, A),
        card("dev:2", at(200, 0), null, B),
        card("dev:3", at(400, 520), null, A),
        card("dev:4", at(600, 900), null),
      ],
      by: "device_type",
    })
    const rows = regions.filter(isRow)
    expect(rows.map((r) => r.label)).toEqual(["PA-3420", "QFX5120", "No type"])
    expect(rows[1].rule).toEqual({ by: "device_type", ids: [A.id] })
    expect(centreIn(rows[1], positions["dev:3"])).toBe(true)
  })

  it("wraps a long row onto more lines", () => {
    const cards = Array.from({ length: 15 }, (_, i) =>
      card(`dev:${String(i).padStart(2, "0")}`, at(i * 150, 0), ROLES.leaf)
    )
    const { positions, regions } = arrangeBands({ cards, by: "role" })
    const ys = new Set(Object.values(positions).map(([, y]) => y))
    expect(ys.size).toBe(2)
    const [r] = regions
    expect(r.h).toBe(
      BAND.TITLE + BAND.PAD_TOP + BAND.PAD_BOTTOM + 2 * 60 + BAND.LINE_GAP
    )
    // Twelve on the first line, the rest centred under them.
    const first = Math.min(...ys)
    expect(
      Object.values(positions).filter(([, y]) => y === first)
    ).toHaveLength(BAND.MAX_PER_LINE)
  })

  it("keeps a renamed, recoloured row on a second run, and drops hand-drawn rows", () => {
    const first = arrangeBands({
      cards: fabric(),
      by: "role",
      newId: counter(),
    })
    const spine = first.regions.find((r) => r.label === "Spine")!
    const edited = first.regions.map((r) =>
      r.id === spine.id ? { ...r, label: "Spine-lag", color: "#8b5cf6" } : r
    )
    const extra = row("hand", 5000)
    const again = arrangeBands({
      cards: fabric(),
      by: "role",
      regions: [...edited, extra, zone("z")],
      newId: counter(),
    })
    const kept = again.regions.find((r) => r.id === spine.id)!
    expect(kept.label).toBe("Spine-lag")
    expect(kept.color).toBe("#8b5cf6")
    expect(again.regions.some((r) => r.id === "hand")).toBe(false)
    expect(again.regions.some((r) => r.id === "z")).toBe(true)
    // Same cards, same answer: the second run is where the first left.
    expect(again.positions).toEqual(first.positions)
    expect(handDrawn([...edited, extra]).map((r) => r.id)).toEqual(["hand"])
  })

  it("keeps a side band on the rows it spanned", () => {
    const first = arrangeBands({
      cards: fabric(),
      by: "role",
      newId: counter(),
    })
    const rows = first.regions.filter(isRow)
    const top = rows[0]
    const second = rows[1]
    const right = top.x + top.w
    const wan = side("wan", top.y, second.y + second.h - top.y, right + 16)
    // The leaves grow: the rows under them move, the side band does not
    // need to (it spans the first two).
    const cards = fabric().map((c) =>
      c.id === "dev:l3" ? { ...c, box: at(3000, 310, 400, 200) } : c
    )
    const again = arrangeBands({
      cards,
      by: "role",
      regions: [...first.regions, wan],
    })
    const now = again.regions.filter(isRow)
    const moved = again.regions.find((r) => r.id === "wan")!
    expect(moved.y).toBe(now[0].y)
    expect(moved.h).toBe(now[1].y + now[1].h - now[0].y)
    expect(moved.x - (now[0].x + now[0].w)).toBe(16)
  })

  it("clears bands and leaves zones", () => {
    const { regions } = arrangeBands({ cards: fabric(), by: "role" })
    expect(clearBands([...regions, zone("z")])).toEqual([zone("z")])
  })
})

describe("editing rows", () => {
  // Two rows, a gap of 24, a card in each.
  const regions = [row("a", 0, 160), row("b", 184, 200), zone("z")]
  const boxes = { "dev:1": at(300, 80), "dev:2": at(600, 280) }

  it("moves a row down, swapping it with the next, cards and all", () => {
    const { regions: out, moves } = reorderRow(regions, boxes, "a", 1)
    const a = out.find((r) => r.id === "a")!
    const b = out.find((r) => r.id === "b")!
    // "b" takes the top slot, "a" goes under it with the same gap.
    expect(b.y).toBe(0)
    expect(a.y).toBe(200 + 24)
    expect(moves).toEqual({
      "dev:1": [300, 80 + 224],
      "dev:2": [600, 280 - 184],
    })
    // Already at the top: nothing to do.
    expect(reorderRow(regions, boxes, "a", -1).moves).toEqual({})
  })

  it("restacks rows in any order", () => {
    const three = [row("a", 0, 100), row("b", 124, 100), row("c", 248, 50)]
    const { regions: out } = reorderRows(three, {}, ["c", "a", "b"])
    expect(out.map((r) => [r.id, r.y])).toEqual([
      ["a", 74],
      ["b", 198],
      ["c", 0],
    ])
  })

  it("pushes the rows below down when a row grows, and widens its stack", () => {
    const wan = side("wan", 0, 384)
    const { regions: out, moves } = resizeRow([...regions, wan], boxes, "a", {
      x: 0,
      y: 0,
      w: 1200,
      h: 260,
    })
    const b = out.find((r) => r.id === "b")!
    expect(b.y).toBe(284)
    expect(b.w).toBe(1200)
    expect(moves).toEqual({ "dev:2": [600, 380] })
    // The side band spanned the edge that moved: it grows, and stays to
    // the right of the wider rows.
    const w = out.find((r) => r.id === "wan")!
    expect([w.x, w.y, w.h]).toEqual([1216, 0, 484])
    // The zone is an annotation: it stays.
    expect(out.find((r) => r.id === "z")).toEqual(zone("z"))
  })

  it("snaps a side band to the rows' edges", () => {
    const out = snapSide([...regions, side("wan", 8, 370)], "wan")
    const w = out.find((r) => r.id === "wan")!
    expect([w.y, w.h]).toEqual([0, 384])
  })
})

describe("adding bands", () => {
  it("adds a row under the stack, as wide as it", () => {
    const r = newRow([row("a", 0)], "n", [], { x: 0, y: 0 })
    expect([r.x, r.y, r.w, r.h]).toEqual([0, 160 + BAND.GAP, 1000, BAND.NEW_H])
    expect(r.color).toBeNull()
  })

  it("starts the first row across the cards", () => {
    const r = newRow([], "n", [at(100, 100), at(500, 100)], { x: 300, y: 0 })
    expect(r.x).toBe(40 - BAND.PAD_X)
    expect(r.w).toBe(520 + 2 * BAND.PAD_X)
  })

  it("adds a side band to the right of the rows and side bands there", () => {
    const one = newSide([row("a", 0), row("b", 184, 200)], "s1", { x: 0, y: 0 })
    expect([one.x, one.y, one.h]).toEqual([1000 + BAND.SIDE_GAP, 0, 384])
    expect(one.orient).toBe("v")
    expect(one.color).not.toBeNull()
    const two = newSide([row("a", 0), one], "s2", { x: 0, y: 0 })
    expect(two.x).toBe(one.x + one.w + BAND.SIDE_GAP)
  })
})

describe("placing cards into rows", () => {
  const regions = [row("a", 0, 160), row("b", 184, 200)]

  it("answers a point with the row's inside, below its title", () => {
    const slot = rowsAt(regions)({ x: 500, y: 250 })
    expect(slot).toEqual({
      x: BAND.PAD_X,
      y: 184 + BAND.TITLE,
      w: 1000 - 2 * BAND.PAD_X,
      h: 200 - BAND.TITLE,
    })
    expect(rowsAt(regions)({ x: 500, y: 170 })).toBeNull()
    expect(rowsAt([])({ x: 0, y: 0 })).toBeNull()
  })

  it("drops a card into the row, not across its title", () => {
    const out = dropPlacement(["n"], { x: 500, y: 190 }, [], {
      rowsAt: rowsAt(regions),
    })
    const b = boxAround({ x: out.n[0], y: out.n[1] }, NEW_CARD)
    expect(b.y).toBeGreaterThanOrEqual(184 + BAND.TITLE)
    expect(b.y + b.h).toBeLessThanOrEqual(384)
  })

  it("puts several side by side on one line, clear of the card there", () => {
    const there = at(500, 290, NEW_CARD.w, NEW_CARD.h)
    const out = dropPlacement(["n1", "n2"], { x: 500, y: 290 }, [there], {
      rowsAt: rowsAt(regions),
    })
    expect(out.n1[1]).toBe(out.n2[1])
    for (const c of Object.values(out)) {
      const b = boxAround({ x: c[0], y: c[1] }, NEW_CARD)
      expect(b.x + b.w <= there.x || there.x + there.w <= b.x).toBe(true)
      expect(b.y).toBeGreaterThanOrEqual(184 + BAND.TITLE)
    }
  })

  it("puts a newcomer that lands in a row on the row's line", () => {
    const out = placeNewcomers(
      ["n"],
      { n: [{ x: 500, y: 60 }] },
      [at(500, 80, 240, 72)],
      {
        rowsAt: rowsAt(regions),
      }
    )
    const b = boxAround({ x: out.n[0], y: out.n[1] }, NEW_CARD)
    const inA = b.y >= BAND.TITLE && b.y + b.h <= 160
    const inB = b.y >= 184 + BAND.TITLE && b.y + b.h <= 384
    expect(inA || inB).toBe(true)
  })
})

describe("a second Arrange as the roles change", () => {
  const levels = { order: ["Spine", "Leaf", "Border"], bonds: ["Border"] }
  const base = () => [
    card("dev:s1", at(0, 0), ROLES.spine),
    card("dev:s2", at(200, 0), ROLES.spine),
    card("dev:l1", at(0, 200), ROLES.leaf),
    card("dev:l2", at(200, 200), ROLES.leaf),
  ]
  const border = card("dev:b1", at(400, 200), ROLES.border)

  it("names a Levels tier by the roles on the map", () => {
    const { regions } = arrangeBands({ cards: base(), by: "role", levels })
    expect(regions.filter(isRow).map((r) => r.label)).toEqual(["Spine", "Leaf"])
    const both = arrangeBands({
      cards: [...base(), border],
      by: "role",
      levels,
    })
    expect(both.regions.filter(isRow).map((r) => r.label)).toEqual([
      "Spine",
      "Leaf + Border",
    ])
  })

  it("keeps a renamed row and its side band when a role joins the tier", () => {
    const first = arrangeBands({ cards: base(), by: "role", levels })
    const [top, leaf] = first.regions.filter(isRow)
    const renamed = first.regions.map((r) =>
      r.id === leaf.id ? { ...r, label: "Leaf-lag", color: "#10b981" } : r
    )
    const fabricBand = side(
      "fabric",
      top.y,
      leaf.y + leaf.h - top.y,
      top.x + top.w + 16
    )
    const again = arrangeBands({
      cards: [...base(), border],
      by: "role",
      levels,
      regions: [...renamed, fabricBand],
    })
    const rows = again.regions.filter(isRow)
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      [top.id, "Spine"],
      [leaf.id, "Leaf-lag"],
    ])
    expect(rows[1].color).toBe("#10b981")
    expect(rows[1].rule?.ids).toEqual([ROLES.leaf.id, ROLES.border.id].sort())
    const f = again.regions.find((r) => r.id === "fabric")!
    expect([f.y, f.h]).toEqual([rows[0].y, rows[1].y + rows[1].h - rows[0].y])
  })

  it("keeps the row when the last card of a role in it goes", () => {
    const first = arrangeBands({
      cards: [...base(), border],
      by: "role",
      levels,
    })
    const leaf = first.regions.filter(isRow)[1]
    const renamed = first.regions.map((r) =>
      r.id === leaf.id ? { ...r, label: "Leaf-lag" } : r
    )
    const again = arrangeBands({
      cards: base(),
      by: "role",
      levels,
      regions: renamed,
    })
    const now = again.regions.filter(isRow)[1]
    expect([now.id, now.label]).toEqual([leaf.id, "Leaf-lag"])
  })

  it("names a row it named after the roles now in it", () => {
    const first = arrangeBands({ cards: base(), by: "role", levels })
    const leaf = first.regions.filter(isRow)[1]
    const again = arrangeBands({
      cards: [...base(), border],
      by: "role",
      levels,
      regions: first.regions,
    })
    const now = again.regions.filter(isRow)[1]
    expect([now.id, now.label]).toEqual([leaf.id, "Leaf + Border"])
  })
})

describe("fitRows", () => {
  const arranged = () => {
    const cards = fabric()
    const { positions, regions } = arrangeBands({ cards, by: "role" })
    const at = (c: ArrangeCard, w = c.box.w, h = c.box.h) =>
      boxAround({ x: positions[c.id][0], y: positions[c.id][1] }, { w, h })
    return { cards, regions, at }
  }

  it("leaves an arrangement that fits exactly as it is", () => {
    const { cards, regions, at } = arranged()
    const rows = bandRows(regions)
    const fit = fitRows(
      rows,
      Object.fromEntries(cards.map((c) => [c.id, at(c)]))
    )
    expect(fit.moves).toEqual({})
    expect(fit.rows).toEqual(rows)
  })

  it("re-fits the rows round cards drawn as photos, each card in its row", () => {
    const { cards, regions, at } = arranged()
    const rows = bandRows(regions)
    // Arranged as cards, drawn as 480 px photos.
    const photos = Object.fromEntries(cards.map((c) => [c.id, at(c, 480, 80)]))
    const was = membersOf(regions, photos)
    const fit = fitRows(rows, photos)
    const moved: Record<string, Rect> = {}
    for (const [id, b] of Object.entries(photos)) {
      const c = fit.moves[id]
      moved[id] = c ? boxAround({ x: c[0], y: c[1] }, { w: b.w, h: b.h }) : b
    }
    const drawn = fit.rows.map((r) => ({
      ...r,
      kind: "band" as const,
      label: r.id,
      color: null,
    }))
    // Every card stays in the row it was in, below its title, inside it.
    const now = membersOf(drawn, moved)
    for (const [id, list] of was) expect(now.get(id)).toEqual(list)
    for (const r of fit.rows)
      for (const id of now.get(r.id) ?? []) {
        const b = moved[id]
        expect(b.y).toBeGreaterThanOrEqual(r.y + BAND.TITLE)
        expect(b.y + b.h).toBeLessThanOrEqual(r.y + r.h)
        expect(b.x).toBeGreaterThanOrEqual(r.x)
        expect(b.x + b.w).toBeLessThanOrEqual(r.x + r.w)
      }
    // No two cards overlap; the rows keep their order and never overlap;
    // the stack keeps one width.
    const all = Object.values(moved)
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]
        const b = all[j]
        expect(
          a.x < b.x + b.w &&
            b.x < a.x + a.w &&
            a.y < b.y + b.h &&
            b.y < a.y + a.h
        ).toBe(false)
      }
    expect(fit.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id))
    for (let i = 1; i < fit.rows.length; i++)
      expect(fit.rows[i].y).toBeGreaterThanOrEqual(
        fit.rows[i - 1].y + fit.rows[i - 1].h
      )
    expect(new Set(fit.rows.map((r) => r.w)).size).toBe(1)
    // Fitted once, it fits.
    expect(fitRows(fit.rows, moved).moves).toEqual({})
  })

  it("draws the fitted rows only for the rows they were fitted from", () => {
    const regions = [row("a", 0, 160), row("b", 184, 200), side("s", 0, 384)]
    const rows = bandRows(regions)
    const fitted = {
      from: rowsSig(rows),
      rows: [
        { id: "a", x: 0, y: 0, w: 1200, h: 300 },
        { id: "b", x: 0, y: 324, w: 1200, h: 200 },
      ],
    }
    const out = drawnRegions(regions, fitted)
    expect(out.find((r) => r.id === "b")).toMatchObject({ y: 324, w: 1200 })
    // The side band follows its rows, beside the wider stack.
    expect(out.find((r) => r.id === "s")).toMatchObject({
      x: 1216,
      y: 0,
      h: 524,
    })
    // Fitted from rows since moved: the saved ones are drawn.
    expect(drawnRegions([row("a", 40), ...regions.slice(1)], fitted)).toEqual([
      row("a", 40),
      ...regions.slice(1),
    ])
  })
})

describe("row titles", () => {
  const r = { x: 0, y: 0, w: 1000, h: 200 }

  it("centres a title with nothing in its way", () => {
    expect(titleSpot(r, 100)).toBe(500)
    expect(titleSpot(r, 100, [[0, 300]])).toBe(500)
  })

  it("moves a title along its strip clear of what crosses there", () => {
    // A cable at 520: the nearer side of it is the left.
    expect(titleSpot(r, 100, [[516, 524]])).toBe(466)
    // Cables either side of the middle: the nearest gap that fits.
    expect(
      titleSpot(r, 100, [
        [400, 480],
        [520, 700],
      ])
    ).toBe(350)
    // Nowhere clear: the middle.
    expect(titleSpot(r, 100, [[0, 1000]])).toBe(500)
  })
})

describe("the row made for a card", () => {
  it("finds the first row whose rule names its role or type", () => {
    const regions = [
      row("spine", 0, 160, { rule: { by: "role", ids: ["r1"] } }),
      row("leaf", 184, 200, { rule: { by: "role", ids: ["r2", "r3"] } }),
      row("hand", 400, 200),
    ]
    expect(ruleRow(regions)({ role: "r3" })).toEqual(
      rowsAt(regions)({ x: 500, y: 300 })
    )
    expect(ruleRow(regions)({ role: "r9", type: "r1" })).toBeNull()
  })

  it("places a newcomer in its role's row, and a drop outside every row", () => {
    const regions = [
      row("spine", 0, 160, { rule: { by: "role", ids: ["r1"] } }),
      row("leaf", 184, 200, { rule: { by: "role", ids: ["r2"] } }),
    ]
    const own = (id: string) =>
      ruleRow(regions)({ role: id === "n" ? "r2" : null })
    // Cabled to a spine: its neighbours say "under the spine", its role
    // says the leaf row.
    const out = placeNewcomers(
      ["n"],
      { n: [{ x: 500, y: 80 }] },
      [at(500, 80)],
      {
        rowsAt: rowsAt(regions),
        ruleRow: own,
      }
    )
    const b = boxAround({ x: out.n[0], y: out.n[1] }, NEW_CARD)
    expect(b.y).toBeGreaterThanOrEqual(184 + BAND.TITLE)
    expect(b.y + b.h).toBeLessThanOrEqual(384)
    // Dropped far below the bands: into its row, under the pointer.
    const drop = dropPlacement(["n"], { x: 300, y: 2000 }, [], {
      rowsAt: rowsAt(regions),
      ruleRow: own,
    })
    expect(drop.n[0]).toBe(300)
    expect(drop.n[1]).toBeGreaterThan(184)
    expect(drop.n[1]).toBeLessThan(384)
    // Dropped in another row: the row it was dropped in.
    const into = dropPlacement(["n"], { x: 300, y: 90 }, [], {
      rowsAt: rowsAt(regions),
      ruleRow: own,
    })
    expect(into.n[1]).toBeLessThan(160)
  })
})

describe("resizing a row round its cards", () => {
  it("never shrinks a row past the cards in it", () => {
    const regions = [row("a", 0, 300), row("b", 324, 200)]
    const boxes = { "dev:1": at(300, 200, 120, 60) }
    const { regions: out, moves } = resizeRow(regions, boxes, "a", {
      x: 0,
      y: 0,
      w: 200,
      h: 80,
    })
    const a = out.find((r) => r.id === "a")!
    expect(a.h).toBe(230 + BAND.PAD_BOTTOM)
    expect(a.w).toBe(360 + BAND.PAD_X)
    // The card is still in it, and the row below moved up with its cards.
    expect(membersOf(out, boxes).get("a")).toEqual(["dev:1"])
    expect(out.find((r) => r.id === "b")!.y).toBe(324 - (300 - a.h))
    expect(moves).toEqual({})
  })
})
