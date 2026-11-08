import { describe, expect, it } from "vitest"

import { tileBox } from "./shapes"
import {
  planAngleToRotY,
  planTilePose,
  poseBounds,
  poseContains,
  poseCorners,
  residualTransform,
  tilePose,
} from "./tile-pose"

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

describe("tilePose - the one tile transform 2D, export and 3D share", () => {
  it("leaves a grid tile untouched (quarter turns, no residual)", () => {
    for (const o of [0, 90, 180, 270]) {
      const p = tilePose({ x: 3, y: 4, w: 2, h: 1, orientation: o })
      expect(p.residual).toBe(0)
      expect(p.quarter).toBe(o)
      expect([p.cx, p.cy, p.w, p.h]).toEqual([4, 4.5, 2, 1])
      expect(residualTransform(p, 40)).toBe("")
    }
    // A quarter turn's stored footprint is already swapped: its own size
    // facing 0° is the stored one turned back.
    const q = tilePose({ x: 0, y: 0, w: 1, h: 2, orientation: 90 })
    expect(q.local).toEqual({ w: 2, h: 1 })
  })

  it("turns a free tile at 28° about its fractional centre", () => {
    const p = tilePose({
      x: 642.71,
      y: 624.689,
      w: 1.5,
      h: 4,
      orientation: 28,
    })
    close(p.cx, 643.46)
    close(p.cy, 626.689)
    expect(p.quarter).toBe(0)
    expect(p.residual).toBe(28)
    expect(p.local).toEqual({ w: 1.5, h: 4 })
    expect(residualTransform(p, 40)).toBe("rotate(28,25738.4,25067.56)")
  })

  it("stores 118° at its 90° footprint: width and height swap back", () => {
    const p = tilePose({ x: 10, y: 10, w: 2, h: 1, orientation: 118 })
    expect(p.quarter).toBe(90)
    expect(p.residual).toBe(28)
    // The stored rect is the after-quarter-turn size; facing 0° it is the
    // other way round - a rack 1 wide and 2 deep.
    expect(p.local).toEqual({ w: 1, h: 2 })
  })

  it("draws 208° as 180° plus 28°", () => {
    const p = tilePose({ x: 0, y: 0, w: 1, h: 2, orientation: 208 })
    expect(p.quarter).toBe(180)
    expect(p.residual).toBe(28)
    expect(p.local).toEqual({ w: 1, h: 2 })
    expect(p.orientation).toBe(208)
  })

  it("turns past 45° the other way from the next quarter", () => {
    const p = tilePose({ x: 0, y: 0, w: 1, h: 1, orientation: 330 })
    expect(p.quarter).toBe(0)
    expect(p.residual).toBe(-30)
  })

  it("agrees with the canvas's tileBox rotation", () => {
    for (const o of [0, 28, 90, 118, 208, 300, 359]) {
      const t = { x: 1.25, y: 2.5, width: 3, height: 1, orientation: o }
      expect(planTilePose(t).residual).toBe(tileBox(t).rotation)
    }
  })

  it("puts the corners where the turned rect lies", () => {
    const p = tilePose({ x: 0, y: 0, w: 2, h: 0, orientation: 90 + 0 })
    expect(p.residual).toBe(0)
    const r = tilePose({ x: -1, y: -1, w: 2, h: 2, orientation: 45 })
    // 45 rounds up to the 90° quarter turn and turns back by 45°.
    expect(r.residual).toBe(-45)
    const c = poseCorners(r)
    const b = poseBounds(r)
    close(b.maxX, Math.SQRT2)
    close(b.minY, -Math.SQRT2)
    expect(c).toHaveLength(4)
    expect(poseContains(r, [0, 0])).toBe(true)
    expect(poseContains(r, [1.3, 0])).toBe(true)
    expect(poseContains(r, [0.95, 0.95])).toBe(false)
  })

  it("maps a clockwise plan turn to a negative three.js turn", () => {
    expect(planAngleToRotY(0)).toBe(0)
    close(planAngleToRotY(28), (-28 * Math.PI) / 180)
  })
})
