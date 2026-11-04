import { describe, expect, it } from "vitest"

import { BAND, arrangeBands, isRow, normalizeRegions, setAlign } from "./bands"
import type { ArrangeCard, Region } from "./bands"
import { boxAround } from "./placement"
import type { Rect } from "./types"
import type { BandAlign } from "../view-positions"

// A band's Align (`align`): Auto centres each line of its cards across the
// band, as before; Left, Center and Right line each one up with that side
// of the band's content - every wrapped line on its own.

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

const spines = (n = 2): ArrangeCard[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `dev:s${i}`,
    box: at(100 + i * 300, 0),
    role: SPINE,
  }))

/** Each line of `ids` (by y, top first): its leftmost card edge and its
 * rightmost, cards 120 wide. */
function spans(positions: Record<string, [number, number]>, ids: string[]) {
  const by = new Map<number, number[]>()
  for (const id of ids) {
    const [x, y] = positions[id]
    by.set(y, [...(by.get(y) ?? []), x])
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, xs]) => [Math.min(...xs) - 60, Math.max(...xs) + 60])
}

/** The content edges of a row: inside its side padding. */
const inner = (r: Region) => [r.x + BAND.PAD_X, r.x + r.w - BAND.PAD_X]

/** The map arranged once, then `align` set on the leaf row. */
function aligned(cards: ArrangeCard[], align: BandAlign | undefined) {
  const first = arrangeBands({ cards, by: "role" })
  const leaf = first.regions.find((r) => r.label === "Leaf")!
  const moved = cards.map((c) => {
    const [x, y] = first.positions[c.id]
    return { ...c, box: at(x, y) }
  })
  const edit = setAlign({
    regions: first.regions,
    cards: moved,
    id: leaf.id,
    align,
  })
  const positions = { ...first.positions, ...edit.moves }
  return {
    first,
    edit,
    positions,
    row: edit.regions.find((r) => r.id === leaf.id)!,
  }
}

describe("a band's alignment", () => {
  // Two spines over 20 leafs: the leaf row wraps at 12 (Auto), its second
  // line of 8 narrower than the first; the spine row is narrower still.
  const cards = () => [...spines(), ...leaves(20)]
  const leafIds = leaves(20).map((c) => c.id)
  const spineIds = spines().map((c) => c.id)

  it("Auto centres each line, as before", () => {
    const { positions, regions } = arrangeBands({ cards: cards(), by: "role" })
    const row = regions.find((r) => r.label === "Leaf")!
    const [lo, hi] = inner(row)
    const lines = spans(positions, leafIds)
    expect(lines).toHaveLength(2)
    for (const [a, b] of lines) expect(a - lo).toBeCloseTo(hi - b, 0)
  })

  it("Left lines every line up with the band's left, wrapped ones too", () => {
    const { positions, row } = aligned(cards(), "left")
    expect(row.align).toBe("left")
    const [lo] = inner(row)
    const lines = spans(positions, leafIds)
    expect(lines).toHaveLength(2)
    for (const [a] of lines) expect(a).toBeCloseTo(lo, 0)
    // The short second line does not reach the right.
    expect(lines[1][1]).toBeLessThan(lines[0][1])
  })

  it("Right lines every line up with the band's right", () => {
    const { positions, row } = aligned(cards(), "right")
    const [, hi] = inner(row)
    const lines = spans(positions, leafIds)
    for (const [, b] of lines) expect(b).toBeCloseTo(hi, 0)
    expect(lines[1][0]).toBeGreaterThan(lines[0][0])
  })

  it("Center centres each line, as Auto does", () => {
    const { positions, row } = aligned(cards(), "center")
    expect(row.align).toBe("center")
    const [lo, hi] = inner(row)
    const lines = spans(positions, leafIds)
    expect(lines).toHaveLength(2)
    for (const [a, b] of lines) expect(a - lo).toBeCloseTo(hi - b, 0)
  })

  it("re-lays out only its own band, where it stands", () => {
    const { first, edit, row } = aligned(cards(), "left")
    const was = first.regions.find((r) => r.id === row.id)!
    expect([row.x, row.y, row.w, row.h]).toEqual([was.x, was.y, was.w, was.h])
    for (const id of spineIds) expect(edit.moves[id]).toBeUndefined()
    // Back to Auto: the key goes and the cards centre again.
    const after = cards().map((c) => {
      const [x, y] = edit.moves[c.id] ?? first.positions[c.id]
      return { ...c, box: at(x, y) }
    })
    const back = setAlign({
      regions: edit.regions,
      cards: after,
      id: row.id,
      align: undefined,
    })
    const r = back.regions.find((x) => x.id === row.id)!
    expect("align" in r).toBe(false)
    const [lo, hi] = inner(r)
    const now = { ...first.positions, ...edit.moves, ...back.moves }
    for (const [a, b] of spans(now, leafIds))
      expect(a - lo).toBeCloseTo(hi - b, 0)
  })

  it("Arrange ▸ Bands by role keeps it", () => {
    const { edit, positions, row } = aligned(cards(), "right")
    const moved = cards().map((c) => {
      const [x, y] = positions[c.id]
      return { ...c, box: at(x, y) }
    })
    const again = arrangeBands({
      cards: moved,
      by: "role",
      regions: edit.regions,
    })
    const kept = again.regions.find((r) => r.id === row.id)!
    expect(kept.align).toBe("right")
    const [, hi] = inner(kept)
    for (const [, b] of spans(again.positions, leafIds))
      expect(b).toBeCloseTo(hi, 0)
    // The spine row is still Auto: centred.
    const spine = again.regions.find((r) => r.label === "Spine")!
    expect(spine.align).toBeUndefined()
    const [lo2, hi2] = inner(spine)
    const [[a, b]] = spans(again.positions, spineIds)
    expect(a - lo2).toBeCloseTo(hi2 - b, 0)
  })

  it("does nothing set to what it already is", () => {
    const { edit, row } = aligned(cards(), "left")
    const same = setAlign({
      regions: edit.regions,
      cards: cards(),
      id: row.id,
      align: "left",
    })
    expect(same.moves).toEqual({})
    expect(same.regions).toEqual(edit.regions)
  })

  it("is read from a saved view only as left, center or right, on a row", () => {
    const base = { label: "", x: 0, y: 0, w: 500, h: 200, kind: "band" }
    const out = normalizeRegions([
      { ...base, id: "a", orient: "h", align: "left" },
      { ...base, id: "b", orient: "h", align: "center" },
      { ...base, id: "c", orient: "h", align: "right" },
      { ...base, id: "d", orient: "h", align: "middle" },
      { ...base, id: "e", orient: "v", align: "left" },
      { ...base, id: "f", orient: "h", align: 1 },
    ])
    expect(out.filter(isRow).length).toBe(5)
    expect(out.map((r) => r.align)).toEqual([
      "left",
      "center",
      "right",
      undefined,
      undefined,
      undefined,
    ])
  })
})
