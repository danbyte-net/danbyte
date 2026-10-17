// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FormCombobox } from "./combobox"
import { FormStatusSelect } from "./status-select"

// Object fields are searchable comboboxes (#276): a status keeps its pill in
// the trigger and in every option, a search narrows the list, and picking the
// row that is already selected changes nothing (a site → location reset must
// not fire on it).

// cmdk measures and scrolls; jsdom has neither.
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

afterEach(cleanup)

const STATUSES = [
  { id: "a", name: "Active", color: "#16a34a" },
  { id: "p", name: "Planned", color: null },
]

describe("FormStatusSelect", () => {
  it("is searchable and shows each status as its pill", () => {
    const onChange = vi.fn()
    render(
      <FormStatusSelect value="a" onChange={onChange} options={STATUSES} />
    )
    const trigger = screen.getByRole("combobox")
    // The selected value is the coloured pill, not plain text.
    expect(trigger.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "Active"
    )

    fireEvent.click(trigger)
    const search = screen.getByPlaceholderText("Search statuses…")
    // An uncoloured status still reads as its neutral pill.
    const planned = screen.getByRole("option", { name: "Planned" })
    expect(planned.querySelector('[data-slot="badge"]')).not.toBeNull()

    fireEvent.change(search, { target: { value: "plan" } })
    expect(screen.queryByRole("option", { name: "Active" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Planned" }))
    expect(onChange).toHaveBeenCalledWith("p")
  })
})

describe("FormCombobox", () => {
  it("does not report a re-pick of the current row", () => {
    const onChange = vi.fn()
    render(
      <FormCombobox
        label="Site"
        value="s1"
        onChange={onChange}
        noneLabel="No site"
        options={[
          { value: "s1", label: "Fra-1" },
          { value: "s2", label: "Ams-1" },
        ]}
      />
    )
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "Fra-1" }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(screen.getByRole("option", { name: "No site" }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
