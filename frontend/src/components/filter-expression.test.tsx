// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, fireEvent } from "@testing-library/react"

import { ExpressionEditor } from "./filter-expression"

// One row shape is enough: the builder discovers its fields from the rows it
// is given, exactly as a list page hands it their own.
const ROWS = [
  { id: "1", name: "sw1", device_type: { id: "a", name: "Catalyst 9300-48P" } },
  { id: "2", name: "sw2", device_type: { id: "b", name: "Nexus 93240YC-FX2" } },
  { id: "3", name: "srv1", device_type: { id: "c", name: "PowerEdge R640" } },
]

afterEach(cleanup)

describe("advanced filter value picker", () => {
  it("lists the values present in the rows (#117)", () => {
    render(
      <ExpressionEditor
        initial='device_type != ""'
        rows={ROWS}
        onChange={() => {}}
      />
    )
    // Open the value picker on the rule the expression already describes.
    const box = screen.getByPlaceholderText("Value")
    fireEvent.focus(box)

    // Each device type in the rows is offered, with its name readable.
    for (const wanted of [
      "Catalyst 9300-48P",
      "Nexus 93240YC-FX2",
      "PowerEdge R640",
    ]) {
      const hit = screen.getByRole("button", { name: wanted })
      expect(hit).toBeTruthy()
      expect(hit.textContent?.trim()).toBe(wanted)
    }
  })

  it("gives the option list a block scroll container, not a flex column", () => {
    // PopoverContent is a flex column by default. When it is also the scroll
    // container, its children become flex items and shrink away once the list
    // outgrows max-h - the panel renders empty with a scrollbar (#117). jsdom
    // has no layout, so the guard is on the class that prevents it.
    render(
      <ExpressionEditor
        initial='device_type != ""'
        rows={ROWS}
        onChange={() => {}}
      />
    )
    fireEvent.focus(screen.getByPlaceholderText("Value"))
    const panel = document
      .querySelector('[data-slot="popover-content"].overflow-y-auto')
    expect(panel).toBeTruthy()
    expect(panel!.classList.contains("block")).toBe(true)
    expect(panel!.classList.contains("flex")).toBe(false)
  })
})
