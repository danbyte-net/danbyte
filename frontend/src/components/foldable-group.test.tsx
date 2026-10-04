// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CheckCountBadge,
  FoldableGroup,
  RowCheckBadge,
  VisibilityToggle,
} from "./foldable-group"

afterEach(cleanup)
beforeEach(() => localStorage.clear())

// Radix measures the tooltip arrow; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

/** Radix opens a tooltip on keyboard focus; that is enough to read it. */
async function tipOf(el: HTMLElement) {
  fireEvent.focus(el)
  return await screen.findByRole("tooltip")
}

describe("VisibilityToggle", () => {
  it("says Hide {name} as its label and its tooltip, never title=", async () => {
    render(
      <VisibilityToggle
        vis={{ shown: true, onChange: () => {}, what: "Access Point" }}
      />
    )
    const eye = screen.getByRole("button", { name: "Hide Access Point" })
    expect(eye.getAttribute("title")).toBeNull()
    expect((await tipOf(eye)).textContent).toBe("Hide Access Point")
  })

  it("says Show {name} once hidden, and flips on click", () => {
    const onChange = vi.fn()
    render(
      <VisibilityToggle vis={{ shown: false, onChange, what: "core-sw1" }} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Show core-sw1" }))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe("FoldableGroup", () => {
  it("draws the label in place of the name and folds without the eye", () => {
    const onChange = vi.fn()
    render(
      <FoldableGroup
        name="Access Point"
        label={<span>AP badge</span>}
        count={4}
        visibility={{ shown: true, onChange, what: "Access Point" }}
      >
        <p>row</p>
      </FoldableGroup>
    )
    expect(screen.getByText("AP badge")).toBeTruthy()
    expect(screen.getByText("row")).toBeTruthy()
    // The eye sits inside the header button; its click must not fold.
    fireEvent.click(screen.getByRole("button", { name: "Hide Access Point" }))
    expect(onChange).toHaveBeenCalledWith(false)
    expect(screen.getByText("row")).toBeTruthy()
    const header = screen.getByRole("button", { expanded: true })
    fireEvent.click(header)
    expect(screen.queryByText("row")).toBeNull()
  })

  it("remembers the fold under its name", () => {
    render(
      <FoldableGroup name="Links" count={1} storageId="test:folds">
        <p>row</p>
      </FoldableGroup>
    )
    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(JSON.parse(localStorage.getItem("test:folds")!)).toEqual({
      Links: false,
    })
  })
})

describe("check badges", () => {
  it("draws a row's state as the status pill, and nothing without one", () => {
    const { container } = render(<RowCheckBadge check={null} />)
    expect(container.textContent).toBe("")
    render(<RowCheckBadge check="down" />)
    expect(screen.getByText("Down")).toBeTruthy()
  })

  it("draws a count on the state's color with its name on hover", async () => {
    render(<CheckCountBadge check="degraded" n={3} />)
    const chip = screen.getByText("3")
    expect(chip.style.backgroundColor).not.toBe("")
    expect((await tipOf(chip)).textContent).toBe("Degraded")
  })

  it("draws nothing for a zero count", () => {
    const { container } = render(<CheckCountBadge check="down" n={0} />)
    expect(container.textContent).toBe("")
  })
})
