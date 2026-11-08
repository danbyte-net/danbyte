// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { AreaShapeView } from "./shape-layer"
import type { AreaShape } from "./shapes"

// A hatched area keeps its line spacing and width on screen at any zoom.

afterEach(cleanup)

const area = {
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 0,
  y: 0,
  width: 20,
  height: 10,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  area_type: {
    id: "t1",
    name: "Hazard",
    color: "#dc2626",
    pattern: "hatched",
    icon: "",
  },
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: false,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
} as unknown as AreaShape

function draw(zoom: number) {
  const { container } = render(
    <svg>
      <AreaShapeView
        area={area}
        selected={false}
        interactive={false}
        zoom={zoom}
      />
    </svg>
  )
  const g = container.querySelector("[data-pattern]")!
  return {
    lines: g.querySelectorAll("line").length,
    width: Number(g.getAttribute("stroke-width")),
  }
}

describe("a hatched area's lines", () => {
  it("spread out in world units as the plan zooms out", () => {
    const near = draw(1)
    cleanup()
    const far = draw(0.25)
    expect(far.lines).toBeLessThan(near.lines)
    expect(far.width).toBeCloseTo(near.width * 4)
  })
})
