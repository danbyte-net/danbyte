// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { planSvg } from "./plan-svg"
import { labelPlate } from "./shapes"
import type { LabelShape } from "./shapes"

// On paper an Opens link is a note under its shape ("→ Campus · B1"), and
// a label's plate wears its own colour with ink that reads over it.

const plan = { grid_width: 24, grid_height: 16, cell_mm: 600 }

const label = (patch: Partial<LabelShape> = {}): LabelShape => ({
  kind: "label",
  id: "l1",
  text: "Go to B1",
  x: 1,
  y: 1,
  width: null,
  height: null,
  rotation: 0,
  font_mm: 300,
  weight: "normal",
  align: "left",
  color: "",
  plate: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
  ...patch,
})

const parse = (svg: string) =>
  new DOMParser().parseFromString(svg, "image/svg+xml").documentElement

describe("Opens on paper", () => {
  it("is a note under the shape", () => {
    const svg = planSvg({
      plan,
      tiles: [],
      shapes: [
        label({
          opens: {
            id: "b1",
            name: "B1",
            stack_name: "Campus",
            kind: "plan",
            can_change: true,
          },
        }),
        label({ id: "l2", y: 8, text: "Plain" }),
      ],
    })
    expect(svg).toContain("→ Campus · B1")
    expect(svg.match(/→/g)).toHaveLength(1)
  })

  it("names nothing of a hidden target", () => {
    const svg = planSvg({
      plan,
      tiles: [],
      shapes: [label({ opens: null, opens_hidden: true })],
    })
    expect(svg).not.toContain("→")
  })
})

describe("a label's plate colour", () => {
  it("fills the plate and picks a readable ink", () => {
    const root = parse(
      planSvg({ plan, tiles: [], shapes: [label({ plate_color: "blue" })] })
    )
    const rect = root.querySelector("g > rect")!
    expect(rect.getAttribute("fill")).toBe("#2563eb")
    expect(root.querySelector("g > text")!.getAttribute("fill")).toBe("#fff")
  })

  it("keeps an explicit text colour", () => {
    const root = parse(
      planSvg({
        plan,
        tiles: [],
        shapes: [label({ plate_color: "amber", color: "violet" })],
      })
    )
    expect(root.querySelector("g > text")!.getAttribute("fill")).toBe("#7c3aed")
  })

  it("reads the theme's background with no plate colour", () => {
    expect(labelPlate(label())).toEqual({ fill: null, ink: null })
    expect(labelPlate(label({ plate: false, plate_color: "red" }))).toEqual({
      fill: null,
      ink: null,
    })
    expect(labelPlate(label({ plate_color: "amber" })).ink).toBe("#fff")
  })
})
