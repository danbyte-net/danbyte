import { describe, expect, it } from "vitest"

import { Grid, segBox, segHitsRect, spansMeet } from "./spatial"
import type { Pt, Rect } from "./types"

// The grid's quick answers must find everything the slow ones would.

/** A small deterministic random sequence. */
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

const meets = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

describe("Grid.touching", () => {
  const rand = rng(7)
  const boxes: Rect[] = Array.from({ length: 400 }, () => ({
    x: rand() * 4000 - 2000,
    y: rand() * 4000 - 2000,
    w: 20 + rand() * 300,
    h: 20 + rand() * 200,
  }))
  const grid = new Grid<number>(128)
  boxes.forEach((b, i) => grid.add(b, i))

  it("finds exactly the boxes a thin or wide query meets", () => {
    const queries: Rect[] = [
      // Runs of a route: thin one way, long the other.
      ...Array.from({ length: 60 }, () =>
        segBox(
          { x: rand() * 4000 - 2000, y: rand() * 4000 - 2000 },
          { x: rand() * 4000 - 2000, y: rand() * 4000 - 2000 },
          1
        )
      ).map((r, i) => (i % 2 ? { ...r, w: 2 } : { ...r, h: 2 })),
      // Boxes of any shape.
      ...Array.from({ length: 30 }, () => ({
        x: rand() * 4000 - 2000,
        y: rand() * 4000 - 2000,
        w: rand() * 900,
        h: rand() * 900,
      })),
    ]
    for (const q of queries) {
      const want = boxes.flatMap((b, i) => (meets(b, q) ? [i] : []))
      expect(grid.touching(q).sort((a, b) => a - b)).toEqual(want)
    }
  })

  it("tells a watcher the cells each query looks at", () => {
    const seen: [number, number, number, number][] = []
    grid.watch((s) => seen.push(s))
    grid.touching({ x: 0, y: 0, w: 2, h: 500 })
    grid.near({ x: -300, y: 10, w: 600, h: 20 })
    grid.watch(null)
    grid.touching({ x: 0, y: 0, w: 2, h: 500 })
    expect(seen).toEqual([
      [0, 0, 0, 3],
      [-3, 0, 2, 0],
    ])
    expect(spansMeet(seen[0], seen[1])).toBe(true)
    expect(spansMeet(seen[0], [1, 4, 5, 9])).toBe(false)
  })
})

describe("Grid.addSegment", () => {
  it("files a line under every cell it passes near, and few others", () => {
    const rand = rng(11)
    const grid = new Grid<number>(64)
    const segs: [Pt, Pt][] = Array.from({ length: 200 }, () => [
      { x: rand() * 3000, y: rand() * 3000 },
      { x: rand() * 3000, y: rand() * 3000 },
    ])
    segs.forEach(([p, q], i) => grid.addSegment(p, q, 1, i))
    for (let k = 0; k < 300; k++) {
      const box = { x: rand() * 3000, y: rand() * 3000, w: 40, h: 12 }
      const found = new Set(grid.near(box))
      segs.forEach(([p, q], i) => {
        if (segHitsRect(p, q, box)) expect(found.has(i)).toBe(true)
      })
    }
    // A long diagonal is not near a box far off its line.
    const g2 = new Grid<string>(64)
    g2.addSegment({ x: 0, y: 0 }, { x: 3000, y: 3000 }, 1, "d")
    expect(g2.near({ x: 2800, y: 100, w: 20, h: 20 })).toEqual([])
    expect(g2.near({ x: 1490, y: 1490, w: 20, h: 20 })).toEqual(["d"])
  })
})
