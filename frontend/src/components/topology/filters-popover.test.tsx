// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TopologyFilters } from "./filters-popover"
import type { TopologyFilterValues } from "./filters-popover"

afterEach(cleanup)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
// cmdk scrolls the active option into view; jsdom has no layout.
Element.prototype.scrollIntoView = () => undefined

const ANY: TopologyFilterValues = {
  site: "all",
  role: "all",
  status: "all",
  tag: "all",
}

const roles = [
  { id: "r1", name: "Core", color: "#2563eb" },
  { id: "r2", name: "Access", color: null },
]
const statuses = [{ id: "s1", name: "Active", color: "#16a34a" }]

function renderFilters(value: TopologyFilterValues = ANY, onChange = vi.fn()) {
  render(
    <TopologyFilters
      value={value}
      onChange={onChange}
      sites={[{ id: "x1", name: "Aarhus" }]}
      roles={roles}
      statuses={statuses}
      tags={[{ name: "Edge", slug: "edge" }]}
    />
  )
  return onChange
}

/** The combobox under a popover field's label. */
function comboUnder(label: string) {
  const field = screen.getByText(label).parentElement!
  return field.querySelector("button")!
}

describe("TopologyFilters", () => {
  it("is a bar menu trigger with a chevron and no count when nothing is set", () => {
    renderFilters()
    const trigger = screen.getByRole("button", { name: "Filters" })
    expect(trigger.className).toContain("h-7")
    expect(trigger.className).toContain("text-xs")
    expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull()
    expect(trigger.querySelector("[data-slot=badge]")).toBeNull()
  })

  it("counts the filters in force", () => {
    renderFilters({ ...ANY, site: "x1", status: "s1" })
    const badge = screen
      .getByRole("button", { name: /Filters/ })
      .querySelector("[data-slot=badge]")
    expect(badge?.textContent).toBe("2")
    expect(badge?.className).toContain("num")
  })

  it("lists each field with an Any row", () => {
    renderFilters()
    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    for (const [label, any] of [
      ["Site", "Any site"],
      ["Role", "Any role"],
      ["Status", "Any status"],
      ["Tag", "Any tag"],
    ])
      expect(comboUnder(label).textContent).toContain(any)
  })

  it("draws roles and statuses as their pills", () => {
    renderFilters()
    fireEvent.click(screen.getByRole("button", { name: "Filters" }))
    fireEvent.click(comboUnder("Role"))
    const core = screen.getByRole("option", { name: "Core" })
    const pill = core.querySelector("[data-slot=badge], span[style]")
    expect(pill?.textContent).toBe("Core")
    expect((pill as HTMLElement).getAttribute("style") ?? "").toMatch(
      /background/
    )
  })

  it("writes the picked value and Any as all", () => {
    const onChange = renderFilters({ ...ANY, role: "r1" })
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }))
    fireEvent.click(comboUnder("Role"))
    fireEvent.click(screen.getByRole("option", { name: "Any role" }))
    expect(onChange).toHaveBeenLastCalledWith({ role: "all" })
  })
})
