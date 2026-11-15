import { describe, expect, it } from "vitest"

import { faceCamera, faceZoom } from "./face-camera"

// A 1U switch: 0.44 wide, 0.044 tall, 0.3 deep.
const SWITCH: [number, number, number] = [0.44, 0.044, 0.3]

describe("faceCamera", () => {
  it("looks straight at the front from −Z, at the box's middle", () => {
    const c = faceCamera(SWITCH, "front", 2)
    expect(c.target).toEqual([0, 0.022, 0])
    expect(c.position[0]).toBe(0)
    expect(c.position[1]).toBe(0.022)
    expect(c.position[2]).toBeLessThan(-0.15)
    expect(c.up).toEqual([0, 1, 0])
    expect([c.faceW, c.faceH]).toEqual([0.44, 0.044])
  })

  it("stands on the far side for the rear and above for the top", () => {
    expect(faceCamera(SWITCH, "rear").position[2]).toBeGreaterThan(0.15)
    const top = faceCamera(SWITCH, "top")
    expect(top.position[1]).toBeGreaterThan(SWITCH[1])
    expect([top.position[0], top.position[2]]).toEqual([0, 0])
    // The back is up on screen.
    expect(top.up).toEqual([0, 0, 1])
    expect([top.faceW, top.faceH]).toEqual([0.44, 0.3])
  })

  it("fits a wide face by its width, a tall one by its height", () => {
    const pad = 0.44 * 0.06
    // A 4:1 viewport: the 10:1 face binds on width.
    const wide = faceCamera(SWITCH, "front", 4)
    expect(wide.halfW).toBeCloseTo((0.44 + 2 * pad) / 2)
    expect(wide.halfH).toBeCloseTo(wide.halfW / 4)
    // A tower in the same viewport binds on height.
    const tower = faceCamera([0.2, 0.5, 0.4], "front", 4)
    expect(tower.halfH).toBeCloseTo((0.5 + 2 * 0.5 * 0.06) / 2)
    expect(tower.halfW).toBeCloseTo(tower.halfH * 4)
  })

  it("keeps the whole box between the clip planes", () => {
    for (const face of ["front", "rear", "top", "left"] as const) {
      const c = faceCamera(SWITCH, face)
      const dist = Math.hypot(
        c.position[0] - c.target[0],
        c.position[1] - c.target[1],
        c.position[2] - c.target[2]
      )
      const r = Math.hypot(...SWITCH) / 2
      expect(c.near).toBeLessThan(dist - r)
      expect(c.far).toBeGreaterThan(dist + r)
      expect(c.near).toBeGreaterThan(0)
    }
  })

  it("survives a zero size and a bad aspect", () => {
    const c = faceCamera([0, 0, 0], "front", Number.NaN)
    expect(Number.isFinite(c.halfW)).toBe(true)
    expect(c.halfW).toBe(c.halfH)
  })
})

describe("faceZoom", () => {
  it("is the pixels per metre that show the fitted view whole", () => {
    const c = faceCamera(SWITCH, "front", 800 / 200)
    const z = faceZoom(c, 800, 200)
    expect(z * 2 * c.halfW).toBeCloseTo(800)
    expect(z * 2 * c.halfH).toBeCloseTo(200)
    expect(faceZoom(c, 0, 200)).toBe(1)
  })
})
