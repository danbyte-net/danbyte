import { describe, expect, it } from "vitest"

import { ROOM_LOOK, gridFade, roomLook } from "./room-look"
import { gridStep } from "./room"

describe("room look", () => {
  it("picks the theme's colours", () => {
    expect(roomLook(false)).toBe(ROOM_LOOK.light)
    expect(roomLook(true)).toBe(ROOM_LOOK.dark)
    // Light walls on a light slab; the dark theme's slab is darker than
    // its walls, so the walls stand up off it.
    expect(ROOM_LOOK.light.wall).not.toBe(ROOM_LOOK.light.slab)
    expect(ROOM_LOOK.dark.slab).not.toBe(ROOM_LOOK.dark.wall)
  })

  it("fades the grid out some tens of cells from the camera", () => {
    const { near, far } = gridFade(0.6)
    expect(near).toBeCloseTo(15)
    expect(far).toBeCloseTo(51)
    expect(far).toBeGreaterThan(near)
  })

  it("draws every cell up to the line cap", () => {
    expect(gridStep(495, 427, 1000)).toBe(1)
    expect(gridStep(495, 427)).toBe(5)
    expect(gridStep(2400, 100, 1000)).toBe(3)
  })
})
