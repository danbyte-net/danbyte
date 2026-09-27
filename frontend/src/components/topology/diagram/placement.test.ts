import { describe, expect, it } from "vitest"

import {
  CARD_GAP,
  NEW_CARD,
  boxAround,
  dropPlacement,
  parseDragIds,
  placeNewcomers,
  separateOverlaps,
} from "./placement"
import type { Centre } from "./placement"
import { CARD } from "./card-layout"
import type { Rect } from "./types"

const box = (c: Centre, size: { w: number; h: number } = NEW_CARD): Rect =>
  boxAround({ x: c[0], y: c[1] }, size)

/** Do any two boxes come closer than `gap`? */
function crowded(boxes: Rect[], gap = CARD_GAP - 0.001): string | null {
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (
        a.x - gap < b.x + b.w &&
        b.x < a.x + a.w + gap &&
        a.y - gap < b.y + b.h &&
        b.y < a.y + a.h + gap
      )
        return `${i} and ${j}`
    }
  return null
}

describe("parseDragIds", () => {
  it("reads a JSON list of ids, once each", () => {
    expect(parseDragIds('["a","b","a"]')).toEqual(["a", "b"])
  })
  it("ignores anything else", () => {
    expect(parseDragIds("")).toEqual([])
    expect(parseDragIds("not json")).toEqual([])
    expect(parseDragIds('{"a":1}')).toEqual([])
    expect(parseDragIds('[1, null, "", "ok"]')).toEqual(["ok"])
  })
})

describe("dropPlacement", () => {
  it("sizes a new card as wide as a Simple card gets", () => {
    expect(NEW_CARD.w).toBe(CARD.MAX_W)
  })

  it("centres one card on the pointer", () => {
    expect(dropPlacement(["a"], { x: 100.4, y: 50.6 }, [])).toEqual({
      a: [100, 51],
    })
  })

  it("fans several out in a square grid, right and down, clear of each other", () => {
    const at = { x: 0, y: 0 }
    const out = dropPlacement(["a", "b", "c", "d", "e"], at, [])
    expect(out.a).toEqual([0, 0])
    // Three columns for five cards; the grid steps one card and a gap.
    expect(out.b).toEqual([NEW_CARD.w + CARD_GAP, 0])
    expect(out.d).toEqual([0, NEW_CARD.h + CARD_GAP])
    expect(crowded(Object.values(out).map((c) => box(c)))).toBeNull()
  })

  it("never lands on a card already there", () => {
    const occupied: Rect[] = [
      { x: -100, y: -50, w: 200, h: 100 },
      { x: 150, y: -40, w: 180, h: 80 },
    ]
    const out = dropPlacement(["a", "b", "c"], { x: 0, y: 0 }, occupied)
    const boxes = [...occupied, ...Object.values(out).map((c) => box(c))]
    expect(crowded(boxes)).toBeNull()
    // Still close to where it was dropped.
    for (const [x, y] of Object.values(out))
      expect(Math.hypot(x, y)).toBeLessThan(600)
  })

  it("is deterministic", () => {
    const occupied: Rect[] = [{ x: -60, y: -60, w: 400, h: 300 }]
    const ids = ["a", "b", "c", "d"]
    const one = dropPlacement(ids, { x: 10, y: 10 }, occupied)
    const two = dropPlacement(ids, { x: 10, y: 10 }, [...occupied])
    expect(two).toEqual(one)
  })

  it("honours a card size and gap", () => {
    const out = dropPlacement(["a", "b"], { x: 0, y: 0 }, [], {
      size: { w: 100, h: 40 },
      gap: 10,
    })
    expect(out.b).toEqual([110, 0])
  })
})

