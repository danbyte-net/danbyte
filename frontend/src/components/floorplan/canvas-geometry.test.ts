import { describe, expect, it } from "vitest"

import { CELL, gridLineStep } from "./canvas-geometry"

// The 2D grid draws a line every cell up close and every 10 or 100 cells
// once a cell is smaller than a few pixels - a site-sized plan fitted whole.

describe("gridLineStep", () => {
  it("draws every cell while a cell is at least 6 px", () => {
    expect(gridLineStep(CELL)).toBe(1)
    expect(gridLineStep(6)).toBe(1)
  })

  it("thins out as the plan is zoomed out", () => {
    // A 2048-cell plan fitted to 1300 px: about 0.6 px a cell.
    expect(gridLineStep(1300 / 2048)).toBe(10)
    expect(gridLineStep(0.05)).toBe(1000)
    expect(gridLineStep(0.5)).toBe(100)
    expect(gridLineStep(1)).toBe(10)
  })
})
