import { describe, expect, it } from "vitest"

import { emptyDocument, historyReducer, initHistory } from "../view-document"
import type { DocAction, DocHistory, NodeOverride } from "../view-document"
import {
  arrangeBands,
  bandLines,
  isRow,
  normalizeRegions,
  setBandLine,
} from "./bands"
import type { ArrangeCard, Region } from "./bands"
import { withNodeLine } from "./line-source"
import { boxAround } from "./placement"

// A band's line (`line` on a row) and a device's (`state.nodes[id].line`):
// each set or cleared in one undo step, kept by Arrange, read from a saved
// view only as one of the four line types.

const at = (x: number, y: number) => boxAround({ x, y }, { w: 120, h: 60 })
const LEAF = { id: "00000000-0000-4000-8000-000000000002", name: "Leaf" }
const SPINE = { id: "00000000-0000-4000-8000-000000000001", name: "Spine" }
const cards: ArrangeCard[] = [
  { id: "dev:s0", box: at(100, 0), role: SPINE },
  { id: "dev:s1", box: at(400, 0), role: SPINE },
  { id: "dev:l0", box: at(0, 300), role: LEAF },
  { id: "dev:l1", box: at(150, 300), role: LEAF },
]
const DEVICE = "a0000000-0000-4000-8000-000000000001"

const doEdit = (h: DocHistory, action: DocAction) =>
  historyReducer(h, { kind: "do", action })

describe("a band's line", () => {
  const first = arrangeBands({ cards, by: "role" })
  const leaf = first.regions.find((r) => r.label === "Leaf")!

  it("sets only the row's line, and Default takes it off", () => {
    const set = setBandLine(first.regions, leaf.id, "bendy")
    const row = set.find((r) => r.id === leaf.id)!
    expect(row.line).toBe("bendy")
    expect({ ...row, line: undefined }).toEqual({ ...leaf, line: undefined })
    expect(bandLines(set)).toEqual({ [leaf.id]: "bendy" })
    const cleared = setBandLine(set, leaf.id, undefined)
    expect("line" in cleared.find((r) => r.id === leaf.id)!).toBe(false)
    expect(bandLines(cleared)).toEqual({})
  })

  it("is one undo step", () => {
    let h = initHistory(
      emptyDocument({ zones: { diagram: first.regions } }),
      "k"
    )
    h = doEdit(h, {
      type: "setRegions",
      style: "diagram",
      regions: setBandLine(first.regions, leaf.id, "elbow"),
    })
    expect(bandLines(h.present.zones.diagram)).toEqual({ [leaf.id]: "elbow" })
    expect(h.past).toHaveLength(1)
    h = historyReducer(h, { kind: "undo" })
    expect(bandLines(h.present.zones.diagram)).toEqual({})
    h = historyReducer(h, { kind: "redo" })
    expect(bandLines(h.present.zones.diagram)).toEqual({ [leaf.id]: "elbow" })
  })

  it("is kept by Arrange ▸ Bands by role", () => {
    const set = setBandLine(first.regions, leaf.id, "cyclical")
    const moved = cards.map((c) => {
      const [x, y] = first.positions[c.id]
      return { ...c, box: at(x, y) }
    })
    const again = arrangeBands({ cards: moved, by: "role", regions: set })
    const kept = again.regions.find((r) => r.id === leaf.id)!
    expect(kept.line).toBe("cyclical")
    expect(again.regions.find((r) => r.label === "Spine")!.line).toBeUndefined()
  })

  it("is read from a saved view only as a line type, on a row", () => {
    const base = { label: "", x: 0, y: 0, w: 500, h: 200, kind: "band" }
    const out: Region[] = normalizeRegions([
      { ...base, id: "a", orient: "h", line: "elbow" },
      { ...base, id: "b", orient: "h", line: "curved" },
      { ...base, id: "c", orient: "v", line: "bendy" },
      { ...base, id: "d", orient: "h", line: 1 },
    ])
    expect(out.filter(isRow)).toHaveLength(3)
    expect(out.map((r) => r.line)).toEqual([
      "elbow",
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("a device's line", () => {
  it("keeps the card's face and anchor, and none left is no override", () => {
    const photo: NodeOverride = { face: "photo" }
    expect(withNodeLine(photo, "bendy")).toEqual({
      face: "photo",
      line: "bendy",
    })
    expect(withNodeLine({ ...photo, line: "bendy" }, undefined)).toEqual({
      face: "photo",
    })
    expect(withNodeLine<NodeOverride>({ line: "bendy" }, undefined)).toBeNull()
    expect(withNodeLine(undefined, "elbow")).toEqual({ line: "elbow" })
  })

  it("is one undo step", () => {
    let h = initHistory(
      emptyDocument({ nodes: { [DEVICE]: { anchor: "edge" } } }),
      "k"
    )
    h = doEdit(h, {
      type: "setNode",
      id: DEVICE,
      value: withNodeLine(h.present.nodes[DEVICE], "elbow"),
    })
    expect(h.present.nodes[DEVICE]).toEqual({ anchor: "edge", line: "elbow" })
    expect(h.past).toHaveLength(1)
    h = historyReducer(h, { kind: "undo" })
    expect(h.present.nodes[DEVICE]).toEqual({ anchor: "edge" })
  })
})
