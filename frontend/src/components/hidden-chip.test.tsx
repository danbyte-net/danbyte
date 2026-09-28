// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { HiddenChip } from "./hidden-chip"

afterEach(cleanup)

describe("HiddenChip", () => {
  it("sits bottom-right by default and shows everything on Show all", () => {
    const onShowAll = vi.fn()
    render(<HiddenChip count={2} onShowAll={onShowAll} />)
    const btn = screen.getByRole("button", { name: "Show all" })
    const chip = btn.parentElement!
    expect(chip.className).toContain("right-3")
    expect(chip.className).toContain("bottom-3")
    expect(chip.className).not.toContain("shadow")
    expect(btn.dataset.size).toBe("xs")
    fireEvent.click(btn)
    expect(onShowAll).toHaveBeenCalledOnce()
  })

  it("moves to the corner it is given", () => {
    render(<HiddenChip count={1} position="top-right" onShowAll={() => {}} />)
    const chip = screen.getByRole("button", { name: "Show all" }).parentElement!
    expect(chip.className).toContain("top-3")
    expect(chip.className).toContain("right-3")
    expect(chip.className).not.toContain("bottom-3")
  })

  it("draws nothing while nothing is hidden", () => {
    const { container } = render(<HiddenChip count={0} onShowAll={() => {}} />)
    expect(container.textContent).toBe("")
  })
})
