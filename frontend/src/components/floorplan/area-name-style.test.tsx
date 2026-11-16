// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_AREA_NAME_LOOK,
  areaNameSize,
  nameBoxAt,
  readAreaNameStyle,
  resolveAreaNameLook,
} from "./area-name-style"
import { planSvg } from "./plan-svg"
import { AreaShapeView } from "./shape-layer"
import type { AreaShape } from "./shapes"

// An area's name look: the plan's default under the area's own keys, the
// nine places in the box, and the plate, colour and size drawn the same on
// screen and on paper.

afterEach(cleanup)

const area = {
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 1,
  y: 1,
  width: 8,
  height: 5,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Server room",
  color: "#3b82f6",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
} as unknown as AreaShape

describe("resolveAreaNameLook", () => {
  it("is today's look with nothing set", () => {
    expect(resolveAreaNameLook(undefined, undefined)).toEqual({
      position: "top-left",
      size: "m",
      color: "",
      plate: false,
    })
  })

  it("lays the area's keys over the plan's, each on its own", () => {
    expect(
      resolveAreaNameLook(
        { position: "center", size: "l", color: "#ff0000" },
        { size: "s", color: "" }
      )
    ).toEqual({ position: "center", size: "s", color: "", plate: false })
  })

  it("drops what is not a valid key", () => {
    expect(
      readAreaNameStyle({
        position: "middle",
        size: "xl",
        color: "red",
        plate: "yes",
        font: 1,
      })
    ).toEqual({})
    expect(readAreaNameStyle("top")).toEqual({})
  })
})

describe("nameBoxAt", () => {
  const rect = { x: 0, y: 0, w: 100, h: 60 }
  const size = { w: 20, h: 10 }
  it("keeps the inset off each side, the centre the inner box's", () => {
    expect(nameBoxAt(rect, size, 5, "top-left")).toEqual({ x: 5, y: 5 })
    expect(nameBoxAt(rect, size, 5, "bottom-right")).toEqual({ x: 75, y: 45 })
    expect(nameBoxAt(rect, size, 5, "center")).toEqual({ x: 40, y: 25 })
    expect(nameBoxAt(rect, size, 5, "top")).toEqual({ x: 40, y: 5 })
    expect(nameBoxAt(rect, size, 5, "left")).toEqual({ x: 5, y: 25 })
  })

  it("grows the box by the plate's pad", () => {
    const bare = areaNameSize("Hall", 12, false, false)
    const plated = areaNameSize("Hall", 12, false, true)
    expect(plated.w - bare.w).toBeCloseTo(2 * plated.pad)
    expect(plated.h - bare.h).toBeCloseTo(2 * plated.pad)
    expect(plated.pad).toBeGreaterThan(0)
  })
})

describe("AreaShapeView", () => {
  const draw = (nameLook = DEFAULT_AREA_NAME_LOOK) =>
    render(
      <svg>
        <AreaShapeView
          area={area}
          selected={false}
          interactive={false}
          nameLook={nameLook}
        />
      </svg>
    ).container

  it("draws the name as it always was by default: no plate", () => {
    const c = draw()
    expect(c.querySelector('[data-part="area-name-plate"]')).toBeNull()
    const t = c.querySelector('[data-part="area-name"] text')!
    expect(t.getAttribute("font-size")).toBe("12")
    expect(Number(t.getAttribute("x"))).toBeCloseTo(40 + 6)
  })

  it("draws a plate, a chosen colour and size, at its position", () => {
    const look = {
      position: "bottom-right",
      size: "l",
      color: "#dc2626",
      plate: true,
    } as const
    const c = draw(look)
    const plate = c.querySelector('[data-part="area-name-plate"]')!
    expect(plate).toBeTruthy()
    const t = c.querySelector('[data-part="area-name"] text')!
    expect(t.getAttribute("font-size")).toBe("16")
    expect(t.getAttribute("fill")).toBe("#dc2626")
    // Its plate ends 6 px in from the area's bottom right.
    const right =
      Number(plate.getAttribute("x")) + Number(plate.getAttribute("width"))
    const bottom =
      Number(plate.getAttribute("y")) + Number(plate.getAttribute("height"))
    expect(right).toBeCloseTo(9 * 40 - 6)
    expect(bottom).toBeCloseTo(6 * 40 - 6)
  })
})

describe("planSvg", () => {
  const plan = { grid_width: 12, grid_height: 8, cell_mm: 600 }
  it("prints the plan's default look, an area's own over it", () => {
    const svg = planSvg({
      plan: {
        ...plan,
        state: { area_names: { plate: true, color: "#16a34a" } },
      },
      tiles: [],
      shapes: [area, { ...area, id: "a2", y: 6, name_style: { plate: false } }],
    })
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
    const names = [...doc.querySelectorAll("text")].filter(
      (t) => t.textContent === "Server room" && !t.getAttribute("stroke")
    )
    expect(names).toHaveLength(2)
    expect(names.every((t) => t.getAttribute("fill") === "#16a34a")).toBe(true)
    // One plate (the first area's); the second turned its off.
    const plates = [...doc.querySelectorAll("rect")].filter(
      (r) => r.getAttribute("stroke") === "#e4e4e7"
    )
    expect(plates).toHaveLength(1)
  })
})
