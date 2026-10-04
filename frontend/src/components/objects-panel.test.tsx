// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CheckFilterTabs, ObjectsPanel, checkCounts } from "./objects-panel"

afterEach(cleanup)

function panel(over: Partial<React.ComponentProps<typeof ObjectsPanel>> = {}) {
  const props: React.ComponentProps<typeof ObjectsPanel> = {
    total: 12,
    query: "",
    onQueryChange: vi.fn(),
    status: null,
    onStatusChange: vi.fn(),
    statusCounts: { down: 2, degraded: 0, up: 9 },
    hiddenCount: 0,
    onShowAll: vi.fn(),
    children: <p>rows</p>,
    ...over,
  }
  render(<ObjectsPanel {...props} />)
  return props
}

describe("checkCounts", () => {
  it("counts the three filterable states and skips the rest", () => {
    expect(
      checkCounts(["down", "up", "up", "stale", null, undefined, "degraded"])
    ).toEqual({ down: 1, degraded: 1, up: 2 })
  })
})

describe("ObjectsPanel", () => {
  it("is titled Objects with its count and a Search… box", () => {
    panel()
    expect(screen.getByText("Objects")).toBeTruthy()
    expect(screen.getByText("12")).toBeTruthy()
    const box = screen.getByRole("textbox", { name: "Search objects" })
    expect(box.getAttribute("placeholder")).toBe("Search…")
  })

  it("hands the search text up and jumps on Enter", () => {
    const onSearchEnter = vi.fn()
    const p = panel({ onSearchEnter })
    const box = screen.getByRole("textbox", { name: "Search objects" })
    fireEvent.change(box, { target: { value: "core" } })
    expect(p.onQueryChange).toHaveBeenCalledWith("core")
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onSearchEnter).toHaveBeenCalledOnce()
  })

  it("draws the hidden row with an outline Show all button", () => {
    const p = panel({ hiddenCount: 3 })
    expect(screen.getByText("hidden").textContent).toContain("3")
    const btn = screen.getByRole("button", { name: "Show all" })
    expect(btn.dataset.variant).toBe("outline")
    expect(btn.dataset.size).toBe("xs")
    fireEvent.click(btn)
    expect(p.onShowAll).toHaveBeenCalledOnce()
  })

  it("has no hidden row when nothing is hidden or nothing can be", () => {
    panel({ hiddenCount: 0 })
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
    cleanup()
    panel({ hiddenCount: 4, onShowAll: undefined })
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
  })
})

describe("CheckFilterTabs", () => {
  it("names the states as the status catalog does, with counts", () => {
    render(
      <CheckFilterTabs
        value={null}
        onChange={() => {}}
        counts={{ down: 2, degraded: 0, up: 9 }}
      />
    )
    const labels = screen.getAllByRole("button").map((b) => b.textContent)
    // A zero count is left off rather than drawn as "0".
    expect(labels).toEqual(["All", "Down2", "Degraded", "Up9"])
  })

  it("reports the picked state, and All as null", () => {
    const onChange = vi.fn()
    render(<CheckFilterTabs value="down" onChange={onChange} counts={{}} />)
    expect(
      screen.getByRole("button", { name: "Down" }).getAttribute("aria-current")
    ).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: "Degraded" }))
    expect(onChange).toHaveBeenLastCalledWith("degraded")
    fireEvent.click(screen.getByRole("button", { name: "All" }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})
