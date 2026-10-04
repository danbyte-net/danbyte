// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ArrangeMenu } from "./arrange-menu"

// Arrange ▾ holds how the map is placed: Reset layout, the Diagram's bands,
// and its Layout group - the direction as a radio pair and "Levels…",
// which opens the level organiser from the same button.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
afterEach(cleanup)

/** The open menu's items, radio items too, in order. */
const items = () => [
  ...document.querySelectorAll<HTMLElement>(
    "[role=menuitem], [role=menuitemradio]"
  ),
]

function openMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Arrange" }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

const levels = {
  roles: [{ name: "Core", color: "#2563eb" }, { name: "Access" }],
  order: [],
  onChange: vi.fn(),
  bonds: [],
  onBonds: vi.fn(),
  distance: {},
  onDistance: vi.fn(),
}

function diagram(over: Partial<Parameters<typeof ArrangeMenu>[0]> = {}) {
  const onDirection = vi.fn()
  const onReset = vi.fn()
  render(
    <ArrangeMenu
      onReset={onReset}
      bands={{
        onByRole: vi.fn(),
        onByType: vi.fn(),
        onClear: vi.fn(),
        canClear: false,
      }}
      direction={{ value: "LR", onChange: onDirection }}
      levels={levels}
      {...over}
    />
  )
  openMenu()
  return { onDirection, onReset }
}

describe("ArrangeMenu", () => {
  it("lists Reset layout, the bands and the Layout group on the Diagram", () => {
    diagram()
    expect(items().map((i) => i.textContent.trim())).toEqual([
      "Reset layout",
      "Bands by role",
      "Bands by device type",
      "Clear bands",
      "Left to right",
      "Top to bottom",
      "Levels…",
    ])
    expect(screen.getByText("Layout")).toBeTruthy()
    // Every item carries an icon.
    for (const item of items()) expect(item.querySelector("svg")).not.toBeNull()
    expect(
      screen
        .getByRole("menuitem", { name: "Clear bands" })
        .getAttribute("aria-disabled")
    ).toBe("true")
  })

  it("sets the direction from its radio pair, and only when it changes", () => {
    const { onDirection } = diagram()
    const lr = screen.getByRole("menuitemradio", { name: "Left to right" })
    expect(lr.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(lr)
    expect(onDirection).not.toHaveBeenCalled()
    openMenu()
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Top to bottom" })
    )
    expect(onDirection).toHaveBeenCalledWith("TB")
  })

  it("opens the levels from Levels…", async () => {
    diagram()
    expect(screen.queryByRole("dialog", { name: "Levels" })).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Levels…" }))
    expect(await screen.findByRole("dialog", { name: "Levels" })).toBeTruthy()
    expect(screen.getByText("Core")).toBeTruthy()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("leaves Levels… out when there are no levels to set", () => {
    diagram({ levels: undefined })
    expect(screen.queryByRole("menuitem", { name: "Levels…" })).toBeNull()
    expect(
      screen.getByRole("menuitemradio", { name: "Top to bottom" })
    ).toBeTruthy()
  })

  it("is Reset layout alone on the Hierarchy", () => {
    const onReset = vi.fn()
    render(<ArrangeMenu onReset={onReset} />)
    openMenu()
    expect(items().map((i) => i.textContent.trim())).toEqual(["Reset layout"])
    expect(screen.queryByText("Layout")).toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset layout" }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
