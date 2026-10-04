import { describe, expect, it } from "vitest"

import { clearOfCorner, paddingSides } from "./fit-clear"

// A fit keeps the map clear of the legend in the corner: above it on a wide
// map, beside it on a tall one.

describe("paddingSides", () => {
  it("reads a share of the screen as React Flow does", () => {
    // 0.15 → (v - v / 1.15) / 2 on each side.
    expect(paddingSides(0.15, 1000, 600)).toEqual({
      top: 39,
      right: 65,
      bottom: 39,
      left: 65,
    })
  })

  it("reads px and % per side", () => {
    expect(
      paddingSides({ x: "6%", top: "6%", bottom: "52px" }, 1000, 500)
    ).toEqual({ top: 30, right: 60, bottom: 52, left: 60 })
  })
})

describe("clearOfCorner", () => {
  const legend = { w: 304, h: 216 }

  it("keeps a wide map above the legend", () => {
    const wide = { x: 0, y: 0, width: 2000, height: 300 }
    expect(clearOfCorner(wide, 1200, 800, 0.15, legend, 2)).toEqual({
      top: "52px",
      right: "78px",
      bottom: "228px",
      left: "78px",
    })
  })

  it("keeps a tall map beside the legend", () => {
    const tall = { x: 0, y: 0, width: 300, height: 2000 }
    expect(clearOfCorner(tall, 1200, 800, 0.15, legend, 2)).toEqual({
      top: "52px",
      right: "78px",
      bottom: "52px",
      left: "316px",
    })
  })

  it("never takes less room than the fit's own padding", () => {
    const wide = { x: 0, y: 0, width: 2000, height: 300 }
    const chip = { w: 10, h: 10 }
    expect(clearOfCorner(wide, 1200, 800, "100px", chip, 2)).toEqual({
      top: "100px",
      right: "100px",
      bottom: "100px",
      left: "100px",
    })
  })
})
