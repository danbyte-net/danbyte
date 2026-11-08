import { describe, expect, it } from "vitest"

import { CELL } from "./canvas-geometry"
import {
  facingBarRect,
  figureBarRect,
  figureLift,
  marksOverlap,
} from "./tile-marks"

// A rack tile's facing bar (its front edge) and figure bar (its capacity,
// along the foot) never cover each other, whichever way it faces and
// however big it is.

const SIZES: [number, number][] = [
  [1, 1],
  [1, 2],
  [2, 1],
  [1.5, 4],
  [4, 1.5],
  [2, 2],
  [6, 3],
  [0.6, 0.6],
]

describe("tile marks", () => {
  for (const orientation of [0, 90, 180, 270, 28, 208, 298, 360]) {
    for (const [cw, ch] of SIZES) {
      it(`keep apart facing ${orientation}° on a ${cw}x${ch} tile`, () => {
        const w = cw * CELL
        const h = ch * CELL
        const fig = figureBarRect(w, h, orientation)
        const face = facingBarRect(w, h, orientation, true)
        expect(marksOverlap(fig, face)).toBe(false)
        // Both stay on the tile.
        for (const r of [fig, face]) {
          expect(r.x).toBeGreaterThanOrEqual(0)
          expect(r.y).toBeGreaterThanOrEqual(0)
          expect(r.x + r.width).toBeLessThanOrEqual(w)
          expect(r.y + r.height).toBeLessThanOrEqual(h)
        }
      })
    }
  }

  it("lifts the figure clear of a front facing down, with a gap", () => {
    const w = 1.5 * CELL
    const h = 4 * CELL
    const fig = figureBarRect(w, h, 180)
    const face = facingBarRect(w, h, 180, true)
    expect(face.y - (fig.y + fig.height)).toBeGreaterThanOrEqual(2)
    expect(figureLift(180)).toBeGreaterThan(0)
    expect(figureLift(0)).toBe(0)
    expect(figureBarRect(w, h, 0).y).toBe(h - 2 - 7)
  })

  it("stops a side-facing bar short of the figure, full length without", () => {
    const w = 2 * CELL
    const h = 2 * CELL
    const fig = figureBarRect(w, h, 90)
    const face = facingBarRect(w, h, 90, true)
    expect(fig.y - (face.y + face.height)).toBeGreaterThanOrEqual(2)
    expect(facingBarRect(w, h, 90).height).toBeGreaterThan(face.height)
  })

  it("draws the front edge where it faces", () => {
    const w = 2 * CELL
    const h = 3 * CELL
    expect(facingBarRect(w, h, 0).y).toBeLessThan(10)
    expect(facingBarRect(w, h, 180).y).toBeGreaterThan(h - 10)
    expect(facingBarRect(w, h, 270).x).toBeLessThan(10)
    expect(facingBarRect(w, h, 90).x).toBeGreaterThan(w - 10)
  })
})
