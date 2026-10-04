// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LeaveGuardDialog } from "./leave-guard-dialog"

afterEach(cleanup)

const blocked = () => ({
  status: "blocked" as const,
  proceed: vi.fn(),
  reset: vi.fn(),
})

describe("LeaveGuardDialog", () => {
  it("stays closed while nothing is blocked", () => {
    render(<LeaveGuardDialog blocker={{ status: "idle" }} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("asks with the shared wording", () => {
    render(<LeaveGuardDialog blocker={blocked()} />)
    const dialog = screen.getByRole("alertdialog")
    expect(dialog.textContent).toContain("Discard unsaved changes?")
    expect(dialog.textContent).toContain("This map has unsaved changes.")
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Discard and leave" })
    ).toBeTruthy()
  })

  it("takes the page's own noun", () => {
    render(
      <LeaveGuardDialog
        blocker={blocked()}
        description="This plan has unsaved changes."
      />
    )
    expect(screen.getByText("This plan has unsaved changes.")).toBeTruthy()
  })

  it("Keep editing settles the blocker as a stay", () => {
    const b = blocked()
    render(<LeaveGuardDialog blocker={b} />)
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }))
    expect(b.reset).toHaveBeenCalled()
    expect(b.proceed).not.toHaveBeenCalled()
  })

  it("Escape settles it as a stay too", () => {
    const b = blocked()
    render(<LeaveGuardDialog blocker={b} />)
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
    expect(b.reset).toHaveBeenCalled()
    expect(b.proceed).not.toHaveBeenCalled()
  })

  it("Discard and leave lets the navigation through", () => {
    const b = blocked()
    render(<LeaveGuardDialog blocker={b} />)
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }))
    // proceed first; Radix's close then calls reset, which the router ignores
    // once the navigation has been settled.
    expect(b.proceed).toHaveBeenCalledOnce()
    expect(b.proceed.mock.invocationCallOrder[0]).toBeLessThan(
      b.reset.mock.invocationCallOrder[0] ?? Infinity
    )
  })
})
