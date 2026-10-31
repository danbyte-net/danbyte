// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { AreaTypeRef } from "@/lib/api"

import { AreaLegend, areaLegendEntries, areaTypesInUse } from "./area-legend"
import type { AreaShape, PlanShape } from "./shapes"

// The plan's Areas legend: each type a plain area wears, once, by name -
// on screen and as the PDF's area_legend rows.

afterEach(cleanup)

const parking: AreaTypeRef = {
  id: "t1",
  name: "Parking",
  color: "#2563eb",
  pattern: "hatched",
  icon: "car",
}
const fence: AreaTypeRef = {
  id: "t2",
  name: "Fence",
  color: "",
  pattern: "crosshatched",
  icon: "",
}

const area = (id: string, patch: Partial<AreaShape>): PlanShape => ({
  kind: "area",
  id,
  shape: "rect",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  area_type: null,
  label: "",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
  ...patch,
})

const shapes: PlanShape[] = [
  area("a1", { area_type: parking }),
  area("a2", { area_type: parking }),
  area("a3", { area_type: fence }),
  // A linked area's type is never drawn, so never keyed.
  area("a4", {
    area_type: { ...parking, id: "t3", name: "Ghost" },
    location: { id: "l1", name: "Hall", color: "" },
  }),
  area("a5", {}),
]

describe("the Areas legend", () => {
  it("keys each type in use once, by name", () => {
    expect(areaTypesInUse(shapes).map((t) => t.name)).toEqual([
      "Fence",
      "Parking",
    ])
  })

  it("gives the PDF a swatch of colour and pattern per type", () => {
    expect(areaLegendEntries(shapes)).toEqual({
      title: "Areas",
      items: [
        { label: "Fence", color: "#71717a", pattern: "crosshatched" },
        { label: "Parking", color: "#2563eb", pattern: "hatched" },
      ],
    })
    expect(areaLegendEntries([area("a1", {})])).toBeNull()
  })

  it("shows the types with their patterns", () => {
    const { container } = render(<AreaLegend types={areaTypesInUse(shapes)} />)
    expect(screen.getByText("Areas")).toBeTruthy()
    expect(screen.getByText("Parking")).toBeTruthy()
    expect(screen.getByText("Fence")).toBeTruthy()
    expect(
      [...container.querySelectorAll("svg[data-pattern]")].map((s) =>
        s.getAttribute("data-pattern")
      )
    ).toEqual(["crosshatched", "hatched"])
  })

  it("is nothing without types", () => {
    const { container } = render(<AreaLegend types={[]} />)
    expect(container.innerHTML).toBe("")
  })
})
