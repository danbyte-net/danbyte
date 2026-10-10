import { describe, expect, it } from "vitest"

import type { FloorPlanDrawingLayer } from "@/lib/api"
import {
  INLINE_ELEMENT_BUDGET,
  applyMatrix,
  canvasToDrawing,
  canvasTransform,
  drawingToCanvas,
  fmtSizeMm,
  placedBoxMm,
  placementMatrix,
  placementOf,
  presetHidden,
  toggleHidden,
  transformMm,
  wantsServerRender,
} from "./cad-math"
import { calibratedScale, parseDistance } from "./cad-calibrate"

// The drawing's placement on the plan: the client must place it exactly as
// the server's transform_mm says (api/cad_render.py), and invert it for the
// calibration clicks.

const size = { width: 1000, height: 400 }
const at = (rotation: 0 | 90 | 180 | 270, x_mm = 0, y_mm = 0) => ({
  x_mm,
  y_mm,
  rotation,
})

describe("placement", () => {
  it("fills defaults the way the server does", () => {
    expect(placementOf({ placement: {} })).toEqual({
      x_mm: 0,
      y_mm: 0,
      rotation: 0,
      opacity: 60,
      hidden_layers: [],
      hide_text: false,
    })
    expect(
      placementOf({ placement: { rotation: 90, opacity: 30 } }, { opacity: 80 })
    ).toMatchObject({ rotation: 90, opacity: 80 })
  })

  it("swaps the box for quarter turns", () => {
    expect(placedBoxMm(size, 2, at(0, 10, 20))).toEqual({
      x: 10,
      y: 20,
      width: 2000,
      height: 800,
    })
    expect(placedBoxMm(size, 2, at(90))).toMatchObject({
      width: 800,
      height: 2000,
    })
    expect(placedBoxMm(size, 2, at(270))).toMatchObject({
      width: 800,
      height: 2000,
    })
  })

  it("writes the server's transform_mm string", () => {
    // transform_mm for W=1000, H=400, s=2, at (100, 50), 90°: the rotated
    // box is 800×2000, centred at (500, 1050).
    expect(transformMm(size, 2, at(90, 100, 50))).toBe(
      "translate(500 1050) rotate(90) scale(2) translate(-500 -200)"
    )
    expect(transformMm({ width: 3, height: 1.5 }, 0.5, at(0))).toBe(
      "translate(0.75 0.375) rotate(0) scale(0.5) translate(-1.5 -0.75)"
    )
    expect(canvasTransform(size, 1, at(0), 40 / 600)).toMatch(
      /^scale\(0\.066667\) translate\(500 200\)/
    )
  })

  it.each([0, 90, 180, 270] as const)(
    "maps the drawing onto its placed box at %i°",
    (rot) => {
      const m = placementMatrix(size, 2, at(rot, 100, 50))
      const box = placedBoxMm(size, 2, at(rot, 100, 50))
      const corners = [
        [0, 0],
        [size.width, 0],
        [0, size.height],
        [size.width, size.height],
      ].map(([x, y]) => applyMatrix(m, x, y))
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      expect(Math.min(...xs)).toBeCloseTo(box.x)
      expect(Math.min(...ys)).toBeCloseTo(box.y)
      expect(Math.max(...xs)).toBeCloseTo(box.x + box.width)
      expect(Math.max(...ys)).toBeCloseTo(box.y + box.height)
    }
  )

  it("turns clockwise on screen, like SVG rotate()", () => {
    // At 90° the drawing's top-left corner lands at the box's top-right.
    const m = placementMatrix(size, 1, at(90))
    const [x, y] = applyMatrix(m, 0, 0)
    expect(x).toBeCloseTo(400)
    expect(y).toBeCloseTo(0)
  })

  it.each([0, 90, 180, 270] as const)(
    "inverts a canvas click back to drawing units at %i°",
    (rot) => {
      const pxPerMm = 40 / 600
      const p = at(rot, 1234, -567)
      for (const pt of [
        [0, 0],
        [250.5, 99.25],
        [1000, 400],
      ] as [number, number][]) {
        const canvas = drawingToCanvas(pt, size, 3.5, p, pxPerMm)
        const back = canvasToDrawing(
          { x: canvas[0], y: canvas[1] },
          size,
          3.5,
          p,
          pxPerMm
        )
        expect(back[0]).toBeCloseTo(pt[0], 6)
        expect(back[1]).toBeCloseTo(pt[1], 6)
      }
    }
  )
})

const layer = (
  name: string,
  kinds: Partial<FloorPlanDrawingLayer["kinds"]>
): FloorPlanDrawingLayer => ({
  name,
  color: "#ffffff",
  on: true,
  frozen: false,
  entity_count: 1,
  kinds: { geometry: 0, hatch: 0, dimension: 0, text: 0, ...kinds },
})

describe("layers", () => {
  const layers = [
    layer("WALLS", { geometry: 40, hatch: 2 }),
    layer("HATCH", { hatch: 10 }),
    layer("DIMS", { dimension: 5, text: 5 }),
    layer("NOTES", { text: 3 }),
  ]

  it("architecture only hides the layers with no plain geometry", () => {
    expect(presetHidden(layers, "architecture")).toEqual([
      "HATCH",
      "DIMS",
      "NOTES",
    ])
    expect(presetHidden(layers, "all")).toEqual([])
  })

  it("toggles one layer and keeps the set sorted", () => {
    expect(toggleHidden(["b"], "a")).toEqual(["a", "b"])
    expect(toggleHidden(["a", "b"], "a")).toEqual(["b"])
  })

  it("switches to a server render above the element budget", () => {
    expect(wantsServerRender({ rendered_elements: 10 })).toBe(false)
    expect(
      wantsServerRender({ rendered_elements: INLINE_ELEMENT_BUDGET + 1 })
    ).toBe(true)
    expect(wantsServerRender({ rendered_elements: 50 }, 20)).toBe(true)
  })
})

describe("calibration", () => {
  it("takes 1 to 1,000,000 mm", () => {
    expect(parseDistance("600")).toBe(600)
    expect(parseDistance("12,5")).toBe(12.5)
    expect(parseDistance("0.5")).toBeNull()
    expect(parseDistance("2000000")).toBeNull()
    expect(parseDistance("")).toBeNull()
  })

  it("gives mm per unit for the picked span", () => {
    expect(calibratedScale([0, 0], [3, 4], 1000)).toBe(200)
    expect(calibratedScale([1, 1], [1, 1], 1000)).toBeNull()
  })

  it("formats sizes in m or mm", () => {
    expect(fmtSizeMm({ width: 12400, height: 8000 })).toBe("12.4 × 8 m")
    expect(fmtSizeMm({ width: 600, height: 450 })).toBe("600 × 450 mm")
  })
})
