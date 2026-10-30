// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { LabelInspector } from "./shape-inspector"
import type { LabelShape } from "./shapes"

// A label's inspector: its size as S/M/L/XL presets of the plan's cell, or
// any height in millimetres; its text, weight, alignment and colour.

afterEach(cleanup)

const plan = {
  id: "p1",
  cell_mm: 600,
  grid_width: 20,
  grid_height: 10,
  site: { id: "s1", name: "AMS" },
  location: { id: "loc1", name: "Hall", slug: "hall" },
} as unknown as FloorPlan

const label: LabelShape = {
  kind: "label",
  id: "l1",
  text: "North side",
  x: 1,
  y: 1,
  width: null,
  height: null,
  rotation: 0,
  font_mm: 300,
  weight: "normal",
  align: "left",
  color: "",
  plate: false,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
}

function inspect(patch: Partial<LabelShape> = {}) {
  const onChange = vi.fn()
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <LabelInspector
          plan={plan}
          label={{ ...label, ...patch }}
          onChange={onChange}
          onRestack={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return onChange
}

describe("a label's size", () => {
  it("shows the preset its height matches", () => {
    inspect()
    expect(
      screen.getByRole("button", { name: "M" }).getAttribute("aria-current")
    ).toBe("page")
  })

  it("takes a preset as millimetres of the plan's cell", () => {
    const onChange = inspect()
    fireEvent.click(screen.getByRole("button", { name: "XL" }))
    expect(onChange).toHaveBeenCalledWith({ font_mm: 750 })
    fireEvent.click(screen.getByRole("button", { name: "S" }))
    expect(onChange).toHaveBeenCalledWith({ font_mm: 150 })
  })

  it("takes any height in millimetres", () => {
    const onChange = inspect({ font_mm: 320 })
    expect(
      screen.getByRole("button", { name: "M" }).getAttribute("aria-current")
    ).toBeNull()
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Text height in millimetres" }),
      { target: { value: "1200" } }
    )
    expect(onChange).toHaveBeenCalledWith({ font_mm: 1200 })
  })
})

describe("a label's text and look", () => {
  it("edits the text and turns bold on", () => {
    const onChange = inspect()
    fireEvent.change(screen.getByDisplayValue("North side"), {
      target: { value: "Loading dock" },
    })
    expect(onChange).toHaveBeenCalledWith({ text: "Loading dock" })
    fireEvent.click(screen.getByRole("button", { name: "Bold" }))
    expect(onChange).toHaveBeenCalledWith({ weight: "bold" })
    fireEvent.click(screen.getByRole("button", { name: "Blue" }))
    expect(onChange).toHaveBeenCalledWith({ color: "blue" })
  })
})