describe("placeNewcomers", () => {
  const hub: Rect = { x: -80, y: -36, w: 160, h: 72 }

  it("hangs a newcomer under the card it is cabled to", () => {
    const out = placeNewcomers(["n"], { n: [{ x: 0, y: 0 }] }, [hub])
    const [x, y] = out.n
    expect(x).toBe(0)
    expect(y).toBeGreaterThan(0)
    expect(crowded([hub, box(out.n)])).toBeNull()
  })

  it("keeps several newcomers of one card close and clear", () => {
    const ids = ["n1", "n2", "n3", "n4"]
    const nb = Object.fromEntries(ids.map((id) => [id, [{ x: 0, y: 0 }]]))
    const out = placeNewcomers(ids, nb, [hub])
    expect(crowded([hub, ...ids.map((id) => box(out[id]))])).toBeNull()
    // They hang under the hub, the first in a row beneath it.
    for (const id of ids) {
      expect(out[id][1]).toBeGreaterThan(0)
      expect(Math.hypot(out[id][0], out[id][1])).toBeLessThan(400)
    }
    expect(out.n1[0]).toBe(0)
    expect(out.n2[1]).toBe(out.n1[1])
    expect(out.n3[1]).toBe(out.n1[1])
    expect(out.n2[0]).toBeGreaterThan(0)
    expect(out.n3[0]).toBeLessThan(0)
    // A full row starts the next one.
    expect(out.n4[1]).toBeGreaterThan(out.n1[1])
  })

  it("puts a newcomer between the cards it joins", () => {
    const a: Rect = { x: -480, y: -36, w: 160, h: 72 }
    const b: Rect = { x: 320, y: -36, w: 160, h: 72 }
    const out = placeNewcomers(
      ["n"],
      {
        n: [
          { x: -400, y: 0 },
          { x: 400, y: 0 },
        ],
      },
      [a, b]
    )
    expect(out.n).toEqual([0, 0])
  })

  it("lines up newcomers with no neighbour under everything", () => {
    const out = placeNewcomers(["x", "y"], {}, [hub])
    expect(out.x[1]).toBeGreaterThan(hub.y + hub.h)
    expect(out.y[1]).toBe(out.x[1])
    expect(out.y[0]).toBeGreaterThan(out.x[0])
    expect(crowded([hub, box(out.x), box(out.y)])).toBeNull()
  })

  it("is deterministic", () => {
    const nb = { a: [{ x: 0, y: 0 }], b: [{ x: 0, y: 0 }], c: [] }
    expect(placeNewcomers(["a", "b", "c"], nb, [hub])).toEqual(
      placeNewcomers(["a", "b", "c"], nb, [hub])
    )
  })
})

describe("separateOverlaps", () => {
  it("leaves boxes that overlap nothing where they are", () => {
    const out = separateOverlaps({
      a: { x: 0, y: 0, w: 100, h: 50 },
      b: { x: 400, y: 0, w: 100, h: 50 },
    })
    expect(out).toEqual({ a: [50, 25], b: [450, 25] })
  })

  it("pulls overlapping boxes apart by the shorter move", () => {
    const boxes: Record<string, Rect> = {
      a: { x: 0, y: 0, w: 160, h: 72 },
      // Mostly beside a: pushed right, not down.
      b: { x: 120, y: 10, w: 160, h: 72 },
      // Mostly under a: pushed down.
      c: { x: 10, y: 60, w: 160, h: 72 },
    }
    const out = separateOverlaps(boxes)
    expect(out.a).toEqual([80, 36])
    expect(out.b[1]).toBe(46)
    expect(out.b[0]).toBeGreaterThan(80 + 160)
    expect(out.c[0]).toBe(90)
    expect(out.c[1]).toBeGreaterThan(36 + 72)
    const moved = Object.entries(out).map(([id, c]) =>
      box(c, { w: boxes[id].w, h: boxes[id].h })
    )
    expect(crowded(moved)).toBeNull()
  })

  it("clears a dense pile completely", () => {
    const boxes: Record<string, Rect> = {}
    // Forty cards dropped on nearly the same spot.
    for (let i = 0; i < 40; i++)
      boxes[`d${i}`] = {
        x: (i % 5) * 7,
        y: Math.floor(i / 5) * 5,
        w: 160,
        h: 72,
      }
    const out = separateOverlaps(boxes)
    const moved = Object.values(out).map((c) => box(c))
    expect(crowded(moved)).toBeNull()
  })

  it("does not depend on the order the boxes come in", () => {
    const entries: [string, Rect][] = [
      ["a", { x: 0, y: 0, w: 160, h: 72 }],
      ["b", { x: 30, y: 20, w: 160, h: 72 }],
      ["c", { x: 60, y: 0, w: 120, h: 50 }],
    ]
    const fwd = separateOverlaps(Object.fromEntries(entries))
    const rev = separateOverlaps(Object.fromEntries([...entries].reverse()))
    expect(rev).toEqual(fwd)
  })
})
