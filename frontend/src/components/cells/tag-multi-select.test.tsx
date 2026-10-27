// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TagMultiSelect } from "./tag-multi-select"

// A global tag and a tenant tag may share a name on older installs; the
// picker marks the global one so the two stay distinguishable.

afterEach(cleanup)

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

const OPTIONS = [
  {
    id: 1,
    name: "prod",
    slug: "prod",
    color: "",
    text_color: "",
    is_global: true,
  },
  { id: 2, name: "prod", slug: "prod", color: "", text_color: "" },
]

describe("TagMultiSelect", () => {
  it("marks global tags in the list and on a picked chip", () => {
    const onChange = vi.fn()
    render(<TagMultiSelect options={OPTIONS} value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /Add tags/ }))
    const rows = screen.getAllByRole("option")
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain("global")
    expect(rows[1].textContent).not.toContain("global")
    fireEvent.click(rows[1])
    expect(onChange).toHaveBeenCalledWith([2])

    cleanup()
    render(<TagMultiSelect options={OPTIONS} value={[1]} onChange={onChange} />)
    expect(screen.getByText("global")).toBeTruthy()
  })
})
