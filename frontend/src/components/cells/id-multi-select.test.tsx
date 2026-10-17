// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { IdOption } from "./id-multi-select"
import { IdMultiSelect } from "./id-multi-select"

// A label template's device-type picker crashed on search when its options
// had no name (it read `model`, which the picker list doesn't carry), and
// coloured catalogs (roles) showed as plain text instead of their badge.

afterEach(cleanup)

// cmdk measures its list and scrolls the active row into view; jsdom has
// neither.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /Add/ }))
}

describe("IdMultiSelect", () => {
  it("searches options without a name instead of crashing", () => {
    const options = [
      { id: "a", name: "Catalyst 9300" },
      { id: "b", name: undefined as unknown as string },
    ]
    render(<IdMultiSelect options={options} value={[]} onChange={() => {}} />)
    open()
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
      target: { value: "cat" },
    })
    expect(screen.getByText("Catalyst 9300")).toBeTruthy()
  })

  it("draws a coloured option and its chip as the row's badge", () => {
    const options: IdOption[] = [
      { id: "r1", name: "Leaf", color: "#0ea5e9" },
      { id: "r2", name: "Spine", color: null },
    ]
    render(
      <IdMultiSelect options={options} value={["r1"]} onChange={() => {}} />
    )
    const chip = screen.getByText("Leaf")
    expect(chip.closest("[data-slot=badge]") ?? chip.parentElement).toBeTruthy()
    expect(
      chip.closest<HTMLElement>("[style]")?.style.backgroundColor
    ).toBeTruthy()
    open()
    // Uncoloured rows of a coloured catalog still render as a (neutral) badge.
    expect(screen.getByText("Spine").closest("[data-slot=badge]")).toBeTruthy()
  })
})
