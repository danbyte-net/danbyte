import { describe, expect, it } from "vitest"

import { BAND, arrangeBands, isRow, normalizeRegions, setPerRow } from "./bands"
import type { ArrangeCard } from "./bands"
import { boxAround } from "./placement"
import type { Rect } from "./types"
import { BAND_PER_ROW_MAX } from "../view-positions"

// A band's Cards per row (`per_row`): Auto wraps past 12 cards (or a line
// too wide); a count wraps past exactly that many, however wide - "All on
// one line" is the largest count.

const at = (x: number, y: number, w = 120, h = 60): Rect =>
  boxAround({ x, y }, { w, h })

const LEAF = { id: "00000000-0000-4000-8000-000000000002", name: "Leaf" }
const SPINE = { id: "00000000-0000-4000-8000-000000000001", name: "Spine" }

const leaves = (n: number, y = 300): ArrangeCard[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `dev:l${String(i).padStart(2, "0")}`,
    box: at(i * 150, y),
    role: LEAF,
  }))

const spines = (): ArrangeCard[] => [
  { id: "dev:s1", box: at(100, 0), role: SPINE },
  { id: "dev:s2", box: at(400, 0), role: SPINE },
]

const lines = (positions: Record<string, [number, number]>, ids: string[]) =>
  new Set(ids.map((id) => positions[id][1])).size

const ids = (cards: readonly ArrangeCard[]) => cards.map((c) => c.id)

describe("a band's cards per row", () => {
  it("wraps past 12 on Auto, as before", () => {
    const cards = leaves(20)
    const { positions } = arrangeBands({ cards, by: "role" })
    expect(lines(positions, ids(cards))).toBe(2)
  })

  it("All on one line keeps every card on one line through Arrange", () => {
    const cards = [...spines(), ...leaves(20)]
    const first = arrangeBands({ cards, by: "role" })
    const leafRow = first.regions.find((r) => r.label === "Leaf")!
    const set = first.regions.map((r) =>
      r.id === leafRow.id ? { ...r, per_row: BAND_PER_ROW_MAX } : r
    )
    const again = arrangeBands({ cards, by: "role", regions: set })
    const row = again.regions.find((r) => r.id === leafRow.id)!
    // Arrange kept the setting on the band it rebuilt.
    expect(row.per_row).toBe(BAND_PER_ROW_MAX)
    expect(lines(again.positions, ids(leaves(20)))).toBe(1)
    // One line of cards: the row is one card tall.
    expect(row.h).toBe(BAND.TITLE + BAND.PAD_TOP + 60 + BAND.PAD_BOTTOM)
    // The other band is still Auto.
    const spineRow = again.regions.find((r) => r.label === "Spine")!
    expect(spineRow.per_row).toBeUndefined()
  })

  it("a count wraps past exactly that many cards", () => {
    const cards = leaves(10)
    const first = arrangeBands({ cards, by: "role" })
    const [band] = first.regions.filter(isRow)
    const moved = cards.map((c) => {
      const [x, y] = first.positions[c.id]
      return { ...c, box: at(x, y) }
    })
    const edit = setPerRow({
      regions: first.regions,
      cards: moved,
      id: band.id,
      perRow: 4,
    })
    const row = edit.regions.find((r) => r.id === band.id)!
    expect(row.per_row).toBe(4)
    const ys = ids(cards).map(
      (id) => (edit.moves[id] ?? first.positions[id])[1]
    )
    expect(new Set(ys).size).toBe(3)
    expect(ys.filter((y) => y === Math.min(...ys))).toHaveLength(4)
    // Back to Auto: one line of ten, the key gone.
    const after = cards.map((c) => {
      const [x, y] = edit.moves[c.id] ?? first.positions[c.id]
      return { ...c, box: at(x, y) }
    })
    const auto = setPerRow({
      regions: edit.regions,
      cards: after,
      id: band.id,
      perRow: undefined,
    })
    const back = auto.regions.find((r) => r.id === band.id)!
    expect("per_row" in back).toBe(false)
    const ys2 = ids(cards).map((id) => (auto.moves[id] ?? [0, 0])[1])
    expect(new Set(ys2).size).toBe(1)
  })

  it("is read from a saved view only as a whole number in range, on a row", () => {
    const base = { label: "", x: 0, y: 0, w: 500, h: 200, kind: "band" }
    const out = normalizeRegions([
      { ...base, id: "a", orient: "h", per_row: 8 },
      { ...base, id: "b", orient: "h", per_row: 0 },
      { ...base, id: "c", orient: "h", per_row: 201 },
      { ...base, id: "d", orient: "h", per_row: 2.5 },
      { ...base, id: "e", orient: "v", per_row: 8 },
      { ...base, id: "f", orient: "h", per_row: "8" },
    ])
    expect(out.map((r) => r.per_row)).toEqual([
      8,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})
