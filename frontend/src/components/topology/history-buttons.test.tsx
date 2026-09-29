// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { HistoryButtons, redoKey, undoKey } from "./history-buttons"

// Undo and Redo in the second bar: disabled with nothing to step to, and
// each names its key.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)

function bar(canUndo: boolean, canRedo: boolean) {
  const onUndo = vi.fn()
  const onRedo = vi.fn()
  render(
    <HistoryButtons
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={onUndo}
      onRedo={onRedo}
    />
  )
  return {
    undo: screen.getByRole<HTMLButtonElement>("button", { name: "Undo" }),
    redo: screen.getByRole<HTMLButtonElement>("button", { name: "Redo" }),
    onUndo,
    onRedo,
  }
}

describe("HistoryButtons", () => {
  it("are disabled with nothing to undo or redo", () => {
    const { undo, redo } = bar(false, false)
    expect(undo.disabled).toBe(true)
    expect(redo.disabled).toBe(true)
  })

  it("step back and forward when there is something to step to", () => {
    const { undo, redo, onUndo, onRedo } = bar(true, false)
    expect(undo.disabled).toBe(false)
    expect(redo.disabled).toBe(true)
    fireEvent.click(undo)
    expect(onUndo).toHaveBeenCalledOnce()
    expect(onRedo).not.toHaveBeenCalled()
    cleanup()
    const next = bar(false, true)
    fireEvent.click(next.redo)
    expect(next.onRedo).toHaveBeenCalledOnce()
  })

  it("are square icon buttons with Lucide icons and their keys", async () => {
    const { undo } = bar(true, true)
    expect(undo.className).toContain("size-7")
    expect(undo.querySelector("svg.lucide-undo-2")).not.toBeNull()
    fireEvent.focus(undo)
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toContain("Undo")
    expect(tip.querySelector("kbd")?.textContent).toBe("Ctrl+Z")
  })

  it("name the keys as the platform does", () => {
    expect(undoKey()).toBe("Ctrl+Z")
    expect(redoKey()).toBe("Ctrl+Shift+Z")
  })
})
