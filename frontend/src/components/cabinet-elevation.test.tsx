// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CabinetElevation } from "./cabinet-elevation"
import type { ElevationRail } from "./cabinet-elevation"

// The plate is drawn in millimetres: the SVG's user units are the API's
// numbers, so a rail's band is a rectangle at its left end, centred on its
// centreline, as long as the rail and as tall as its profile.

const rail = (
  key: string,
  label: string,
  y_mm: number,
  patch: Partial<ElevationRail> = {}
): ElevationRail => ({
  key,
  label,
  profile: "ts35",
  x_mm: 0,
  y_mm,
  length_mm: 525,
  ...patch,
})

const band = (label: string) => {
  const g = document.querySelector(`[data-rail="${label}"]`)
  const r = g?.querySelector("rect")
  if (!g || !r) throw new Error(`no rail ${label}`)
  const n = (a: string) => Number(r.getAttribute(a))
  return { g, x: n("x"), y: n("y"), width: n("width"), height: n("height") }
}

afterEach(cleanup)

describe("CabinetElevation", () => {
  it("draws the plate in millimetres, inside the box when it is known", () => {
    const { container } = render(
      <CabinetElevation
        width={525}
        height={625}
        outerWidth={600}
        outerHeight={700}
        rails={[]}
      />
    )
    const plate = container.querySelector("[data-part=plate]")
    expect(plate?.getAttribute("width")).toBe("525")
    expect(plate?.getAttribute("height")).toBe("625")
    // The box centred around it: 37.5 mm to each side, 37.5 above and below.
    const box = container.querySelector("[data-part=box]")
    expect(box?.getAttribute("x")).toBe("-37.5")
    expect(box?.getAttribute("y")).toBe("-37.5")
    expect(box?.getAttribute("width")).toBe("600")
    // The view takes in the whole box.
    const [x, , w] = (
      container.querySelector("svg")?.getAttribute("viewBox") ?? ""
    )
      .split(" ")
      .map(Number)
    expect(x).toBeLessThan(-37.5)
    expect(w).toBeGreaterThan(600)
  })

  it("leaves the box out while a side of it is unknown", () => {
    const { container } = render(
      <CabinetElevation
        width={400}
        height={500}
        outerWidth={450}
        outerHeight={null}
        rails={[]}
        emptyText="No rails yet."
      />
    )
    expect(container.querySelector("[data-part=box]")).toBeNull()
    expect(screen.getByText("No rails yet.")).toBeTruthy()
  })

  it("draws each rail as its band, labelled", () => {
    render(
      <CabinetElevation
        width={525}
        height={625}
        rails={[
          rail("a", "R1", 75),
          rail("b", "R2", 200, { profile: "ts15", x_mm: 12.5, length_mm: 300 }),
          rail("c", "R3", 400, { profile: "g32" }),
        ]}
      />
    )
    expect(band("R1")).toMatchObject({ x: 0, y: 57.5, width: 525, height: 35 })
    expect(band("R2")).toMatchObject({
      x: 12.5,
      y: 192.5,
      width: 300,
      height: 15,
    })
    expect(band("R3")).toMatchObject({ y: 384, height: 32 })
    expect(band("R2").g.textContent).toBe("R2")
    // Read-only: one picture, no rail to tab to.
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Plate 525×625 mm, 3 rails"
    )
    expect(band("R1").g.getAttribute("tabindex")).toBeNull()
  })

  it("marks the picked rail and the rails that will not save", () => {
    render(
      <CabinetElevation
        width={525}
        height={625}
        rails={[rail("a", "R1", 75), rail("b", "R2", 200, { invalid: true })]}
        selected="a"
      />
    )
    expect(band("R1").g.getAttribute("data-selected")).toBe("true")
    expect(band("R1").g.querySelector("rect")?.getAttribute("class")).toContain(
      "stroke-primary"
    )
    expect(band("R2").g.getAttribute("data-invalid")).toBe("true")
    expect(band("R2").g.querySelector("rect")?.getAttribute("class")).toContain(
      "stroke-destructive"
    )
  })

  it("nudges a focused rail with the arrow keys, kept on the plate", () => {
    const onMove = vi.fn()
    const onSelect = vi.fn()
    render(
      <CabinetElevation
        width={525}
        height={625}
        rails={[rail("a", "R1", 75, { length_mm: 500 }), rail("b", "R2", 20)]}
        onMove={onMove}
        onSelect={onSelect}
      />
    )
    const r1 = screen.getByRole("button", { name: "Rail R1" })
    fireEvent.focus(r1)
    expect(onSelect).toHaveBeenCalledWith("a")
    fireEvent.keyDown(r1, { key: "ArrowDown" })
    expect(onMove).toHaveBeenLastCalledWith("a", { x_mm: 0, y_mm: 76 })
    fireEvent.keyDown(r1, { key: "ArrowRight", shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith("a", { x_mm: 10, y_mm: 75 })
    // Up by 10 stops at the top edge; left from the left edge goes nowhere.
    onMove.mockClear()
    const r2 = screen.getByRole("button", { name: "Rail R2" })
    fireEvent.keyDown(r2, { key: "ArrowUp", shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith("b", { x_mm: 0, y_mm: 17.5 })
    fireEvent.keyDown(r2, { key: "ArrowLeft" })
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it("shows a rail's numbers on hover", async () => {
    render(
      <CabinetElevation
        width={525}
        height={625}
        rails={[rail("a", "R1", 75, { x_mm: 12.5, length_mm: 400 })]}
        onMove={() => {}}
      />
    )
    fireEvent.focus(screen.getByRole("button", { name: "Rail R1" }))
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toContain("TS 35")
    expect(tip.textContent).toContain("Left end12.5 mm")
    expect(tip.textContent).toContain("Centreline75 mm")
    expect(tip.textContent).toContain("Length400 mm")
  })
})
